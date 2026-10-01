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
const VERSION = pkg.version || '1.0.0';

const args = process.argv.slice(2);
const command = args[0];

function printHelp() {
  console.log(`
\x1b[1m\x1b[36mNVW\x1b[0m • Authentic Neovim WebUI (v${VERSION})

\x1b[1m用法:\x1b[0m
  nvw web [path] [options]    启动 NVW (真正的 Neovim WebUI) 并在浏览器打开
  nvw stop [options]          停止运行中的 NVW 服务
  nvw status [options]        检查 NVW 服务运行状态
  nvw --help, -h              显示帮助信息
  nvw --version, -v           显示版本号

\x1b[1m参数与选项:\x1b[0m
  [path]                      工作区目录路径（默认：当前目录；当前目录不像项目根时自动沿用上次工作区）
  -p, --port <port>           指定监听端口（默认：3999）
  --no-open                   启动后不自动在浏览器中打开
  --here                      强制用当前目录当工作区（覆盖"上次工作区"兜底）
  --last                      直接用上次用过的工作区
  --restart                   端口被占用时强制接管（结束旧进程再启动）

\x1b[1m示例:\x1b[0m
  \x1b[32mnvw web\x1b[0m                     在当前目录启动 NVW 并打开浏览器
  \x1b[32mnvw web /path/to/project\x1b[0m    在指定科研项目目录启动
  \x1b[32mnvw web --last\x1b[0m              重新打开上次的工作区
  \x1b[32mnvw web -p 5000\x1b[0m             在 5000 端口启动
  \x1b[32mnvw stop\x1b[0m                    停止默认 3999 端口的 NVW 实例
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
  } catch { /* 打不开就算了 */ }
}

async function handleWeb() {
  let targetPath = process.cwd();
  let port = process.env.NVW_PORT || 3999;
  let autoOpen = true;
  let explicitPath = false;
  let forceHere = false;

  // 解析参数
  const restArgs = args.slice(1);
  for (let i = 0; i < restArgs.length; i++) {
    const arg = restArgs[i];
    if (arg === '-p' || arg === '--port') {
      port = restArgs[++i] || port;
    } else if (arg === '--no-open') {
      autoOpen = false;
    } else if (arg === '--here') {
      forceHere = true;
    } else if (arg === '--last' || arg === '-l') {
      const last = lastWorkspace();
      if (last) { targetPath = last; explicitPath = true; }
      else { console.warn('\x1b[33m⚠ 还没有"上次工作区"记录，回退到当前目录\x1b[0m'); }
    } else if (!arg.startsWith('-')) {
      targetPath = path.resolve(process.cwd(), arg);
      explicitPath = true;
    }
  }

  // 无参启动的兜底：当前目录不像项目根时，别把用户丢进一个"空工作台"。
  // 曾经的坑：在 ~/DemoProject 下敲 `nvw web` → 工作区被静默设成 DemoProject，
  // 打开后自己的项目文件树整个消失，看起来像"项目废了"。
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

  // 检查端口是否被占用。
  // 关键行为：如果占用者**本身就是 NVW**，不再报错退出 —— 直接复用它
  //（必要时顺手把它的工作区切到你这次要的目录），然后打开浏览器。
  // 之前这里是硬性 exit(1)：谁先用 nvw web 起了服务，别人再敲就"不行"，
  // 表现得像是"我启动的和你启动的不一样"。
  const url = `http://127.0.0.1:${port}`;
  const restart = args.includes('--restart');
  const running = await probeRunningNvw(port);
  if (running) {
    if (!restart) {
      const samePath = path.resolve(running.workspace) === path.resolve(targetPath);
      if (samePath) {
        console.log(`\x1b[32m✔ NVW 已在运行\x1b[0m（端口 ${port}，工作区 \x1b[1m${running.workspace}\x1b[0m），直接打开浏览器。`);
      } else {
        const ok = await tellRunningNvwToSwitch(port, targetPath);
        if (ok) {
          console.log(`\x1b[32m✔ NVW 已在运行\x1b[0m（端口 ${port}），已把工作区切换到 \x1b[1m${targetPath}\x1b[0m。`);
        } else {
          console.warn(`\x1b[33m⚠ NVW 已在运行但切换工作区失败\x1b[0m（当前：${running.workspace}）。`);
        }
      }
      console.log(`🌐 ${url}\n`);
      if (autoOpen) openBrowser(url);
      process.exit(0);
    } else {
      console.log(`\x1b[33m↻ --restart：通过控制接口优雅停止旧 NVW 实例 (PID: ${running.pid})...\x1b[0m`);
      await requestGracefulShutdown(port);
      await new Promise(r => setTimeout(r, 600));
    }
  } else {
    // 检查端口是否被非 NVW 的外部进程占用
    const inUse = await new Promise(resolve => {
      const tester = net.createServer()
        .once('error', err => resolve(err.code === 'EADDRINUSE'))
        .once('listening', () => tester.close(() => resolve(false)))
        .listen(port, '127.0.0.1');
    });
    if (inUse) {
      console.error(`\x1b[31m✖ 端口 ${port} 当前已被其他外部程序占用，且非 NVW 服务。\x1b[0m`);
      console.warn(`出于安全考虑禁止误杀外部程序。请使用 \x1b[1mnvw web -p <port>\x1b[0m 换个端口启动。\n`);
      process.exit(1);
    }
  }

  console.log(`\x1b[1m\x1b[36m⚡ 正在启动 NVW Web 工作台...\x1b[0m`);
  if (fellBackToLast) {
    console.log(`\x1b[33m⚠ 当前目录不像项目根（没有 .git / package.json / pyproject.toml …）\x1b[0m`);
    console.log(`\x1b[33m  已自动沿用上次的工作区。想强制用当前目录：nvw web --here\x1b[0m`);
  }
  console.log(`📂 工作区目录: \x1b[32m\x1b[1m${targetPath}\x1b[0m`);
  console.log(`🌐 访问端口: \x1b[34m${port}\x1b[0m\n`);

  const child = spawn(process.execPath, [SERVER_PATH, targetPath], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      NVW_WORKSPACE: targetPath,
      NVW_PORT: String(port)
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

  console.log(`🛑 正在通过控制接口停止 NVW 服务 (PID: ${instance.pid}, 端口: ${port})...`);
  const shutdownOk = await requestGracefulShutdown(port);
  if (shutdownOk) {
    // 等待进程退出
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 100));
      const stillRunning = await probeRunningNvw(port);
      if (!stillRunning) {
        console.log(`\x1b[32m✔ 成功停止运行在端口 ${port} 上的 NVW 服务。\x1b[0m`);
        return;
      }
    }
  }

  // 若优雅关闭超时，仅针对已核实身份的实例 PID 执行回收
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
    console.log(`\x1b[37m○ NVW 服务未在端口 ${port} 运行。\x1b[0m (使用 \x1b[32mnvw web\x1b[0m 启动)`);
  }
}

// 调度
switch (command) {
  case 'web':
  case 'start':
    handleWeb();
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
  case undefined:
    if (!command && args.length === 0) {
      // 默认如果没有子命令，显示帮助或支持 nvw 也能直接提示
      printHelp();
    } else {
      printHelp();
    }
    break;
  default:
    console.error(`未知命令: ${command}`);
    printHelp();
    process.exit(1);
}
