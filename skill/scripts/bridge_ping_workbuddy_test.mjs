// 反向链路验证脚本：以 MCP 客户端身份拉起 workbuddy 模式桥（模拟 Codex 侧），调用 ask_workbuddy
// 用途：验证 Codex → WorkBuddy 方向，不依赖 Codex 重启
//
// ⚠️ 必须在"普通终端"（非 WorkBuddy 沙箱）运行，否则 reg.exe 黑名单会阻断凭证解密。
// 用法：node bridge_ping_workbuddy_test.mjs
//
// 修改点：按本机实际路径调整 NODE / BRIDGE_DIR / CLI_ENTRY / PING。
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const NODE = "C:/Program Files/nodejs/node.exe";
const BRIDGE_DIR = "C:/Users/EDY/Documents/Codex/2026-10-13/new-chat/outputs/workbuddy-codex-bridge";
const CLI_ENTRY = "C:/Users/EDY/AppData/Roaming/npm/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy";
const PING = "只回复：WB-CODEX-PING-<DATE>";

const env = { ...process.env };
// 清理 App 注入的污染变量（强制 bundle 变体 / 劫持配置目录 / 代理等），模拟真实 Codex 环境
for (const k of Object.keys(env)) {
  if (/^(CODEBUDDY|WORKBUDDY)_/i.test(k) || /(^|_)proxy$/i.test(k) || /^(HTTP|HTTPS|ALL|NO)_PROXY$/i.test(k)) delete env[k];
}
env.WORKBUDDY_CLI_ENTRY = CLI_ENTRY;

console.log("[0] 桥模式: workbuddy | CLI 入口:", CLI_ENTRY);

const child = spawn(NODE, ["server.mjs", "workbuddy"], {
  cwd: BRIDGE_DIR,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env,
});

let nextId = 1;
const pending = new Map();
const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { console.log("[非JSON输出]", line.slice(0, 300)); return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const entry = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result);
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => console.log("[桥stderr]", String(d).slice(0, 800)));
child.on("exit", (code) => console.log("[桥进程退出] code=", code));

function request(method, params, timeoutMs = 600000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(method + " 响应超时")); }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(t); resolve(v); },
      reject: (e) => { clearTimeout(t); reject(e); },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params = {}) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "wb-reverse-ping-test", version: "1.0.0" },
  }, 30000);
  console.log("[1] initialize OK，服务器:", init?.serverInfo?.name, "协议:", init?.protocolVersion);
  notify("notifications/initialized");

  const tools = await request("tools/list", {}, 30000);
  console.log("[2] tools/list:", (tools?.tools || []).map((t) => t.name).join(", "));

  console.log("[3] 发送 ping 给 WorkBuddy CLI（ask_workbuddy）...");
  const t0 = Date.now();
  const call = await request("tools/call", {
    name: "ask_workbuddy",
    arguments: { prompt: PING, permission_mode: "plan" },
  });
  console.log(`[4] 工具返回（耗时 ${Math.round((Date.now() - t0) / 1000)}s），isError = ${call?.isError === true}`);
  console.log("========== 完整结果 ==========");
  for (const item of call?.content || []) {
    if (item.type === "text") console.log(item.text);
  }
  console.log("========== 结果结束 ==========");
} catch (error) {
  console.log("测试失败:", error.message);
} finally {
  child.kill();
  process.exit(0);
}
