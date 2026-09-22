/**
 * DeepSeek 官方价格引擎（纯函数，无依赖）。
 *
 * 移植自 bpc-oss/dsh-web-billing（MIT）：https://github.com/bpc-oss/dsh-web-billing
 * （lib/pricing.js），并参考 dsh-deepseek-quota（MIT）。保留官方政策时间表与
 * 峰谷判定。价格表策展自 DeepSeek 官方公告（https://api-docs.deepseek.com/zh-cn/quick_start/pricing/），
 * 如官方调整欢迎同步更新。
 *
 * 语义约定（与 DeepSeek 官方及 provider 适配器一致）：
 * - input      缓存未命中输入（uncached input）
 * - cacheRead  缓存命中输入
 * - output     输出
 * 单价单位：每 1M tokens，人民币（cny）与美元（usd）各一份。
 */

/** 峰谷判定的默认时区（北京时间）。 */
export const DEFAULT_TIMEZONE = "Asia/Shanghai";

/** 官方高峰时段（本地小时，[start, end) 闭开区间；仅周一至周五）。 */
export const DEFAULT_PEAK_WINDOWS = [[9, 12], [14, 18]];

/**
 * 中国法定节假日与调休上班日（放假日程照抄官方通知）。
 *
 * 计费口径（DeepSeek 2026-09-19《API 峰谷时间说明》）：**调休上班的周末、中国法定
 * 节假日全天均按空闲时段计费**。⇒ 峰谷判定只看"这一天是不是普通工作日"：
 *   - 周六/周日（含被调休成上班日的周末）→ 全天闲时；
 *   - 法定节假日（哪怕落在周一至周五）→ 全天闲时；
 *   - 其余周一至周五 → 09:00-12:00、14:00-18:00 高峰，其余时段闲时。
 *
 * `makeup` 是调休上班日：它们是周末，按官方口径**仍按空闲时段计费**——列出来是为了
 * 口径完整、界面能说明"今天要上班但仍是闲时价"，不参与峰谷判定。
 *
 * 维护：国务院一般每年 11 月发布次年安排（本条数据源为《关于2026年部分节假日安排的
 * 通知》），届时把下一年度的条目**追加**进来即可，旧条目一律不动（历史账单可复现）。
 */
export const CN_HOLIDAY_SOURCE = "国务院办公厅《关于2026年部分节假日安排的通知》";

