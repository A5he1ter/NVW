import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import os from 'os';
import { NvimEmbed } from './server/nvim-embed.js';
import { GridState } from './server/grid-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
// WS 用 noServer + 自建 upgrade 路由：直接 new WebSocketServer({ server, path })
// 会在路径不匹配时抢先回 400，导致其它端点收不到连接（实测踩过）。

const PORT = process.env.NVW_PORT || process.env.PORT || 3999;
const HOST = process.env.NVW_HOST || '127.0.0.1';

// 当前活动工作区
const initialProject = process.env.NVW_WORKSPACE || (process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : null) || process.cwd();
let currentProject = path.resolve(initialProject);

// 历史项目记录文件
const PROJECTS_FILE = path.join(os.homedir(), '.nvw_recent_projects.json');

function loadRecentProjects() {
  try {
    if (fs.existsSync(PROJECTS_FILE)) {
      const list = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8'));
      return list.filter(p => fs.existsSync(p) && p !== os.homedir());
    }
  } catch (e) {
    console.error('Failed to read recent projects:', e);
  }
  return [
    currentProject,
    path.resolve(__dirname, '..')
  ];
}

function saveRecentProjects(projects) {
  try {
    const filtered = Array.from(new Set(projects)).filter(p => p !== os.homedir()).slice(0, 20);
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(filtered, null, 2));
  } catch (e) {
    console.error('Failed to save recent projects:', e);
  }
}

let recentProjects = loadRecentProjects();
if (!recentProjects.includes(currentProject) && currentProject !== os.homedir()) {
  recentProjects.unshift(currentProject);
  saveRecentProjects(recentProjects);
}

app.use((req, res, next) => {
  // F01 校验 HTTP Host 与 Origin 白名单，防止外部恶意网站对本地 REST API 发起 CSRF / DNS Rebinding
  const host = req.headers['host'] || '';
  const origin = req.headers['origin'];
  const isLocalHost = /^127\.0\.0\.1(:\d+)?$/.test(host) || /^localhost(:\d+)?$/.test(host);
  if (!isLocalHost) {
    return res.status(403).json({ error: 'Forbidden: Invalid Host' });
  }
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.hostname !== '127.0.0.1' && originUrl.hostname !== 'localhost') {
        return res.status(403).json({ error: 'Forbidden: Untrusted Origin' });
      }
    } catch {
      return res.status(403).json({ error: 'Forbidden: Malformed Origin' });
    }
  }

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// —— 诊断用请求日志 ——
// 记录"谁请求了什么、拿到什么状态码"，写进 $TMPDIR/nvw-http.log，
// 用于排查"页面停在静态外壳、JS 没跑起来"这类问题（浏览器控制台拿不到时，服务端是唯一证人）。
const HTTP_LOG = path.join(os.tmpdir(), 'nvw-http.log');
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const ua = req.headers['user-agent'] || '';
    try {
      fs.appendFileSync(HTTP_LOG,
        `${new Date().toISOString()} ${res.statusCode} ${req.method} ${req.originalUrl} ${Date.now() - started}ms ua="${ua}"\n`);
    } catch {}
    if (req.path === '/' || res.statusCode >= 400) {
      console.log(`[http] ${res.statusCode} ${req.method} ${req.originalUrl}${req.path === '/' ? '  ua=' + ua : ''}`);
    }
  });
  next();
});

app.use(express.json());

// 浏览器/工具在缺少 rel=icon 的文档里总会回退请求 /favicon.ico，
// 301 到我们真实的 SVG 图标，杜绝控制台里永远消不掉的 favicon 404 噪声。
app.get('/favicon.ico', (req, res) => res.redirect(302, '/favicon.svg'));

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0
}));

// 忽略的文件和文件夹（系统敏感目录与大型构建依赖）
const IGNORED_NAMES = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  '.DS_Store',
  '.idea',
  '.vscode',
  '.mypy_cache',
  '.pytest_cache',
  'Library',
  'Applications',
  '.cache',
  '.npm'
]);

