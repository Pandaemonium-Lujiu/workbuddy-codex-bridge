import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const VERSION = "1.0.0";
const TIMEOUT_MS = Number(process.env.BRIDGE_TIMEOUT_MS || 540000);
const MAX_OUTPUT_CHARS = 200000;
const SETTINGS_FILE = path.join(os.homedir(), ".codex", "workbuddy-codex-bridge-settings.json");
const DEFAULT_CODEX_MODEL = process.env.CODEX_BRIDGE_MODEL || "gpt-6-luna";
const CODEX_EFFORT = process.env.CODEX_BRIDGE_EFFORT || "low";
const mode = process.argv[2];

function readBridgeSettings() {
  try {
    const value = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    const valid = (model) => typeof model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(model);
    return {
      codexModel: valid(value.codexModel) ? value.codexModel : DEFAULT_CODEX_MODEL,
      workbuddyModel: valid(value.workbuddyModel) ? value.workbuddyModel : null,
    };
  } catch {
    return { codexModel: DEFAULT_CODEX_MODEL, workbuddyModel: null };
  }
}

function ensureDirectory(cwd) {
  const resolved = path.resolve(cwd || process.cwd());
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`工作目录不存在或不是文件夹：${resolved}`);
  }
  return resolved;
}

function capText(value, max = MAX_OUTPUT_CHARS) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}\n[输出过长，已截断]` : text;
}

function redact(text) {
  return String(text ?? "")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[已隐藏]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*)[^\s,;"']+/gi, "$1[已隐藏]");
}

function startJsonRpcProcess(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pending = new Map();
  const listeners = new Set();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let stderr = "";
  let nextId = 1;
  let closed = false;

  const failPending = (error) => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    for (const listener of listeners) listener({ _bridgeExit: error });
  };

  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      failPending(new Error(`子进程返回了无效的 JSON-RPC 消息：${line.slice(0, 300)}`));
      return;
    }
    if (message.id !== undefined && pending.has(String(message.id))) {
      const entry = pending.get(String(message.id));
      pending.delete(String(message.id));
      if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else entry.resolve(message.result);
    }
    for (const listener of listeners) listener(message);
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = capText(stderr + chunk, 12000);
  });
  child.on("error", (error) => failPending(error));
  child.on("exit", (code, signal) => {
    failPending(new Error(`子进程已退出（code=${code}, signal=${signal}）。${redact(stderr).slice(-1200)}`));
  });

  function send(payload) {
    if (closed || child.stdin.destroyed) throw new Error("子进程通信通道已关闭。");
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  function request(method, params, timeoutMs = 30000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(String(id));
        reject(new Error(`等待 ${method} 响应超时。`));
      }, timeoutMs);
      pending.set(String(id), {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try {
        send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(String(id));
        reject(error);
      }
    });
  }

  function notify(method, params = {}) {
    send({ jsonrpc: "2.0", method, params });
  }

  function onMessage(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function replyError(id, message) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message } });
  }

  function close() {
    if (!closed) {
      closed = true;
      child.kill();
    }
    lines.close();
  }

  return { child, request, notify, onMessage, replyError, close, getStderr: () => stderr };
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时（${Math.round(timeoutMs / 1000)} 秒）。`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function resolveCodexBin() {
  const configured = process.env.CODEX_BIN;
  if (configured && fs.existsSync(configured)) return configured;
  // App 升级会更换引擎目录 hash —— 自动发现 bin/*/codex.exe 中最新修改的引擎
  const binRoot = path.join(os.homedir(), "AppData", "Local", "OpenAI", "Codex", "bin");
  let best = null;
  try {
    for (const name of fs.readdirSync(binRoot)) {
      const candidate = path.join(binRoot, name, "codex.exe");
      try {
        const st = fs.statSync(candidate);
        if (!best || st.mtimeMs > best.mtimeMs) best = { path: candidate, mtimeMs: st.mtimeMs };
      } catch { /* 目录里没有 codex.exe（如 rg.exe），跳过 */ }
    }
  } catch { /* bin 根目录不存在 */ }
  if (best) return best.path;
  if (configured) return configured; // 保持旧行为：配置存在但损坏时让 spawn 报 ENOENT
  return "codex";
}

