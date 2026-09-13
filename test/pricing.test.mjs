// 官方价格引擎回归测试：峰谷 / 周末 / 模型改名 / 调价分界
// 运行：node test/pricing.test.mjs
import { priceAt } from "../lib/pricing.js";

const cases = [
  ["周日全天闲时（周末政策）", "deepseek-flash", "2026-09-13T15:00:00+08:00", "offPeak", { input: 1, cacheRead: 0.02, output: 4 }],
  ["周一高峰（09-10 新政）", "deepseek-flash", "2026-09-14T15:00:00+08:00", "peak", { input: 2, cacheRead: 0.04, output: 8 }],
  ["周一闲时（09-10 新政）", "deepseek-flash", "2026-09-14T20:00:00+08:00", "offPeak", { input: 1, cacheRead: 0.02, output: 4 }],
  ["v4-pro 高峰＝沿用 08-23 旧价", "deepseek-v4-pro", "2026-09-14T15:00:00+08:00", "peak", { input: 9, cacheRead: 0.3, output: 27 }],
  ["v4-pro 闲时＝沿用 08-23 旧价", "deepseek-v4-pro", "2026-09-14T20:00:00+08:00", "offPeak", { input: 4.5, cacheRead: 0.15, output: 13.5 }],
  ["旧名 deepseek-v4-flash 同价", "deepseek-v4-flash", "2026-09-14T20:00:00+08:00", "offPeak", { input: 1, cacheRead: 0.02, output: 4 }],
  ["09-10 12:00 之前仍按旧价（高峰）", "deepseek-flash", "2026-09-10T11:00:00+08:00", "peak", { input: 3, cacheRead: 0.1, output: 9 }],
  ["09-10 12:00 之后按新价（闲时）", "deepseek-flash", "2026-09-10T13:00:00+08:00", "offPeak", { input: 1, cacheRead: 0.02, output: 4 }]
];

let pass = 0;
let fail = 0;
for (const [label, model, iso, wantMode, wantCny] of cases) {
  const got = priceAt(model, Date.parse(iso));
  const ok = got.mode === wantMode &&
    got.cny.input === wantCny.input &&
    got.cny.cacheRead === wantCny.cacheRead &&
    got.cny.output === wantCny.output;
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    console.log(`FAIL  ${label}\n      得到 ${got.mode} ${got.cny.input}/${got.cny.cacheRead}/${got.cny.output}，期望 ${wantMode} ${wantCny.input}/${wantCny.cacheRead}/${wantCny.output}`);
  }
}
console.log(`价格回归测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
