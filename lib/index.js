/**
 * dsh-deepseek-billing — host half.
 *
 * Registers two HTTP routes on the DSH web server:
 *
 *   GET /api/dsh-deepseek-billing/balance
 *     Resolves DEEPSEEK_API_KEY through the credentials seam, calls
 *     DeepSeek's /user/balance endpoint, and returns the account balance.
 *
 *   GET /api/dsh-deepseek-billing/session-cost?sessionId=<id>
 *     Replays the session's persisted log (falling back to an in-memory
 *     live ledger) and returns token counts and estimated cost for that
 *     conversation, using the official DeepSeek price table.
 *
 * The API key never leaves the host; the browser only talks to these local
 * routes.
 */
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { costOf, priceAt } from "./pricing.js";

const name = "dsh-deepseek-billing";
const inject = ["credentials", "webServer", "sessionQuery"];

const PUBLIC_BASE_URL = "https://api.deepseek.com";
/** Environment override honored for parity with the llm-deepseek adapter. */
const BASE_URL_ENV = "DEEPSEEK_BASE_URL";
const CREDENTIAL_REF = credentialRef("DEEPSEEK_API_KEY");
const BALANCE_PATH = "/user/balance";
const ROUTE_PATH = "/api/dsh-deepseek-billing/balance";
const SESSION_COST_ROUTE_PATH = "/api/dsh-deepseek-billing/session-cost";
const REQUEST_ROUTE_PATH = "/api/dsh-deepseek-billing/requests";
const TIMEOUT_MS = 15000;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function balanceUrl() {
  const base = process.env[BASE_URL_ENV] ?? PUBLIC_BASE_URL;
  return `${base.replace(/\/+$/, "")}${BALANCE_PATH}`;
}

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/** Extract a readable provider message from a DeepSeek error body. */
function providerMessage(text, status) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.error === "object" && parsed.error !== null && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
  } catch {}
  return `DeepSeek 接口返回 HTTP ${status}`;
}

// ---- session cost ledger -------------------------------------------------

