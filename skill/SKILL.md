---
name: workbuddy-codex-bridge
description: 本机 WorkBuddy 与 OpenAI Codex 双向任务交接桥的部署、配置、调用与排错。当需要让 WorkBuddy 与 Codex 互相派活、传递上下文、续接会话，或桥接报错（"需要登录"/"Not connected"/端口占用/模型不支持/工具缺失/续接失败）时使用本技能。
agent_created: true
version: 2.1
contributors: [WorkBuddy (小Q), OpenAI Codex]
---

# WorkBuddy ↔ Codex 双向交接桥

## 用途

让本机两个 AI 通过 MCP 互相派活并延续各自会话：

- **正向** `WorkBuddy → Codex`：WorkBuddy 调 `ask_codex`，走 Codex **app-server**（stdio JSONL / JSON-RPC 2.0），返回 `thread_id` 续聊。
- **反向** `Codex → WorkBuddy`：Codex 调 `ask_workbuddy`，走 WorkBuddy **CLI headless** JSON 输出，返回 `session_id` 续聊。

两侧均本机 stdio 通信，不开放 HTTP 端口、不需要公网地址。

> **协议边界（Codex 补充）**：`codex app-server` 是面向"会话管理 + 流式事件 + 审批处理"的深度集成接口，**不是**把 CLI 包成简单请求/响应。stdio 走**逐行 JSON（JSONL）**，省略 `jsonrpc` 字段；顺序为 `initialize` → `initialized` → `thread/start` → `turn/start`。协议字段随版本演进，须按实际引擎版本核对。

## 架构与组件

| 组件 | 路径 |
|---|---|
| 桥脚本（两模式：`codex` / `workbuddy`） | `%USERPROFILE%\Documents\Codex\<date>\new-chat\outputs\workbuddy-codex-bridge\server.mjs` |
| WorkBuddy 侧 MCP 配置 | `%USERPROFILE%\.workbuddy\mcp.json` → server 名 `codex_bridge` |
| Codex 侧 MCP 配置 | `%USERPROFILE%\.codex\config.toml` → `[mcp_servers.workbuddy_bridge]` |
| 完整版 CLI（反向必需） | `%APPDATA%\npm\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy` |
| 内置 CLI（**不可用于反向**） | `%LOCALAPPDATA%\Programs\WorkBuddy\resources\app.asar.unpacked\cli\bin\codebuddy` |

## 前置条件

1. Node.js 已安装。
2. Codex 已安装并登录（`~/.codex/auth.json` 存在）。
3. **完整版 WorkBuddy CLI 已安装并登录**：`npm i -g @tencent-ai/codebuddy-code`，然后终端运行 `codebuddy` → 选「Log in via Chinese Site」→ 浏览器授权。
4. 桥脚本已加入两侧配置（见下）。

## 配置要点

### WorkBuddy 侧（`.workbuddy/mcp.json`）

```json
{
  "mcpServers": {
    "codex_bridge": {
      "type": "stdio",
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["<桥目录>\\server.mjs", "codex"],
      "env": {
        "CODEX_BIN": "<桌面 App 的 codex.exe 绝对路径，bin/<hash>/codex.exe>",
        "CODEX_BRIDGE_MODEL": "gpt-6-luna",
        "CODEX_BRIDGE_EFFORT": "low"
      }
    }
  }
}
```

- `CODEX_BIN` 必须指向**新版 Codex 引擎**（桌面 App 的 `bin/<hash>/codex.exe`，实测 0.162.x），**不要**用 WinGet 老版（0.125.0）——否则报 `model is not supported when using Codex with a ChatGPT account`。
- App 升级后 `bin/<hash>` 会变——桥已内置 `resolveCodexBin()` 自动发现（失效时扫 `bin\*\codex.exe` 取 mtime 最新），**无需手动同步**；仅当自动发现也失效（如目录结构变动）才需更新 `CODEX_BIN`。

### Codex 侧（`.codex/config.toml`）

```toml
[mcp_servers.workbuddy_bridge]
command = 'C:\Program Files\nodejs\node.exe'
args = ["<桥目录>\server.mjs", "workbuddy"]
env = { "WORKBUDDY_CLI_ENTRY" = "<完整版 CLI 的 bin/codebuddy 绝对路径>" }
startup_timeout_sec = 30
tool_timeout_sec = 600
```