// 单层目录快速扫描（极速，支持树形懒加载）
function getDirectoryItems(targetDir, rootPath) {
  try {
    if (!fs.existsSync(targetDir)) return [];
    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    const items = [];

    const sorted = entries
      .filter(e => !IGNORED_NAMES.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    for (const entry of sorted) {
      const fullPath = path.join(targetDir, entry.name);
      const relativePath = path.relative(rootPath, fullPath);
      if (entry.isDirectory()) {
        items.push({
          name: entry.name,
          path: fullPath,
          relativePath,
          type: 'directory',
          hasChildren: true
        });
      } else {
        const ext = path.extname(entry.name).toLowerCase().replace('.', '');
        items.push({
          name: entry.name,
          path: fullPath,
          relativePath,
          type: 'file',
          ext
        });
      }
    }
    return items;
  } catch (err) {
    return [];
  }
}

// 判断路径是否在指定根目录范围内（防止同名前缀邻居目录逃逸及符号链接穿透）
function isPathInside(targetPath, rootDir, { mustResolveReal = false } = {}) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(rootDir);

  const rel = path.relative(resolvedRoot, resolvedTarget);
  const isLexicallyInside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (!isLexicallyInside) return false;

  if (mustResolveReal) {
    try {
      // 检查已存在路径或最近父目录的真实物理路径
      let checkPath = resolvedTarget;
      while (checkPath && !fs.existsSync(checkPath)) {
        const parent = path.dirname(checkPath);
        if (parent === checkPath) break;
        checkPath = parent;
      }
      if (checkPath && fs.existsSync(checkPath)) {
        const realTarget = fs.realpathSync(checkPath);
        const realRoot = fs.realpathSync(resolvedRoot);
        const realRel = path.relative(realRoot, realTarget);
        if (realRel !== '' && (realRel.startsWith('..') || path.isAbsolute(realRel))) {
          return false;
        }
      }
    } catch {
      return false;
    }
  }

  return true;
}
function scanPlots(dirPath, rootPath = dirPath, depth = 0) {
  if (depth > 2) return [];
  const plotExts = new Set(['png', 'jpg', 'jpeg', 'svg', 'webp', 'pdf']);
  let plots = [];

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name) || entry.name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        plots = plots.concat(scanPlots(fullPath, rootPath, depth + 1));
      } else {
        const ext = path.extname(entry.name).toLowerCase().replace('.', '');
        if (plotExts.has(ext)) {
          const stats = fs.statSync(fullPath);
          plots.push({
            name: entry.name,
            path: fullPath,
            relativePath: path.relative(rootPath, fullPath),
            mtime: stats.mtime,
            size: stats.size,
            ext
          });
          if (plots.length >= 30) break;
        }
      }
    }
  } catch (e) {}

  return plots.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
}

// 活跃 Neovim 会话状态
// 进程安全终止集合

// ---------------- REST API ----------------

// 当前服务 PID 与元数据记录
app.get('/api/instance', (req, res) => {
  res.json({
    app: 'nvw',
    pid: process.pid,
    port: PORT,
    workspace: currentProject
  });
});

// 优雅关闭受控接口
app.post('/api/shutdown', (req, res) => {
  res.json({ success: true, message: 'Shutting down' });
  setTimeout(() => gracefulShutdown(), 100);
});

// 获取当前工作区及最近记录
app.get('/api/projects', (req, res) => {
  res.json({
    current: currentProject,
    currentName: path.basename(currentProject) || currentProject,
    recent: recentProjects
  });
});

