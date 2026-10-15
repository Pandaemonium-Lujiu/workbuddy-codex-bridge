# 完整排查记录（2026-10-13 ~ 10-14 实战）

本文件记录 WorkBuddy ↔ Codex 双向桥从零打通时踩过的全部坑与证据，供后续复现和排错参考。

## 时间线与根因

### 阶段一：正向 WorkBuddy → Codex

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | `The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account` | 桥的 `CODEX_BIN` 指向 WinGet 老引擎 codex 0.125.0 | 改指桌面 App 引擎 `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`（0.162.x） |
| 2 | `Not connected`（App 侧） | 改过 `codex_bridge` 配置 → 信任哈希失效 | UI 重新信任该 MCP |
| 3 | `stream disconnected before completion: ... chatgpt.com/backend-api/codex/responses`（耗时 432s） | 会话注入的代理 `127.0.0.1:49262` 对境外不通 | 改用 `127.0.0.1:7890` |
| 4 | 配置改了仍不生效 | App 的 MCP 管理器需重载 | 重启 WorkBuddy |

**验证成功的证据**：`ask_codex` 返回 `thread_id` + 正确回显；同 thread 续聊能记住上下文。

### 阶段二：反向 Codex → WorkBuddy

| # | 现象 | 根因 | 结论 |
|---|---|---|---|
| 5 | `Authentication required. Please use /login command` | 反向调的是**内置 CLI**，它是 App 受控组件，凭证靠 App prewarm IPC 注入 | 换完整版 npm CLI |
| 6 | `Cannot find module '../dist/codebuddy'` | 内置 CLI 无 TUI 产物，无参数启动走 TUI 分支且无 fallback | 内置版无独立交互界面，无法 `/login` |
| 7 | 独立跑 CLI 卡 4-8 分钟后 `userId -> <empty>` | 无凭证引导（`AtRestEncryption missing-key`、`hasAccessToken=false`） | 同上 |
| 8 | 跑完整版仍报 `Authentication required` | 环境变量劫持（`CODEBUDDY_CONFIG_DIR` 指向 App 目录 + `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1` 强制宿主变体） | 清空所有 `CODEBUDDY_*`/`WORKBUDDY_*` 变量 |
| 9 | `EADDRINUSE 127.0.0.1:56641` | CLI 复用记录端口，被占用 | 调用时传 `--port <随机>` |
| 10 | `PROGRAM BLOCKED ... reg.exe` | 沙箱程序黑名单拦截（完整版 CLI 需读注册表解密凭证） | 不可绕过，须在普通终端执行 |
| 11 | Codex 内看不到 `ask_workbuddy` 工具 | 桥调 Codex 时传 `-c mcp_servers.workbuddy_bridge.enabled=false`（防递归） | 正常设计 |

**最终验证成功的证据**（用户普通 PowerShell 执行）：
- `[4] 工具返回（耗时 9s），isError = false`
- `session_id: codexwb-831ea19d145344699d7b45c19f35b743`
- CLI 会话文件中 `role:assistant` / `type:output_text` / `text:"WB-CODEX-PING-20261014-A1B2"`，`status=completed`

## 关键区分（最容易混淆的两点）

1. **"能连 MCP 服务" ≠ "自己是 MCP 服务"**：WorkBuddy 是 MCP **客户端**（无服务端模式）；Codex 两者皆是（`codex mcp-server` 暴露 `codex`/`codex-reply`）。所以原生双向不成立，反向必须自建桥。
2. **桌面 App 与内置 CLI 是两套凭证体系**：App 凭证在 `~/.workbuddy/keyblob`（经 prewarm 注入），CLI 独立凭证在 `~/.codebuddy/local_storage/entry_*.info`。桥的反向不能用内置 CLI。

## 日志取证位置

| 目标 | 路径 |
|---|---|
| WorkBuddy 主线程 / MCP 生命周期 | `~/.workbuddy/logs/<date>/workbuddyMainThread__*.log` |
| 桥进程日志 | `~/.workbuddy/logs/<date>/workbuddy-codex-bridge__*.log` |
| CLI 会话（环境相关） | `~/.codebuddy/logs/<date>/*.log` |
| CLI 任务状态 | `~/.codebuddy/jobs/<shortId>/state.json` |
| Codex 会话记录 | `~/.codex/sessions/<yyyy>/<mm>/<dd>/*.jsonl` |
| 凭证文件 | App：`~/.workbuddy/keyblob`；CLI：`~/.codebuddy/local_storage/entry_*.info` |

