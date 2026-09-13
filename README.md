# dsh-deepseek-billing

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web GUI 用的**轻量计费插件**。

安装后，你会在这些地方看到费用：

1. **每条 assistant 消息下方**：显示那一轮的合计费用与 token（只在该轮最后一条消息下显示一次，不重复刷屏）。
2. **会话标题栏右侧「计费」按钮**：实时显示 DeepSeek 余额 + 当前对话费用；点击展开面板，可查看按轮次展开的请求费用明细（含子代理会话）。

3. **计费面板里的「价格设置」页**（可选）：不填就完全按官方价表计算；需要时可在界面上维护自己的高峰价 / 闲时价。

> 定位是**轻量**：默认零配置，只做“看费用”；自定义价格是可选功能，不做本地记账、不做多账户结算——界面保持干净。

---

## 兼容性

- 在 DSH **0.1.0-rc.6** 与 **0.1.5-rc.2**（Web 版）上实测通过。会话日志回放会**自动识别两代接口**：
  - **0.1.5+**：`sessionPersistence.stat(id)` + `open(id, 'read')` → `handle.read()`（返回已解析事件）；
  - **旧版（0.1.0-rc.6）**：`readStoredRevision(id)` + `readRaw(id)`（JSONL 文本）。
- DSH 仍处于 rc 阶段，其余版本未验证；两代接口都不存在时自动退回简化计费，不会崩溃，但重启前的历史费用与子代理明细会缺失。
- 桌面版未测试（上游同类插件声明 web/desktop 通用，理论上可用）。

---

## 功能

- ✅ **实时余额**：从 DeepSeek API 读取账户余额（`GET /user/balance`），按钮上直接显示。
- ✅ **每条消息费用**：assistant 消息下方显示当轮合计费用 + token（输入/缓存/输出/推理）。
- ✅ **会话费用明细**：标题栏按钮点开，按**轮次**分层展示每次请求的费用与 token，**子代理会话**单独归类、可展开。
- ✅ **官方计价**：内置 DeepSeek 官方价格表引擎（`pricing.js`），支持：
  - 峰谷定价：工作日高峰 09:00-12:00 / 14:00-18:00（北京时间），闲时半价
  - 周末全天闲时：2026-08-23 起周六/周日一律闲时价
  - 缓存命中 / 缓存写入的差异化计价
  - 推理 token 已含在输出 token 中，**不重复计价**
  - 历史政策时间表：模型改名、降价、下架都按**当时**价格计算，老消息的费用和平台账单对得上
  - 已收录至 **2026-09-10 V4.1-Flash 调价**（flash 系列降价、新增模型名 `deepseek-flash`；`deepseek-v4-pro` 计费不变）
- ✅ **会话日志回放**：读 DSH 持久化的会话日志重新计价，**重启前产生的费用也算进去**，不会漏。
- ✅ **价格设置（可选）**：在面板里维护自己的价格表——按模型（或 `*` 表示所有模型）填**高峰价 / 闲时价**与**生效时间**。自定义价只影响 CNY（USD 仍用官方同刻价），且**只对自己的生效时间之后的请求生效**：改价不改写更早的账，历史账单依旧可复现。官方价表保留为兜底，删掉自定义条目即回退官方价。

---

## 安装

需要 DSH CLI（以及 Node.js ≥ 18，如使用一键安装器）。

### 方式一：一条命令安装（推荐）

在 `dsh-deepseek-billing` 目录内执行：

```sh
node scripts/install.js --from . --force
```

它会自动把插件拷贝到 `$DSH_HOME/profiles/node_modules/dsh-deepseek-billing`，并把加载条目写入 `$DSH_HOME/profiles/web/cordis.patch.yml`。

### 方式二：使用 DSH CLI

在 `dsh-deepseek-billing` 的**父目录**执行：

```sh
dsh plugin --profile web add ./dsh-deepseek-billing
```

安装后，无论哪种方式：

1. 重启 Web 应用：`dsh web`
2. 打开 `http://127.0.0.1:3080` 并刷新页面
3. 进入任意会话，标题栏右侧出现「计费」按钮

> 手动安装方式：把 `dsh-deepseek-billing` 放到 profile 的 `node_modules`，并在
> `~/.dsh/profiles/web/cordis.patch.yml` 中加入：
>
> ```yaml
> - insert:
>     - id: dsh-deepseek-billing
>       name: dsh-deepseek-billing
> ```

---

## 配置 DeepSeek API Key

插件通过 DSH 已有的 `DEEPSEEK_API_KEY` 凭证读取余额：

- 在 **设置 → 模型** 页面填写 DeepSeek API Key；
- 或启动时设置环境变量 `DEEPSEEK_API_KEY`；
- 凭证保存在 `~/.dsh/.credentials.yaml`。

---

## 官方调价了怎么办

价格表维护在 `lib/pricing.js` 的 `OFFICIAL_PRICING_POLICIES`（政策时间表）：

