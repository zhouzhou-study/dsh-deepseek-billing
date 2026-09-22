// 自定义价格层（价格设置的服务端）测试：路径可移植性 / 生效规则 / 回退 / 容错
// 运行：node test/user-pricing.test.mjs
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  deleteEntry,
  describePricing,
  pricingFilePath,
  readSnapshot,
  upsertEntry
} from "../lib/user-pricing.js";

const tmpFile = path.join(os.tmpdir(), "billing-prices-test.json");
try { fs.unlinkSync(tmpFile); } catch {}
process.env.DSH_BILLING_PRICING_FILE = tmpFile;

let pass = 0;
let fail = 0;
function check(label, ok, extra) {
  if (ok) { pass += 1; console.log(`PASS  ${label}`); }
  else { fail += 1; console.log(`FAIL  ${label}  ${extra ?? ""}`); }
}

// 1) 环境变量覆盖路径
check("DSH_BILLING_PRICING_FILE 覆盖路径", pricingFilePath() === tmpFile, pricingFilePath());

// 2) 可移植性：没有 env / 没有 DSH_HOME 时按 os.homedir() 推导，不写死任何本机路径
delete process.env.DSH_BILLING_PRICING_FILE;
delete process.env.DSH_HOME;
const expectHome = path.join(os.homedir(), ".dsh", "billing-prices.json");
check("无 DSH_HOME 时回退 ~/.dsh（os.homedir() 推导）", pricingFilePath() === expectHome, pricingFilePath());
const srcPath = new URL("../lib/user-pricing.js", import.meta.url);
const src = fs.readFileSync(srcPath, "utf8");
const hardcoded = src.match(/["'`][A-Za-z]:[\\/][^"'`]*["'`]|["'`]\/home\/[^"'`]*["'`]/g);
check("源码内没有任何写死的绝对路径", hardcoded === null, JSON.stringify(hardcoded));
process.env.DSH_BILLING_PRICING_FILE = tmpFile;

// 3) 初始状态：没有自定义价，全部走官方表
const empty = readSnapshot({ force: true });
check("初始无自定义价（exists=false）", empty.exists === false && empty.entries.length === 0);

// 4) 写入一条自定义价（明显区别于官方 Flash 价）
const up = upsertEntry({
  since: "2026-09-14 00:00",
  scope: "deepseek-flash",
  peak: { input: 1.5, cacheRead: 0.03, output: 6 },
  offPeak: { input: 0.5, cacheRead: 0.01, output: 2 },
  note: "测试价"
});
check("写入自定义价成功", up.ok === true, JSON.stringify(up).slice(0, 120));

// 5) 闲时 / 高峰两档都取自定义价
const offPeakAt = Date.parse("2026-09-14T20:00:00+08:00");
const stateOff = describePricing(readSnapshot({ force: true }), offPeakAt);
const rowOff = stateOff.now.rows["deepseek-flash"];
check("闲时取到自定义价 0.5/0.01/2",
  rowOff !== void 0 && rowOff.source === "user" && rowOff.cny.input === 0.5 && rowOff.cny.cacheRead === 0.01 && rowOff.cny.output === 2,
  JSON.stringify(rowOff));

const statePeak = describePricing(readSnapshot({ force: true }), Date.parse("2026-09-14T15:00:00+08:00"));
const rowPeak = statePeak.now.rows["deepseek-flash"];
check("高峰取到自定义价 1.5/0.03/6",
  rowPeak !== void 0 && rowPeak.cny.input === 1.5 && rowPeak.cny.output === 6,
  JSON.stringify(rowPeak));

// 6) 未被点名的模型不受影响（v4-pro 沿用 08-23 旧价）
const pro = stateOff.now.rows["deepseek-v4-pro"];
check("v4-pro 未受影响（官方 4.5/0.15/13.5）",
  pro !== void 0 && pro.source === "official" && pro.cny.input === 4.5 && pro.cny.output === 13.5,
  JSON.stringify(pro));

// 6b) 峰谷口径：中国法定节假日全天按闲时（官方 2026-09-19《API 峰谷时间说明》）
// 自定义价与官方价必须同一套口径，否则"有没有自定义价"会算出两种价。
check("config 默认就开「法定节假日全天闲时」", empty.config.holidayOffPeak === true, JSON.stringify(empty.config));
const holidayAt = Date.parse("2026-09-25T11:00:00+08:00"); // 中秋假期里的周五上午，平时算高峰
const stateHoliday = describePricing(readSnapshot({ force: true }), holidayAt);
const rowHoliday = stateHoliday.now.rows["deepseek-flash"];
check("节假日里取闲时自定义价 0.5/0.01/2（不是高峰价 1.5/0.03/6）",
  stateHoliday.now.holiday === "中秋节" && stateHoliday.now.mode === "offPeak" &&
    rowHoliday.cny.input === 0.5 && rowHoliday.cny.cacheRead === 0.01 && rowHoliday.cny.output === 2,
  JSON.stringify({ holiday: stateHoliday.now.holiday, mode: stateHoliday.now.mode, row: rowHoliday.cny }));
const makeupAt = Date.parse("2026-10-10T15:00:00+08:00"); // 国庆调休上班的周六下午
const stateMakeup = describePricing(readSnapshot({ force: true }), makeupAt);
check("调休上班的周六（10-10 15:00）也是闲时价",
  stateMakeup.now.makeupWorkday === true && stateMakeup.now.mode === "offPeak" &&
    stateMakeup.now.rows["deepseek-flash"].cny.input === 0.5,
  JSON.stringify({ makeup: stateMakeup.now.makeupWorkday, mode: stateMakeup.now.mode }));
// 假期一过就恢复高峰，别把整月都算成闲时
const afterHoliday = describePricing(readSnapshot({ force: true }), Date.parse("2026-10-08T15:00:00+08:00"));
check("节后普通工作日（10-08 周四 15:00）仍是高峰价 1.5/0.03/6",
  afterHoliday.now.mode === "peak" && afterHoliday.now.rows["deepseek-flash"].cny.input === 1.5,
  JSON.stringify({ mode: afterHoliday.now.mode }));

// 7) 删除后回退官方价
check("删除自定义价成功", deleteEntry(up.entry.id).ok === true);
const after = describePricing(readSnapshot({ force: true }), offPeakAt);
check("删除后回退官方价 1/0.02/4",
  after.now.rows["deepseek-flash"].source === "official" && after.now.rows["deepseek-flash"].cny.input === 1,
  JSON.stringify(after.now.rows["deepseek-flash"]));

// 8) 坏数据只记录错误，不抛异常
fs.writeFileSync(tmpFile, "{ this is not json", "utf8");
const broken = readSnapshot({ force: true });
check("坏 JSON 不抛错、记 errors", broken.errors.length > 0 && broken.entries.length === 0);

try { fs.unlinkSync(tmpFile); } catch {}
console.log(`\n价格设置测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
