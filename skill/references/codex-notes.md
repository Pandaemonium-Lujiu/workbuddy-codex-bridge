# Codex 侧技术笔记（由 Codex 本人审阅补充，2026-10-14）

本文件是 Codex 对桥接技能的**增量审阅意见**，覆盖 app-server 协议、配置语义、审批/沙箱、线程续接等 Codex 侧专属知识。原始审阅由 Codex（gpt-6-luna，effort=medium，thread 01a13852-bcb5-70d3-97fe-fd8c2743ffb8）通过 `ask_codex` 返回。

## 一、Codex app-server 的协议边界

- `codex app-server` 是 Codex 客户端使用的本地 JSON-RPC 接口，适合需要**管理会话、接收流式事件、处理审批**的深度集成；不是把 CLI 命令包成简单请求/响应。
- stdio 传输使用**逐行 JSON（JSONL）**，协议为 JSON-RPC 2.0，但**线上消息省略 `"jsonrpc":"2.0"` 字段**。
- 初始化顺序：先 `initialize`，再发 `initialized`，之后才能 `thread/start` 与 `turn/start`。
- `codex exec` / CLI 非交互模式适合一次性脚本化任务；app-server 需客户端维护进程生命周期、事件流、会话状态，并处理服务端发起的审批请求。
- **协议字段应按实际运行的 Codex 版本核对**，不要当成稳定不变的通用 JSON-RPC API。
- 参考：https://developers.openai.com/codex/app-server/

## 二、TOML 与 MCP 加载要点

- `[mcp_servers.<name>]` 是服务器配置表；`command` 可执行程序、`args` 参数数组、`env` 字符串映射。**参数作为进程启动参数传递，不要依赖 shell 引号/变量展开/`&` 语法**。
- Windows 路径建议用 TOML 单引号字面字符串（`command = 'C:\Program Files\nodejs\node.exe'`）；双引号需转义反斜杠。
- `env = { KEY = "value" }` 内联表合法；复杂时改写为 `[mcp_servers.<name>.env]` 子表。**不要同时用两种方式重复定义同一张表**。
- `startup_timeout_sec` / `tool_timeout_sec`：分别控制 MCP 启动等待与单次工具调用超时。**官方默认 10 秒 / 60 秒**；桥用的 30/600 是覆盖值，不是全局默认。
- `enabled = false` 可暂停加载保留配置；`enabled_tools` / `disabled_tools` 可限制工具暴露（后者在启用之后应用）；`required = true` 会使服务器初始化失败时 thread 启动也失败。
- 排查用 `codex mcp list` 与 TUI 的 `/mcp`。
- 配置层级：用户级 `~/.codex/config.toml`；项目级 `.codex/config.toml` **仅在项目受信任时加载**，且不能覆盖所有机器级配置。**改配置后须确认客户端/app-server 是否已重新加载**，不要凭"文件已保存"判断生效。
- `WORKBUDDY_CLI_ENTRY` 须为**绝对路径字符串**；不要把 `%APPDATA%` / `%USERPROFILE%` 展开语法写进 TOML 后假设 Codex 会展开。
- 参考：https://developers.openai.com/codex/mcp/ 、 https://developers.openai.com/codex/config-reference/

## 三、审批与沙箱（两个独立控制面）

- 桥示例未显式设置 `approval_policy` / `sandbox_mode`，**不能仅凭 MCP 配置断定审批行为**；实际值可能来自用户/项目配置、启动参数或宿主策略。
- `approval_policy` 控制何时暂停请求批准；`sandbox_mode` 控制命令执行的文件/网络边界。**两者相关但不等价**——`never` 不代表沙箱关闭。
- app-server 客户端**必须消费审批请求并响应**；桥若未实现，遇到需审批操作时会等待或失败。
- `-c key=value` 覆盖仅对**这次子进程**生效（如递归防护的 `-c mcp_servers.workbuddy_bridge.enabled=false` 不等于永久修改用户配置）。
- **不要为无人值守直接把全局策略改成"永不审批"**；按工作目录、写入范围、网络需求选沙箱。

