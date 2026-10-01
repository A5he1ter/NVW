#!/usr/bin/env node

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { spawn, execSync } from 'child_process';

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

function getPidsOnPort(port) {
  try {
    const stdout = execSync(`lsof -t -i:${port} 2>/dev/null`, { encoding: 'utf-8' }).trim();
    if (!stdout) return [];
    return stdout.split('\n').map(p => p.trim()).filter(Boolean);
  } catch {
    return [];
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

/** 当前目录是否"看起来像"一个项目根 —— 决定无参启动时要不要用上次工作区兜底 */
function looksLikeProject(dir) {
  const MARKERS = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'Makefile', '.nvw'];
  return MARKERS.some(m => fs.existsSync(path.join(dir, m)));
}

/** 探测端口上跑的是不是 NVW，返回它的工作区信息；不是或连不上则 null */
async function probeRunningNvw(port) {
  try {
    const ctl = AbortSignal.timeout(1200);
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`, { signal: ctl });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data.current !== 'string') return null;
    return data;
  } catch {
    return null;
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
  const existingPids = getPidsOnPort(port);
  if (existingPids.length > 0 && !restart) {
    const running = await probeRunningNvw(port);
    if (running) {
      const samePath = path.resolve(running.current) === path.resolve(targetPath);
      if (samePath) {
        console.log(`\x1b[32m✔ NVW 已在运行\x1b[0m（端口 ${port}，工作区 \x1b[1m${running.currentName}\x1b[0m），直接打开浏览器。`);
      } else {
        const ok = await tellRunningNvwToSwitch(port, targetPath);
        if (ok) {
          console.log(`\x1b[32m✔ NVW 已在运行\x1b[0m（端口 ${port}），已把工作区切换到 \x1b[1m${targetPath}\x1b[0m。`);
        } else {
          console.warn(`\x1b[33m⚠ NVW 已在运行但切换工作区失败\x1b[0m（当前：${running.current}）。`);
        }
      }
      console.log(`🌐 ${url}\n`);
      if (autoOpen) openBrowser(url);
      process.exit(0);
    }
    console.warn(`\x1b[33m⚠ 提示: 端口 ${port} 当前已被占用 (PID: ${existingPids.join(', ')})，且不是 NVW 服务。\x1b[0m`);
    console.warn(`您可以执行 \x1b[1mnvw web --restart\x1b[0m 强制接管，或用 \x1b[1mnvw web -p <port>\x1b[0m 换个端口启动。\n`);
    process.exit(1);
  }
  if (existingPids.length > 0 && restart) {
    console.log(`\x1b[33m↻ --restart：强制接管端口 ${port}（结束 PID: ${existingPids.join(', ')}）\x1b[0m`);
    for (const pid of existingPids) {
      try { execSync(`kill -9 ${pid} 2>/dev/null`); } catch {}
    }
    await new Promise(r => setTimeout(r, 600));
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

    // 优雅退出并强制核验端口释放，确保下次启动绝不冲突
    setTimeout(() => {
      const pids = getPidsOnPort(port);
      for (const pid of pids) {
        try { execSync(`kill -9 ${pid} 2>/dev/null`); } catch {}
      }
      console.log(`\x1b[32m✔ NVW 服务已停止，端口 ${port} 已完全释放。\x1b[0m`);
      process.exit(0);
    }, 350);
  };

  process.on('SIGINT', cleanExit);
  process.on('SIGTERM', cleanExit);

  child.on('exit', () => {
    if (!isStopping) {
      const pids = getPidsOnPort(port);
      for (const pid of pids) {
        try { execSync(`kill -9 ${pid} 2>/dev/null`); } catch {}
      }
      process.exit(0);
    }
  });
}

function handleStop() {
  let port = 3999;
  const restArgs = args.slice(1);
  for (let i = 0; i < restArgs.length; i++) {
    if (restArgs[i] === '-p' || restArgs[i] === '--port') {
      port = restArgs[++i] || port;
    }
  }

  const pids = getPidsOnPort(port);
  if (pids.length === 0) {
    console.log(`\x1b[32m✔ 端口 ${port} 没有正在运行的 NVW 服务。\x1b[0m`);
    return;
  }

  try {
    for (const pid of pids) {
      execSync(`kill -9 ${pid} 2>/dev/null`);
    }
    console.log(`\x1b[32m✔ 成功停止运行在端口 ${port} 上的服务 (PID: ${pids.join(', ')}).\x1b[0m`);
  } catch (err) {
    console.error(`\x1b[31m✖ 停止进程失败: ${err.message}\x1b[0m`);
  }
}

function handleStatus() {
  let port = 3999;
  const restArgs = args.slice(1);
  for (let i = 0; i < restArgs.length; i++) {
    if (restArgs[i] === '-p' || restArgs[i] === '--port') {
      port = restArgs[++i] || port;
    }
  }

  const pids = getPidsOnPort(port);
  if (pids.length > 0) {
    console.log(`\x1b[32m● NVW 服务正在运行\x1b[0m`);
    console.log(`  - 端口: ${port}`);
    console.log(`  - PID: ${pids.join(', ')}`);
    console.log(`  - 网址: http://127.0.0.1:${port}`);
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
