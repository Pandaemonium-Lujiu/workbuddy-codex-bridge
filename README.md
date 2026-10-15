# WorkBuddy ↔ Codex 本机对话桥

这套桥接让 WorkBuddy 和 Codex 通过本机 MCP 工具互相发起对话，并分别延续各自的会话。

## 能力与权限

- WorkBuddy 侧提供 `ask_codex`，通过 Codex app-server 调用 Codex。默认只读；需要修改当前工作区时，调用参数可显式设为 `access: "workspace-write"`。
- WorkBuddy 侧还提供 `ask_dsh` / `ask_dsh_edit` / `list_dsh_sessions`（经 `dsh_bridge`），调用本机 DSH（DeepSeek Harness）。默认只读。
- `ask_codex` 默认显式使用 `gpt-6-luna` 和 `low` 推理强度，避免继承本机 Codex 配置中不可用或过慢的默认项；可通过 `CODEX_BRIDGE_MODEL`、`CODEX_BRIDGE_EFFORT` 覆盖，也可在调用时指定 `effort`。
- Codex 侧提供 `ask_workbuddy`，通过 WorkBuddy 自带 CLI 调用 WorkBuddy。默认 `plan` 模式；只有明确需要编辑工作区时，才设 `permission_mode: "acceptEdits"`。
- 两边返回 `thread_id` / `session_id`。后续调用传回同一 ID，即可续接该侧对话。
- 两边都在本机通过 stdio 通信，不需要开放 HTTP 端口或公网地址。
- 桥只负责提供对话工具；不会在一侧结束时自动唤起另一侧，也不会自行循环。由当前对话中的 AI 按任务需要调用对方。

## 本机前置条件

- Node.js 已安装。
- `codex` 已安装并已登录。
- **完整版 WorkBuddy CLI**（`npm i -g @tencent-ai/codebuddy-code`）通过 `WORKBUDDY_CLI_ENTRY` 指定入口（`%APPDATA%\npm\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy`）。**不要用 App 内置 CLI**——它是受控组件，凭证靠 App prewarm IPC 注入，独立运行必然"未登录"。
- WorkBuddy CLI 的登录态**有 TTL（实测约 7 小时）**，过期后 `ask_workbuddy` 会报 `Authentication required`。修复：终端运行 `codebuddy`，TUI 输入 `/login`，浏览器授权。桥内置错误分类器，会把该修复指令直接抛给调用方。

## 已内置的韧性设计（2026-10-14）

- **Codex 引擎自动发现**（`resolveCodexBin()`）：`CODEX_BIN` 失效时（如 App 升级换了 `bin/<hash>` 目录），自动扫描 `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` 取最新者，无需手动同步配置。
- **错误分类器**（`classifyWorkBuddyFailure()`）：CLI 失败时按 stderr 特征给出可执行修复指令——未登录（提示 `/login` 步骤）、端口占用（提示换端口）、429 额度（给出购买链接）、其余原样透出。
- **防递归保险丝**：桥调 Codex 时传 `-c mcp_servers.workbuddy_bridge.enabled=false`，故 `ask_codex` 路径下看不到 `ask_workbuddy`，属正常设计；反向测试须从 Codex 自己的会话发起。

## 已内置的韧性设计（2026-10-15，环境净化）

- **子进程环境净化**（`cleanWorkBuddyEnv()`）：spawn WorkBuddy CLI 前剔除 `CODEBUDDY_*` / `WORKBUDDY_*` / `CLAUDE_*` / `CLIENT_INFO_*` / `SANDBOX_*` / `ACC_*` / `GALILEO_*` 等宿主签名变量。其中 `CLIENT_INFO_PRODUCT_NAME="WorkBuddy"` 单变量即可让完整版 CLI 误判为"App 受控组件"去要宿主凭证，**假报** `Authentication required`（A/B 二分实测，与登录态无关）。
- **429 账号额度分类**：账号额度耗尽时直接把 https://www.codebuddy.cn/profile/usage 抛给调用方（换模型无效，额度是账号级）。

## 三方互通：DSH（DeepSeek Harness，2026-10-15）

本机第三个 AI 宿主 DSH 已接入同一套桥：

- **WorkBuddy → DSH**：WorkBuddy 侧注册 `dsh_bridge`（复用 Codex 侧建好的 `codex-dsh-bridge` 适配器），工具 `ask_dsh`（只读）/ `ask_dsh_edit`（工作区写）/ `list_dsh_sessions`（不调模型）。适配器自带 DSH Web 后端（`127.0.0.1:3082`，净环境 spawn、文件锁防重入、会话跨重启持久化），任何 MCP 客户端都能驱动。**需重启 WorkBuddy 会话后工具才可见。**
- **DSH → WorkBuddy**：DSH profile 的 Cordis 补丁（`%USERPROFILE%\.dsh\profiles\<web|desktop>\cordis.patch.yml`）新增 `mcp-workbuddy-bridge` 插件（`@deepseek-ai/dsh-mcp-client`，stdio），指向本桥 `workbuddy` 模式——与 Codex 侧同一条 `ask_workbuddy` 代码路径。**需重启 DSH 后生效。**
- 防递归：`codex-dsh-bridge/backend.patch.yml` 同步禁用 `mcp-workbuddy-bridge`，保持 DSH 后端是纯 Codex→DSH 路径。

实测：正向 `ask_dsh` 回显通过（模型 deepseek-V4.1-Flash）；反向 `ask_workbuddy` 代码路径验到 API 层（净化修复后认证通过），仅剩 WorkBuddy CLI 账号额度（429）待恢复。接入细节与坑见技能版 SKILL.md「三方互通：DSH」章节。

## 配置位置

安装脚本会在两个现有配置中各添加一个独立 MCP 项，不覆盖已有服务器：

- WorkBuddy：`%USERPROFILE%\.workbuddy\mcp.json`，服务器名 `codex_bridge`
- Codex：`%USERPROFILE%\.codex\config.toml`，服务器名 `workbuddy_bridge`

配置修改前会在原目录保存带时间戳的备份。WorkBuddy 需要重启或重新加载 MCP；Codex 需要重新加载配置或重启应用。

## 使用方式

在 WorkBuddy 中：

> 请用 `ask_codex` 让 Codex 只读检查当前项目的登录错误，并把结论和 `thread_id` 返回给我。

续谈时把之前返回的 `thread_id` 传给 `ask_codex`。

在 Codex 中：

> 请用 `ask_workbuddy` 让 WorkBuddy 只读检查当前项目的 README 结构，并把结论和 `session_id` 返回给我。

续谈时把之前返回的 `session_id` 传给 `ask_workbuddy`。如果任务确实需要 WorkBuddy 修改当前工作区，再明确指定 `permission_mode: "acceptEdits"`。

## 实现说明

MCP 工具由 `@modelcontextprotocol/sdk` 提供。WorkBuddy → Codex 使用 Codex app-server 的 stdio JSON-RPC；Codex → WorkBuddy 使用 WorkBuddy CLI 的非交互式 JSON 输出。Codex 官方文档推荐 app-server 用于需要持久对话和任务事件的集成；当前 Codex CLI 将 app-server 标为 experimental，因此其协议未来可能变化。