async function runCodex({ prompt, thread_id, cwd, access, effort }) {
  const workingDirectory = ensureDirectory(cwd);
  const codexBin = await resolveCodexBin();
  const model = readBridgeSettings().codexModel;
  const reasoningEffort = effort || CODEX_EFFORT;
  const args = [
    "app-server", "--listen", "stdio://",
    "-c", "mcp_servers.workbuddy_bridge.enabled=false",
    "-c", "mcp_servers.qoder_bridge.enabled=false",
  ];
  const rpc = startJsonRpcProcess(codexBin, args, { cwd: workingDirectory });
  const sandbox = access === "workspace-write" ? "workspace-write" : "read-only";
  const threadParams = {
    cwd: workingDirectory,
    approvalPolicy: "never",
    sandbox,
    model,
  };

  try {
    await rpc.request("initialize", {
      capabilities: {},
      clientInfo: {
        name: "workbuddy_codex_bridge",
        title: "WorkBuddy Codex Bridge",
        version: VERSION,
      },
    });
    rpc.notify("initialized");

    let threadId = thread_id;
    if (threadId) {
      await rpc.request("thread/resume", { ...threadParams, threadId }, 60000);
    } else {
      const started = await rpc.request("thread/start", { ...threadParams, ephemeral: false }, 60000);
      threadId = started?.thread?.id;
      if (!threadId) throw new Error("Codex 没有返回 thread ID，无法继续对话。");
    }

    let answer = "";
    let completionResolve;
    const completion = new Promise((resolve) => { completionResolve = resolve; });
    const removeListener = rpc.onMessage((message) => {
      if (message._bridgeExit) {
        completionResolve({ status: "failed", error: message._bridgeExit.message });
        return;
      }
      if (message.method === "item/agentMessage/delta" && message.params?.threadId === threadId) {
        answer += message.params.delta || "";
      }
      if (message.method === "turn/completed" && message.params?.threadId === threadId) {
        completionResolve(message.params.turn || { status: "failed" });
      }
      if (message.id !== undefined && message.method && !rpc.child.killed) {
        rpc.replyError(message.id, "此桥接只支持 Codex 的非交互式只读或工作区写入任务；审批请求未自动批准。");
      }
    });

    try {
      await rpc.request("turn/start", {
        threadId,
        model,
        effort: reasoningEffort,
        input: [{ type: "text", text: prompt }],
      }, 60000);
      const turn = await withTimeout(completion, TIMEOUT_MS, "Codex 对话");
      if (turn.status !== "completed") {
        throw new Error(`Codex turn 状态为 ${turn.status || "未知"}${turn.error?.message ? `：${turn.error.message}` : ""}`);
      }
      return { answer: capText(answer).trim() || "Codex 已完成，但没有返回文本消息。", threadId, cwd: workingDirectory, sandbox, model, effort: reasoningEffort };
    } finally {
      removeListener();
    }
  } finally {
    rpc.close();
  }
}

function extractWorkBuddyText(stdout) {
  const raw = String(stdout || "").trim();
  if (!raw) return "WorkBuddy 没有返回文本。";
  const candidates = [raw, ...raw.split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        const finalResult = [...parsed].reverse().find((item) =>
          item?.type === "result" && item.is_error !== true && typeof item.result === "string" && item.result.trim(),
        );
        if (finalResult) return finalResult.result;
        const assistant = [...parsed].reverse().find((item) =>
          item?.type === "message" && item.role === "assistant" && item.status === "completed",
        );
        if (assistant) {
          if (typeof assistant.text === "string") return assistant.text;
          if (typeof assistant.content === "string") return assistant.content;
          if (Array.isArray(assistant.content)) {
            const text = assistant.content
              .filter((item) => ["output_text", "text"].includes(item?.type) && typeof item.text === "string")
              .map((item) => item.text)
              .join("\n")
              .trim();
            if (text) return text;
          }
        }
      }
      if (typeof parsed.result === "string") return parsed.result;
      if (typeof parsed.output === "string") return parsed.output;
      if (typeof parsed.text === "string") return parsed.text;
      if (Array.isArray(parsed.messages)) {
        const assistant = [...parsed.messages].reverse().find((item) => item.role === "assistant" || item.type === "assistant");
        if (assistant) return assistant.content || assistant.text || JSON.stringify(assistant);
      }
      if (Array.isArray(parsed.content)) {
        const textItem = parsed.content.find((item) => item.type === "text" && item.text);
        if (textItem) return textItem.text;
      }
    } catch {
      // Continue to the next possible JSON line; JSON mode may include a short preamble.
    }
  }
  return raw;
}

// 净化子进程环境：剔除宿主（如 WorkBuddy App / Codex / DSH）注入的变量。
// 2026-10-15 二分实验结论（A/B bisect，逐组加回验证）：
//   全量宿主环境 → CLI 必报 "Authentication required"（假阳性，与登录态无关）；
//   元凶组 = CLIENT_INFO_*（如 CLIENT_INFO_PRODUCT_NAME="WorkBuddy"，CLI 据此
//   误判为"App 受控组件"去要宿主凭证）与 SANDBOX_*（App 沙箱 IPC 签名）；
//   CODEBUDDY_*/WORKBUDDY_*/CLAUDE_* 为其余已知劫持面（CONFIG_DIR 等）。
//   极净白名单环境在本机恒定通过。故此处统一剔除全部宿主签名前缀。
function cleanWorkBuddyEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(CODEBUDDY_|WORKBUDDY_|CLAUDE_|CLIENT_INFO_|SANDBOX_|ACC_|GALILEO_)/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