## 编码陷阱（Windows 中文环境通用）

| # | 现象 | 根因 | 处置 |
|---|---|---|---|
| 12 | 通过 AI 命令沙箱读取中文 md 并 print 回显 → 中文变 `�`，AI 误判"文件损坏" | Windows Python/PowerShell 默认 stdout 编码 CP936（GBK），回传链路按错误编码解读 | **文件本身是好的**。用字节级验证绕开显示编码：`open(f,'rb')` 查 BOM、`decode('utf-8-sig')` 是否抛错、布尔断言（如 `text.startswith('# WorkBuddy')`）——hex/布尔不受显示编码影响 |
| 13 | 无 BOM 的中文 md 在 Windows 工具链下被按 ANSI/GBK 解读 | 部分 Windows 读取器（PowerShell 5.1 Get-Content 等）对无 BOM 文件不按 UTF-8 处理 | 写中文 md 时统一带 **UTF-8 BOM**：`Buffer.concat([Buffer.from([0xEF,0xBB,0xBF]), buf])` |
| 14 | `↔` 等 Unicode 装饰符号在某些显示链路损坏 | 特殊符号跨编码环境不稳 | 正式文档/配置避免装饰性 Unicode 符号，用普通文字（如"与"代替"↔"） |

## 第二轮实战（2026-10-14 晚：复测 + 根治 + 认证考古）

### 正向加固：引擎 hash 自动发现（已根治）

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 15 | `spawn ...bin\2e5e00daee91c61d\codex.exe ENOENT` | Codex 桌面 App 升级换了引擎 hash 目录（版本不变 0.162.x） | 桥新增 `resolveCodexBin()`：`CODEX_BIN` 失效时自动扫 `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` 取 mtime 最新者 |

修复后实测：ping 回环成功（模型 gpt-6-luna，监视器捕获双向消息）。此后 App 再升级换 hash 无需人工干预。

### 反向断链：CLI 登录 token 有 TTL（约 7 小时）

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 16 | `ask_workbuddy` 报 `Authentication required. Please use /login command` | 完整版 CLI 登录态有时效：今早 10:42/10:44/11:51 三次反向全成（auth_success），18:51 失效；App 当天 10:40:30 重启过，token 寿命约 7 小时 | 终端跑 `codebuddy`，TUI 输入 `/login`，浏览器授权 |

**桥已加错误分类器**（`classifyWorkBuddyFailure`，零额外开销）：命中 `Authentication required` 时直接抛中文可执行修复指令（含 /login 步骤）；`EADDRINUSE` 提示换端口；其余原样透出保留排查线索。

### 认证考古（证明"磁盘上无法免交互恢复登录态"）

按"token 可能藏在哪"逐个排除（2026-10-14 实测）：

| 位置 | 结果 |
|---|---|
| `~/.codebuddy/local_storage/entry_*.info` | 只有用户配置（userId/agents/models），**无 token 键**（按用户名反查亦无） |
| `~/.workbuddy/.credentials.json` | 仅 MCP OAuth（lighthouse-ops），无用户登录态 |
| `~/.workbuddy/cache/acc-product-config-v3.json` 与 `conversation-product-spill/*`（App 溢写产品配置） | `authentication.type=account-scoped-external-link`，**无原始 token** |
| Windows 凭据管理器（cmdkey /list） | 无 codebuddy/workbuddy 条目 |
| App 的 `Local Storage/leveldb` 与 `IndexedDB` | 有 userId/sessionid，token 为 DPAPI 加密不可提取 |
| JWT 特征串（eyJ）全盘扫 | 无真实 token（仅分页 cursor 与二进制噪声） |

**结论**：CLI 登录态无法从磁盘恢复，过期后唯一路径是交互式 `/login`。"自动续登录"不可行；错误分类器把修复指令直接送到眼前是目前最优解。

### cbc-prewarm：App 的预热 IPC（未来可省的交互）

App 安装目录 `resources/app.asar.unpacked/cli/bin/cbc-prewarm` 是预热进程管理 CLI（`list/ping/status/activate/kill`）。App 以 `node <内置cliPath> --prewarm --prewarm-id <id>` 加注入环境拉起带凭证的预热进程，`activate` 可借其凭证跑会话。**实测当前无存活预热进程**（`list` 为空），激活链路未经实战验证——列为后续优化方向，非当前依赖。

### codex exec 手动复现反向的坑

