# dsh-deepseek-billing

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web GUI 用的**轻量计费插件**。

安装后，你会在两个地方看到费用：

1. **每条 assistant 消息下方**：显示那一轮的合计费用与 token（只在该轮最后一条消息下显示一次，不重复刷屏）。
2. **会话标题栏右侧「计费」按钮**：实时显示 DeepSeek 余额 + 当前对话费用；点击展开面板，可查看按轮次展开的请求费用明细（含子代理会话）。

> 这是一个**精简版**：只做“看费用”，不做本地记账、不做自定义价格、不做设置面板——保持界面干净。

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
  - 推理 token 按“输出价”计费（与 DeepSeek 官方一致）
  - 历史政策时间表：模型改名、降价、下架都按**当时**价格计算，老消息的费用和平台账单对得上
  - 已收录至 **2026-09-10 V4.1-Flash 调价**（flash 系列降价、新增模型名 `deepseek-flash`；`deepseek-v4-pro` 计费不变）
- ✅ **会话日志回放**：读 DSH 持久化的会话日志重新计价，**重启前产生的费用也算进去**，不会漏。

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
    ├── index.js          # Host 侧：余额/会话费用/请求明细路由、DeepSeek 凭证解析
    ├── client.js         # 浏览器侧：消息费用徽标 + 标题栏计费按钮 + 明细面板
    └── pricing.js        # DeepSeek 官方价格表引擎（峰谷/周末闲时/缓存/推理 token）
```

---

## 安全性

- 浏览器只访问本地路由 `/api/dsh-deepseek-billing/balance`、`/api/dsh-deepseek-billing/session-cost`、`/api/dsh-deepseek-billing/requests`，**API Key 不会出现在前端**。
- 会话费用通过 DSH 会话日志回放计算，无需额外上传任何数据。

---

## 更新日志

完整记录见 [CHANGELOG.md](./CHANGELOG.md)。

**0.2.2（2026-09-13）**：**适配 DSH 0.1.5**——会话日志接口换代（`stat`/`open`）后改为双代自动识别，修掉"新版 DSH 上重启前的历史费用不回放"的静默降级；旧版 0.1.0-rc.6 路径保留。只改服务端日志读取，价格与界面未动。

**0.2.1（2026-09-13）**：内置 **2026-09-10 V4.1-Flash 调价政策**——flash 系列降价（闲时缓存命中输入 0.05 → 0.02 元、未命中输入 1.5 → 1 元、输出 4.5 → 4 元，高峰仍为 2 倍）；新增模型名 `deepseek-flash`；`deepseek-v4-pro` 因官方撤回下线计划而计费不变（自动沿用 08-23 旧价）。只动价格表，历史消息仍按当时政策计价。

**0.2.0（2026-08-25）**：首个公开版本（余额、逐条费用、会话明细、官方峰谷计价、会话日志回放）。

---

## License

MIT