async function runWorkBuddy({ prompt, session_id, cwd, permission_mode, allow_callback }) {
  const workingDirectory = ensureDirectory(cwd);
  const entry = process.env.WORKBUDDY_CLI_ENTRY;
  if (!entry || !fs.existsSync(entry)) {
    throw new Error("找不到 WorkBuddy CLI。请检查 WORKBUDDY_CLI_ENTRY 配置。");
  }
  const sessionId = session_id || `codexwb-${randomUUID().replaceAll("-", "")}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,120}$/.test(sessionId)) {
    throw new Error("session_id 只能包含字母、数字、冒号、下划线或连字符，且必须以字母或数字开头。");
  }
  // 回拨 Codex 的显式提权开关：默认关闭，需服务端 env + 调用方参数双开。
  const wantCallback = allow_callback === true;
  if (wantCallback && process.env.WORKBUDDY_CLI_ALLOW_CALLBACK !== "1") {
    throw new Error("allow_callback 需要服务端设置 WORKBUDDY_CLI_ALLOW_CALLBACK=1（默认关闭的显式提权能力）。");
  }
  // 子会话要调用 MCP 工具必须绕过非交互审批（DeferExecuteTool 在 --print 下无法弹确认）。
  const permissionMode = wantCallback ? "bypassPermissions" : (permission_mode || "plan");
  const cliPort = process.env.WORKBUDDY_CLI_PORT || String(50000 + Math.floor(Math.random() * 10000));
  const args = [
    entry,
    "--print",
    "--output-format", "json",
    "--port", cliPort,
    "--permission-mode", permissionMode,
  ];
  // 回拨能力（2026-10-21 实测选型）：headless CLI 子会话默认零 MCP（~/.codebuddy/ 无 mcp.json），
  // 故 Codex 让 WorkBuddy “反过来 ping 一下”必然失败。开启后注入最小 MCP 配置（仅 codex_bridge），
  // 配合上面的 bypassPermissions 才能通过非交互审批。⚠️ 这会放大 Codex 可触发子会话的权限，按需开启。
  if (wantCallback) {
    const callbackServer = path.resolve(process.argv[1]);
    const callbackConfig = {
      mcpServers: {
        codex_bridge: {
          type: "stdio",
          command: process.execPath,
          args: [callbackServer, "codex"],
          env: {
            CODEX_BRIDGE_MODEL: readBridgeSettings().codexModel,
            CODEX_BRIDGE_EFFORT: CODEX_EFFORT,
          },
        },
      },
    };
    args.push("--mcp-config", JSON.stringify(callbackConfig));
  }
  const model = readBridgeSettings().workbuddyModel;
  if (model) args.push("--model", model);
  if (session_id) args.push("--resume", sessionId);
  else args.push("--session-id", sessionId);
  args.push("--", prompt);

  const child = spawn(process.execPath, args, {
    cwd: workingDirectory,
    env: cleanWorkBuddyEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, TIMEOUT_MS);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = capText(stdout + chunk); });
  child.stderr.on("data", (chunk) => { stderr = capText(stderr + chunk, 12000); });

  const exit = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));

  if (timedOut) throw new Error("WorkBuddy CLI 超过 9 分钟没有完成，已停止等待。");
  if (exit.code !== 0) {
    throw new Error(classifyWorkBuddyFailure(stderr, exit.code, exit.signal));
  }
  if (!stdout.trim() && stderr.trim()) {
    throw new Error(classifyWorkBuddyFailure(stderr, exit.code, exit.signal));
  }
  return {
    answer: capText(extractWorkBuddyText(stdout)).trim(),
    sessionId,
    cwd: workingDirectory,
    permissionMode,
    model: model || null,
  };
}

/**
 * 把 CLI 的 stderr 特征映射为可执行的修复指令（2026-10-14 实测沉淀）：
 * - 登录态过期（token TTL 约 7 小时）→ 提示交互式 /login
 * - 端口占用 → 提示换端口重试
 * - 其余 → 原样透出，保留排查线索
 */
function classifyWorkBuddyFailure(stderr, code, signal) {
  const text = redact(stderr).slice(-1500);
  if (/Authentication required|Please use \/login|Authentication failed/i.test(text)) {
    return "WorkBuddy CLI 未登录或登录态已过期（token 有 TTL，约 7 小时失效）。" +
      "修复：在终端运行 `codebuddy`，在 TUI 中输入 `/login`，完成浏览器授权后重试。" +
      `（原始错误：${text.slice(-300)}）`;
  }
  if (/EADDRINUSE|address already in use/i.test(text)) {
    return "WorkBuddy CLI 启动时端口被占用。修复：重试（桥会自动换随机端口），或设置 WORKBUDDY_CLI_PORT 指定空闲端口。" +
      `（原始错误：${text.slice(-300)}）`;
  }
  if (/429|额度已用尽|quota|rate limit/i.test(text)) {
    return "WorkBuddy CLI 账号额度已用尽或触发限流（429）。" +
      "修复：前往 https://www.codebuddy.cn/profile/usage 查看额度/购买加量包，或改用其他模型（桥设置 workbuddyModel）。" +
      `（原始错误：${text.slice(-300)}）`;
  }
  return `WorkBuddy CLI 执行失败（code=${code}, signal=${signal}）。${text}`;
}

function toolResult(text) {
  return { content: [{ type: "text", text: capText(text) }] };
}

async function main() {
  if (mode !== "codex" && mode !== "workbuddy") {
    process.stderr.write("用法：node server.mjs codex|workbuddy\n");
    process.exitCode = 2;
    return;
  }

  const server = new McpServer(
    { name: `workbuddy-codex-bridge-${mode}`, version: VERSION },
    { instructions: "这是本机的双向 AI 交接桥。默认只读/计划模式；需要继续同一对话时复用返回的 thread_id 或 session_id。不要在对话内容中放入密码、API 密钥或其他秘密。" },
  );

  if (mode === "codex") {
    server.registerTool("ask_codex", {
      title: "Ask Codex",
      description: "把问题或任务交给本机 Codex app-server。默认 read-only；只有明确指定 workspace-write 时才允许修改当前工作目录中的文件。把返回的 thread_id 用于后续轮次以延续对话。",
      inputSchema: {
        prompt: z.string().min(1).max(30000).describe("发给 Codex 的任务或问题"),
        thread_id: z.string().min(1).optional().describe("延续 Codex 对话时使用上一次返回的 thread_id"),
        cwd: z.string().optional().describe("工作目录；省略时使用启动 MCP 服务时的当前目录"),
        access: z.enum(["read-only", "workspace-write"]).optional().describe("新对话或恢复对话的文件权限；默认 read-only"),
        effort: z.enum(["low", "medium", "high", "xhigh"]).optional().describe("推理强度；默认 low，避免继承本机 Codex 的高强度设置"),
      },
    }, async ({ prompt, thread_id, cwd, access, effort }) => {
      try {
        const result = await runCodex({ prompt, thread_id, cwd, access, effort });
        return toolResult(`thread_id: ${result.threadId}\n模型: ${result.model}\n推理强度: ${result.effort}\n权限: ${result.sandbox}\n工作目录: ${result.cwd}\n\n${result.answer}`);
      } catch (error) {
        return { ...toolResult(`Codex 调用失败：${redact(error.message)}`), isError: true };
      }
    });
  } else {
    server.registerTool("ask_workbuddy", {
      title: "Ask WorkBuddy",
      description: "把问题交给 WorkBuddy 的本机 headless CLI。默认 plan 模式，不编辑文件。把返回的 session_id 用于后续轮次；只有明确指定 acceptEdits 时才允许 WorkBuddy 执行文件编辑。不会使用跳过权限检查的参数。allow_callback=true 时允许该子会话回拨 Codex（需服务端开启 WORKBUDDY_CLI_ALLOW_CALLBACK=1，子会话将以 bypassPermissions 运行——显式提权，仅用于需要嵌套对话的场景）。",
      inputSchema: {
        prompt: z.string().min(1).max(30000).describe("发给 WorkBuddy 的任务或问题"),
        session_id: z.string().min(1).optional().describe("延续 WorkBuddy 对话时使用上一次返回的 session_id"),
        cwd: z.string().optional().describe("工作目录；省略时使用启动 MCP 服务时的当前目录"),
        permission_mode: z.enum(["plan", "default", "acceptEdits"]).optional().describe("默认 plan；只有明确需要编辑当前工作区时才指定 acceptEdits"),
        allow_callback: z.boolean().optional().describe("允许本次子会话回拨 Codex（需服务端 env WORKBUDDY_CLI_ALLOW_CALLBACK=1；子会话会以 bypassPermissions 运行，属显式提权，默认 false）"),
      },
    }, async ({ prompt, session_id, cwd, permission_mode, allow_callback }) => {
      try {
        const result = await runWorkBuddy({ prompt, session_id, cwd, permission_mode, allow_callback });
        return toolResult(`session_id: ${result.sessionId}\n模型: ${result.model || "WorkBuddy CLI 默认模型"}\n权限模式: ${result.permissionMode}\n工作目录: ${result.cwd}\n\n${result.answer}`);
      } catch (error) {
        return { ...toolResult(`WorkBuddy 调用失败：${redact(error.message)}`), isError: true };
      }
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`${redact(error?.stack || error)}\n`);
  process.exitCode = 1;
});
