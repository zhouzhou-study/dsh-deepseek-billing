/**
 * dsh-deepseek-billing — 用户自定义价格层（服务端）。
 *
 * 目的：让用户**在界面上**维护自己的价格表（高峰价 / 闲时价 / 生效时间），
 * 不用改代码。官方价表（pricing.js）保持不变，作为兜底与 USD 来源。
 *
 * 数据文件：`$DSH_HOME/billing-prices.json`（可用环境变量 DSH_BILLING_PRICING_FILE 覆盖）。
 * 形如：
 *   {
 *     "version": 1,
 *     "updatedAt": 0,
 *     "config": { "timezone": "Asia/Shanghai", "peakWindows": [[9,12],[14,18]], "weekendOffPeak": true },
 *     "entries": [
 *       { "id": "u-...", "since": "2026-09-13T12:00:00+08:00", "scope": "deepseek-flash",
 *         "peak":   { "input": 2, "cacheRead": 0.04, "output": 8 },
 *         "offPeak":{ "input": 1, "cacheRead": 0.02, "output": 4 },
 *         "note": "我自己调价", "createdAt": 0, "updatedAt": 0 }
 *     ]
 *   }
 *
 * 语义（与官方表一致，保证历史账单可复现）：
 * - 每条 entry 只对「自己的 since 之后」的请求生效；改价不改写更早的账。
 * - 同一时刻多条命中时：精确匹配模型 > `*` 兜底；同类里 since 最新者胜。
 * - 命中用户条目的请求：**CNY 单价用用户填的**；USD 沿用官方同刻价。
 * - 文件缺失 / 坏条目 / 类型不对 ⇒ 跳过该条并记录 errors，绝不抛错、绝不让接口 500。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_PEAK_WINDOWS,
  DEFAULT_TIMEZONE,
  OFFICIAL_PRICING_POLICIES,
  costOf,
  isPeak,
  isWeekend,
  priceAt
} from "./pricing.js";

export const SCHEMA_VERSION = 1;
/** 单价上限（元/百万 tokens）——防手滑把 1 打成 1000000。 */
const MAX_RATE = 100000;
/** 读盘缓存节流：同一版本的文件最少 500ms 才重读一次。 */
const READ_THROTTLE_MS = 500;
/** 未设置 DSH_HOME 时的兜底：DSH 的默认数据目录 `~/.dsh`（各平台通用）。 */
function defaultHome() {
  try {
    return path.join(os.homedir(), ".dsh");
  } catch {
    return ".dsh";
  }
}

/** 价格数据文件的实际路径（env 覆盖 > `$DSH_HOME` > `~/.dsh`）。 */
export function pricingFilePath() {
  const explicit = process.env.DSH_BILLING_PRICING_FILE;
  if (typeof explicit === "string" && explicit.trim() !== "") return explicit;
  const home = process.env.DSH_HOME;
  const base = typeof home === "string" && home.trim() !== "" ? home : defaultHome();
  return path.join(base, "billing-prices.json");
}

function defaultConfig() {
  return {
    timezone: DEFAULT_TIMEZONE,
    peakWindows: DEFAULT_PEAK_WINDOWS.map(([start, end]) => [start, end]),
    weekendOffPeak: true
  };
}