// 统一工作区切换逻辑 (包含未保存检查、Neovim cwd 协调与最近记录更新)
async function doSwitchWorkspace(targetPath, { force = false } = {}) {
  const resolved = path.resolve(targetPath);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error('目标必须是有效目录');
  }

  const nvim = await ensureUiSession();
  if (nvim) {
    const modified = await nvim.rpc('nvim_exec_lua', `
      local list = {}
      for _, b in ipairs(vim.api.nvim_list_bufs()) do
        if vim.api.nvim_buf_is_loaded(b) and vim.bo[b].modified then
          local name = vim.api.nvim_buf_get_name(b)
          table.insert(list, { bufnr = b, name = (name ~= '' and name or '[No Name]') })
        end
      end
      return list
    `, []);

    if (modified.length > 0 && !force) {
      const err = new Error('存在未保存修改的缓冲区');
      err.hasUnsaved = true;
      err.modified = modified;
      err.status = 409;
      throw err;
    }

    await nvim.setCwd(resolved);
  }

  currentProject = resolved;
  if (currentProject !== os.homedir()) {
    recentProjects = [resolved, ...recentProjects.filter(p => p !== resolved)].slice(0, 20);
    saveRecentProjects(recentProjects);
  }

  return {
    current: currentProject,
    currentName: path.basename(currentProject) || currentProject
  };
}

// 切换工作区
app.post('/api/project/switch', async (req, res) => {
  const targetPath = req.body.path || req.body.projectPath;
  if (!targetPath || !fs.existsSync(targetPath)) {
    return res.status(400).json({ error: '路径不存在' });
  }

  try {
    const result = await doSwitchWorkspace(targetPath, { force: req.body.force === true });
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.hasUnsaved) {
      return res.status(409).json({
        error: err.message,
        hasUnsaved: true,
        modified: err.modified
      });
    }
    const status = err.status || (err.message.includes('有效目录') ? 400 : 500);
    res.status(status).json({ error: err.message });
  }
});

// 目录浏览 API (供可视化文件夹浏览器使用)
app.get('/api/browse-dirs', (req, res) => {
  const queryDir = req.query.dir || req.query.path;
  const reqDir = queryDir ? path.resolve(queryDir) : currentProject;
  if (!fs.existsSync(reqDir) || !fs.statSync(reqDir).isDirectory()) {
    return res.status(400).json({ error: '无效目录路径' });
  }

  const parent = path.dirname(reqDir) !== reqDir ? path.dirname(reqDir) : null;
  const folders = [];

  try {
    const entries = fs.readdirSync(reqDir, { withFileTypes: true });
    const sorted = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !IGNORED_NAMES.has(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const e of sorted) {
      folders.push({
        name: e.name,
        path: path.join(reqDir, e.name)
      });
    }
  } catch (err) {}

  res.json({
    current: reqDir,
    parent,
    folders,
    dirs: folders
  });
});

// 新建工作区 API
app.post('/api/create-workspace', async (req, res) => {
  const { parentDir, name, force } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '工作区名称不能为空' });
  }

  const baseDir = parentDir && fs.existsSync(parentDir) ? path.resolve(parentDir) : currentProject;
  const targetPath = path.join(baseDir, name.trim());

  try {
    if (fs.existsSync(targetPath)) {
      return res.status(400).json({ error: '该文件夹已存在' });
    }
    fs.mkdirSync(targetPath, { recursive: true });

    // F05: 创建成功后复用统一工作区切换逻辑（进行未保存保护和 Neovim cwd 切换）
    try {
      await doSwitchWorkspace(targetPath, { force: force === true });
    } catch (switchErr) {
      if (switchErr.hasUnsaved) {
        return res.status(409).json({
          created: true,
          error: switchErr.message,
          hasUnsaved: true,
          modified: switchErr.modified,
          path: targetPath,
          name: path.basename(targetPath)
        });
      }
      return res.status(500).json({
        created: true,
        error: `目录已创建，但切换工作区失败: ${switchErr.message}`,
        path: targetPath,
        name: path.basename(targetPath)
      });
    }

    res.json({
      success: true,
      path: targetPath,
      name: path.basename(targetPath)
    });
  } catch (err) {
    res.status(500).json({ error: '创建工作区失败: ' + err.message });
  }
});

