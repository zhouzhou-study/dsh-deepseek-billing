// dsh-deepseek-billing — browser half.
//
// 1. Under the last assistant message of each turn: that turn's combined
//    cost + tokens (one badge per turn, no spam).
// 2. Header button: live DeepSeek balance + this conversation's cost; opens
//    a per-turn/per-request cost panel (subagent sessions included).
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

    function estimateCostFromUsage(usage) {
      if (!usage || typeof usage !== "object") return 0;
      var peak = isPeakNow();
      // 默认按 deepseek-v4-flash 价格估算；精确值稍后由服务端返回。
      var inputRate = peak ? 3 : 1.5;
      var cacheReadRate = peak ? 0.1 : 0.05;
      var outputRate = peak ? 9 : 4.5;
      var input = (usage.uncachedInputTokens || 0) + (usage.cacheWriteTokens || 0);
      var cacheRead = usage.cacheReadTokens || 0;
      var output = usage.outputTokens || 0;
      return (input * inputRate + cacheRead * cacheReadRate + output * outputRate) / 1e6;
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
      var rootRef = useRef(null);

      var localCost = 0;
      var localTokens = 0;
      if (sessionId !== void 0) {
        var localIds = collectSessionIdsFromById(byId, sessionId);
        for (var li = 0; li < localIds.length; li++) {
          var entry = byId[localIds[li]];
          var usage = entry && entry.projectionValues && entry.projectionValues.tokenUsage;
          if (usage) {
            localCost += estimateCostFromUsage(usage);
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

        panel = h("div", {
          style: {
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            zIndex: 300,
            width: 360,
            maxWidth: "calc(100vw - 32px)",
            maxHeight: "min(480px, calc(100vh - 140px))",
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
          h("div", { style: { fontWeight: 600, marginBottom: 6 } }, "本次对话费用明细（含子代理）"),
          h("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: 6 } },
            h("span", null, "合计 " + fmtMoney(displayCost, currency)),
            h("span", null, fmtTokens(displayTokens) + " tok")
          ),
          error ? h("div", { style: { color: "var(--dsw-alias-state-error-primary)", marginBottom: 6 } }, error) : null,
          rows
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
    return module.exports;
  }
});