/** 空快照 = 没有任何自定义价，全部走官方表。 */
export function emptySnapshot() {
  return { path: pricingFilePath(), exists: false, updatedAt: null, config: defaultConfig(), entries: [], errors: [] };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把用户填的时间归一化成 `YYYY-MM-DDTHH:mm:ss+08:00`（北京时间无夏令时，安全）。 */
export function normalizeSince(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const naive = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (naive !== null) {
    const [, y, mo, d, hh, mm, ss] = naive;
    return `${y}-${mo}-${d}T${hh}:${mm}:${ss ?? "00"}+08:00`;
  }
  if (Number.isFinite(Date.parse(trimmed))) return trimmed;
  return null;
}

/** 校验一组单价（input/cacheRead/output，单位 元/百万 tokens）。 */
function normalizeRateBlock(value, where, errors) {
  if (!isPlainObject(value)) {
    errors.push({ where, message: "缺少价格块（需要 input / cacheRead / output 三个数字）" });
    return null;
  }
  const out = {};
  for (const key of ["input", "cacheRead", "output"]) {
    const raw = value[key];
    const num = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
    if (typeof num !== "number" || !Number.isFinite(num) || num < 0 || num > MAX_RATE) {
      errors.push({ where: `${where}.${key}`, message: `价格必须是 0 ~ ${MAX_RATE} 之间的数字` });
      return null;
    }
    out[key] = num;
  }
  return out;
}

function normalizePeakWindows(value, errors) {
  if (value === void 0) return defaultConfig().peakWindows;
  if (!Array.isArray(value)) {
    errors.push({ where: "config.peakWindows", message: "高峰时段必须是数组，例如 [[9,12],[14,18]]" });
    return defaultConfig().peakWindows;
  }
  const windows = [];
  for (let i = 0; i < value.length; i++) {
    const pair = value[i];
    const ok = Array.isArray(pair) && pair.length === 2 && pair.every((v) => Number.isInteger(v) && v >= 0 && v <= 24) && pair[0] < pair[1];
    if (!ok) {
      errors.push({ where: `config.peakWindows[${i}]`, message: "每个高峰时段要写成 [起始小时, 结束小时]，例如 [9,12]" });
      continue;
    }
    windows.push([pair[0], pair[1]]);
  }
  return windows.length > 0 ? windows : defaultConfig().peakWindows;
}

function normalizeConfig(value, errors) {
  const base = defaultConfig();
  if (!isPlainObject(value)) return base;
  const timezone = typeof value.timezone === "string" && value.timezone.trim() !== "" ? value.timezone.trim() : base.timezone;
  return {
    timezone,
    peakWindows: normalizePeakWindows(value.peakWindows, errors),
    weekendOffPeak: value.weekendOffPeak === void 0 ? base.weekendOffPeak : value.weekendOffPeak === true
  };
}

let idCounter = 0;
function newEntryId() {
  idCounter += 1;
  return `u-${Date.now().toString(36)}-${idCounter}`;
}

/** 校验单条自定义价；坏条目返回 null 并写 errors（不抛错）。 */
export function normalizeEntry(value, where, errors) {
  if (!isPlainObject(value)) {
    errors.push({ where, message: "条目必须是对象" });
    return null;
  }
  const since = normalizeSince(value.since);
  if (since === null) {
    errors.push({ where: `${where}.since`, message: "生效时间无法解析，例如 2026-09-13 12:00" });
    return null;
  }
  const scope = typeof value.scope === "string" && value.scope.trim() !== "" ? value.scope.trim().toLowerCase() : null;
  if (scope === null) {
    errors.push({ where: `${where}.scope`, message: "必须指定模型（填 * 表示所有模型）" });
    return null;
  }
  const peak = normalizeRateBlock(value.peak, `${where}.peak`, errors);
  const offPeak = normalizeRateBlock(value.offPeak, `${where}.offPeak`, errors);
  if (peak === null || offPeak === null) return null;
  const note = typeof value.note === "string" ? value.note.slice(0, 200) : "";
  const id = typeof value.id === "string" && value.id.trim() !== "" ? value.id.trim() : newEntryId();
  const now = Date.now();
  const createdAt = typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : now;
  return { id, since, scope, peak, offPeak, note, createdAt, updatedAt: now };
}

/** 解析文件文本 → 快照（永不抛错）。 */
export function parseSnapshot(text, snapshotPath, exists) {
  const errors = [];
  const snapshot = { path: snapshotPath, exists: exists === true, updatedAt: null, config: defaultConfig(), entries: [], errors };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    errors.push({ where: "(文件)", message: `不是合法 JSON：${error instanceof Error ? error.message : String(error)}` });
    return snapshot;
  }
  if (!isPlainObject(parsed)) {
    errors.push({ where: "(文件)", message: "顶层必须是对象" });
    return snapshot;
  }
  snapshot.config = normalizeConfig(parsed.config, errors);
  snapshot.updatedAt = typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : null;
  const rawEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
  const seen = new Set();
  for (let i = 0; i < rawEntries.length; i++) {
    const entry = normalizeEntry(rawEntries[i], `entries[${i}]`, errors);
    if (entry === null) continue;
    if (seen.has(entry.id)) {
      errors.push({ where: `entries[${i}].id`, message: `id 重复：${entry.id}` });
      continue;
    }
    seen.add(entry.id);
    snapshot.entries.push(entry);
  }
  snapshot.entries.sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
  return snapshot;
}

let cache = { key: null, at: 0, snapshot: null };

