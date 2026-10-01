#!/usr/bin/env node

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import net from 'net';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(ROOT_DIR, 'server.js');
const PKG_PATH = path.join(ROOT_DIR, 'package.json');

const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8'));
const VERSION = pkg.version || '0.1.1-rc.2';

const args = process.argv.slice(2);
const command = args[0];

function printHelp() {
  console.log(`
\x1b[1m\x1b[36mNVW\x1b[0m • Authentic Neovim WebUI (v${VERSION})

\x1b[1m用法:\x1b[0m
  nvw [path] [options]          直接在指定或当前目录启动 NVW 并打开浏览器
  nvw web [path] [options]      标准启动模式（同上）
  nvw run [path] [options]      前台运行服务（默认不自动弹浏览器）
  nvw open [path] [options]     启动并确保在系统默认浏览器中打开
  nvw stop [options]            停止指定或默认端口运行的 NVW 服务
  nvw restart [options]         重启运行中的 NVW 服务
  nvw status [options]          检查 NVW 服务与当前工作区运行状态
  nvw --help, -h                显示帮助信息
  nvw --version, -v             显示版本号

\x1b[1m参数与选项:\x1b[0m
  [path]                        工作区目录或要打开的文件（默认：当前目录）
  -p, --port <port>             指定监听端口（默认：3999，或环境变量 NVW_PORT）
  -H, --host <host>             指定监听主机（默认：127.0.0.1，或环境变量 NVW_HOST）
  --no-open                     启动后不自动在浏览器中打开页面
  --here                        强制使用当前目录为工作区（禁用智能上次目录回退）
  --last, -l                    直接加载上次访问的历史工作区
  --restart                     若端口被旧 NVW 实例占用，自动接管并重启

\x1b[1m常用示例:\x1b[0m
  \x1b[32mnvw\x1b[0m                           在当前目录启动 NVW 并弹出浏览器
  \x1b[32mnvw ./src\x1b[0m                     打开当前项目的 src 子目录
  \x1b[32mnvw /path/to/project\x1b[0m          在指定工作区目录启动 NVW
  \x1b[32mnvw web -p 5000\x1b[0m               在 5000 端口启动 Web 服务
  \x1b[32mnvw run --here\x1b[0m                 作为前台控制台服务运行（不弹浏览器）
  \x1b[32mnvw restart -p 3999\x1b[0m            重启 3999 端口上的服务
  \x1b[32mnvw status\x1b[0m                    检查默认 3999 端口的运行状态与当前工作区
  \x1b[32mnvw stop\x1b[0m                      优雅停止 3999 端口的 NVW 实例
`);
}

/** 校验端口是否为合法正整数 */
function validatePort(val) {
  const p = parseInt(val, 10);
  if (isNaN(p) || p <= 0 || p > 65535) {
    console.error(`\x1b[31m✖ 错误: 无效端口 -> ${val}\x1b[0m`);
    process.exit(1);
  }
  return p;
}

/** 探测运行在指定端口上的 NVW 实例信息 */
async function probeRunningNvw(port) {
  try {
    const ctl = AbortSignal.timeout(1200);
    const res = await fetch(`http://127.0.0.1:${port}/api/instance`, { signal: ctl });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.app !== 'nvw') return null;
    return data;
  } catch {
    return null;
  }
}

/** 请求正在运行的 NVW 实例优雅关闭 */
async function requestGracefulShutdown(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(2000)
    });
    return res.ok;
  } catch {
    return false;
  }
}

const RECENT_FILE = path.join(process.env.HOME || '', '.nvw_recent_projects.json');

/** 上次用过的工作区（server.js 把它写在 recent 列表首位） */
function lastWorkspace() {
  try {
    const list = JSON.parse(fs.readFileSync(RECENT_FILE, 'utf-8'));
    const hit = (Array.isArray(list) ? list : []).find(p => p && fs.existsSync(p));
    return hit || null;
  } catch {
    return null;
  }
}

/** 当前目录是否像项目根 —— 决定无参启动时要不要用上次工作区兜底 */
function looksLikeProject(dir) {
  const MARKERS = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'Makefile', '.nvw'];
  return MARKERS.some(m => fs.existsSync(path.join(dir, m)));
}

