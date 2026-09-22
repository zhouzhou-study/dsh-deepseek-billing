// 面板「官方历史价」列表的回归测试。
//
// 目的：锁住一个容易想当然的数字——引擎里的政策条数 ≠ 面板显示的调价次数。
// 引擎有 6 条政策；面板只列「点名了当前可选模型」的那些，所以显示 5 条，
// 2025-02-09 那条（只点名 deepseek-chat / deepseek-reasoner）被过滤掉，
// 但它仍然在给老会话算钱。
//
// 运行：node test/pricing-panel.test.mjs
import { describePricing } from "../lib/user-pricing.js";
import { OFFICIAL_PRICING_POLICIES, priceAt } from "../lib/pricing.js";

let pass = 0;
let fail = 0;
function check(label, ok, extra) {
  if (ok) { pass += 1; console.log(`PASS  ${label}`); }
  else { fail += 1; console.log(`FAIL  ${label}  ${extra ?? ""}`); }
}

const emptySnapshot = {
  path: "(测试)",
  exists: false,
  updatedAt: null,
  config: { timezone: "Asia/Shanghai", peakWindows: [[9, 12], [14, 18]], weekendOffPeak: true, holidayOffPeak: true },
  entries: [],
  errors: []
};

const state = describePricing(emptySnapshot, Date.parse("2026-09-13T20:00:00+08:00"));
const shown = state.official.map((policy) => policy.since.slice(0, 10));

// 1) 引擎里的政策条数（当前是 6）
check("引擎政策条数 = 6", OFFICIAL_PRICING_POLICIES.length === 6, String(OFFICIAL_PRICING_POLICIES.length));

// 2) 面板显示的条数（当前是 5）——注意：不是 6
check("面板显示条数 = 5（界面上的「5 次调价」）", state.official.length === 5, String(state.official.length));

// 3) 显示的正是这五条
const expected = ["2026-05-22", "2026-08-17", "2026-08-23", "2026-09-10", "2026-09-19"];
check("显示的日期与顺序不变", JSON.stringify(shown) === JSON.stringify(expected), JSON.stringify(shown));

// 4) 2025-02-09 那条被过滤（只点名 2025 年的老模型名）
check("2025-02-09 那条不出现在面板里", shown.indexOf("2025-02-09") === -1, JSON.stringify(shown));

// 5) 但它仍然在引擎里生效：老模型的老消息照旧按当时价算
const oldChat = priceAt("deepseek-chat", Date.parse("2025-06-01T15:00:00+08:00"));
check("2025-02-09 政策仍给 deepseek-chat 定价（2/0.5/8）",
  oldChat.cny.input === 2 && oldChat.cny.cacheRead === 0.5 && oldChat.cny.output === 8,
  JSON.stringify(oldChat.cny));
check("被过滤的那条仍在政策表里", OFFICIAL_PRICING_POLICIES.some((p) => p.since.slice(0, 10) === "2025-02-09"));

// 6) 每条显示出来的政策都确实点名了当前可选模型
const ACTIVE = ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"];
const allNamed = state.official.every((policy) =>
  policy.named.some((n) => ACTIVE.indexOf(n.model) !== -1));
check("显示的每条都点名了当前可选模型", allNamed);

// 7) 最新那条是 2026-09-19 的节假日口径：两个规则都开，且逐模型照抄价格（等于不调价）
const newest = state.official[state.official.length - 1];
check("最新一条是 09-19 且标了节假日规则",
  newest.since.slice(0, 10) === "2026-09-19" && newest.holidayOffPeak === true && newest.weekendOffPeak === true,
  JSON.stringify({ since: newest.since, holiday: newest.holidayOffPeak, weekend: newest.weekendOffPeak }));
check("09-19 那条没有『这次没调它』的遗留模型（四个模型都点名了）", newest.inherited.length === 0, JSON.stringify(newest.inherited));
check("09-19 那条的 flash 两档价与 09-10 一致（只改规则不改价）",
  newest.named.every((n) => n.model !== "deepseek-flash" || (n.peak.input === 2 && n.offPeak.input === 1)) &&
  newest.fallback.peak.input === 2 && newest.fallback.offPeak.input === 1,
  JSON.stringify(newest.named));

// 8) 面板拿得到"今天算什么"与节假日表（前端据此显示闲时原因，不再自己抄一份日期表）
check("state.now 带节假日/周末/调休判定（2026-09-13 是周日）",
  state.now.holiday === null && state.now.weekend === true && state.now.makeupWorkday === false && state.now.date === "2026-09-13",
  JSON.stringify(state.now).slice(0, 120));
check("state.calendar 带 33 天放假日与 6 天调休", state.calendar.holidays.length === 33 && state.calendar.makeup.length === 6);
// 9) 补表自检也随状态下发（面板靠它提醒）；2026-09-13 这天不该提醒
check("state.coverage 存在且 9 月不提醒补表", state.coverage !== void 0 && state.coverage.stale === false, JSON.stringify(state.coverage));
const holidayState = describePricing(emptySnapshot, Date.parse("2026-09-25T11:00:00+08:00"));
check("中秋当天 state.now 认得出节假日并按闲时",
  holidayState.now.holiday === "中秋节" && holidayState.now.mode === "offPeak",
  JSON.stringify({ holiday: holidayState.now.holiday, mode: holidayState.now.mode }));
const makeupState = describePricing(emptySnapshot, Date.parse("2026-10-10T15:00:00+08:00"));
check("调休上班的周六 state.now 标出调休且按闲时",
  makeupState.now.makeupWorkday === true && makeupState.now.mode === "offPeak",
  JSON.stringify({ makeup: makeupState.now.makeupWorkday, mode: makeupState.now.mode }));

console.log(`\n面板历史价测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