/** Round a cost to 6 decimals for the wire (costs can be fractions of a cent). */
function roundCost(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** Empty per-session cost record (flat sums + per-bucket token/cost pairs for the formula breakdown). */
function emptyCostRecord() {
  return {
    calls: 0,
    cost: 0,
    costUsd: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requests: [],
    buckets: {
      input: { tokens: 0, cost: 0 },
      cacheRead: { tokens: 0, cost: 0 },
      cacheWrite: { tokens: 0, cost: 0 },
      output: { tokens: 0, cost: 0 }
    }
  };
}

/** Price one `assistant/message` event into a cost record (shared by live and replay paths). */
function priceEventInto(record, event) {
  const data = event.data;
  const usage = data?.usage;
  if (usage === void 0 || usage === null) return false;
  if (typeof usage.outputTokens !== "number" && typeof usage.inputTokens !== "number") return false;
  const source = data.message?.source;
  // 归一化：模型名可能带 provider 前缀（deepseek-official/deepseek-v4-flash），
  // 取斜杠后段并转小写，保证价格表按裸模型名匹配（否则会落到 * 兜底价）。
  const rawModel = typeof source?.model === "string" ? source.model : "unknown";
  const model = rawModel.split("/").pop().toLowerCase();
  const unit = priceAt(model, event.time ?? Date.now());
  const sample = costOf(usage, unit);
  // 推理 token 按输出价计费（DeepSeek 思考模式：reasoning 计入 output 计费），
  // 之前漏计会导致会话费用比官方平台明显偏低。
  const reasoningTokens = usage.reasoningTokens ?? 0;
  sample.cost += (reasoningTokens * unit.cny.output) / 1e6;
  sample.costUsd += (reasoningTokens * unit.usd.output) / 1e6;
  record.calls += 1;
  record.cost += sample.cost;
  record.costUsd += sample.costUsd;
  record.inputTokens += sample.inputTokens;
  record.cacheReadTokens += sample.cacheReadTokens;
  record.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  record.reasoningTokens += usage.reasoningTokens ?? 0;
  record.outputTokens += sample.outputTokens;
  record.totalTokens += sample.inputTokens + sample.cacheReadTokens + (usage.cacheWriteTokens ?? 0) + sample.outputTokens + (usage.reasoningTokens ?? 0);
  // 分桶累计（按每条消息的实际单价），供"计算公式"明细展示。
  record.buckets.input.tokens += sample.inputTokens;
  record.buckets.input.cost += (sample.inputTokens * unit.cny.input) / 1e6;
  record.buckets.cacheRead.tokens += sample.cacheReadTokens;
  record.buckets.cacheRead.cost += (sample.cacheReadTokens * unit.cny.cacheRead) / 1e6;
  record.buckets.cacheWrite.tokens += sample.cacheWriteTokens;
  record.buckets.cacheWrite.cost += (sample.cacheWriteTokens * unit.cny.input) / 1e6;
  record.buckets.output.tokens += sample.outputTokens + reasoningTokens;
  record.buckets.output.cost += ((sample.outputTokens + reasoningTokens) * unit.cny.output) / 1e6;
  const messageId = data.message?.id || `${data.turn ?? 0}:${data.step ?? 0}`;
  record.requests.push({
    messageId,
    turn: data.turn ?? 0,
    step: data.step ?? 0,
    time: event.time ?? Date.now(),
    model,
    inputTokens: sample.inputTokens,
    cacheReadTokens: sample.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    outputTokens: sample.outputTokens + reasoningTokens,
    totalTokens: sample.inputTokens + sample.cacheReadTokens + (usage.cacheWriteTokens ?? 0) + sample.outputTokens + reasoningTokens,
    cost: roundCost(sample.cost),
    costUsd: roundCost(sample.costUsd)
  });
  return true;
}

/**
 * Build the formula breakdown for one cost record: per bucket `{ label, tokens,
 * rate, subtotal }`, where `rate` is the EFFECTIVE blended price (¥/M) — the
 * exact `subtotal / tokens × 1e6` so `tokens × rate = subtotal` holds for the
 * displayed formula. Zero-token buckets are kept with rate 0.
 */
function breakdownOf(record) {
  const parts = [
    { label: "输入(未缓存)", key: "input" },
    { label: "缓存命中", key: "cacheRead" },
    { label: "缓存写入", key: "cacheWrite" },
    { label: "输出", key: "output" }
  ];
  return parts.map(({ label, key }) => {
    const bucket = record.buckets[key];
    const tokens = bucket.tokens;
    const subtotal = bucket.cost;
    const rate = tokens > 0 ? roundCost((subtotal / tokens) * 1e6) : 0;
    return { label, tokens, rate, subtotal: roundCost(subtotal) };
  });
}

/** Min interval between log re-decodings of the same session (avoids churn during active turns). */
const REPLAY_MIN_INTERVAL_MS = 2000;

/**
 * Replay a session's persisted log and price EVERY assistant/message event, so
 * the reported cost covers the whole conversation (including messages that
 * happened before this plugin loaded — the live in-memory ledger alone would
 * undercount after a restart). Cached per session by the stored log's revision
 * token; REPLAY_MIN_INTERVAL_MS still throttles re-decodes of a changed log.
 * Two persistence eras are supported:
 *   - legacy (0.1.0-rc.6): readStoredRevision(id) + readRaw(id) -> JSONL text;
 *   - 0.1.5+: stat(id) -> snapshot.revision (opaque token derived from the log
 *     file's dev/ino/size/mtime identity — same cache-key role as the old
 *     numeric revision) and open(id, 'read') -> handle.read(), which returns
 *     already-parsed events (no per-line JSON.parse).
 * When neither interface exists the replay is unsupported and null is
 * returned, leaving loadOneRecord() to fall back to the live ledger.
 */
async function replaySessionCost(ctx, sessionId) {
  const persistence = ctx.get("sessionPersistence");
  if (persistence === void 0) return null;
  const isLegacy = typeof persistence.readRaw === "function" && typeof persistence.readStoredRevision === "function";
  const isSeam = typeof persistence.stat === "function" && typeof persistence.open === "function";
  if (!isLegacy && !isSeam) return null;
  let revision;
  try {
    revision = isLegacy ? await persistence.readStoredRevision(sessionId) : (await persistence.stat(sessionId))?.revision;
  } catch (error) {
    ctx.logger.warn("dsh-deepseek-billing: failed to read session log revision");
    ctx.logger.warn(error);
    return null;
  }
  if (revision === void 0) return null;
  const cached = logCostCache.get(sessionId);
  if (cached !== void 0) {
    if (cached.revision === revision) return cached;
    if (Date.now() - cached.at < REPLAY_MIN_INTERVAL_MS) return cached;
  }
  try {
    const record = emptyCostRecord();
    if (isLegacy) {
      const raw = await persistence.readRaw(sessionId);
      if (raw === void 0 || raw === null || typeof raw.content !== "string") return null;
      for (const line of raw.content.split("\n")) {
        if (line === "") continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event === null || typeof event !== "object" || event.type !== "assistant/message") continue;
        try {
          priceEventInto(record, event);
        } catch {
          // one malformed message must not fail the whole replay
        }
      }
    } else {
      // Read pattern mirrors readColdSessionLog in @deepseek-ai/dsh-session-query:
      // open a 'read' handle, close it on both the success and the error path.
      const handle = await persistence.open(sessionId, "read");
      let events;
      try {
        ({ events } = await handle.read());
      } catch (error) {
        try {
          await handle.close();
        } catch {}
        throw error;
      }
      await handle.close();
      for (const event of events) {
        if (event === null || typeof event !== "object" || event.type !== "assistant/message") continue;
        try {
          priceEventInto(record, event);
        } catch {
          // one malformed message must not fail the whole replay
        }
      }
    }
    const result = { ...record, revision, at: Date.now() };
    logCostCache.set(sessionId, result);
    return result;
  } catch (error) {
    ctx.logger.warn("dsh-deepseek-billing: failed to replay session log for costing");
    ctx.logger.warn(error);
    return null;
  }
}