export const CN_HOLIDAY_PERIODS = [
  { name: "元旦", from: "2026-01-01", to: "2026-01-03", makeup: ["2026-01-04"] },
  { name: "春节", from: "2026-02-15", to: "2026-02-23", makeup: ["2026-02-14", "2026-02-28"] },
  { name: "清明节", from: "2026-04-04", to: "2026-04-06", makeup: [] },
  { name: "劳动节", from: "2026-05-01", to: "2026-05-05", makeup: ["2026-05-09"] },
  { name: "端午节", from: "2026-06-19", to: "2026-06-21", makeup: [] },
  { name: "中秋节", from: "2026-09-25", to: "2026-09-27", makeup: [] },
  { name: "国庆节", from: "2026-10-01", to: "2026-10-07", makeup: ["2026-09-20", "2026-10-10"] }
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** "YYYY-MM-DD" → 该日 00:00 的 UTC 毫秒（只用于按日展开，与时区无关）。 */
function utcMsOfDateKey(key) {
  const [year, month, day] = key.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/** UTC 毫秒 → "YYYY-MM-DD"（配合 utcMsOfDateKey 做日期展开）。 */
function dateKeyOfUtcMs(ms) {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${`${date.getUTCMonth() + 1}`.padStart(2, "0")}-${`${date.getUTCDate()}`.padStart(2, "0")}`;
}

/** 放假日 → 节日名（"2026-09-25" → "中秋节"）；调休上班日在另一个 Set 里。 */
const CN_HOLIDAY_DATES = new Map();
const CN_MAKEUP_DATES = new Set();
for (const period of CN_HOLIDAY_PERIODS) {
  const end = utcMsOfDateKey(period.to);
  for (let ms = utcMsOfDateKey(period.from); ms <= end; ms += DAY_MS) {
    CN_HOLIDAY_DATES.set(dateKeyOfUtcMs(ms), period.name);
  }
  for (const day of period.makeup ?? []) CN_MAKEUP_DATES.add(day);
}

const ZERO_UNIT = Object.freeze({ input: 0, cacheRead: 0, output: 0 });

/**
 * 官方政策时间表（`since` 为生效时刻，含时区偏移）。每条政策要么是固定单价表
 * （`prices`），要么是峰谷单价表（`peak`/`offPeak`）；`weekendOffPeak: true`
 * 表示该政策下周六/周日全天按闲时价（无峰时段）。每个模型条目的值为
 * `{ cny: {...}, usd: {...} }` 双币种单价。新政策通过追加条目生效——`since`
 * 最晚且不晚于消息时间的政策胜出。
 */
export const OFFICIAL_PRICING_POLICIES = [
  {
    since: "2025-02-09T00:00:00+08:00",
    label: "deepseek-chat / deepseek-reasoner 标准价（2025-02-09 优惠期结束）",
    prices: {
      "deepseek-chat": {
        cny: { input: 2, cacheRead: 0.5, output: 8 },
        usd: { input: 0.28, cacheRead: 0.028, output: 0.42 }
      },
      "deepseek-reasoner": {
        cny: { input: 4, cacheRead: 1, output: 16 },
        usd: { input: 0.55, cacheRead: 0.055, output: 1.68 }
      },
      "*": {
        cny: { input: 2, cacheRead: 0.5, output: 8 },
        usd: { input: 0.28, cacheRead: 0.028, output: 0.42 }
      }
    }
  },
  {
    since: "2026-05-22T00:00:00+08:00",
    label: "V4 系列 75% 降价转永久（deepseek-v4-flash / deepseek-v4-pro 上线）",
    prices: {
      "deepseek-v4-flash": {
        cny: { input: 1, cacheRead: 0.02, output: 2 },
        usd: { input: 0.14, cacheRead: 0.0028, output: 0.28 }
      },
      "deepseek-v4-pro": {
        cny: { input: 3, cacheRead: 0.025, output: 6 },
        usd: { input: 0.435, cacheRead: 0.003625, output: 0.87 }
      },
      "*": {
        cny: { input: 1, cacheRead: 0.02, output: 2 },
        usd: { input: 0.14, cacheRead: 0.0028, output: 0.28 }
      }
    }
  },
  {
    since: "2026-08-17T00:00:00+08:00",
    label: "峰谷定价：高峰 09:00-12:00 / 14:00-18:00（北京时间），空闲时段半价",
    peak: {
      "deepseek-v4-flash": {
        cny: { input: 3, cacheRead: 0.1, output: 9 },
        usd: { input: 0.44, cacheRead: 0.014, output: 1.32 }
      },
      "deepseek-v4-pro": {
        cny: { input: 9, cacheRead: 0.3, output: 27 },
        usd: { input: 1.32, cacheRead: 0.044, output: 3.96 }
      },
      "*": {
        cny: { input: 3, cacheRead: 0.1, output: 9 },
        usd: { input: 0.44, cacheRead: 0.014, output: 1.32 }
      }
    },
    offPeak: {
      "deepseek-v4-flash": {
        cny: { input: 1.5, cacheRead: 0.05, output: 4.5 },
        usd: { input: 0.22, cacheRead: 0.007, output: 0.66 }
      },
      "deepseek-v4-pro": {
        cny: { input: 4.5, cacheRead: 0.15, output: 13.5 },
        usd: { input: 0.66, cacheRead: 0.022, output: 1.98 }
      },
      "*": {
        cny: { input: 1.5, cacheRead: 0.05, output: 4.5 },
        usd: { input: 0.22, cacheRead: 0.007, output: 0.66 }
      }
    }
  },
  {
    since: "2026-08-23T00:00:00+08:00",
    label: "周末全天闲时：周六/周日一律闲时价（工作日峰谷时段不变，单价同 2026-08-17 政策）",
    weekendOffPeak: true,
    peak: {
      "deepseek-v4-flash": {
        cny: { input: 3, cacheRead: 0.1, output: 9 },
        usd: { input: 0.44, cacheRead: 0.014, output: 1.32 }
      },
      "deepseek-v4-pro": {
        cny: { input: 9, cacheRead: 0.3, output: 27 },
        usd: { input: 1.32, cacheRead: 0.044, output: 3.96 }
      },
      "*": {
        cny: { input: 3, cacheRead: 0.1, output: 9 },
        usd: { input: 0.44, cacheRead: 0.014, output: 1.32 }
      }
    },
    offPeak: {
      "deepseek-v4-flash": {
        cny: { input: 1.5, cacheRead: 0.05, output: 4.5 },
        usd: { input: 0.22, cacheRead: 0.007, output: 0.66 }
      },
      "deepseek-v4-pro": {
        cny: { input: 4.5, cacheRead: 0.15, output: 13.5 },
        usd: { input: 0.66, cacheRead: 0.022, output: 1.98 }
      },
      "*": {
        cny: { input: 1.5, cacheRead: 0.05, output: 4.5 },
        usd: { input: 0.22, cacheRead: 0.007, output: 0.66 }
      }
    }
  },
  {
    since: "2026-09-10T12:00:00+08:00",
    label: "V4.1-Flash 上线调价（官方公告 news260910）：Flash 系列峰谷单价下调；deepseek-flash 为新模型名，旧名 deepseek-v4-flash / deepseek-v4-flash-vision-exp 由 V4.1-Flash 提供服务、按 Flash 价计费。deepseek-v4-pro 官方已撤回 09-14 淘汰计划（计费方式保持不变），本政策未点名它=自动沿用 2026-08-23 政策旧价",
    weekendOffPeak: true,
    peak: {
      "deepseek-flash": {
        cny: { input: 2, cacheRead: 0.04, output: 8 },
        usd: { input: 0.3, cacheRead: 0.006, output: 1.2 }
      },
      "deepseek-v4-flash": {
        cny: { input: 2, cacheRead: 0.04, output: 8 },
        usd: { input: 0.3, cacheRead: 0.006, output: 1.2 }
      },
      "*": {
        cny: { input: 2, cacheRead: 0.04, output: 8 },
        usd: { input: 0.3, cacheRead: 0.006, output: 1.2 }
      }
    },
    offPeak: {
      "deepseek-flash": {
        cny: { input: 1, cacheRead: 0.02, output: 4 },
        usd: { input: 0.15, cacheRead: 0.003, output: 0.6 }
      },
      "deepseek-v4-flash": {
        cny: { input: 1, cacheRead: 0.02, output: 4 },
        usd: { input: 0.15, cacheRead: 0.003, output: 0.6 }
      },
      "*": {
        cny: { input: 1, cacheRead: 0.02, output: 4 },
        usd: { input: 0.15, cacheRead: 0.003, output: 0.6 }
      }
    }
  },
  {
    since: "2026-09-19T00:00:00+08:00",
    label: "节假日计费口径（官方 2026-09-19《API 峰谷时间说明》）：调休上班的周末 + 中国法定节假日全天一律按空闲时段计费；工作日峰谷时段与各模型单价均不变（本条逐模型照抄上一条的生效价，只新增 holidayOffPeak 规则，故不产生调价）",
    weekendOffPeak: true,
    holidayOffPeak: true,
    peak: {
      "deepseek-flash": {
        cny: { input: 2, cacheRead: 0.04, output: 8 },
        usd: { input: 0.3, cacheRead: 0.006, output: 1.2 }
      },
      "deepseek-v4-flash": {
        cny: { input: 2, cacheRead: 0.04, output: 8 },
        usd: { input: 0.3, cacheRead: 0.006, output: 1.2 }
      },
      "deepseek-v4-flash-vision-exp": {
        cny: { input: 2, cacheRead: 0.04, output: 8 },
        usd: { input: 0.3, cacheRead: 0.006, output: 1.2 }
      },
      "deepseek-v4-pro": {
        cny: { input: 9, cacheRead: 0.3, output: 27 },
        usd: { input: 1.32, cacheRead: 0.044, output: 3.96 }
      },
      "*": {
        cny: { input: 2, cacheRead: 0.04, output: 8 },
        usd: { input: 0.3, cacheRead: 0.006, output: 1.2 }
      }
    },
    offPeak: {
      "deepseek-flash": {
        cny: { input: 1, cacheRead: 0.02, output: 4 },
        usd: { input: 0.15, cacheRead: 0.003, output: 0.6 }
      },
      "deepseek-v4-flash": {
        cny: { input: 1, cacheRead: 0.02, output: 4 },
        usd: { input: 0.15, cacheRead: 0.003, output: 0.6 }
      },
      "deepseek-v4-flash-vision-exp": {
        cny: { input: 1, cacheRead: 0.02, output: 4 },
        usd: { input: 0.15, cacheRead: 0.003, output: 0.6 }
      },
      "deepseek-v4-pro": {
        cny: { input: 4.5, cacheRead: 0.15, output: 13.5 },
        usd: { input: 0.66, cacheRead: 0.022, output: 1.98 }
      },
      "*": {
        cny: { input: 1, cacheRead: 0.02, output: 4 },
        usd: { input: 0.15, cacheRead: 0.003, output: 0.6 }
      }
    }
  }
];

/** 某时刻生效的官方政策（第一个 `since` 之前取第一条）。 */
export function activePolicy(timeMs, policies = OFFICIAL_PRICING_POLICIES) {
  let active = policies[0];
  for (const policy of policies) {
    const since = Date.parse(policy.since);
    if (Number.isFinite(since) && timeMs >= since) active = policy;
  }
  return active;
}

/** 该时刻是否处于高峰时段（按指定时区与窗口判定；窗口为 [start, end) 小时）。 */
export function isPeak(timeMs, timezone = DEFAULT_TIMEZONE, windows = DEFAULT_PEAK_WINDOWS) {
  let hour;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      hour: "numeric",
      minute: "numeric"
    }).formatToParts(new Date(timeMs));
    hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0") % 24;
  } catch {
    // 非法时区等异常按非高峰处理，不阻断计价。
    hour = -1;
  }
  return windows.some(([start, end]) => hour >= start && hour < end);
}

/** 某时刻在指定时区是否为周六/周日（时区非法按工作日处理，不阻断计价）。 */
export function isWeekend(timeMs, timezone = DEFAULT_TIMEZONE) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short"
    }).formatToParts(new Date(timeMs));
    const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
    return weekday === "Sat" || weekday === "Sun";
  } catch {
    return false;
  }
}

/** 某时刻在指定时区的日历日（"YYYY-MM-DD"；时区非法返回 ""，不阻断计价）。 */
export function localDateKey(timeMs, timezone = DEFAULT_TIMEZONE) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date(timeMs));
    const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
    const year = get("year");
    const month = get("month");
    const day = get("day");
    return year === "" || month === "" || day === "" ? "" : `${year}-${month}-${day}`;
  } catch {
    return "";
  }
}

/** 该时刻是否中国法定节假日：是则返回节日名（如"中秋节"），否则 `null`。 */
export function cnHolidayName(timeMs, timezone = DEFAULT_TIMEZONE) {
  return CN_HOLIDAY_DATES.get(localDateKey(timeMs, timezone)) ?? null;
}

/** 该时刻是否调休上班日（周末补班；按官方口径仍按空闲时段计费）。 */
export function isCnMakeupWorkday(timeMs, timezone = DEFAULT_TIMEZONE) {
  return CN_MAKEUP_DATES.has(localDateKey(timeMs, timezone));
}

/** 节假日/调休数据的只读副本（界面展示口径用：原始时段 + 展开后的日期表）。 */
export function cnHolidayCalendar() {
  return {
    source: CN_HOLIDAY_SOURCE,
    periods: CN_HOLIDAY_PERIODS.map((period) => ({ name: period.name, from: period.from, to: period.to })),
    holidays: [...CN_HOLIDAY_DATES.keys()].sort(),
    makeup: [...CN_MAKEUP_DATES].sort()
  };
}

/**
 * 节假日表的"要不要补表"自检（面板据此提醒；表靠人补，官方不提供机器可读接口）。
 *
 * 什么时候提醒：
 *   ① 今天所在年份表里完全没有 → 随时提醒（漏一年，落在工作日的法定节假日会按高峰算）；
 *   ② 已进入 11 月而表里还没有次年条目 → 提醒补次年（国务院一般每年 11 月公布次年安排）。
 * 其余情况一律不提醒，免得变成天天挂着的噪音。
 *
 * @returns { today, latestYear, stale, missingYear, message } —— `stale: true` 时 `message`
 *   是可以直接显示给用户的中文提示（措辞放在这里，前端不再拼字符串，也便于测试锁住）。
 */
export function cnHolidayCoverage(timeMs, timezone = DEFAULT_TIMEZONE) {
  const today = localDateKey(timeMs, timezone);
  const todayYear = Number(today.slice(0, 4));
  const todayMonth = Number(today.slice(5, 7));
  let latestYear = 0;
  for (const period of CN_HOLIDAY_PERIODS) {
    const year = Number(period.to.slice(0, 4));
    if (Number.isFinite(year) && year > latestYear) latestYear = year;
  }
  const quiet = { today, latestYear, stale: false, missingYear: null, message: "" };
  if (!Number.isFinite(todayYear) || todayYear === 0 || latestYear === 0) return quiet;
  if (todayYear > latestYear) {
    return {
      today,
      latestYear,
      stale: true,
      missingYear: todayYear,
      message: `⚠️ ${todayYear} 年的放假安排还没收录（表里只到 ${latestYear} 年）：落在工作日的中国法定节假日会被当成高峰计费，请补 \`CN_HOLIDAY_PERIODS\`。`
    };
  }
  if (todayMonth >= 11 && latestYear < todayYear + 1) {
    return {
      today,
      latestYear,
      stale: true,
      missingYear: todayYear + 1,
      message: `⚠️ ${todayYear + 1} 年的放假安排还没收录：国务院一般每年 11 月公布次年安排，公布后往 \`CN_HOLIDAY_PERIODS\` 追加一条即可，否则明年落在工作日的法定节假日会按高峰计费。`
    };
  }
  return quiet;
}