// 在工作区内新建文件 / 目录
// 与 /api/create-workspace 的区别：这一步**不改变当前工作区**，也不写入 recentProjects。
// 原先 "+d" 只能借道 create-workspace（它会顺手切换工作区），导致点一次新建目录就换了工作区、
// 最近工作区列表被污染，还得再切回来。
app.post('/api/create-item', (req, res) => {
  const kind = req.body.kind === 'dir' ? 'dir' : 'file';
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '名称不能为空' });
  if (path.isAbsolute(name)) return res.status(400).json({ error: '请使用相对路径' });

  const base = req.body.parent ? path.resolve(currentProject, String(req.body.parent)) : currentProject;
  const target = path.resolve(base, name);
  if (!isPathInside(base, currentProject, { mustResolveReal: true }) || !isPathInside(target, currentProject, { mustResolveReal: true })) {
    return res.status(403).json({ error: '越权访问：超出当前工作区范围' });
  }
  if (fs.existsSync(target)) {
    return res.status(409).json({ error: kind === 'dir' ? '该目录已存在' : '该文件已存在' });
  }

  try {
    if (kind === 'dir') {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '', { flag: 'wx' });
    }
    res.json({ success: true, kind, path: target, rel: path.relative(currentProject, target) });
  } catch (err) {
    res.status(500).json({ error: `创建失败: ${err.message}` });
  }
});

// 快速获取文件树 (支持单层 / 子目录展开)
app.get('/api/files', (req, res) => {
  const sub = req.query.dir ? path.resolve(currentProject, req.query.dir) : currentProject;
  if (!isPathInside(sub, currentProject, { mustResolveReal: false })) {
    return res.status(403).json({ error: '越权访问：超出当前工作区范围' });
  }

  const items = getDirectoryItems(sub, currentProject);
  res.json({
    project: currentProject,
    projectName: path.basename(currentProject) || currentProject,
    files: items
  });
});

// 全局工作区快速搜索文件
// 单次服务端遍历替代前端 N+1 目录请求：前端一次调用即可拿到排好序的结果。
// 排序：文件名前缀命中 > 文件名包含 > 路径包含；同级按路径长度（越浅越靠前）。
app.get('/api/search-files', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
  const HARD_CAP = 1200;          // 内部收集上限，保证排序质量的同时不拖垮大仓库
  const MAX_DEPTH = 8;

  const files = [];
  let capped = false;

  function walk(dir, depth) {
    if (files.length >= HARD_CAP || depth > MAX_DEPTH) { capped = true; return; }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const e of entries) {
      if (files.length >= HARD_CAP) { capped = true; return; }
      if (IGNORED_NAMES.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }

      const rel = path.relative(currentProject, full);
      const lowerName = e.name.toLowerCase();
      const lowerRel = rel.toLowerCase();

      if (q && !lowerName.includes(q) && !lowerRel.includes(q)) continue;
      files.push({
        name: e.name,
        path: rel,
        dir: path.dirname(rel) === '.' ? '' : path.dirname(rel),
        fullPath: full,
        score: !q ? 0 : (lowerName.startsWith(q) ? 0 : (lowerName.includes(q) ? 1 : 2))
      });
    }
  }

  walk(currentProject, 0);

  files.sort((a, b) => (a.score - b.score) || (a.path.length - b.path.length) || a.path.localeCompare(b.path));
  const total = files.length;
  const results = files.slice(0, limit).map(({ score, ...rest }) => rest);

  res.json({ results, total, truncated: capped || total > results.length, query: q });
});