> **TOML / 加载要点（Codex 补充）**
> - `command`/`args` 作为进程启动参数传递，**不经过 shell**——不要依赖引号、变量展开或 `&`。
> - Windows 路径用单引号字面字符串最省心；`env` 内联表合法，复杂时改 `[mcp_servers.workbuddy_bridge.env]` 子表，**勿重复定义同一张表**。
> - `startup_timeout_sec` / `tool_timeout_sec` 官方默认 **10s / 60s**；此处 30/600 是覆盖值。
> - `enabled = false` 可暂停保留配置；`enabled_tools`/`disabled_tools` 限制工具暴露；**`required = true` 会让该服务器初始化失败时，连带 `thread/start` 与 `thread/resume` 也失败**。
> - `WORKBUDDY_CLI_ENTRY` 必须是**已解析的绝对路径**，不要在 TOML 里写 `%APPDATA%` 期望被展开。
> - **配置来源与优先级**：用户级 `~/.codex/config.toml` 是默认来源，但实际生效还受 `CODEX_HOME`、启动参数、配置覆盖、宿主策略影响；项目级 `.codex/config.toml` **仅在项目受信任时**加载，且**部分机器级配置不能由项目配置覆盖**。**改配置后须确认客户端已重新加载**，别凭"文件已保存"判断生效。
> - 排查：`codex mcp list`、TUI 内 `/mcp`。

## 调用方式

- **WorkBuddy 内**：用 `ask_codex`；续聊传回上次 `thread_id`。关键参数：`access`（read-only 默认 / workspace-write）、`effort`（low~xhigh）、`cwd`。
- **Codex 内**：用 `ask_workbuddy`；续聊传回上次 `session_id`。

> **thread 续接（Codex 补充）**
> - 保存 `thread/start` 的 `thread.id`，续接用 `thread/resume` + `turn/start`。**别把 `turn.id` / MCP 请求 ID / 桥请求 ID 当 `thread_id`。**
> - `thread_id`（Codex）与 `session_id`（WorkBuddy）**不可互换**；ID 只标识会话，**不等于自动同步上下文**——每次交接仍需传目标、结论、路径、待办。
> - 续接要求**续接进程能访问原 thread 的本地持久数据**（同 `CODEX_HOME` 是确保这一点的常见办法，非协议硬性条件）。换用户/配置目录/数据后旧 ID 可能失效。**保存 ID ≠ 备份会话数据。**
> - 续接时 `cwd`/模型/权限/可用 MCP 可能不同；**不要假设恢复原环境与代理变量**。
> - app-server 客户端应**按请求 ID 匹配响应、持续读取事件流**；判成功看 `turn/completed` 状态（`failed` / `interrupted` 不算）。只截文本增量会漏掉结束状态或审批请求。
> - 长会话历史**可能需按游标分页读取**；`thread/resume` 不保证始终返回完整历史。

## 关键陷阱（按踩坑频率排序）