/**
 * 按单个政策自己的规则判定高峰：`weekendOffPeak` 政策在周末、`holidayOffPeak` 政策在
 * 中国法定节假日一律非高峰（2026-09-19 起的官方口径）。
 */
function policyIsPeak(timeMs, timezone, windows, policy) {
  if (policy.weekendOffPeak === true && isWeekend(timeMs, timezone)) return false;
  if (policy.holidayOffPeak === true && cnHolidayName(timeMs, timezone) !== null) return false;
  return isPeak(timeMs, timezone, windows);
}

/** 在单张价格表内取模型单价（含 `*` 兜底）。 */
function priceFor(model, table) {
  return table[model] ?? table["*"] ?? ZERO_UNIT;
}

/** 把两个币种的单价合并（后者的存在键覆盖前者）。 */
function mergeUnit(base, over) {
  return {
    cny: { ...base.cny, ...(over?.cny ?? {}) },
    usd: { ...base.usd, ...(over?.usd ?? {}) }
  };
}

/**
 * 计算某模型在某一时刻的单价（双币种）。
 *
 * 解析顺序（政策链继承）：
 * 1. 从新到旧遍历「不晚于消息时刻」的政策，取第一个点名该模型的政策单价
 *    （被新政策下架的模型自动沿用旧政策价格，历史账单才与平台一致）；
 * 2. 没有任何政策点名 → 用最新适用政策的 `*` 兜底。
 *
 * 峰谷按各政策自己的规则判定（`weekendOffPeak` 政策在周末一律闲时）。
 *
 * @param model - 模型名。
 * @param timeMs - 消息时间（epoch ms）。
 * @param opts - { timezone, peakWindows, policies }。
 * @returns { cny, usd, mode, policy } — mode: 'flat' | 'peak' | 'offPeak'。
 */
