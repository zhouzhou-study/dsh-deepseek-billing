// dsh-deepseek-billing — browser half.
//
// 1. Under the last assistant message of each turn: that turn's combined
//    cost + tokens (one badge per turn, no spam).
// 2. Header button: live DeepSeek balance + this conversation's cost; opens
//    a per-turn/per-request cost panel (subagent sessions included).
// 3. A pricing-settings panel: maintain your own peak / off-peak rates, kept
//    alongside (and falling back to) the built-in official price table.
window.__ModuleLoader__.load({
  id: "dsh-deepseek-billing",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var h = React.createElement;
    var Fragment = React.Fragment;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;

    var BALANCE_PATH = "/api/dsh-deepseek-billing/balance";
    var REQUESTS_PATH = "/api/dsh-deepseek-billing/requests";
    var SESSION_COST_PATH = "/api/dsh-deepseek-billing/session-cost";
    var PRICING_PATH = "/api/dsh-deepseek-billing/pricing";
    var BALANCE_POLL_MS = 60 * 1000;
    var REQUESTS_POLL_MS = 5 * 1000;
    var HEADER_POLL_MS = 15 * 1000;

    function fmtMoney(value, currency) {
      var symbol = currency === "USD" ? "$" : "¥";
      var n = Number.isFinite(value) ? value : 0;
      var abs = Math.abs(n);
      var digits = abs > 0 && abs < 0.01 ? 4 : 2;
      return symbol + n.toFixed(digits);
    }

    function fmtTokens(n) {
      var v = Number.isFinite(n) ? n : 0;
      if (v >= 1e8) return (v / 1e8).toFixed(v < 1e9 ? 2 : 1) + "亿";
      if (v >= 1e4) return (v / 1e4).toFixed(v < 1e5 ? 1 : 0) + "万";
      return String(Math.round(v));
    }

    async function fetchJson(url) {
      var res = await fetch(url, { cache: "no-store" });
      var body = null;
      try { body = await res.json(); } catch (e) {}
      if (!res.ok) {
        var msg = body && typeof body.message === "string" ? body.message : "HTTP " + res.status;
        throw new Error(msg);
      }
      return body;
    }

    // ---- per-request cost badge -----------------------------------------
    function RequestCostBadge(props) {
      var messageId = props.messageId;
      var sessionId = props.sessionId;
      var [requests, setRequests] = useState(null);
      var [error, setError] = useState("");

      useEffect(function () {
        if (sessionId === void 0) return;
        var cancelled = false;
        var load = async function () {
          try {
            var body = await fetchJson(REQUESTS_PATH + "?sessionId=" + encodeURIComponent(sessionId));
            if (!cancelled) {
              setRequests(Array.isArray(body.requests) ? body.requests : []);
              setError("");
            }
          } catch (err) {
            if (!cancelled) {
              setRequests([]);
              setError(err instanceof Error ? err.message : String(err));
            }
          }
        };
        load();
        var timer = setInterval(load, REQUESTS_POLL_MS);
        return function () { cancelled = true; clearInterval(timer); };
      }, [sessionId]);

      var rec = null;
      if (requests !== null && messageId !== void 0) {
        for (var i = 0; i < requests.length; i++) {
          if (requests[i].messageId === messageId && (requests[i].sessionId === sessionId || requests[i].sessionId === void 0)) { rec = requests[i]; break; }
        }
      }

      if (error) {
        return h("span", {
          title: error,
          style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 11, lineHeight: "16px", whiteSpace: "nowrap" }
        }, "计费错误");
      }

      if (rec === null) {
        return null;
      }

      // 只在该轮最后一条消息下面显示“本轮合计”，避免每一步都重复显示。
      var turn = rec.turn || 0;
      var maxStep = 0;
      var roundCost = 0;
      var roundTokens = 0;
      var roundInput = 0;
      var roundOutput = 0;
      for (var ri = 0; ri < requests.length; ri++) {
        var rr = requests[ri];
        if ((rr.sessionId === sessionId || rr.sessionId === void 0) && (rr.turn || 0) === turn) {
          if ((rr.step || 0) > maxStep) maxStep = rr.step || 0;
          roundCost += rr.cost || 0;
          roundTokens += rr.totalTokens || 0;
          roundInput += (rr.inputTokens || 0) + (rr.cacheReadTokens || 0) + (rr.cacheWriteTokens || 0);
          roundOutput += rr.outputTokens || 0;
        }
      }
      if ((rec.step || 0) !== maxStep) {
        return null;
      }

      var currency = "CNY";
      var text = fmtMoney(roundCost, currency) + " · " + fmtTokens(roundTokens) + " tok";
      return h("span", {
        title: "本轮合计：" + fmtTokens(roundInput) + " 输入 / " + fmtTokens(roundOutput) + " 输出 / " + fmtTokens(roundTokens) + " tokens",
        style: {
          color: "var(--dsw-alias-label-secondary)",
          fontSize: 11,
          lineHeight: "16px",
          whiteSpace: "nowrap",
          fontVariantNumeric: "tabular-nums",
          cursor: "help"
        }
      }, text);
    }

    // ---- shared balance fetch helper ------------------------------------
    function parseBalance(body) {
      var payload = body && typeof body === "object" && body.balance ? body.balance : body;
      var info = payload && Array.isArray(payload.balance_infos) ? payload.balance_infos[0] : null;
      var rawBalance = info && info.total_balance !== void 0 ? info.total_balance : null;
      var balanceNum = rawBalance === null ? null : Number(rawBalance);
      return {
        balance: balanceNum !== null && Number.isFinite(balanceNum) ? balanceNum : null,
        currency: info && typeof info.currency === "string" ? info.currency : "CNY"
      };
    }

    // Collect this session and all descendant subagent session ids (client fallback).
    function collectSessionIds(items, rootId) {
      var result = [rootId];
      var queue = [rootId];
      while (queue.length > 0) {
        var parent = queue.shift();
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          if (item && item.parentSessionId === parent) {
            result.push(item.sessionId);
            queue.push(item.sessionId);
          }
        }
      }
      return result;
    }

    // Client-side instant estimate using DSH's already-loaded token projections.
    function collectSessionIdsFromById(byId, rootId) {
      var result = [rootId];
      var queue = [rootId];
      while (queue.length > 0) {
        var parent = queue.shift();
        for (var key in byId) {
          if (Object.prototype.hasOwnProperty.call(byId, key) && byId[key] && byId[key].parentId === parent) {
            result.push(key);
            queue.push(key);
          }
        }
      }
      return result;
    }

    function beijingHour(date) {
      try {
        var parts = new Intl.DateTimeFormat("en-US", {
          timeZone: "Asia/Shanghai",
          hour12: false,
          hour: "numeric",
          minute: "numeric"
        }).formatToParts(date);
        return Number(parts.find(function (p) { return p.type === "hour"; })?.value ?? "0") % 24;
      } catch (e) {
        return date.getHours();
      }
    }

    function beijingWeekend(date) {
      try {
        var parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "short" }).formatToParts(date);
        var w = parts.find(function (p) { return p.type === "weekday"; })?.value ?? "";
        return w === "Sat" || w === "Sun";
      } catch (e) {
        return false;
      }
    }

    function isPeakNow(date) {
      // 2026-08-23 起周末全天闲时；即时估算只看当前时刻，无需日期门槛。
      if (beijingWeekend(date || new Date())) return false;
      var h = beijingHour(date || new Date());
      return (h >= 9 && h < 12) || (h >= 14 && h < 18);
    }

    function estimateCostFromUsage(usage, rates) {
      if (!usage || typeof usage !== "object") return 0;
      var peak = isPeakNow();
      // 兜底常量 = 官方当前价（Flash 闲时 1/0.02/4、高峰 2/0.04/8）；
      // 服务端下发了当前生效价时优先用它（含你在面板里改的价）。
      // 注意：不再给 reasoningTokens 单独加钱 —— 它已含在 outputTokens 里。
      var inputRate = peak ? 2 : 1;
      var cacheReadRate = peak ? 0.04 : 0.02;
      var outputRate = peak ? 8 : 4;
      if (rates && typeof rates === "object") {
        if (Number.isFinite(rates.input)) inputRate = rates.input;
        if (Number.isFinite(rates.cacheRead)) cacheReadRate = rates.cacheRead;
        if (Number.isFinite(rates.output)) outputRate = rates.output;
      }
      var input = (usage.uncachedInputTokens || 0) + (usage.cacheWriteTokens || 0);
      var cacheRead = usage.cacheReadTokens || 0;
      var output = usage.outputTokens || 0;
      return (input * inputRate + cacheRead * cacheReadRate + output * outputRate) / 1e6;
    }

    function tabButtonStyle(active) {
      return {
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "transparent",
        color: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-tertiary)",
        fontWeight: active ? 600 : 400,
        borderRadius: 999,
        padding: "2px 10px",
        fontSize: 11,
        lineHeight: "18px",
        cursor: "pointer",
        fontFamily: "inherit"
      };
    }

    // ---- pricing settings UI ---------------------------------------------
    // 纯展示层（PricingBody）与取数层（PricingSettings）分开：纯展示层可以在
    // 没有浏览器的情况下被直接渲染测试，取数层只管请求与状态。
    var FIELD_STYLE = {
      boxSizing: "border-box",
      width: "100%",
      border: "1px solid var(--dsw-alias-border-l2)",
      borderRadius: 6,
      background: "transparent",
      color: "var(--dsw-alias-label-primary)",
      fontFamily: "inherit",
      fontSize: 11,
      lineHeight: "18px",
      padding: "2px 6px"
    };
    var TINY_BUTTON_STYLE = {
      border: "1px solid var(--dsw-alias-border-l2)",
      background: "transparent",
      color: "var(--dsw-alias-label-primary)",
      borderRadius: 6,
      padding: "2px 8px",
      fontSize: 11,
      lineHeight: "18px",
      cursor: "pointer",
      fontFamily: "inherit",
      whiteSpace: "nowrap"
    };
    var MUTED = { color: "var(--dsw-alias-label-tertiary)", fontSize: 11, lineHeight: "16px" };
    var SECTION_TITLE = { fontWeight: 600, fontSize: 12, margin: "8px 0 4px", color: "var(--dsw-alias-label-primary)" };
    var BADGE_STYLE = { fontSize: 10, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 999, padding: "0 5px", color: "var(--dsw-alias-label-secondary)", whiteSpace: "nowrap" };
    var RATES_STYLE = { fontSize: 11, lineHeight: "16px", fontVariantNumeric: "tabular-nums" };

    /** 把价格相同的模型合并成一组，避免同一串数字刷一屏。 */
    function groupByRates(items) {
      var groups = [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var key = JSON.stringify([item.peak, item.offPeak]);
        var hit = null;
        for (var j = 0; j < groups.length; j++) {
          if (groups[j].key === key) { hit = groups[j]; break; }
        }
        if (hit === null) groups.push({ key: key, models: [item.model], peak: item.peak, offPeak: item.offPeak });
        else hit.models.push(item.model);
      }
      return groups;
    }

    function fmtRate(n) {
      if (typeof n !== "number" || !Number.isFinite(n)) return "-";
      var text = n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
      return text === "" ? "0" : text;
    }

    function fmtTriple(rates) {
      if (!rates) return "-";
      return fmtRate(rates.input) + " / " + fmtRate(rates.cacheRead) + " / " + fmtRate(rates.output);
    }

    function fmtSince(since) {
      if (typeof since !== "string") return "-";
      var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(since);
      return m === null ? since : m[1] + "-" + m[2] + "-" + m[3] + " " + m[4] + ":" + m[5];
    }

    function pad2(n) { return (n < 10 ? "0" : "") + String(n); }

    /** 现在的北京时间，写成 <input type="datetime-local"> 需要的字面量。 */
    function nowInputValue() {
      try {
        var parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Shanghai",
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", hour12: false
        }).formatToParts(new Date());
        var get = function (type) {
          for (var i = 0; i < parts.length; i++) { if (parts[i].type === type) return parts[i].value; }
          return "00";
        };
        return get("year") + "-" + get("month") + "-" + get("day") + "T" + get("hour") + ":" + get("minute");
      } catch (e) {
        var d = new Date();
        return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
      }
    }

    /** 把已存的 since 还原成输入框字面量（本地时间部分）。 */
    function sinceToInput(since) {
      if (typeof since !== "string") return nowInputValue();
      var m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(since);
      return m === null ? nowInputValue() : m[1] + "T" + m[2];
    }

    /** 高峰时段文本 <-> 数组：`9-12, 14-18`。 */
    function parsePeakWindows(text) {
      var out = [];
      var chunks = String(text === void 0 || text === null ? "" : text).split(/[,，、\s]+/);
      for (var i = 0; i < chunks.length; i++) {
        var chunk = chunks[i];
        if (chunk === "") continue;
        var m = /^(\d{1,2})\s*[-~到]\s*(\d{1,2})$/.exec(chunk);
        if (m === null) return null;
        var start = Number(m[1]);
        var end = Number(m[2]);
        if (!(start >= 0 && start <= 24 && end >= 0 && end <= 24 && start < end)) return null;
        out.push([start, end]);
      }
      return out.length > 0 ? out : null;
    }

    function formatPeakWindows(windows) {
      if (!Array.isArray(windows)) return "";
      return windows.map(function (pair) { return pair[0] + "-" + pair[1]; }).join(", ");
    }

    /** 表单草稿 -> 提交给服务端的条目（数字字符串由服务端转数字，已单测覆盖）。 */
    function buildEntryPayload(draft) {
      var payload = {
        since: typeof draft.since === "string" ? draft.since.trim() : "",
        scope: typeof draft.scope === "string" ? draft.scope.trim() : "",
        peak: { input: draft.peak.input, cacheRead: draft.peak.cacheRead, output: draft.peak.output },
        offPeak: { input: draft.offPeak.input, cacheRead: draft.offPeak.cacheRead, output: draft.offPeak.output },
        note: typeof draft.note === "string" ? draft.note : ""
      };
      if (typeof draft.id === "string" && draft.id !== "") payload.id = draft.id;
      return payload;
    }

    /** 官方价表里最新一条政策在某模型上的两档价（用于"照官方价填一遍"）。 */
    function latestOfficialRates(state, scope) {
      if (state === null || !Array.isArray(state.official) || state.official.length === 0) return null;
      for (var i = state.official.length - 1; i >= 0; i--) {
        var row = state.official[i];
        var entry = row.prices ? row.prices[scope] : null;
        if (entry && entry.peak && entry.offPeak) return entry;
      }
      return null;
    }

    function RateInputs(props) {
      var value = props.value;
      var fields = [["input", "输入"], ["cacheRead", "缓存命中"], ["output", "输出"]];
      return h("div", { style: { display: "flex", gap: 6 } }, fields.map(function (field) {
        var key = field[0];
        return h("label", { key: key, style: { flex: 1, display: "flex", flexDirection: "column", gap: 2, fontSize: 10, color: "var(--dsw-alias-label-tertiary)" } },
          field[1],
          h("input", {
            type: "text",
            inputMode: "decimal",
            value: value[key] === void 0 || value[key] === null ? "" : String(value[key]),
            onChange: function (event) {
              var next = Object.assign({}, value);
              next[key] = event.target.value;
              props.onChange(next);
            },
            style: FIELD_STYLE
          })
        );
      }));
    }

    function ModelSelect(props) {
      var models = [];
      var seen = {};
      var list = props.models || [];
      for (var i = 0; i < list.length; i++) {
        if (!seen[list[i]]) { seen[list[i]] = true; models.push(list[i]); }
      }
      if (!seen["*"]) models.unshift("*");
      return h("select", {
        value: props.value,
        onChange: function (event) { props.onChange(event.target.value); },
        style: FIELD_STYLE
      }, models.map(function (model) {
        return h("option", { key: model, value: model }, model === "*" ? "*（所有模型）" : model);
      }));
    }

    /** 纯展示层：给定状态就渲染整块「价格设置」。 */
    function PricingBody(props) {
      var state = props.state;
      var ui = props.ui;
      var draft = props.draft;
      var on = props.on;
      var models = state === null || !Array.isArray(state.models) ? [] : state.models;
      var rows = [];

      if (state === null) {
        // 载入失败时必须说出来：服务端代码改动要重启 DSH 才加载，只改前端刷新页面即可。
        // （2026-09-13 修：此前这里无论如何都显示"载入价格表…"，失败时永远转圈。）
        if (ui.error) {
          return h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
            h("div", { style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 11, lineHeight: "16px" } },
              "读不到价格表：" + ui.error
            ),
            h("div", { style: MUTED },
              "如果是 404，说明后端还没重启（接口是重启时才载入的）；只改前端的话刷新页面就够。"
            ),
            h("button", { type: "button", style: TINY_BUTTON_STYLE, onClick: function () { on.retry(); } }, "重试")
          );
        }
        return h("div", { style: MUTED }, "载入价格表…");
      }

      // 1) 现在生效的价格（价格相同的模型并成一行）
      var nowRows = state.now && state.now.rows ? state.now.rows : {};
      var nowItems = Object.keys(nowRows).map(function (model) {
        var row = nowRows[model];
        return { model: model, peak: row.cny, offPeak: row.cny, source: row.source, mode: row.mode };
      });
      var nowGroups = groupByRates(nowItems);
      rows.push(h("div", { key: "now-title", style: SECTION_TITLE },
        "现在生效的价 · " + (state.now && state.now.mode === "peak" ? "高峰时段" : "闲时") + "（元/百万 token：输入 / 缓存命中 / 输出）"
      ));
      rows.push(h("div", { key: "now", style: { display: "flex", flexDirection: "column", gap: 4 } }, nowGroups.map(function (group, index) {
        var mine = group.models.some(function (model) { return nowRows[model] && nowRows[model].source === "user"; });
        var mode = group.mode !== void 0 ? group.mode : (nowRows[group.models[0]] ? nowRows[group.models[0]].mode : "offPeak");
        return h("div", { key: "now-" + index, style: { borderLeft: "2px solid var(--dsw-alias-border-l1)", paddingLeft: 6 } },
          h("div", { style: { display: "flex", alignItems: "center", gap: 4, fontSize: 11, lineHeight: "16px" } },
            h("span", { style: { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, group.models.join("、")),
            mine ? h("span", { style: BADGE_STYLE }, "含我的价") : null
          ),
          h("div", { style: { ...RATES_STYLE, color: "var(--dsw-alias-label-secondary)" } }, fmtTriple(group.peak))
        );
      })));

      // 2) 我的调价记录
      rows.push(h("div", { key: "mine-title", style: SECTION_TITLE }, "我的调价记录（" + state.entries.length + "）"));
      if (state.entries.length === 0) {
        rows.push(h("div", { key: "mine-empty", style: MUTED }, "还没有。下面新增一条，就能覆盖官方价。"));
      } else {
        rows.push(h("div", { key: "mine", style: { display: "flex", flexDirection: "column", gap: 4 } }, state.entries.map(function (entry) {
          return h("div", {
            key: entry.id,
            style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, padding: "4px 6px", display: "flex", flexDirection: "column", gap: 2 }
          },
            h("div", { style: { display: "flex", justifyContent: "space-between", gap: 6, fontSize: 11 } },
              h("span", { style: { fontWeight: 600 } }, fmtSince(entry.since) + " 起"),
              h("span", { style: MUTED }, entry.scope === "*" ? "所有模型" : entry.scope)
            ),
            h("div", { style: { ...MUTED, fontVariantNumeric: "tabular-nums" } },
              "高峰 " + fmtTriple(entry.peak) + "　闲时 " + fmtTriple(entry.offPeak)
            ),
            entry.note ? h("div", { style: MUTED }, entry.note) : null,
            h("div", { style: { display: "flex", gap: 6, marginTop: 2 } },
              h("button", { type: "button", style: TINY_BUTTON_STYLE, onClick: function () { on.edit(entry); } }, "编辑"),
              h("button", { type: "button", style: TINY_BUTTON_STYLE, onClick: function () { on.remove(entry.id); } }, "删除")
            )
          );
        })));
      }

      // 3) 新增/编辑表单
      rows.push(h("div", { key: "form-title", style: SECTION_TITLE },
        h("button", {
          type: "button",
          style: TINY_BUTTON_STYLE,
          onClick: function () { on.toggleForm(); }
        }, ui.showForm ? "收起新增表单" : "＋ 新增/修改一条调价")
      ));
      if (ui.showForm) {
        rows.push(h("div", {
          key: "form",
          style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, padding: "6px", display: "flex", flexDirection: "column", gap: 6 }
        },
          h("div", { style: { display: "flex", gap: 6 } },
            h("label", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 2, fontSize: 10, color: "var(--dsw-alias-label-tertiary)" } },
              "从什么时间开始（北京时间）",
              h("input", {
                type: "datetime-local",
                value: draft.since,
                onChange: function (event) { on.draft({ since: event.target.value }); },
                style: FIELD_STYLE
              })
            )
          ),
          h("label", { style: { display: "flex", flexDirection: "column", gap: 2, fontSize: 10, color: "var(--dsw-alias-label-tertiary)" } },
            "模型",
            h(ModelSelect, { models: models, value: draft.scope, onChange: function (scope) { on.draft({ scope: scope }); } })
          ),
          h("div", { style: { fontSize: 10, color: "var(--dsw-alias-label-tertiary)" } }, "高峰价"),
          h(RateInputs, { value: draft.peak, onChange: function (peak) { on.draft({ peak: peak }); } }),
          h("div", { style: { fontSize: 10, color: "var(--dsw-alias-label-tertiary)" } }, "闲时价"),
          h(RateInputs, { value: draft.offPeak, onChange: function (offPeak) { on.draft({ offPeak: offPeak }); } }),
          h("label", { style: { display: "flex", flexDirection: "column", gap: 2, fontSize: 10, color: "var(--dsw-alias-label-tertiary)" } },
            "备注（可空）",
            h("input", {
              type: "text",
              value: draft.note,
              onChange: function (event) { on.draft({ note: event.target.value }); },
              style: FIELD_STYLE
            })
          ),
          h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
            h("button", { type: "button", style: TINY_BUTTON_STYLE, onClick: function () { on.applyOfficial(); } }, "照官方最新价填一遍"),
            h("button", { type: "button", style: { ...TINY_BUTTON_STYLE, fontWeight: 600 }, onClick: function () { on.save(); } }, ui.busy ? "保存中…" : "保存"),
            h("button", { type: "button", style: TINY_BUTTON_STYLE, onClick: function () { on.cancel(); } }, "取消")
          ),
          h("div", { style: MUTED }, "生效时间填过去 = 连历史账单一起按新价重算；填未来 = 到点自动换价。")
        ));
      }

      // 4) 官方历史价（折叠）
      rows.push(h("div", { key: "hist-title", style: SECTION_TITLE },
        h("button", { type: "button", style: TINY_BUTTON_STYLE, onClick: function () { on.toggleHistory(); } },
          (ui.openHistory ? "▾ " : "▸ ") + "官方历史价（" + state.official.length + " 次调价）")
      ));
      if (ui.openHistory) {
        rows.push(h("div", { key: "hist", style: { display: "flex", flexDirection: "column", gap: 6 } }, state.official.map(function (policy, index) {
          var key = policy.since + ":" + index;
          var expanded = ui.expandedPolicy !== void 0 && ui.expandedPolicy[key] === true;
          // 新服务端只发"政策点名的模型"（named）+ 通用价（fallback）+ 沿用的模型；
          // 旧服务端（重启前）只有 prices，这里退回旧形状，靠分组把重复项并掉。
          var named = Array.isArray(policy.named)
            ? policy.named
            : Object.keys(policy.prices || {}).map(function (model) {
              return { model: model, peak: policy.prices[model].peak, offPeak: policy.prices[model].offPeak };
            });
          var groups = groupByRates(named);
          var inherited = Array.isArray(policy.inherited) ? policy.inherited : [];
          return h("div", { key: key, style: { borderLeft: "2px solid var(--dsw-alias-border-l1)", paddingLeft: 6 } },
            h("div", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 600, lineHeight: "16px", flexWrap: "wrap" } },
              h("span", null, fmtSince(policy.since) + " 起"),
              policy.weekendOffPeak ? h("span", { style: BADGE_STYLE }, "周末全天闲时") : null,
              policy.flat ? h("span", { style: BADGE_STYLE }, "统一价") : null
            ),
            h("div", {
              style: expanded ? { ...MUTED, cursor: "pointer" } : { ...MUTED, cursor: "pointer", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" },
              title: expanded ? "点击收起" : "点击看全文",
              onClick: function () { on.togglePolicy(key); }
            }, policy.label),
            groups.length > 0 ? h("div", { style: { marginTop: 2, display: "flex", flexDirection: "column", gap: 1 } }, groups.map(function (group, gi) {
              return h("div", { key: gi, style: { ...RATES_STYLE, color: "var(--dsw-alias-label-secondary)" } },
                h("span", { style: { color: "var(--dsw-alias-label-primary)" } }, group.models.join("、") + "　"),
                policy.flat ? fmtTriple(group.peak) : "高峰 " + fmtTriple(group.peak) + "　闲时 " + fmtTriple(group.offPeak)
              );
            })) : null,
            policy.fallback ? h("div", { style: { ...MUTED, fontVariantNumeric: "tabular-nums" } },
              "其他模型（通用价）　" + (policy.flat ? fmtTriple(policy.fallback.peak) : "高峰 " + fmtTriple(policy.fallback.peak) + "　闲时 " + fmtTriple(policy.fallback.offPeak))
            ) : null,
            inherited.length > 0 ? h("div", { style: MUTED }, "这次没调它：" + inherited.join("、")) : null
          );
        })));
      }

      // 5) 高级：高峰时段定义
      rows.push(h("div", { key: "adv-title", style: SECTION_TITLE },
        h("button", { type: "button", style: TINY_BUTTON_STYLE, onClick: function () { on.toggleAdvanced(); } },
          (ui.openAdvanced ? "▾ " : "▸ ") + "高级：高峰时段定义")
      ));
      if (ui.openAdvanced) {
        rows.push(h("div", { key: "adv", style: { display: "flex", flexDirection: "column", gap: 4, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, padding: 6 } },
          h("label", { style: { display: "flex", flexDirection: "column", gap: 2, fontSize: 10, color: "var(--dsw-alias-label-tertiary)" } },
            "高峰时段（例如 9-12, 14-18）",
            h("input", {
              type: "text",
              value: ui.advancedText,
              onChange: function (event) { on.advancedText(event.target.value); },
              style: FIELD_STYLE
            })
          ),
          h("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 11 } },
            h("input", {
              type: "checkbox",
              checked: ui.weekendOffPeak === true,
              onChange: function (event) { on.weekendOffPeak(event.target.checked); }
            }),
            "周六/周日全天按闲时价"
          ),
          h("div", { style: MUTED }, "这些规则只作用于「我的调价记录」里填的价；没自定义的模型永远按官方历史价算。"),
          h("div", null, h("button", { type: "button", style: TINY_BUTTON_STYLE, onClick: function () { on.saveAdvanced(); } }, "保存时段设置"))
        ));
      }

      // 6) 状态行
      if (ui.error) {
        rows.push(h("div", { key: "err", style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 11, marginTop: 6 } }, ui.error));
      }
      if (ui.notice) {
        rows.push(h("div", { key: "ok", style: { color: "var(--dsw-alias-label-secondary)", fontSize: 11, marginTop: 6 } }, ui.notice));
      }
      if (Array.isArray(state.errors) && state.errors.length > 0) {
        rows.push(h("div", { key: "parse-errors", style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 11, marginTop: 6 } },
          "配置文件里有 " + state.errors.length + " 处问题（已跳过，不影响计价）：",
          state.errors.map(function (item, index) { return h("div", { key: index }, "· " + item.where + "：" + item.message); })
        ));
      }

      return h("div", { style: { display: "flex", flexDirection: "column" } }, rows);
    }

    /** 取数层：拉状态、提交改动。 */
    function PricingSettings() {
      var [state, setState] = useState(null);
      var [error, setError] = useState("");
      var [notice, setNotice] = useState("");
      var [busy, setBusy] = useState(false);
      var [showForm, setShowForm] = useState(false);
      var [openHistory, setOpenHistory] = useState(false);
      var [openAdvanced, setOpenAdvanced] = useState(false);
      var [expandedPolicy, setExpandedPolicy] = useState({});
      var [advancedText, setAdvancedText] = useState("");
      var [weekendOffPeak, setWeekendOffPeak] = useState(true);
      var [draft, setDraft] = useState({
        id: "",
        since: "",
        scope: "deepseek-flash",
        peak: { input: "", cacheRead: "", output: "" },
        offPeak: { input: "", cacheRead: "", output: "" },
        note: ""
      });

      function adopt(next) {
        setState(next);
        if (next && next.config) {
          setAdvancedText(formatPeakWindows(next.config.peakWindows));
          setWeekendOffPeak(next.config.weekendOffPeak === true);
        }
      }

      async function load() {
        try {
          var body = await fetchJson(PRICING_PATH);
          adopt(body);
          setError("");
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }

      useEffect(function () {
        var cancelled = false;
        (async function () {
          try {
            var body = await fetchJson(PRICING_PATH);
            if (!cancelled) { adopt(body); setError(""); }
          } catch (err) {
            if (!cancelled) setError(err instanceof Error ? err.message : String(err));
          }
        })();
        return function () { cancelled = true; };
      }, []);

      async function post(payload) {
        setBusy(true);
        setError("");
        setNotice("");
        try {
          var res = await fetch(PRICING_PATH, {
            method: "POST",
            headers: { "content-type": "application/json" },
            cache: "no-store",
            body: JSON.stringify(payload)
          });
          var body = null;
          try { body = await res.json(); } catch (e) {}
          if (!res.ok || body === null || body.ok !== true) {
            throw new Error(body && typeof body.message === "string" ? body.message : "HTTP " + res.status);
          }
          adopt(body);
          return body;
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          return null;
        } finally {
          setBusy(false);
        }
      }

      function blankDraft(scope) {
        return {
          id: "",
          since: nowInputValue(),
          scope: scope === void 0 ? "deepseek-flash" : scope,
          peak: { input: "", cacheRead: "", output: "" },
          offPeak: { input: "", cacheRead: "", output: "" },
          note: ""
        };
      }

      function applyOfficialRates(target) {
        var scope = target.scope === "*" ? "deepseek-flash" : target.scope;
        var entry = latestOfficialRates(state, scope);
        if (entry === null) return target;
        function fill(rates) {
          return { input: fmtRate(rates.input), cacheRead: fmtRate(rates.cacheRead), output: fmtRate(rates.output) };
        }
        return Object.assign({}, target, { peak: fill(entry.peak), offPeak: fill(entry.offPeak) });
      }

      var handlers = {
        retry: function () { setNotice(""); load(); },
        togglePolicy: function (key) {
          setExpandedPolicy(function (prev) {
            var next = Object.assign({}, prev);
            if (next[key]) delete next[key]; else next[key] = true;
            return next;
          });
        },
        toggleForm: function () {
          setNotice("");
          setError("");
          setShowForm(function (prev) {
            if (prev) return false;
            setDraft(function (prevDraft) { return applyOfficialRates(blankDraft(prevDraft.scope)); });
            return true;
          });
        },
        toggleHistory: function () { setOpenHistory(function (prev) { return !prev; }); },
        toggleAdvanced: function () { setOpenAdvanced(function (prev) { return !prev; }); },
        draft: function (patch) { setDraft(function (prev) { return Object.assign({}, prev, patch); }); },
        advancedText: function (text) { setAdvancedText(text); },
        weekendOffPeak: function (value) { setWeekendOffPeak(value === true); },
        applyOfficial: function () {
          setDraft(function (prev) { return applyOfficialRates(prev); });
          setNotice("已按官方最新价填入，改完点保存");
        },
        cancel: function () { setShowForm(false); setNotice(""); setError(""); },
        edit: function (entry) {
          setDraft({
            id: entry.id,
            since: sinceToInput(entry.since),
            scope: entry.scope,
            peak: { input: fmtRate(entry.peak.input), cacheRead: fmtRate(entry.peak.cacheRead), output: fmtRate(entry.peak.output) },
            offPeak: { input: fmtRate(entry.offPeak.input), cacheRead: fmtRate(entry.offPeak.cacheRead), output: fmtRate(entry.offPeak.output) },
            note: entry.note || ""
          });
          setShowForm(true);
          setNotice("正在修改这条记录，改完点保存");
          setError("");
        },
        save: async function () {
          var saved = await post({ action: "upsert", entry: buildEntryPayload(draft) });
          if (saved !== null) { setNotice("已保存并立即生效（费用重算不需要重启）"); setShowForm(false); }
        },
        remove: async function (id) {
          var removed = await post({ action: "delete", id: id });
          if (removed !== null) setNotice("已删除这条记录");
        },
        saveAdvanced: async function () {
          var windows = parsePeakWindows(advancedText);
          if (windows === null) {
            setError("高峰时段格式不对，写成 9-12, 14-18 这样");
            return;
          }
          var saved = await post({ action: "config", config: { peakWindows: windows, weekendOffPeak: weekendOffPeak } });
          if (saved !== null) setNotice("时段设置已保存");
        }
      };

      return h(PricingBody, {
        state: state,
        ui: {
          showForm: showForm,
          openHistory: openHistory,
          openAdvanced: openAdvanced,
          expandedPolicy: expandedPolicy,
          advancedText: advancedText,
          weekendOffPeak: weekendOffPeak,
          busy: busy,
          error: error,
          notice: notice
        },
        draft: draft,
        on: handlers
      });
    }

    // ---- header button + per-request panel ------------------------------
    function ConversationCostButton(props) {
      var sessionId = props.sessionId;
      var useSessions = props.useSessions;
      var items = typeof useSessions === "function"
        ? useSessions(function (s) { return s && Array.isArray(s.items) ? s.items : []; })
        : [];
      var byId = typeof useSessions === "function"
        ? useSessions(function (s) { return s && s.byId ? s.byId : {}; })
        : {};
      var [open, setOpen] = useState(false);
      var [balance, setBalance] = useState(null);
      var [currency, setCurrency] = useState("CNY");
      var [totalCost, setTotalCost] = useState(0);
      var [totalTokens, setTotalTokens] = useState(0);
      var [requests, setRequests] = useState([]);
      var [error, setError] = useState("");
      var [expanded, setExpanded] = useState({});
      var [tab, setTab] = useState("detail");
      var [flashRates, setFlashRates] = useState(null);
      var rootRef = useRef(null);

      var localCost = 0;
      var localTokens = 0;
      if (sessionId !== void 0) {
        var localIds = collectSessionIdsFromById(byId, sessionId);
        for (var li = 0; li < localIds.length; li++) {
          var entry = byId[localIds[li]];
          var usage = entry && entry.projectionValues && entry.projectionValues.tokenUsage;
          if (usage) {
            localCost += estimateCostFromUsage(usage, flashRates);
            localTokens += (usage.uncachedInputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0) + (usage.outputTokens || 0);
          }
        }
      }

      useEffect(function () {
        var cancelled = false;
        var load = async function () {
          try {
            var balBody = await fetchJson(BALANCE_PATH);
            var parsed = parseBalance(balBody);
            if (!cancelled) {
              setBalance(parsed.balance);
              setCurrency(parsed.currency);
            }
          } catch (e) {}
          // 当前生效价（用于本地估算兜底；也让"你改的价"立刻反映到徽章上）
          try {
            var priceBody = await fetchJson(PRICING_PATH);
            if (!cancelled && priceBody && priceBody.now && priceBody.now.rows) {
              var flashRow = priceBody.now.rows["deepseek-flash"];
              setFlashRates(flashRow && flashRow.cny ? flashRow.cny : null);
            }
          } catch (e) {}
        };
        load();
        var timer = setInterval(load, BALANCE_POLL_MS);
        return function () { cancelled = true; clearInterval(timer); };
      }, []);

      useEffect(function () {
        if (sessionId === void 0) return;
        var cancelled = false;
        var load = async function () {
          try {
            var body = await fetchJson(SESSION_COST_PATH + "?sessionId=" + encodeURIComponent(sessionId));
            if (!cancelled && body && typeof body === "object") {
              setTotalCost(typeof body.cost === "number" ? body.cost : 0);
              setTotalTokens(typeof body.totalTokens === "number" ? body.totalTokens : 0);
              setError("");
            }
          } catch (err) {
            if (!cancelled) setError(err instanceof Error ? err.message : String(err));
          }
        };
        load();
        var timer = setInterval(load, HEADER_POLL_MS);
        return function () { cancelled = true; clearInterval(timer); };
      }, [sessionId]);

      useEffect(function () {
        if (!open || sessionId === void 0) return;
        var cancelled = false;
        var load = async function () {
          try {
            var body = await fetchJson(REQUESTS_PATH + "?sessionId=" + encodeURIComponent(sessionId));
            var reqs = Array.isArray(body.requests) ? body.requests : [];
            var serverTagged = reqs.length > 0 && reqs[0].sessionId !== void 0;
            var all = [];
            if (serverTagged) {
              all = reqs;
            } else {
              // 旧版 Host：服务端还没汇总，前端自己按子代理关系补一次。
              var ids = collectSessionIds(items, sessionId);
              for (var i = 0; i < ids.length; i++) {
                var childBody = await fetchJson(REQUESTS_PATH + "?sessionId=" + encodeURIComponent(ids[i]));
                var childReqs = childBody && Array.isArray(childBody.requests) ? childBody.requests : [];
                for (var j = 0; j < childReqs.length; j++) {
                  all.push(Object.assign({}, childReqs[j], { sessionId: ids[i] }));
                }
              }
            }
            if (!cancelled) {
              setRequests(all);
              setError("");
            }
          } catch (err) {
            if (!cancelled) setError(err instanceof Error ? err.message : String(err));
          }
        };
        load();
        var timer = setInterval(load, HEADER_POLL_MS);
        return function () { cancelled = true; clearInterval(timer); };
      }, [open, sessionId, items]);

      useEffect(function () {
        if (!open) return;
        var onPointerDown = function (event) {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown);
        return function () { document.removeEventListener("pointerdown", onPointerDown); };
      }, [open]);

      var displayCost = totalCost > 0 ? totalCost : localCost;
      var displayTokens = totalTokens > 0 ? totalTokens : localTokens;
      var buttonText = "计费";
      if (balance !== null) {
        buttonText = "DeepSeek " + fmtMoney(balance, currency);
        if (displayCost > 0) buttonText += " · 本对话 " + fmtMoney(displayCost, currency);
      }

      var panel = null;
      if (open) {
        var rows = null;
        if (requests.length === 0) {
          rows = h("div", { style: { color: "var(--dsw-alias-label-tertiary)", textAlign: "center", padding: "12px 0" } }, "暂无已结算的 API 请求");
        } else {
          var parentTurns = {};
          var childSessions = {};
          for (var gi = 0; gi < requests.length; gi++) {
            var gr = requests[gi];
            if (gr.sessionId === sessionId || gr.sessionId === void 0) {
              var pt = gr.turn || 0;
              if (!parentTurns[pt]) parentTurns[pt] = { turn: pt, cost: 0, tokens: 0, items: [], start: Infinity, end: -Infinity, children: [] };
              parentTurns[pt].cost += gr.cost || 0;
              parentTurns[pt].tokens += gr.totalTokens || 0;
              parentTurns[pt].items.push(gr);
              if (typeof gr.time === "number") {
                if (gr.time < parentTurns[pt].start) parentTurns[pt].start = gr.time;
                if (gr.time > parentTurns[pt].end) parentTurns[pt].end = gr.time;
              }
            } else {
              var sid = gr.sessionId;
              if (!childSessions[sid]) childSessions[sid] = { sessionId: sid, createdAt: gr.sessionCreatedAt || 0, turns: {} };
              var ct = gr.turn || 0;
              if (!childSessions[sid].turns[ct]) childSessions[sid].turns[ct] = { turn: ct, cost: 0, tokens: 0, items: [] };
              childSessions[sid].turns[ct].cost += gr.cost || 0;
              childSessions[sid].turns[ct].tokens += gr.totalTokens || 0;
              childSessions[sid].turns[ct].items.push(gr);
            }
          }

          // 把子代理会话按创建时间挂到最接近的父轮次下
          var orphanChildren = [];
          for (var sidKey in childSessions) {
            if (!Object.prototype.hasOwnProperty.call(childSessions, sidKey)) continue;
            var cs = childSessions[sidKey];
            var bestParent = null;
            if (cs.createdAt) {
              for (var ptKey in parentTurns) {
                if (!Object.prototype.hasOwnProperty.call(parentTurns, ptKey)) continue;
                var cand = parentTurns[ptKey];
                if (cand.start <= cs.createdAt + 5000 && (!bestParent || cand.start > bestParent.start)) bestParent = cand;
              }
            }
            if (bestParent) bestParent.children.push(cs);
            else orphanChildren.push(cs);
          }

          function renderRequestItem(r, turn) {
            return h("div", {
              key: r.messageId || (turn + ":" + r.step),
              style: {
                display: "flex",
                justifyContent: "space-between",
                gap: 8,
                padding: "3px 0 3px 12px",
                borderBottom: "1px solid var(--dsw-alias-border-l1)",
                fontSize: 11,
                lineHeight: "16px",
                fontVariantNumeric: "tabular-nums"
              }
            },
              h("span", { style: { color: "var(--dsw-alias-label-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                "T" + turn + "." + (r.step || 0) + (r.model ? " " + r.model : "")
              ),
              h("span", null, fmtMoney(r.cost, currency) + " · " + fmtTokens(r.totalTokens || 0) + " tok")
            );
          }

          function renderChildTurns(children) {
            var els = [];
            for (var ci = 0; ci < children.length; ci++) {
              var child = children[ci];
              var cTurnKeys = Object.keys(child.turns).sort(function (a, b) { return Number(a) - Number(b); });
              for (var cti = 0; cti < cTurnKeys.length; cti++) {
                var cg = child.turns[cTurnKeys[cti]];
                els.push(h("div", { key: child.sessionId + ":" + cg.turn, style: { marginTop: 4, paddingLeft: 12, borderLeft: "2px solid var(--dsw-alias-border-l1)" } },
                  h("div", { style: { fontWeight: 600, fontSize: 11, color: "var(--dsw-alias-label-secondary)", padding: "2px 0" } },
                    "子代理 · 第 " + cg.turn + " 轮 · " + fmtMoney(cg.cost, currency) + " · " + fmtTokens(cg.tokens) + " tok"
                  ),
                  cg.items.map(function (r) { return renderRequestItem(r, cg.turn); })
                ));
              }
            }
            return els;
          }

          function renderGroup(key, g, isChild) {
            var isOpen = !!expanded[key];
            var header = h("button", {
              key: key + "-h",
              type: "button",
              onClick: function () {
                setExpanded(function (prev) {
                  var next = Object.assign({}, prev);
                  if (next[key]) delete next[key]; else next[key] = true;
                  return next;
                });
              },
              style: {
                display: "flex",
                justifyContent: "space-between",
                gap: 8,
                width: "100%",
                border: "none",
                background: "transparent",
                color: "var(--dsw-alias-label-primary)",
                cursor: "pointer",
                padding: "6px 0",
                fontSize: 12,
                fontWeight: 600,
                fontVariantNumeric: "tabular-nums",
                textAlign: "left"
              }
            },
              h("span", { style: { display: "inline-flex", alignItems: "center", gap: 6 } },
                h("span", null, (isChild ? "子 " : "") + "第 " + g.turn + " 轮"),
                (!isChild && g.children && g.children.length > 0)
                  ? h("span", { style: { fontSize: 10, color: "var(--dsw-alias-state-business-primary, var(--dsw-alias-label-secondary))", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 999, padding: "0 5px", lineHeight: "14px" } }, "有子代理")
                  : null
              ),
              h("span", null, fmtMoney(g.cost, currency) + " · " + fmtTokens(g.tokens) + " tok")
            );
            var detail = null;
            if (isOpen) {
              detail = h("div", null,
                g.items.map(function (r) { return renderRequestItem(r, g.turn); }),
                g.children ? renderChildTurns(g.children) : null
              );
            }
            return h("div", { key: key, style: { borderBottom: "1px solid var(--dsw-alias-border-l1)" } }, header, detail);
          }

          var groupDefs = [];
          var parentKeys = Object.keys(parentTurns).sort(function (a, b) { return Number(a) - Number(b); });
          for (var pi = 0; pi < parentKeys.length; pi++) {
            var pKey = parentKeys[pi];
            var pg = parentTurns[pKey];
            // 父轮总金额包含挂到它下面的子代理
            for (var childIdx = 0; childIdx < pg.children.length; childIdx++) {
              var cs2 = pg.children[childIdx];
              for (var ck in cs2.turns) {
                if (Object.prototype.hasOwnProperty.call(cs2.turns, ck)) {
                  pg.cost += cs2.turns[ck].cost;
                  pg.tokens += cs2.turns[ck].tokens;
                }
              }
            }
            groupDefs.push({ key: "p:" + pKey, g: pg, isChild: false });
          }
          for (var oi = 0; oi < orphanChildren.length; oi++) {
            var oc = orphanChildren[oi];
            var ocKeys = Object.keys(oc.turns).sort(function (a, b) { return Number(a) - Number(b); });
            for (var oki = 0; oki < ocKeys.length; oki++) {
              var ocg = oc.turns[ocKeys[oki]];
              groupDefs.push({ key: "c:" + oc.sessionId + ":" + ocg.turn, g: ocg, isChild: true });
            }
          }
          rows = groupDefs.map(function (def) { return renderGroup(def.key, def.g, def.isChild); });
        }

        var tabBar = h("div", { style: { display: "flex", gap: 4, marginBottom: 6 } },
          h("button", { type: "button", style: tabButtonStyle(tab === "detail"), onClick: function () { setTab("detail"); } }, "费用明细"),
          h("button", { type: "button", style: tabButtonStyle(tab === "pricing"), onClick: function () { setTab("pricing"); } }, "价格设置")
        );
        var body = tab === "pricing"
          ? h(PricingSettings, null)
          : h("div", null,
            h("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: 6 } },
              h("span", null, "合计 " + fmtMoney(displayCost, currency)),
              h("span", null, fmtTokens(displayTokens) + " tok")
            ),
            error ? h("div", { style: { color: "var(--dsw-alias-state-error-primary)", marginBottom: 6 } }, error) : null,
            rows
          );

        panel = h("div", {
          style: {
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            zIndex: 300,
            width: 440,
            maxWidth: "calc(100vw - 32px)",
            maxHeight: "min(560px, calc(100vh - 140px))",
            overflowY: "auto",
            boxSizing: "border-box",
            border: "1px solid var(--dsw-alias-border-l2)",
            background: "var(--dsw-specific-menu, var(--dsw-alias-bg-overlay))",
            borderRadius: 12,
            boxShadow: "var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,0.18))",
            padding: "10px 12px",
            color: "var(--dsw-alias-label-primary)",
            fontSize: 12
          }
        },
          h("div", { style: { fontWeight: 600, marginBottom: 6 } }, "DeepSeek 计费"),
          tabBar,
          body
        );
      }

      return h("div", { ref: rootRef, style: { position: "relative", display: "inline-flex", alignItems: "center" } },
        h("button", {
          type: "button",
          style: {
            height: 28,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            border: "1px solid var(--dsw-alias-border-l2)",
            background: "transparent",
            color: "var(--dsw-alias-label-secondary)",
            borderRadius: 999,
            padding: "0 10px",
            fontSize: 12,
            lineHeight: "20px",
            cursor: "pointer",
            fontFamily: "inherit",
            whiteSpace: "nowrap"
          },
          "aria-expanded": open,
          onClick: function () { setOpen(!open); }
        }, buttonText),
        panel
      );
    }

    // ---- plugin body -----------------------------------------------------
    var inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("conversation.chat.assistant-actions", function () {
        return ctx.slots.register({
          name: "conversation.chat.assistant-actions",
          id: "dsh-deepseek-billing-request-cost",
          order: 100
        }, RequestCostBadge);
      });

      ctx.slots.inject("conversation.session.header.actions", function () {
        return ctx.slots.register({
          name: "conversation.session.header.actions",
          id: "dsh-deepseek-billing-conversation-cost",
          order: 100
        }, ConversationCostButton);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    // 仅供离线测试（浏览器里不会被调用）：让"没有浏览器也能渲染/校验"成为可能。
    exports.__test = {
      PricingBody: PricingBody,
      PricingSettings: PricingSettings,
      ConversationCostButton: ConversationCostButton,
      buildEntryPayload: buildEntryPayload,
      parsePeakWindows: parsePeakWindows,
      formatPeakWindows: formatPeakWindows,
      latestOfficialRates: latestOfficialRates,
      nowInputValue: nowInputValue,
      sinceToInput: sinceToInput,
      fmtRate: fmtRate,
      estimateCostFromUsage: estimateCostFromUsage
    };
    return module.exports;
  }
});