/** 让已在运行的实例切换工作区 */
async function tellRunningNvwToSwitch(port, targetPath) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/project/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: targetPath }),
      signal: AbortSignal.timeout(3000)
    });
    return res.ok;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  try {
    if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore' }).unref();
    else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', url], { stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { stdio: 'ignore' }).unref();
  } catch { /* 忽略浏览器启动异常 */ }
}

async function handleStart({ defaultOpen = true, forceRestart = false } = {}) {
  let targetPath = process.cwd();
  let port = process.env.NVW_PORT ? validatePort(process.env.NVW_PORT) : 3999;
  let host = process.env.NVW_HOST || '127.0.0.1';
  let autoOpen = defaultOpen;
  let explicitPath = false;
  let forceHere = false;
  let restart = forceRestart;

  // 如果首参数是命令词（web / start / run / open），跳过它解析后续参数；否则从首参数开始解析
  const hasSubcommand = ['web', 'start', 'run', 'open'].includes(command);
  const restArgs = hasSubcommand ? args.slice(1) : args;

  for (let i = 0; i < restArgs.length; i++) {
    const arg = restArgs[i];
    if (arg === '-p' || arg === '--port') {
      port = validatePort(restArgs[++i]);
    } else if (arg === '-H' || arg === '--host') {
      host = restArgs[++i] || host;
    } else if (arg === '--no-open') {
      autoOpen = false;
    } else if (arg === '--open') {
      autoOpen = true;
    } else if (arg === '--here') {
      forceHere = true;
    } else if (arg === '--restart') {
      restart = true;
    } else if (arg === '--last' || arg === '-l') {
      const last = lastWorkspace();
      if (last) { targetPath = last; explicitPath = true; }
      else { console.warn('\x1b[33m⚠ 还没有"上次工作区"记录，沿用当前目录\x1b[0m'); }
    } else if (!arg.startsWith('-')) {
      targetPath = path.resolve(process.cwd(), arg);
      explicitPath = true;
    }
  }

  // 无参启动时：当前目录不像项目根时，自动沿用上次工作区
  let fellBackToLast = false;
  if (!explicitPath && !forceHere && !looksLikeProject(targetPath)) {
    const last = lastWorkspace();
    if (last && path.resolve(last) !== path.resolve(targetPath)) {
      targetPath = last;
      fellBackToLast = true;
    }
  }

  if (!fs.existsSync(targetPath)) {
    console.error(`\x1b[31m✖ 错误: 路径不存在 -> ${targetPath}\x1b[0m`);
    process.exit(1);
  }

  const url = `http://${host}:${port}`;
  const running = await probeRunningNvw(port);

  if (running) {
    if (!restart) {
      const samePath = path.resolve(running.workspace) === path.resolve(targetPath);
      if (samePath) {
        console.log(`\x1b[32m✔ NVW 已在运行\x1b[0m（端口 ${port}，工作区 \x1b[1m${running.workspace}\x1b[0m）。`);
      } else {
        const ok = await tellRunningNvwToSwitch(port, targetPath);
        if (ok) {
          console.log(`\x1b[32m✔ NVW 已在运行\x1b[0m（端口 ${port}），工作区已切换至 \x1b[1m${targetPath}\x1b[0m。`);
        } else {
          console.warn(`\x1b[33m⚠ NVW 已在运行但工作区切换失败（当前：${running.workspace}）。\x1b[0m`);
        }
      }
      console.log(`🌐 访问地址: ${url}\n`);
      if (autoOpen) openBrowser(url);
      process.exit(0);
    } else {
      console.log(`\x1b[33m↻ 正在停止并重启端口 ${port} 上的旧 NVW 实例 (PID: ${running.pid})...\x1b[0m`);
      await requestGracefulShutdown(port);
      await new Promise(r => setTimeout(r, 600));
    }
  } else {
    // 检查端口是否被非 NVW 的外部进程占用
    const inUse = await new Promise(resolve => {
      const tester = net.createServer()
        .once('error', err => resolve(err.code === 'EADDRINUSE'))
        .once('listening', () => tester.close(() => resolve(false)))
        .listen(port, host);
    });
    if (inUse) {
      console.error(`\x1b[31m✖ 端口 ${port} 当前已被其他外部程序占用，且非 NVW 服务。\x1b[0m`);
      console.warn(`出于安全考虑禁止误杀外部程序。请使用 \x1b[1mnvw -p <port>\x1b[0m 换个端口启动。\n`);
      process.exit(1);
    }
  }

  console.log(`\x1b[1m\x1b[36m⚡ 正在启动 NVW (Neovim WebTUI)...\x1b[0m`);
  if (fellBackToLast) {
    console.log(`\x1b[33m⚠ 当前目录不像项目根，已自动沿用上次工作区。强制用当前目录请加 --here\x1b[0m`);
  }
  console.log(`📂 工作区目录: \x1b[32m\x1b[1m${targetPath}\x1b[0m`);
  console.log(`🌐 监听地址: \x1b[34m${url}\x1b[0m\n`);

  const child = spawn(process.execPath, [SERVER_PATH, targetPath], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      NVW_WORKSPACE: targetPath,
      NVW_PORT: String(port),
      NVW_HOST: host
    },
    stdio: 'inherit'
  });

  if (autoOpen) setTimeout(() => openBrowser(url), 600);

  let isStopping = false;
  const cleanExit = () => {
    if (isStopping) return;
    isStopping = true;
    try {
      child.kill('SIGINT');
    } catch {}
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      console.log(`\x1b[32m✔ NVW 服务已停止。\x1b[0m`);
      process.exit(0);
    }, 1500);
  };

  process.on('SIGINT', cleanExit);
  process.on('SIGTERM', cleanExit);

  child.on('exit', () => {
    if (!isStopping) {
      process.exit(0);
    }
  });
}