export function priceAt(model, timeMs, opts) {
  const { timezone = DEFAULT_TIMEZONE, peakWindows = DEFAULT_PEAK_WINDOWS, policies = OFFICIAL_PRICING_POLICIES } = opts ?? {};
  const applicable = policies.filter((policy) => timeMs >= Date.parse(policy.since));
  const scope = applicable.length > 0 ? applicable : [policies[0]];
  let winner;
  let named = false;
  let baseTable;
  let peak = policyIsPeak(timeMs, timezone, peakWindows, scope[scope.length - 1]);
  for (let index = scope.length - 1; index >= 0; index--) {
    const policy = scope[index];
    peak = policyIsPeak(timeMs, timezone, peakWindows, policy);
    const table = policy.peak !== void 0 && policy.offPeak !== void 0
      ? (peak ? policy.peak : policy.offPeak)
      : policy.prices;
    if (table[model] !== void 0) {
      winner = policy;
      named = true;
      baseTable = table;
      break;
    }
  }
  if (winner === void 0) {
    winner = scope[scope.length - 1];
    peak = policyIsPeak(timeMs, timezone, peakWindows, winner);
    baseTable = winner.peak !== void 0 && winner.offPeak !== void 0
      ? (peak ? winner.peak : winner.offPeak)
      : winner.prices;
  }
  const unit = named
    ? priceFor(model, baseTable)
    : mergeUnit(priceFor(model, baseTable), void 0);
  return {
    cny: unit.cny,
    usd: unit.usd,
    mode: winner.peak !== void 0 && winner.offPeak !== void 0 ? (peak ? "peak" : "offPeak") : "flat",
    policy: { since: winner.since, label: winner.label }
  };
}

/**
 * 按 TokenUsage 与单价计算费用（双币种）与 token 拆分。
 * @param usage - `{ inputTokens, cacheReadTokens?, outputTokens }`（assistant/message 事件上报）。
 * @param unit - `priceAt` 返回的单价（`cny`/`usd`）。
 * @returns { inputTokens, cacheReadTokens, outputTokens, cost, costUsd }。
 */
export function costOf(usage, unit) {
  const inputTokens = usage.inputTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  // DeepSeek charges cache writes (prompt_cache_miss_tokens) at the ordinary
  // input price; only cache reads get the discounted hit price.
  const cost = (
    (inputTokens + cacheWriteTokens) * unit.cny.input +
    cacheReadTokens * unit.cny.cacheRead +
    outputTokens * unit.cny.output
  ) / 1e6;
  const costUsd = (
    (inputTokens + cacheWriteTokens) * unit.usd.input +
    cacheReadTokens * unit.usd.cacheRead +
    outputTokens * unit.usd.output
  ) / 1e6;
  return { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, cost, costUsd };
}