// 会话快照：一次 RPC 同时取回状态与 buffer 列表（原先前端每轮要发两次请求、起两个 nvim 进程）
app.get('/api/session', async (req, res) => {
  const nvim = await ensureUiSession();
  if (!nvim) return res.status(200).json({ status: {}, buffers: [], clients: uiClients.size });
  try {
    const data = await nvim.rpc('nvim_exec_lua', `
      local m = vim.api.nvim_get_mode().mode
      local buffers = {}
      for _, b in ipairs(vim.api.nvim_list_bufs()) do
        if vim.api.nvim_buf_is_loaded(b) and vim.bo[b].buflisted then
          buffers[#buffers+1] = { bufnr = b, name = vim.api.nvim_buf_get_name(b),
                                  changed = vim.bo[b].modified and 1 or 0,
                                  active = (b == vim.api.nvim_get_current_buf()) and 1 or 0 }
        end
      end
      return { status = { modeRaw = m, name = vim.fn.expand('%:t'), filetype = vim.bo.filetype,
                          modified = vim.bo.modified and 1 or 0, line = vim.fn.line('.'),
                          col = vim.fn.col('.'), total = vim.api.nvim_buf_line_count(0),
                          lines = vim.o.lines, columns = vim.o.columns },
               buffers = buffers }`, []);
    const MODE_NAMES = { n:'NORMAL', v:'VISUAL', V:'V-LINE', i:'INSERT', R:'REPLACE', c:'COMMAND',
                         r:'PROMPT', t:'TERMINAL', s:'SELECT' };
    data.status.mode = MODE_NAMES[data.status.modeRaw] || String(data.status.modeRaw || '').toUpperCase();
    res.json({ ...data, clients: uiClients.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 白名单化的 Neovim 命令桥：前端只发语义化名字，绝不把任意 ex 命令透传到 nvim
const NVIM_COMMANDS = {
  save: "execute('write')",
  close: "execute('bdelete')",
  new: "execute('enew')",
  reload: "execute('edit!')"
};

app.post('/api/nvim-cmd', async (req, res) => {
  const cmd = String(req.body.cmd || '');
  const VIM_CMD = { save: 'write', close: 'bdelete', new: 'enew', reload: 'edit!' };
  const vimCmd = VIM_CMD[cmd];
  if (!vimCmd) return res.status(400).json({ error: `不支持的命令: ${cmd}` });

  const nvim = await ensureUiSession();
  if (!nvim) return res.status(500).json({ error: '未连接到 Neovim' });
  try {
    await nvim.rpc('nvim_command', vimCmd);
    res.json({ success: true, cmd });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/set-theme', async (req, res) => {
  let theme = req.body.theme || req.body.mode || 'catppuccin-mocha';
  if (theme === 'light') theme = 'catppuccin-latte';
  if (theme === 'dark') theme = 'catppuccin-mocha';

  const nvim = await ensureUiSession();
  if (!nvim) return res.status(500).json({ status: 'failed', error: '未连接到 Neovim' });
  try {
    // 主题脚本（nvim_theme.lua）暴露 AilyreTheme；执行后 nvim 触发 ColorScheme，
    // 我们注册的 autocmd 会回调刷新颜色表并广播给浏览器 —— 颜色始终只有一个来源。
    await nvim.rpc('nvim_command', `AilyreTheme ${String(theme).replace(/[^a-zA-Z0-9_-]/g, '')}`);
    res.json({ status: 'applied', theme });
  } catch (e) {
    console.error('[ui] 设置主题失败:', e.message);
    res.status(500).json({ status: 'failed', error: e.message });
  }
});

app.post('/api/open-file', async (req, res) => {
  const file = req.body.file || req.body.filePath;
  if (!file) return res.status(400).json({ error: '缺少文件路径' });

  // 走常驻 UI 通道（msgpack-rpc），不再 spawn 一个 nvim 进程去 --remote-expr：
  // 每次 spawn 要几十毫秒，而且拿不到"整屏替换后需要全量重绘"这件事。
  const nvim = await ensureUiSession();
  if (!nvim) return res.status(500).json({ error: '当前没有活动的 Neovim 实例' });

  try {
    // 用 nvim_cmd 传结构化参数：Vim 命令行里单引号**不是**引号，
    // `edit '<路径>'` 会被当成字面文件名（实测缓冲区名字直接变成一个带引号的怪路径）。
    await nvim.rpc('nvim_cmd', { cmd: 'edit', args: [file] }, {});
    res.json({ success: true, method: 'embed-rpc' });
  } catch (e) {
    res.status(500).json({ error: `打开文件失败: ${e.message}` });
  }
});

// 获取 Neovim 当前所有打开的 buffers (标签页数据)
app.get('/api/buffers', async (req, res) => {
  const nvim = await ensureUiSession();
  if (!nvim) return res.status(500).json({ error: '未连接到 Neovim' });
  try {
    const buffers = await nvim.rpc('nvim_exec_lua', `
      local out = {}
      for _, b in ipairs(vim.api.nvim_list_bufs()) do
        if vim.api.nvim_buf_is_loaded(b) and vim.bo[b].buflisted then
          out[#out+1] = { bufnr = b, name = vim.api.nvim_buf_get_name(b),
                          changed = vim.bo[b].modified and 1 or 0,
                          active = (b == vim.api.nvim_get_current_buf()) and 1 or 0 }
        end
      end
      return out`, []);
    res.json({ buffers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 读取 Neovim 真实状态：模式 / 尺寸 / 编码 / 是否已修改 / buftype
// 前端状态栏必须显示这些真实值，不能写死 "NORMAL"、"utf-8" 之类的假信息
app.get('/api/status', async (req, res) => {
  const nvim = await ensureUiSession();
  if (!nvim) return res.status(500).json({ error: '未连接到 Neovim' });
  try {
    const st = await nvim.rpc('nvim_exec_lua', `
      local m = vim.api.nvim_get_mode().mode
      return { modeRaw = m, lines = vim.o.lines, columns = vim.o.columns,
               encoding = (vim.bo.fileencoding ~= '' and vim.bo.fileencoding or vim.o.encoding),
               modified = vim.bo.modified and 1 or 0, name = vim.fn.expand('%:t'),
               filetype = vim.bo.filetype, buftype = vim.bo.buftype,
               bufnr = vim.api.nvim_get_current_buf(),
               winid = vim.api.nvim_get_current_win(),
               line = vim.fn.line('.'), col = vim.fn.col('.'),
               total = vim.api.nvim_buf_line_count(0) }`, []);
    const MODE_NAMES = { n:'NORMAL', no:'OP', nov:'OP', noV:'OP', v:'VISUAL', V:'V-LINE', '\u0016':'V-BLOCK',
      i:'INSERT', ic:'INSERT', ix:'INSERT', R:'REPLACE', c:'COMMAND', r:'PROMPT', t:'TERMINAL', s:'SELECT' };
    res.json({ ...st, mode: MODE_NAMES[st.modeRaw] || String(st.modeRaw || '').toUpperCase() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 切换标签页 (buffer)
app.post('/api/switch-buffer', async (req, res) => {
  const bufnr = req.body.bufnr || req.body.bufferId;
  if (!bufnr) return res.status(400).json({ error: '缺少 bufnr' });
  const nvim = await ensureUiSession();
  if (!nvim) return res.status(500).json({ error: '未连接到 Neovim' });
  try {
    await nvim.rpc('nvim_set_current_buf', parseInt(bufnr, 10));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: `切换标签失败: ${e.message}` });
  }
});

// 关闭标签页 (安全关闭与强制关闭协议)
app.post('/api/close-buffer', async (req, res) => {
  const bufnr = parseInt(req.body.bufnr || req.body.bufferId, 10);
  const discard = req.body.discard === true;
  const save = req.body.save === true;
  if (!bufnr) return res.status(400).json({ error: '缺少 bufnr' });

  const nvim = await ensureUiSession();
  if (!nvim) return res.status(500).json({ error: '未连接到 Neovim' });
  try {
    const modified = await nvim.rpc('nvim_exec_lua',
      'return vim.bo[...].modified and 1 or 0', [bufnr]);
    if (modified === 1 && !discard && !save) {
      return res.status(409).json({ error: 'Buffer has unsaved changes', modified: true, bufnr });
    }
    await nvim.rpc('nvim_exec_lua', `
      local b = ...
      if vim.bo[b].modified and ${save ? 'true' : 'false'} then vim.api.nvim_buf_call(b, function() vim.cmd('write') end) end
      local listed = #vim.fn.getbufinfo({ buflisted = 1 })
      if listed <= 1 then vim.cmd('enew') end
      vim.api.nvim_buf_delete(b, { force = ${discard ? 'true' : 'false'} })`, [bufnr]);
    res.json({ success: true, bufnr });
  } catch (e) {
    res.status(500).json({ error: `关闭失败: ${e.message}` });
  }
});

// 新建空 buffer
app.post('/api/new-buffer', async (req, res) => {
  const nvim = await ensureUiSession();
  if (!nvim) return res.status(500).json({ error: '未连接到 Neovim' });
  try {
    await nvim.rpc('nvim_command', 'enew');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =====================================================================
   UI 协议桥（新架构主链）
   nvim --embed ──msgpack-rpc──▶ 本进程 ──WS(JSON)──▶ 浏览器 DOM 渲染
   取代 "PTY + 终端模拟器"：不再有 VT 字节流、不再有字符宽高猜测。
   ===================================================================== */
const uiWss = new WebSocketServer({ noServer: true });

// upgrade 路由：/ws/ui → nvim 常驻通道（唯一的数据通路）
server.on('upgrade', (req, socket, head) => {
  let reqUrl;
  try { reqUrl = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
  if (reqUrl.pathname !== '/ws/ui') {
    socket.destroy();
    return;
  }

  // F01 校验 Origin 与 Host 白名单，防御跨站 WebSocket 劫持 (CSWSH)
  const host = req.headers['host'] || '';
  const origin = req.headers['origin'];

  // Host 必须是本地 loopback
  const isLocalHost = /^127\.0\.0\.1(:\d+)?$/.test(host) || /^localhost(:\d+)?$/.test(host);
  if (!isLocalHost) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  // Origin 检查：若有 Origin，必须匹配本地 loopback
  if (origin) {
    let originUrl;
    try { originUrl = new URL(origin); } catch {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const isLocalOrigin = (originUrl.hostname === '127.0.0.1' || originUrl.hostname === 'localhost');
    if (!isLocalOrigin) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  uiWss.handleUpgrade(req, socket, head, ws => uiWss.emit('connection', ws, req));
});
const uiClients = new Set();
let uiSession = null;
let uiQueue = [];

function broadcastUi(msg) {
  const payload = JSON.stringify(msg);
  for (const c of uiClients) if (c.readyState === WebSocket.OPEN) c.send(payload);
}

function flushUiFrame() {                       // 一个 nvim 通知 = 一帧（0.12.5 不发 flush 事件）
  if (!uiQueue.length) return;
  broadcastUi({ t: 'frame', events: uiQueue.splice(0) });
}

/** 确保常驻通道存在（REST 端点也能直接用它，不必等浏览器连上） */
async function ensureUiSession() {
  if (uiSession && !uiSession.exited && !uiSession.broken) return uiSession;
  try { return await getUiSession(100, 30); } catch (e) { console.error('[ui] 启动失败:', e.message); return null; }
}

let uiStarting = null;
async function getUiSession(cols, rows) {
  // 已存在时也要 await start()：start() 幂等，返回的是同一个 promise。
  // 否则第二个调用者会在通道还没 attach 完时就发 RPC，直接吃 "通道已关闭"（实测 500）。
  if (uiSession && !uiSession.exited && !uiSession.broken) { await uiSession.start(); return uiSession; }
  // 并发首次连接（页面 WS + setTheme REST 同时到）必须复用同一次启动，
  // 否则会 spawn 出两个 nvim，其中一个被覆盖后再也没人回收。
  if (uiStarting) return uiStarting;
  const nvim = new NvimEmbed({ cwd: currentProject, workspace: currentProject, cols, rows });
  nvim.grid = new GridState(cols, rows);          // 服务端权威网格（给新客户端发快照）
  nvim.on('ui', (name, args) => {
    nvim.grid.apply(name, args);
    uiQueue.push([name, args]);
  });
  nvim.on('frame', flushUiFrame);
  nvim.on('colors', c => broadcastUi({ t: 'colors', groups: c.groups || {}, normal: c.normal || {} }));
  nvim.on('handlerError', (where, e) => console.error('[ui] 事件处理器异常:', where, e.message));
  // 换缓冲区（:edit / :bnext / 点文件树）后 nvim 的增量不完整，必须整屏重来：
  // 先清空镜像与客户端（抹掉旧屏残留），再触发一次全量重绘把内容填回来。
  // 注意：这里**不能**清空镜像。nvim 的增量是"相对它自己屏幕"算的，
  // 清空本地状态等于主动丢内容，而 nvim 不会把没变化的格子重发一遍（实测踩过）。
  nvim.on('stderr', d => { const t = d.trim(); if (t) console.error('[nvim]', t.slice(0, 400)); });
  nvim.on('exit', () => {
    if (uiSession === nvim) {
      uiSession = null;
      broadcastUi({ t: 'closed' });
    }
  });
  uiStarting = (async () => {
    await nvim.start();
    uiSession = nvim;
    console.log(`[ui] nvim --embed 就绪 ${nvim.version.major}.${nvim.version.minor}.${nvim.version.patch}  chan=${nvim.chan}`);
    return nvim;
  })();
  try {
    return await uiStarting;
  } finally {
    uiStarting = null;
  }
}

uiWss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const cols = Math.max(20, parseInt(url.searchParams.get('cols'), 10) || 100);
  const rows = Math.max(5, parseInt(url.searchParams.get('rows'), 10) || 30);
  uiClients.add(ws);

  let nvim;
  try {
    nvim = await getUiSession(cols, rows);
  } catch (e) {
    ws.send(JSON.stringify({ t: 'error', message: `nvim 启动失败: ${e.message}` }));
    ws.close();
    return;
  }

  // 新客户端拿到的是空网格，而 nvim 认为屏幕早已同步（增量协议），
  // 所以这里先"清空镜像 + 触发一次全量重绘"，再把重绘后的镜像作为快照发出去。
  // 这样新客户端、老客户端、服务端镜像三者一次对齐（否则刷新页面 = 全白）。
  ws.send(JSON.stringify({ t: 'colors', groups: nvim.colors.groups || {}, normal: nvim.colors.normal || {} }));
  ws.send(JSON.stringify({ t: 'snapshot', ...nvim.grid.snapshot() }));
  ws.send(JSON.stringify({ t: 'ready', cols: nvim.cols, rows: nvim.rows }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf-8') : raw); } catch { return; }
    try {
      if (msg.t === 'input') await nvim.input(msg.keys);
      else if (msg.t === 'paste') await nvim.paste(msg.data);
      else if (msg.t === 'mouse') await nvim.inputMouse(msg.button, msg.action, msg.modifier || '', msg.grid || 0, msg.row, msg.col);
      else if (msg.t === 'colors') await nvim.refreshColors();
      else if (msg.t === 'resize') {
        const c = Math.max(20, parseInt(msg.cols, 10) || 100);
        const r = Math.max(5, parseInt(msg.rows, 10) || 30);
        await nvim.tryResize(c, r);
      }
    } catch (e) {
      console.error('[ui] 客户端消息处理失败:', e.message);
    }
  });

  ws.on('close', () => {
    uiClients.delete(ws);
    console.log(`[ui] 客户端断开，剩余 ${uiClients.size}`);
  });
});

let isShuttingDown = false;
const gracefulShutdown = async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('\n🛑 正在停止 NVW 服务...');

  // 1. 关闭所有活跃客户端 WebSocket 连接
  for (const c of uiClients) {
    try { c.close(); } catch {}
  }
  uiClients.clear();

  // 2. 异步等待启动中或已就绪的 Neovim 实例完整 dispose 与回收
  try {
    if (uiStarting) {
      const startingInstance = await Promise.race([
        uiStarting.catch(() => null),
        new Promise(r => setTimeout(r, 800))
      ]);
      if (startingInstance) await startingInstance.dispose(1500).catch(() => {});
    }
  } catch {}

  if (uiSession) {
    try { await uiSession.dispose(1500); } catch {}
    uiSession = null;
  }

  // 3. 关闭 HTTP 监听
  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(0);
  }, 2500);
};

process.on('SIGINT', () => { gracefulShutdown(); });
process.on('SIGTERM', () => { gracefulShutdown(); });

server.listen(PORT, HOST, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 NVW • Authentic Neovim Web Studio is running!`);
  console.log(`🌐 Web UI: http://${HOST}:${PORT}`);
  console.log(`📂 Workspace: ${currentProject}`);
  console.log(`⌨️  按 Ctrl+C 可随时停止服务并释放端口`);
  console.log(`======================================================\n`);
});