async function handleStop() {
  let port = 3999;
  const restArgs = args.slice(1);
  for (let i = 0; i < restArgs.length; i++) {
    if (restArgs[i] === '-p' || restArgs[i] === '--port') {
      port = validatePort(restArgs[++i]);
    }
  }

  const instance = await probeRunningNvw(port);
  if (!instance) {
    console.log(`\x1b[33m○ 端口 ${port} 上没有探测到活动的 NVW 服务。\x1b[0m`);
    return;
  }

  console.log(`🛑 正在停止 NVW 服务 (PID: ${instance.pid}, 端口: ${port})...`);
  const shutdownOk = await requestGracefulShutdown(port);
  if (shutdownOk) {
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 100));
      const stillRunning = await probeRunningNvw(port);
      if (!stillRunning) {
        console.log(`\x1b[32m✔ 成功停止运行在端口 ${port} 上的 NVW 服务。\x1b[0m`);
        return;
      }
    }
  }

  if (instance.pid) {
    try {
      process.kill(instance.pid, 'SIGTERM');
      await new Promise(r => setTimeout(r, 400));
      process.kill(instance.pid, 'SIGKILL');
    } catch {}
    console.log(`\x1b[32m✔ 目标 NVW 实例 (PID: ${instance.pid}) 已终止。\x1b[0m`);
  }
}

async function handleStatus() {
  let port = 3999;
  const restArgs = args.slice(1);
  for (let i = 0; i < restArgs.length; i++) {
    if (restArgs[i] === '-p' || restArgs[i] === '--port') {
      port = validatePort(restArgs[++i]);
    }
  }

  const instance = await probeRunningNvw(port);
  if (instance) {
    console.log(`\x1b[32m● NVW 服务正在运行\x1b[0m`);
    console.log(`  - 端口: ${instance.port}`);
    console.log(`  - PID: ${instance.pid}`);
    console.log(`  - 工作区: ${instance.workspace}`);
    console.log(`  - 网址: http://127.0.0.1:${instance.port}`);
  } else {
    console.log(`\x1b[37m○ NVW 服务未在端口 ${port} 运行。\x1b[0m (使用 \x1b[32mnvw\x1b[0m 启动)`);
  }
}

// 调度
switch (command) {
  case 'web':
  case 'start':
    handleStart({ defaultOpen: true });
    break;
  case 'open':
    handleStart({ defaultOpen: true });
    break;
  case 'run':
    handleStart({ defaultOpen: false });
    break;
  case 'restart':
    handleStart({ defaultOpen: true, forceRestart: true });
    break;
  case 'stop':
  case 'kill':
    handleStop();
    break;
  case 'status':
    handleStatus();
    break;
  case '--version':
  case '-v':
    console.log(`nvw v${VERSION}`);
    break;
  case '--help':
  case '-h':
    printHelp();
    break;
  default:
    // 如果首参数不是任何系统指令，直接视作目标工作区路径启动！
    // 比如：nvw、nvw .、nvw /path/to/project、nvw -p 4000
    handleStart({ defaultOpen: true });
    break;
}