1. **改配置 → 信任失效**：WorkBuddy 对自定义 MCP 的信任按配置哈希签名，**任何一次修改 `codex_bridge` 配置（含 env）都会使信任失效**，需在界面（侧边栏「插件」→ 右上角「MCP 服务器」）重新信任/重连。表现：工具报 `Not connected`。
2. **内置 CLI 不能做反向**：它是 App 的受控组件——无 TUI 产物（无参数启动报 `Cannot find module '../dist/codebuddy'`）、凭证由 App 通过 prewarm IPC 注入（独立运行报 `Authentication required` 且卡数分钟）。**反向必须用完整版 npm CLI**。（App 的预热 IPC 客户端 `cbc-prewarm` 在 `resources/app.asar.unpacked/cli/bin/`，理论可 `activate` 借凭证跑会话，但当前无存活预热进程、未经实战验证，列为后续方向。）
3. **环境变量劫持**：App 会话注入 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1` / `CODEBUDDY_FORCE_HEADLESS_BUNDLE=1`（强制走宿主模式变体）、`CODEBUDDY_CONFIG_DIR`（劫持配置目录）等上百个变量。桥/脚本若要独立跑 CLI，**必须清除所有 `CODEBUDDY_*` / `WORKBUDDY_*` 变量**，否则必报"需要登录"。
4. **代理污染**：会话注入的 `HTTP_PROXY`（如 `127.0.0.1:49262`）常无法访问境外服务。Codex 报 `stream disconnected before completion` 时，改用可用代理（实测 `127.0.0.1:7890` 可通，HTTP 405 = 网络正常）或直连。
5. **端口占用**：CLI 启动会复用记录的端口，可能 `EADDRINUSE`。桥调用 CLI 时应传 `--port <随机端口>`。
6. **安全中心黑名单**：部分沙箱/安全策略拦截 `reg.exe`，导致完整版 CLI 无法读注册表解密凭证 → 报 `Authentication required`。此限制**不可绕过**，需在真实环境（普通终端）执行。
7. **递归防护**：桥调 Codex 时传 `-c mcp_servers.workbuddy_bridge.enabled=false`，故在 `ask_codex` 路径下看不到 `ask_workbuddy` 工具，属正常设计。**该覆盖只影响这次子进程**，不改主客户端工具列表。
8. **模型可用性不是稳定白名单**：`gpt-6-luna` / `gpt-6.1-sol` 曾实测可用，但模型可用性取决于**账号、工作区权限、引擎版本**。升级或权限变化后须重验；可用 app-server `model/list` 查询可见模型（**可见 ≠ 可调用**）。排错时同时记录引擎版本 + 模型名 + 返回错误。

> **Codex 补充的排查项**
> 9. **启动超时 ≠ 工具超时**：前者影响 MCP 初始化，后者影响调用执行；只在工具实际耗时长时延长后者。
> 10. **MCP 启动环境 ≠ 交互终端**：子进程的 `cwd`/PATH/代理/环境变量可能与已登录终端不同；诊断时检查**子进程实际拿到的环境**。
> 11. **MCP 工具审批 ≠ shell 审批**：`default_tools_approval_mode` / `tools.<tool>.approval_mode` 管 MCP 工具；`approval_policy` / `sandbox_mode` 管命令执行边界。两者独立。
> 12. **协议随版本演进**：升级 `CODEX_BIN` 后核对初始化/事件/审批/续接；必要时 `codex app-server generate-ts` / `generate-json-schema`。
> 13. **审批必须被消费**：app-server 客户端须读取并响应服务端审批请求，否则相关操作会挂起或失败；不要为无人值守而全局关审批。
>
> **第二轮实战补充（2026-10-14）**
> 14. **完整版 CLI 登录态有 TTL（实测约 7 小时）**：过期后报 `Authentication required. Please use /login command`。磁盘上无免交互恢复路径（local_storage/凭据管理器/溢写配置/DPAPI 全部排除，见 pitfalls.md 认证考古）。修复：终端 `codebuddy` → TUI `/login` → 浏览器授权。桥的 `classifyWorkBuddyFailure` 会直接把该修复指令抛给调用方。
> 15. **从 `ask_codex` 路径内测反向必败**：桥传 `-c mcp_servers.workbuddy_bridge.enabled=false` 防递归（陷阱 7），反向测试必须从 Codex 自己的会话发起；用 `codex exec -c approval_policy=never -c mcp_servers.workbuddy_bridge.default_tools_approval_mode=auto "调用 ask_workbuddy..."` 可手动模拟（注意 `default_tools_approval_mode` 无 `never` 值）。

## 排错决策树

| 现象 | 首查 |
|---|---|
| `Not connected`（WorkBuddy 侧） | 是否改过配置 → 重新信任 MCP |
| 反向报"需要登录" | 三步：① 是否用了内置 CLI → 换完整版；② 环境变量是否被劫持；③ **完整版登录态是否过期（TTL 约 7h）→ 终端 `codebuddy` → `/login`** |
| `Cannot find module '../dist/codebuddy'` | 误用内置 CLI 走 TUI 分支 → 换完整版 |
| 模型不支持 | `CODEX_BIN` 是否指向老引擎 |
| 正向 `spawn ...codex.exe ENOENT` | App 升级换了引擎 hash → 桥已自动发现；仍失败则检查 `bin` 目录结构 |
| 调用超时 | **先分层**：MCP 启动 / app-server turn / CLI / 外层调用方，分别查 `startup_timeout_sec`、`tool_timeout_sec`、桥超时、CLI 超时，再看子进程环境与日志 |
| thread 续接失败 / 找不到会话 | 是否换 `CODEX_HOME`、Windows 用户或引擎数据目录；确认传的是 `thread.id` |
| `ask_workbuddy` 一直等待或审批失败 | app-server 是否收到审批请求、桥能否响应；检查 MCP 工具审批与命令审批策略 |
| MCP 已配置但工具不可见 | 检查用户级/项目级配置、项目是否受信任、`enabled`、工具过滤、是否已重新加载 |
| PowerShell `UnexpectedToken` | 命令以引号路径开头 → 前置 `&` 调用运算符 |

## 验收

- **正向**：WorkBuddy 调 `ask_codex` 发一个 ping，应返回 `thread_id` + 正确回显。（2026-10-14 复验通过：ping 回环 + 监视器捕获双向消息；引擎 hash 自动发现生效。）
- **反向**：普通终端运行 `scripts/bridge_ping_workbuddy_test.mjs`（先改 `CLI_ENTRY` 为完整版路径），或让 Codex 调 `ask_workbuddy`，应返回 `session_id` + 正确回显。**前置检查**：完整版 CLI 登录态在有效期内（过期表现：`Authentication required`，修复 `/login`）。

## 参考

- `references/pitfalls.md`：完整排查记录（现象 → 根因 → 修复 + 日志取证位置）
- `references/codex-notes.md`：Codex 审阅补充的 Codex 侧技术笔记（协议/配置/审批/续接）
- `scripts/bridge_ping_workbuddy_test.mjs`：反向链路可复用验证脚本
