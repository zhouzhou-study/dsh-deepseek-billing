// 面板「官方历史价」列表的回归测试。
//
// 目的：锁住一个容易想当然的数字——引擎里的政策条数 ≠ 面板显示的调价次数。
// 引擎有 5 条政策；面板只列「点名了当前可选模型」的那些，所以显示 4 条，
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
  config: { timezone: "Asia/Shanghai", peakWindows: [[9, 12], [14, 18]], weekendOffPeak: true },
  entries: [],
  errors: []
};

const state = describePricing(emptySnapshot, Date.parse("2026-09-13T20:00:00+08:00"));
const shown = state.official.map((policy) => policy.since.slice(0, 10));

// 1) 引擎里的政策条数（当前是 5）
check("引擎政策条数 = 5", OFFICIAL_PRICING_POLICIES.length === 5, String(OFFICIAL_PRICING_POLICIES.length));

// 2) 面板显示的条数（当前是 4）——注意：不是 5
check("面板显示条数 = 4（界面上的「4 次调价」）", state.official.length === 4, String(state.official.length));

// 3) 显示的正是这四条
const expected = ["2026-05-22", "2026-08-17", "2026-08-23", "2026-09-10"];
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

console.log(`\n面板历史价测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
