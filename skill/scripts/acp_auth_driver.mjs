#!/usr/bin/env node
/**
 * ACP 登录驱动器（免 TUI 程序化登录完整版 WorkBuddy CLI）
 * 流程：净环境 spawn ACP agent → initialize → authenticate(methodId)
 *       → 捕获 _codebuddy.ai/authUrl 通知写盘 → 用户浏览器授权
 *       → authenticate 响应（携带用户信息）写盘
 * 用法：node acp_auth_driver.mjs [methodId]
 *   methodId: internal(微信,默认) | iOA | external(Google/Github) | selfhosted
 * 环境变量：
 *   CODEBUDDY_CLI  完整版 CLI 的 bin/codebuddy 路径（默认取本机 npm 全局安装路径）
 * 产物（%TEMP%）：
 *   acp_auth_url.txt    登录 URL（发给用户去浏览器授权）
 *   acp_auth_result.txt 最终结果（OK/ERR + 用户信息）
 *   acp_auth_driver.log 全程日志
 *
 * 关键：必须净环境 spawn——App 注入的 CODEBUDDY_* 与代理变量
 * 会让 CLI 启动约 2.6 秒后退出；端口显式传随机高端口防 EADDRINUSE。
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = process.env.CODEBUDDY_CLI
  || "C:/Users/EDY/AppData/Roaming/npm/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy";
const methodId = process.argv[2] || "internal";
const PORT = String(51500 + Math.floor(Math.random() * 400));
const URL_FILE = join(tmpdir(), "acp_auth_url.txt");
const RESULT_FILE = join(tmpdir(), "acp_auth_result.txt");
const LOG_FILE = join(tmpdir(), "acp_auth_driver.log");

const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { writeFileSync(LOG_FILE, line + "\n", { flag: "a" }); } catch {}
};

log(`driver start methodId=${methodId} port=${PORT}`);

const child = spawn(process.execPath, [CLI, "-d", "acp", "--acp", "--acp-transport", "stdio", "--port", PORT], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: false,
  env: {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot || "C:\\Windows",
    windir: process.env.windir,
    TEMP: process.env.TEMP, TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE, HOMEPATH: process.env.HOMEPATH,
    APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA,
    COMSPEC: process.env.COMSPEC, PATHEXT: process.env.PATHEXT,
    OS: process.env.OS, PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE,
    NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS,
  },
});

let buffer = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");

child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      log("<< " + JSON.stringify(msg).slice(0, 600));
      if (msg.method === "_codebuddy.ai/authUrl" && msg.params?.authUrl) {
        writeFileSync(URL_FILE, msg.params.authUrl);
        log("AUTH_URL_WRITTEN: " + msg.params.authUrl);
      }
      if (msg.id === 2) {
        const ok = !msg.error && msg.result;
        const out = ok
          ? "OK " + JSON.stringify(msg.result).slice(0, 500)
          : "ERR " + (msg.error?.message || "unknown");
        writeFileSync(RESULT_FILE, out);
        log("AUTH_RESULT: " + out);
        setTimeout(() => finish(ok ? 0 : 1), 2000);
      }
    } catch {
      log("<< (raw) " + line.slice(0, 200));
    }
  }
});

child.stderr.on("data", (c) => {
  const t = c.toString().trim();
  if (t && !/Git Bash|git-scm|CODEBUDDY_CODE_GIT_BASH|CliMemWatch|fetch config failed|setProxy|Axios|at async|at http|at new Promise|at wrapAsync|拒绝访问/.test(t)) {
    log("[stderr] " + t.slice(0, 250));
  }
});

const send = (obj) => { log(">> " + JSON.stringify(obj).slice(0, 200)); child.stdin.write(JSON.stringify(obj) + "\n"); };

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });

setTimeout(() => {
  send({ jsonrpc: "2.0", id: 2, method: "authenticate", params: { methodId } });
  log("authenticate sent, waiting for user authorization (10min)...");
}, 2000);

// 10 分钟总超时
setTimeout(() => {
  log("TIMEOUT 600s");
  try { writeFileSync(RESULT_FILE, "ERR timeout"); } catch {}
  finish(2);
}, 600000);

child.on("exit", (code) => { log("child exit: " + code); finish(0); });
function finish(code) { try { child.kill(); } catch {} process.exit(code); }