- 官方调整价格或峰谷规则时，**追加**一个带 `since`（生效时刻，含 `+08:00` 时区偏移）的新条目即可，峰谷规则变化可配合 `weekendOffPeak` 等字段表达；
- 不需要修改旧条目——历史消息仍按当时的政策计价，只有 `since` 之后的消息用新价格；
- 改完执行 `npm run check` 做语法自检；
- 价格策展自 [DeepSeek 官方价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)，官方调整后欢迎提 PR 同步。

---

## 价格设置（可选）

面板里的「价格设置」页可以维护自己的价格表，**不用改代码**：

- **怎么填**：模型（具体模型名，或 `*` 表示所有模型未命中时的通用价）、**高峰价 / 闲时价**（输入缓存未命中 / 缓存命中 / 输出，单位 元/百万 tokens）、**生效时间**（例如 `2026-09-13 12:00`，按北京时间）。
- **存哪**：`$DSH_HOME/billing-prices.json`（可用环境变量 `DSH_BILLING_PRICING_FILE` 覆盖；未设置 `DSH_HOME` 时回退到 `~/.dsh`）。写盘是**原子写**（先写 `.tmp` 再改名）；文件损坏只会被跳过并提示，**不会影响计费本身**。
- **怎么生效**：每条自定义价只对**自己的生效时间之后**的请求生效——改价不改写更早的账，历史账单仍可复现。同一时刻多条命中时，精确匹配模型优先于 `*`，同类里生效时间最新的胜出。
- **币种**：自定义价只覆盖 **CNY**；USD 继续沿用官方同刻价。
- **怎么回退**：官方价表始终保留为兜底。删掉自定义条目就回到官方价，把整个文件删掉也一样。

---

## 文件结构

```text
dsh-deepseek-billing/
├── package.json          # DSH bundle/client 声明
├── cordis.patch.yml      # 插件加载条目
├── README.md
├── LICENSE
├── scripts/
│   └── install.js        # 一键安装器
└── lib/
    ├── index.js          # Host 侧：余额/会话费用/请求明细/价格设置路由、凭证解析、计费修正
    ├── client.js         # 浏览器侧：消息费用徽标 + 标题栏计费按钮 + 明细面板 + 价格设置页
    ├── user-pricing.js   # 用户自定义价格层（价格设置的服务端；读写 billing-prices.json）
    └── pricing.js        # DeepSeek 官方价格表引擎（峰谷/周末闲时/缓存/推理 token）
```

---

## 安全性

- 浏览器只访问本地路由 `/api/dsh-deepseek-billing/balance`、`/api/dsh-deepseek-billing/session-cost`、`/api/dsh-deepseek-billing/requests`、`/api/dsh-deepseek-billing/pricing`，**API Key 不会出现在前端**。
- 会话费用通过 DSH 会话日志回放计算，无需额外上传任何数据。
- 价格设置只读写本地文件 `$DSH_HOME/billing-prices.json`（原子写），不发起任何外部请求。

---

## 更新日志

完整记录见 [CHANGELOG.md](./CHANGELOG.md)。

**0.4.0（2026-09-13）**：**移除「历史用量」功能**——面板不再统计"你在每档价格用了多少次/花了多少"，同时删掉后台扫全部会话的代码与 `/usage-by-policy` 接口（少读一堆本地会话、少一个接口）。面板只保留：当前生效价 / 我的调价记录 / 官方历史价。

**0.3.1（2026-09-13）**：面板的用量区块带上 `data-dsh-billing-section="usage"` 标记，便于自定义 CSS 定位；移除客户端内部写死的显示开关。（该功能与标记已在 **0.4.0** 一并移除。）

**0.3.0（2026-09-13）**：新增**价格设置面板**（界面上维护自己的高峰价/闲时价与生效时间，数据存 `$DSH_HOME/billing-prices.json`；只影响 CNY、只对生效时间之后的请求生效、官方价表兜底）；修正**推理 token 重复计费**。

**0.2.2（2026-09-13）**：**适配 DSH 0.1.5**——会话日志接口换代（`stat`/`open`）后改为双代自动识别，修掉"新版 DSH 上重启前的历史费用不回放"的静默降级；旧版 0.1.0-rc.6 路径保留。只改服务端日志读取，价格与界面未动。

**0.2.1（2026-09-13）**：内置 **2026-09-10 V4.1-Flash 调价政策**——flash 系列降价（闲时缓存命中输入 0.05 → 0.02 元、未命中输入 1.5 → 1 元、输出 4.5 → 4 元，高峰仍为 2 倍）；新增模型名 `deepseek-flash`；`deepseek-v4-pro` 因官方撤回下线计划而计费不变（自动沿用 08-23 旧价）。只动价格表，历史消息仍按当时政策计价。

**0.2.0（2026-08-25）**：首个公开版本（余额、逐条费用、会话明细、官方峰谷计价、会话日志回放）。

---

## License

MIT
