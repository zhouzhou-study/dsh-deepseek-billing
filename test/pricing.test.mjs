// 官方价格引擎回归测试：峰谷 / 周末与法定节假日 / 模型改名 / 调价分界
// 运行：node test/pricing.test.mjs
import {
  cnHolidayCalendar,
  cnHolidayName,
  isCnMakeupWorkday,
  localDateKey,
  priceAt
} from "../lib/pricing.js";

const cases = [
  ["周日全天闲时（周末政策）", "deepseek-flash", "2026-09-13T15:00:00+08:00", "offPeak", { input: 1, cacheRead: 0.02, output: 4 }],
  ["周一高峰（09-10 新政）", "deepseek-flash", "2026-09-14T15:00:00+08:00", "peak", { input: 2, cacheRead: 0.04, output: 8 }],
  ["周一闲时（09-10 新政）", "deepseek-flash", "2026-09-14T20:00:00+08:00", "offPeak", { input: 1, cacheRead: 0.02, output: 4 }],
  ["v4-pro 高峰＝沿用 08-23 旧价", "deepseek-v4-pro", "2026-09-14T15:00:00+08:00", "peak", { input: 9, cacheRead: 0.3, output: 27 }],
  ["v4-pro 闲时＝沿用 08-23 旧价", "deepseek-v4-pro", "2026-09-14T20:00:00+08:00", "offPeak", { input: 4.5, cacheRead: 0.15, output: 13.5 }],
  ["旧名 deepseek-v4-flash 同价", "deepseek-v4-flash", "2026-09-14T20:00:00+08:00", "offPeak", { input: 1, cacheRead: 0.02, output: 4 }],
  ["09-10 12:00 之前仍按旧价（高峰）", "deepseek-flash", "2026-09-10T11:00:00+08:00", "peak", { input: 3, cacheRead: 0.1, output: 9 }],
  ["09-10 12:00 之后按新价（闲时）", "deepseek-flash", "2026-09-10T13:00:00+08:00", "offPeak", { input: 1, cacheRead: 0.02, output: 4 }],
  // ---- 2026-09-19 官方《API 峰谷时间说明》：调休上班的周末、法定节假日全天按空闲时段 ----
  ["中秋假期里的工作日（09-25 周五 11:00）闲时", "deepseek-flash", "2026-09-25T11:00:00+08:00", "offPeak", { input: 1, cacheRead: 0.02, output: 4 }],
  ["国庆假期里的工作日（10-05 周一 15:00）闲时", "deepseek-flash", "2026-10-05T15:00:00+08:00", "offPeak", { input: 1, cacheRead: 0.02, output: 4 }],
  ["调休上班的周日（09-20 10:00）仍闲时", "deepseek-flash", "2026-09-20T10:00:00+08:00", "offPeak", { input: 1, cacheRead: 0.02, output: 4 }],
  ["调休上班的周六（10-10 15:00）仍闲时", "deepseek-flash", "2026-10-10T15:00:00+08:00", "offPeak", { input: 1, cacheRead: 0.02, output: 4 }],
  ["v4-pro 也吃节假日规则（10-06 周二 15:00）闲时价", "deepseek-v4-pro", "2026-10-06T15:00:00+08:00", "offPeak", { input: 4.5, cacheRead: 0.15, output: 13.5 }],
  ["假期一过仍是普通工作日（10-08 周四 15:00）高峰", "deepseek-flash", "2026-10-08T15:00:00+08:00", "peak", { input: 2, cacheRead: 0.04, output: 8 }],
  ["2026-05-22 之前仍是统一价（flat，不含峰谷）", "deepseek-flash", "2026-02-16T15:00:00+08:00", "flat", { input: 2, cacheRead: 0.5, output: 8 }]
];

let pass = 0;
let fail = 0;
function check(label, ok, extra) {
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    console.log(`FAIL  ${label}${extra === void 0 ? "" : `\n      ${extra}`}`);
  }
}

for (const [label, model, iso, wantMode, wantCny] of cases) {
  const got = priceAt(model, Date.parse(iso));
  check(
    label,
    got.mode === wantMode &&
      got.cny.input === wantCny.input &&
      got.cny.cacheRead === wantCny.cacheRead &&
      got.cny.output === wantCny.output,
    `得到 ${got.mode} ${got.cny.input}/${got.cny.cacheRead}/${got.cny.output}，期望 ${wantMode} ${wantCny.input}/${wantCny.cacheRead}/${wantCny.output}`
  );
}

// 节假日表本身（数据源：国务院办公厅《关于2026年部分节假日安排的通知》）
const cal = cnHolidayCalendar();
check("节假日表：7 个节日 / 33 个放假日", cal.periods.length === 7 && cal.holidays.length === 33, `${cal.periods.length} 个节日 / ${cal.holidays.length} 天`);
check(
  "调休上班日 6 天且日期正确",
  cal.makeup.join(",") === "2026-01-04,2026-02-14,2026-02-28,2026-05-09,2026-09-20,2026-10-10",
  cal.makeup.join(",")
);
check("09-25 是中秋节", cnHolidayName(Date.parse("2026-09-25T12:00:00+08:00")) === "中秋节");
check("10-01 是国庆节", cnHolidayName(Date.parse("2026-10-01T12:00:00+08:00")) === "国庆节");
check("10-08 不是节假日", cnHolidayName(Date.parse("2026-10-08T12:00:00+08:00")) === null);
check("09-20 是调休上班日", isCnMakeupWorkday(Date.parse("2026-09-20T12:00:00+08:00")) === true);
check("10-10 是调休上班日", isCnMakeupWorkday(Date.parse("2026-10-10T12:00:00+08:00")) === true);
check("09-21 不是调休上班日", isCnMakeupWorkday(Date.parse("2026-09-21T12:00:00+08:00")) === false);
check(
  "北京日历日按时区换算（UTC 16:30 = 北京次日 00:30）",
  localDateKey(Date.parse("2026-09-25T16:30:00Z")) === "2026-09-26",
  localDateKey(Date.parse("2026-09-25T16:30:00Z"))
);
check(
  "元旦/春节/清明/劳动/端午 都在表里",
  ["2026-01-01", "2026-02-16", "2026-04-06", "2026-05-04", "2026-06-19"].every((day) => cal.holidays.indexOf(day) !== -1)
);

console.log(`价格回归测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