- `mcp_servers.workbuddy_bridge.default_tools_approval_mode` 合法值仅 `auto/prompt/writes/approve`（**无 never**）；手动复现反向外围参数用 `-c approval_policy=never`，但 **`default_tools_approval_mode` 必须用 `approve`**——用 `auto` 会报 `MCP tool call requires approval, but approval policy is never`（2026-10-15 实测：`auto` 把 ask_workbuddy 判为需审批后遭 never 拒绝，`approve` 直接放行）。
- ** stdin 必须关**：exec 打印 `Reading additional input from stdin...` 后挂等 EOF，命令尾加 `< /dev/null`。
- **代理必须显式覆盖**：App 注入的 `HTTP_PROXY=127.0.0.1:64116` 会死（连接拒绝/502），codex 连 `wss://chatgpt.com` 重连 5 次后挂死；实测 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY=http://127.0.0.1:7890` + `NO_PROXY=127.0.0.1,localhost` 可通。
- 从 `ask_codex` 路径内测反向必败：桥传 `-c mcp_servers.workbuddy_bridge.enabled=false` 是防递归保险丝（正常设计），反向测试必须从 Codex 自己的会话发起。

## 第三轮实战（2026-10-15：ACP 程序化登录 + 双向全链路复验通过）

### ACP 协议登录（免 TUI，本轮最大突破）

前置：完整版 CLI v2.164.0；**必须净环境 spawn**（App 注入的 `CODEBUDDY_*` + 代理变量会让 CLI 启动约 2.6 秒后退岀，只传 PATH/SystemRoot/TEMP/USERPROFILE/APPDATA 等系统必需变量）。

协议序列（stdio JSONL）：

1. `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}` → 响应带 `authMethods`：`iOA` / `external`（Google/Github）/ `internal`（微信）/ `selfhosted`（企业域）。
2. `{"jsonrpc":"2.0","id":2,"method":"authenticate","params":{"methodId":"internal"}}` → 服务端发通知 `_codebuddy.ai/authUrl`（`https://copilot.tencent.com/login?platform=CLI&state=<UUID>&version=2.164.0`）。
3. 用户浏览器授权（约 40 秒）→ stderr 出现 `Successfully signed in.` → id=2 响应携带 `_meta.codebuddy.ai/userinfo`（userId/userName/authType）。
4. 登录态**持久化到磁盘**：随后净环境 headless `--print` ping 直接回环（`WB-CLI-PING-1015-OK`，13.1s），无需再走 ACP。

参考实现：`scripts/acp_auth_driver.mjs`（净环境 spawn + 协议序列 + 捕获 authUrl 落盘 + 600s 等授权）。端口须显式传随机高端口（`--port`），否则可能撞 App 服务代理端口（EADDRINUSE）。

### SKILL.md BOM 陷阱

codex 报 `failed to load skill ...SKILL.md: missing YAML frontmatter delimited by ---`——文件头 UTF-8 BOM（`EF BB BF`）把 frontmatter 分隔符顶掉了。中文 md 给人看可带 BOM，**机器解析的技能文件必须剥 BOM**。本轮 6 个文件（SKILL.md + references×2，部署副本与仓库副本）已剥。

### 双向复验结果（2026-10-15）

| 方向 | 命令 | 结果 |
|---|---|---|
| 正向 | `ask_codex`（effort=low, read-only） | ✅ `WB-FORWARD-PING-1015-OK`（thread_id 返回） |
| 反向 | `codex exec --skip-git-repo-check -c approval_policy=never -c mcp_servers.workbuddy_bridge.default_tools_approval_mode=approve -c model_reasoning_effort=low "..." < /dev/null`（代理覆盖 7890） | ✅ `WB-REVERSE-PING-1015-OK`；stderr `mcp: workbuddy_bridge/ask_workbuddy started → (completed)`；监视器 5988 捕获 `workbuddy user → assistant` |

其余 MCP 报错（ardot 50501 连接拒绝、wielokskillhub 401、chatgpt challenge 403）均为 config.toml 里**其他** MCP 服务器的既有噪声，不影响桥链路。

## 第四轮实战（2026-10-15 下午：DSH 三方互通 + 环境净化根因）