/** Whole-session log replay cache: sessionId -> { revision, calls, cost, ..., at }. */
const logCostCache = new Map();

/** Aggregate (parent + descendants) cache: sessionId -> { at, record, source, ids }. */
const aggregateCache = new Map();

function apply(ctx) {
  // ---- current-conversation cost ledger ----------------------------------
  // 订阅 session/event 实时累计（覆盖尚未落盘的进行中消息）；查询时优先用
  // 全量日志回放（replaySessionCost）以获得包含重启前历史的整段会话费用。
  const bySession = new Map();
  const headersBySession = new Map();

  ctx.on("session/event", (session, event) => {
    try {
      if (event?.type === "request/header" && event.data?.header?.config) {
        const header = event.data.header.config;
        if (typeof header.provider === "string" && typeof header.model === "string") {
          headersBySession.set(session.id, { provider: header.provider, model: header.model });
        }
        return;
      }
      if (event?.type !== "assistant/message") return;
      let record = bySession.get(session.id);
      if (record === void 0) {
        record = { ...emptyCostRecord(), updatedAt: 0 };
        bySession.set(session.id, record);
      }
      priceEventInto(record, event);
      record.updatedAt = event.time ?? Date.now();
    } catch (error) {
      ctx.logger.warn("dsh-deepseek-billing: failed to price an assistant/message event");
      ctx.logger.warn(error);
    }
  });

  // ---- descendant aggregation helpers -----------------------------------
  function flattenDescendantIds(nodes, out) {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (node && node.session && node.session.header && typeof node.session.header.id === "string") {
        out.push({ id: node.session.header.id, createdAt: node.session.header.createdAt });
      }
      if (node && Array.isArray(node.descendants)) flattenDescendantIds(node.descendants, out);
    }
  }

  async function collectSessionIds(sessionId) {
    const query = ctx.get("sessionQuery");
    if (query && typeof query.traceSession === "function") {
      try {
        const trace = await query.traceSession(sessionId);
        const ids = [{ id: trace.target.header.id, createdAt: trace.target.header.createdAt }];
        flattenDescendantIds(trace.descendants, ids);
        return ids;
      } catch (error) {
        ctx.logger.warn("dsh-deepseek-billing: traceSession failed, falling back to single session");
        ctx.logger.warn(error);
      }
    }
    return [{ id: sessionId, createdAt: Date.now() }];
  }

  async function loadOneRecord(sessionId) {
    const replay = await replaySessionCost(ctx, sessionId);
    if (replay !== null) return { record: replay, source: "log" };
    const live = bySession.get(sessionId);
    if (live !== void 0) return { record: live, source: "live" };
    return { record: null, source: null };
  }

  async function aggregateSession(sessionId) {
    const cached = aggregateCache.get(sessionId);
    if (cached !== void 0 && Date.now() - cached.at < 8000) {
      return { record: cached.record, source: cached.source, ids: cached.ids };
    }
    const ids = await collectSessionIds(sessionId);
    const merged = emptyCostRecord();
    let source = null;
    let any = false;
    for (const info of ids) {
      const id = info.id;
      const { record, source: recSource } = await loadOneRecord(id);
      if (record === null) continue;
      any = true;
      if (source === null) source = recSource;
      merged.calls += record.calls;
      merged.cost += record.cost;
      merged.costUsd += record.costUsd;
      merged.inputTokens += record.inputTokens;
      merged.cacheReadTokens += record.cacheReadTokens;
      merged.cacheWriteTokens += record.cacheWriteTokens;
      merged.reasoningTokens += record.reasoningTokens;
      merged.outputTokens += record.outputTokens;
      merged.totalTokens += record.totalTokens;
      for (const key of ["input", "cacheRead", "cacheWrite", "output"]) {
        if (record.buckets[key]) {
          merged.buckets[key].tokens += record.buckets[key].tokens;
          merged.buckets[key].cost += record.buckets[key].cost;
        }
      }
      for (const req of record.requests) {
        merged.requests.push(Object.assign({}, req, { sessionId: id, sessionCreatedAt: info.createdAt }));
      }
    }
    const result = { record: any ? merged : null, source, ids };
    aggregateCache.set(sessionId, { at: Date.now(), record: result.record, source: result.source, ids });
    return result;
  }

  // ---- balance route -----------------------------------------------------
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: ROUTE_PATH,
      handler: async (req, res) => {
        try {
          const hit = await ctx.credentials.resolve(CREDENTIAL_REF);
          if (hit === void 0) {
            sendJson(res, 503, {
              ok: false,
              error: "no-api-key",
              message: "未配置 DEEPSEEK_API_KEY：请在 设置 → 模型 中填写 DeepSeek API Key。"
            });
            return;
          }
          const response = await fetch(balanceUrl(), {
            headers: {
              Authorization: `Bearer ${hit.value}`,
              Accept: "application/json"
            },
            signal: AbortSignal.timeout(TIMEOUT_MS)
          });
          const text = await response.text();
          if (!response.ok) {
            sendJson(res, response.status, {
              ok: false,
              error: "provider",
              message: providerMessage(text, response.status)
            });
            return;
          }
          let body = null;
          try {
            body = JSON.parse(text);
          } catch {}
          sendJson(res, 200, { ok: true, balance: body });
        } catch (error) {
          ctx.logger.warn("dsh-deepseek-billing: failed to fetch DeepSeek balance");
          ctx.logger.warn(error);
          sendJson(res, 502, {
            ok: false,
            error: "fetch-failed",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }),
    "dsh-deepseek-billing: balance route"
  );

  // ---- session cost route ------------------------------------------------
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: SESSION_COST_ROUTE_PATH,
      handler: async (req, res) => {
        try {
          const sessionId = new URL(req.url ?? "/", "http://x").searchParams.get("sessionId") ?? "";
          // 汇总当前会话 + 所有子代理会话（含嵌套子代理）。
          const agg = sessionId !== "" ? await aggregateSession(sessionId) : { record: null, source: null };
          const record = agg.record;
          const source = agg.source;
          if (record === null) {
            sendJson(res, 200, {
              ok: true,
              sessionId,
              cost: null,
              costUsd: null,
              calls: 0,
              inputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              breakdown: null
            });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            sessionId,
            source,
            cost: roundCost(record.cost),
            costUsd: roundCost(record.costUsd),
            calls: record.calls,
            inputTokens: record.inputTokens,
            cacheReadTokens: record.cacheReadTokens,
            cacheWriteTokens: record.cacheWriteTokens,
            reasoningTokens: record.reasoningTokens,
            outputTokens: record.outputTokens,
            totalTokens: record.totalTokens,
            breakdown: breakdownOf(record)
          });
        } catch (error) {
          ctx.logger.warn("dsh-deepseek-billing: session-cost lookup failed");
          ctx.logger.warn(error);
          sendJson(res, 500, { ok: false, error: "internal", message: "internal error" });
        }
      }
    }),
    "dsh-deepseek-billing: session cost route"
  );

  // ---- per-request cost route --------------------------------------------
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: REQUEST_ROUTE_PATH,
      handler: async (req, res) => {
        try {
          const sessionId = new URL(req.url ?? "/", "http://x").searchParams.get("sessionId") ?? "";
          // 汇总当前会话 + 所有子代理会话（含嵌套子代理）。
          const agg = sessionId !== "" ? await aggregateSession(sessionId) : { record: null, source: null };
          sendJson(res, 200, {
            ok: true,
            sessionId,
            source: agg.source,
            requests: agg.record === null ? [] : agg.record.requests
          });
        } catch (error) {
          ctx.logger.warn("dsh-deepseek-billing: per-request cost lookup failed");
          ctx.logger.warn(error);
          sendJson(res, 500, { ok: false, error: "internal", message: "internal error" });
        }
      }
    }),
    "dsh-deepseek-billing: per-request cost route"
  );
}

export { name, inject, apply };