/** 读快照（按 mtime+size 缓存；文件不存在也算正常状态，回退官方表）。 */
export function readSnapshot(options) {
  const force = options?.force === true;
  const file = pricingFilePath();
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    stat = null;
  }
  const key = stat === null ? `${file}|missing` : `${file}|${stat.mtimeMs}|${stat.size}`;
  const now = Date.now();
  if (!force && cache.snapshot !== null && cache.key === key && now - cache.at < READ_THROTTLE_MS) return cache.snapshot;
  if (stat === null) {
    const snapshot = emptySnapshot();
    cache = { key, at: now, snapshot };
    return snapshot;
  }
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    const snapshot = emptySnapshot();
    snapshot.exists = true;
    snapshot.errors.push({ where: "(文件)", message: `读取失败：${error instanceof Error ? error.message : String(error)}` });
    cache = { key, at: now, snapshot };
    return snapshot;
  }
  const snapshot = parseSnapshot(text, file, true);
  cache = { key, at: now, snapshot };
  return snapshot;
}

/** 写快照（原子写：先写 .tmp 再改名），成功后清缓存。 */
export function writeSnapshotEntries(entries, config) {
  const file = pricingFilePath();
  const payload = {
    version: SCHEMA_VERSION,
    updatedAt: Date.now(),
    config,
    entries: entries.map((entry) => ({
      id: entry.id,
      since: entry.since,
      scope: entry.scope,
      peak: entry.peak,
      offPeak: entry.offPeak,
      note: entry.note,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt
    }))
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  cache = { key: null, at: 0, snapshot: null };
  return readSnapshot({ force: true });
}

/** 生效时刻的峰谷判定（遵循用户配置的时段与「周末全天闲时」）。 */
export function isPeakAt(timeMs, config) {
  if (config.weekendOffPeak === true && isWeekend(timeMs, config.timezone)) return false;
  return isPeak(timeMs, config.timezone, config.peakWindows);
}

/** 找出该时刻命中的自定义条目（模型精确匹配优先，其次 `*`；同类取 since 最新）。 */
export function findUserEntry(entries, model, timeMs) {
  let exact = null;
  let wildcard = null;
  for (const entry of entries) {
    const since = Date.parse(entry.since);
    if (!Number.isFinite(since) || timeMs < since) continue;
    if (entry.scope === model) {
      if (exact === null || since >= Date.parse(exact.since)) exact = entry;
    } else if (entry.scope === "*") {
      if (wildcard === null || since >= Date.parse(wildcard.since)) wildcard = entry;
    }
  }
  return exact ?? wildcard;
}

/** 先查自定义价、再回退官方表的单价查询（CNY 用自定义，USD 沿用官方）。 */
export function priceAtWithUser(model, timeMs, snapshot) {
  const config = snapshot?.config ?? defaultConfig();
  const official = priceAt(model, timeMs, { timezone: config.timezone, peakWindows: config.peakWindows });
  const entry = findUserEntry(snapshot?.entries ?? [], model, timeMs);
  if (entry === null) return official;
  const peak = isPeakAt(timeMs, config);
  const table = peak ? entry.peak : entry.offPeak;
  return {
    cny: { ...official.cny, ...table },
    usd: official.usd,
    mode: peak ? "peak" : "offPeak",
    policy: { since: entry.since, label: entry.note === "" ? "自定义价" : entry.note, user: true, id: entry.id }
  };
}

/** 0.1.5 模型菜单里真正能选到的模型（旧名 deepseek-chat / deepseek-reasoner 已选不到）。 */
const ACTIVE_MODELS = ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"];

/** 官方价表里点名过的模型（给界面做下拉）。 */
function officialModelNames() {
  const names = new Set();
  for (const policy of OFFICIAL_PRICING_POLICIES) {
    for (const table of [policy.peak, policy.offPeak, policy.prices]) {
      if (!isPlainObject(table)) continue;
      for (const key of Object.keys(table)) {
        if (key !== "*") names.add(key);
      }
    }
  }
  return names;
}

/** 某条官方政策**显式点名**某模型时的两档 CNY 单价；没点名返回 null（= 沿用更早的政策）。 */
function namedRatesFor(policy, model) {
  const flat = isPlainObject(policy.prices) ? policy.prices[model] : void 0;
  if (flat !== void 0) return { peak: flat.cny, offPeak: flat.cny };
  const peakRow = isPlainObject(policy.peak) ? policy.peak[model] : void 0;
  const offRow = isPlainObject(policy.offPeak) ? policy.offPeak[model] : void 0;
  if (peakRow === void 0 && offRow === void 0) return null;
  return {
    peak: peakRow === void 0 ? null : peakRow.cny,
    offPeak: offRow === void 0 ? null : offRow.cny
  };
}

/**
 * 界面用的完整状态：当前生效价 + 我的调价记录 + 官方价表（历史）。
 *
 * 历史价表只发**政策显式点名的模型**（`named`）与 `*` 通用价（`fallback`），
 * 其余模型进 `inherited`（沿用更早政策）。此前把 `*` 兜底摊平到每个模型，
 * 会让"没被点名的模型"显示成通用价 —— 例如 deepseek-v4-pro 在 09-10 政策后
 * 实际沿用 08-23 的 9 / 0.3 / 27，却被显示成 2 / 0.04 / 8（计价引擎本身是对的，
 * 只有这层展示错了）。
 */
export function describePricing(snapshot, timeMs) {
  const at = typeof timeMs === "number" ? timeMs : Date.now();
  // 只关心"你现在能用的模型"：0.1.5 的模型菜单就这 4 个（deepseek-chat / deepseek-reasoner
  // 是 2025 年的老名字，菜单里选不到，别让它们污染"现在生效的价"和历史列表）。
  const models = new Set(ACTIVE_MODELS);
  for (const entry of snapshot.entries) {
    if (entry.scope !== "*") models.add(entry.scope);
  }
  const sortedModels = [...models].sort();
  const rows = {};
  for (const model of sortedModels) {
    const unit = priceAtWithUser(model, at, snapshot);
    rows[model] = {
      source: unit.policy.user === true ? "user" : "official",
      mode: unit.mode,
      since: unit.policy.since,
      label: unit.policy.label,
      id: unit.policy.id ?? null,
      cny: unit.cny
    };
  }
  const official = [];
  for (const policy of OFFICIAL_PRICING_POLICIES) {
    const named = [];
    const inherited = [];
    for (const model of sortedModels) {
      const rates = namedRatesFor(policy, model);
      if (rates === null) inherited.push(model);
      else named.push({ model, peak: rates.peak, offPeak: rates.offPeak });
    }
    // 没点名任何"你在用的模型"的政策不进列表（例：2025-02-09 那条只点名
    // deepseek-chat / deepseek-reasoner，对当前模型零影响）。
    if (named.length === 0) continue;
    official.push({
      since: policy.since,
      label: policy.label,
      weekendOffPeak: policy.weekendOffPeak === true,
      flat: isPlainObject(policy.prices),
      named,
      inherited,
      fallback: namedRatesFor(policy, "*")
    });
  }
  return {
    ok: true,
    path: snapshot.path,
    exists: snapshot.exists,
    updatedAt: snapshot.updatedAt,
    config: snapshot.config,
    errors: snapshot.errors,
    models: sortedModels,
    now: { at, mode: isPeakAt(at, snapshot.config) ? "peak" : "offPeak", rows },
    entries: snapshot.entries,
    official
  };
}

/** 会话根目录（`$DSH_HOME/sessions`；可用 DSH_BILLING_SESSIONS_ROOT 覆盖，供测试）。 */
export function sessionsRoot() {
  const explicit = process.env.DSH_BILLING_SESSIONS_ROOT;
  if (typeof explicit === "string" && explicit.trim() !== "") return explicit;
  return path.join(path.dirname(pricingFilePath()), "sessions");
}

/** 会话目录是两级分片：sessions/<xx>/<session-id>/ */
function listSessionIds(root) {
  const ids = [];
  let level1;
  try {
    level1 = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return ids;
  }
  for (const a of level1) {
    if (!a.isDirectory()) continue;
    let level2;
    try {
      level2 = fs.readdirSync(path.join(root, a.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const b of level2) {
      if (b.isDirectory() && b.name.startsWith("session-")) ids.push(b.name);
    }
  }
  return ids;
}

/**
 * 统计"每档官方价你实际用了多少"：扫全部会话，把每次 assistant/message 按**当时生效的政策**归类。
 * 只读；单次扫描约几秒（70+ 会话 / 4000+ 次调用），因此走后台 + 缓存，接口不阻塞。
 */
export async function scanUsageByPolicy(persistence, snapshot) {
  const root = sessionsRoot();
  const ids = listSessionIds(root);
  const buckets = new Map();
  let calls = 0;
  let totalCost = 0;
  let read = 0;
  let failed = 0;
  let first = Infinity;
  let last = -Infinity;
  for (const id of ids) {
    let events;
    try {
      const handle = await persistence.open(id, "read");
      try {
        ({ events } = await handle.read());
      } finally {
        try {
          await handle.close();
        } catch {}
      }
      read += 1;
    } catch {
      failed += 1;
      continue;
    }
    for (const event of events) {
      if (event?.type !== "assistant/message") continue;
      const usage = event.data?.usage;
      if (usage === void 0 || usage === null) continue;
      if (typeof usage.outputTokens !== "number" && typeof usage.inputTokens !== "number") continue;
      const rawModel = typeof event.data?.message?.source?.model === "string" ? event.data.message.source.model : "unknown";
      const model = rawModel.split("/").pop().toLowerCase();
      const timeMs = event.time ?? Date.now();
      const unit = priceAtWithUser(model, timeMs, snapshot);
      const sample = costOf(usage, unit);
      const key = unit.policy.since;
      const bucket = buckets.get(key) ?? {
        since: key,
        label: unit.policy.label,
        user: unit.policy.user === true,
        calls: 0,
        cost: 0,
        first: Infinity,
        last: -Infinity,
        models: new Map()
      };
      bucket.calls += 1;
      bucket.cost += sample.cost;
      bucket.first = Math.min(bucket.first, timeMs);
      bucket.last = Math.max(bucket.last, timeMs);
      bucket.models.set(model, (bucket.models.get(model) ?? 0) + 1);
      buckets.set(key, bucket);
      calls += 1;
      totalCost += sample.cost;
      first = Math.min(first, timeMs);
      last = Math.max(last, timeMs);
    }
  }
  return {
    scannedAt: Date.now(),
    sessions: ids.length,
    read,
    failed,
    calls,
    totalCost,
    first: calls > 0 ? first : null,
    last: calls > 0 ? last : null,
    buckets: [...buckets.values()]
      .sort((a, b) => a.first - b.first)
      .map((bucket) => ({
        since: bucket.since,
        label: bucket.label,
        user: bucket.user,
        calls: bucket.calls,
        cost: bucket.cost,
        first: bucket.first,
        last: bucket.last,
        models: Object.fromEntries(bucket.models)
      }))
  };
}

const usageCache = { at: 0, running: false, result: null };
/** 缓存 10 分钟；面板打开时若过期就后台重扫（不阻塞响应）。 */
const USAGE_TTL_MS = 10 * 60 * 1000;

/** 当前缓存状态（接口用）。 */
export function usageCacheState() {
  return { at: usageCache.at, running: usageCache.running, result: usageCache.result, fresh: usageCache.result !== null && Date.now() - usageCache.at < USAGE_TTL_MS };
}

/** 需要时在后台触发一次重扫（同一时刻只跑一个）。 */
export function refreshUsage(persistence, snapshot) {
  if (usageCache.running) return;
  if (usageCache.result !== null && Date.now() - usageCache.at < USAGE_TTL_MS) return;
  usageCache.running = true;
  scanUsageByPolicy(persistence, snapshot)
    .then((result) => {
      usageCache.result = result;
      usageCache.at = Date.now();
    })
    .catch(() => {})
    .finally(() => {
      usageCache.running = false;
    });
}

/** 增/改一条自定义价。 */
export function upsertEntry(input) {
  const snapshot = readSnapshot({ force: true });
  const errors = [];
  const entry = normalizeEntry(input, "(提交)", errors);
  if (entry === null) return { ok: false, error: errors[0]?.message ?? "条目不合法", errors };
  const replaced = snapshot.entries.find((existing) => existing.id === entry.id);
  if (replaced !== void 0) entry.createdAt = replaced.createdAt;
  const entries = snapshot.entries.filter((existing) => existing.id !== entry.id);
  entries.push(entry);
  entries.sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
  const next = writeSnapshotEntries(entries, snapshot.config);
  return { ok: true, entry, state: describePricing(next) };
}

/** 删一条自定义价。 */
export function deleteEntry(id) {
  const snapshot = readSnapshot({ force: true });
  const entries = snapshot.entries.filter((entry) => entry.id !== id);
  if (entries.length === snapshot.entries.length) return { ok: false, error: "没找到这条记录" };
  const next = writeSnapshotEntries(entries, snapshot.config);
  return { ok: true, state: describePricing(next) };
}

/** 改全局设置（高峰时段 / 周末全天闲时）。 */
export function updateConfig(patch) {
  const snapshot = readSnapshot({ force: true });
  const errors = [];
  const config = normalizeConfig({ ...snapshot.config, ...(isPlainObject(patch) ? patch : {}) }, errors);
  const next = writeSnapshotEntries(snapshot.entries, config);
  return { ok: true, state: describePricing(next), errors };
}