## 四、thread 与续接

- 新会话保存 `thread/start` 返回的 `thread.id`；下轮通过 `thread/resume` 续接同一持久 thread，再 `turn/start`。**不要把 `turn.id`、MCP 请求 ID 或桥自身请求 ID 当成 `thread_id`**。
- `thread_id`（Codex）与 `session_id`（WorkBuddy）**不可互换**；也不等于自动同步上下文——每次交接仍需传本轮目标、关键结论、文件路径、待办。
- 续接前确认**同机器、同 `CODEX_HOME`**、rollout 数据可访问；换用户/配置目录/本地数据后旧 ID 可能无法续接。**保存 ID ≠ 备份会话数据**。
- 续接时 `cwd`、模型、权限、可用 MCP 可能与原来不同；**不要假设续接恢复原进程环境/代理变量/工具连接**。
- app-server 应持续读 stdout 事件、按 `id` 匹配响应、以 `turn/completed` 状态判断结果（`failed` / `interrupted` **不是**成功）。只截文本增量会漏掉结束状态或审批请求。
- 长会话历史可能分页；不要假设一次 `thread/resume` 返回完整历史。

## 五、对陷阱第 8 条（模型）的修正

**模型可用性是账号、工作区权限与引擎版本相关的实测结果，不是稳定白名单。** 桥传入的模型名必须被当前 `CODEX_BIN` 支持且对已登录账号可用。升级引擎或权限变化后须重新验证；可用 app-server 的 `model/list` 获取当前可见模型（**可见 ≠ 一定可调用**）。出错时同时记录**引擎版本、模型名、返回错误**三者。

## 六、补充排查项（Codex 建议新增）

9. **启动超时 ≠ 工具超时**：`startup_timeout_sec` 太短 → MCP 初始化阶段失败；`tool_timeout_sec` 太短 → 调用执行期间超时。只在工具实际耗时长时延长后者。
10. **MCP 启动环境 ≠ 交互终端**：Codex 启动 MCP 子进程时的 `cwd`、PATH、代理、环境变量可能不同于已登录的 PowerShell。需特定目录时设 `cwd`；诊断时检查**子进程实际拿到的环境**。
11. **MCP 工具审批 ≠ shell 审批**：`default_tools_approval_mode` / `tools.<tool>.approval_mode` 管 MCP 工具审批；`approval_policy` / `sandbox_mode` 管命令执行边界。改一个不影响另一个。
12. **app-server 协议随版本演进**：升级 `CODEX_BIN` 后核对初始化/事件/审批/续接行为；必要时用 `codex app-server generate-ts` 或 `generate-json-schema` 生成匹配类型。
13. **递归禁用只影响子进程**：`-c` 禁用桥 MCP 不改变主 Codex 客户端工具列表；确认两侧工具分别在哪个进程加载。

## 七、决策树补充行

| 现象 | 首查 |
|---|---|
| thread 续接失败 / 找不到会话 | 是否换了 `CODEX_HOME`、Windows 用户或引擎数据目录；确认传的是 `thread.id`，检查本地会话数据是否还在 |
| `ask_workbuddy` 一直等待或审批失败 | app-server 是否收到审批请求；桥能否读取并响应服务端请求；检查 MCP 工具审批模式与 Codex 命令审批策略 |
| MCP 已配置但工具不可见 | 检查用户级/项目级配置、项目是否受信任、server 是否 `enabled`、工具过滤规则及是否已重新加载配置 |

## 八、"超时"诊断修正

原表述"调用超时数分钟 → 环境劫持致连 MCP/解密卡死"过于单一。**正确做法**：先区分 **MCP 启动阶段 / app-server turn 阶段 / WorkBuddy CLI 阶段 / 外层调用方超时**四个层次，分别检查 `startup_timeout_sec`、`tool_timeout_sec`、桥自身超时、CLI 超时，再看子进程环境、代理与日志。环境劫持/代理只是可能原因之一。