### 环境变量污染：假 "Authentication required" 的真根因（A/B 二分定位）

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 17 | 反向 `ask_workbuddy` 在 App 会话内必报 `Authentication required`，同机极净环境必通 | App 会话向子进程注入 `CLIENT_INFO_PRODUCT_NAME="WorkBuddy"`（**最强触发源，单变量即可复现**）；`SANDBOX_*` 需组合触发；`CODEBUDDY_*`/`WORKBUDDY_*`/`CLAUDE_*`/`ACC_*`/`GALILEO_*` 为其余已知劫持面。CLI 据此误判自己是"App 受控组件"去要宿主凭证 | 桥内 `cleanWorkBuddyEnv()`：spawn CLI 前按前缀黑名单剔除全部宿主签名变量（2026-10-15 内置 server.mjs） |

实验方法：逐组加回二分（`env_bisect` → `env_solo` 单变量复测 → `env_confirm` 确认），全部探针在 `D:\WB\_tmp\`。**与登录态无关**——净化后同一登录态的错误从"未登录"变为"429 额度"（认证层通过的直接证据）。复验探针 `mcp_wb_e2e_probe_b3.mjs`：外层环境原样保留 `CLIENT_INFO_PRODUCT_NAME=WorkBuddy` + 4 个 `SANDBOX_*`，只由桥内部净化，CLI 一路打到 API 层。

**旧认知修正**：#10 认为 reg.exe 黑名单"必然导致 Authentication required、不可绕过"——判断过强。实测黑名单拦截时 CLI 打印 notice（`Suppress this notice with: CODEBUDDY_SKIP_GIT_BASH_CHECK=1`）后仍继续执行到 API 层；真实根因是环境变量污染。

### DSH 互通接入（2026-10-15）

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 18 | DSH 临时实例启动即崩 `duplicate loader entry id: mcp-wielo-skillhub` | 该插件 id 在 web 与 desktop 两个 profile 的 `cordis.patch.yml` 中都存在，两 patch 叠加加载即重名崩宿主（**改动前既有隐患**，非本轮引入） | 单 profile 单独加载均正常；DSH Desktop 入口（desktop profile）可正常用。日常勿让 web+desktop 叠加加载 |
| 19 | DSH 零成本验证脚本报 `Unexpected token 'o', "not found"` | DSH 的 `/api/mcp.list` 等 HTTP 端点不存在（返回纯文本 not found），JSON.parse 失败 | 改用**手工 MCP stdio 客户端**驱动适配器（initialize → tools/list → tools/call）；`list_dsh_sessions` 不调模型，可零额度验通路 |

三处配置落地（YAML/JSON 全部语法校验通过）：

1. WorkBuddy `~/.workbuddy/mcp.json` → `dsh_bridge`（node + codex-dsh-bridge/server.mjs，env NO_PROXY）——**需重启 WorkBuddy 会话生效**。
2. DSH `~/.dsh/profiles/web/cordis.patch.yml` 与 `~/.dsh/profiles/desktop/cordis.patch.yml` → `mcp-workbuddy-bridge` 插件（`@deepseek-ai/dsh-mcp-client`，stdio；`serverName: workbuddy_bridge` 在存活实例内唯一；`failOnStartupError: false`）。
3. `codex-dsh-bridge/backend.patch.yml` → `mcp-workbuddy-bridge` `disabled: true`（防 DSH 后端会话递归回呼 WorkBuddy，保持后端是纯 Codex→DSH 路径）。

验证结果：

| 方向 | 方法 | 结果 |
|---|---|---|
| WorkBuddy → DSH | 手工 MCP 客户端驱动 `dsh_bridge` → `ask_dsh` | ✅ `DSH-SMOKE-1015-OK`（deepseek-V4.1-Flash；3082 后端会话持久化正常，旧会话可枚举） |
| DSH → WorkBuddy | 探针 B3 驱动 workbuddy 模式桥（= DSH 插件同一条代码路径） | ⛔ 验到 API 层（净化修复后认证通过），仅剩账号 429 额度墙 |

### 429 账号额度（当前唯一阻断）

现象：`429 额度已用尽，请访问以下链接，购买加量包以获取更多额度：https://www.codebuddy.cn/profile/usage`。换模型（glm-5.3-flash / qwen3.5-max / deepseek-v4.1-flash / 默认）均 429 → **账号级**，与模型选择、登录态无关。处置：桥的 `classifyWorkBuddyFailure` 加 429 分支直接把购买链接抛给调用方；待缴费/购买后重跑 `mcp_wb_e2e_probe_b3.mjs` 同类探针闭环。

## 备份记录（本机）

- `server.mjs.bak-20261013_1733`、`server.mjs.bak-20261013_1838`
- `~/.workbuddy/mcp.json.bak-20261013_1731`
- `~/.codex/config.toml.bak-20261013_1838`
