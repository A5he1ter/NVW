/**
 * NVW · 100% WebTUI 前端引擎（行为层编排）
 * 所有 DOM 仅使用官方 WebTUI 元素与属性（https://webtui.ironclad.sh）
 * 不产生任何自定义 class / 自定义选择器样式 / 行内样式
 */

import { api } from './js/api.js';
import { showToast } from './js/toast.js';
import { createTree } from './js/tree.js';
import { createTabs } from './js/tabs.js';
import { createStatusbar } from './js/statusbar.js';
import { createGridRenderer } from './js/grid-renderer.js';
import { createInputLayer } from './js/input.js';

let THEMES_REGISTRY = {};

const STORE = typeof localStorage === 'undefined' ? null : localStorage;
const readPref = (key, fallback) => {
  try { return (STORE && STORE.getItem(key)) ?? fallback; } catch { return fallback; }
};
const writePref = (key, value) => { try { STORE?.setItem(key, value); } catch { /* 隐私模式 */ } };
const dropPref = key => { try { STORE?.removeItem(key); } catch { /* 隐私模式 */ } };

const state = {
  term: null,
  fitAddon: null,
  ws: null,
  reconnectAttempts: 0,
  lastResizeSig: null,   // 上一次真正发给服务端的 (cols×rows, focused) 签名，用于去重
  connectTimer: null,    // WS 连接超时计时器（后端不可达时用它报警）
  lastStatus: null,      // /api/session 最近一次 status，供 newBuffer() 判断空 buffer
  currentTheme: readPref('nvw_theme', 'catppuccin-mocha'),
  currentProject: '',
  recentProjects: [],
  buffers: [],
  status: null,
  zen: false,
  activePath: '',
  pendingCloseBufnr: null,
  sessionSeq: 0,
  pollTimer: null,
  finder: null,
  browser: null,
  renderer: null,
  rendererAddon: null,
  lhFixes: 0
};

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[m]);
}

const baseName = p => (p ? String(p).split('/').pop() : '');
const $ = id => document.getElementById(id);

/* ---------------- 模块装配（构造期不碰 DOM） ---------------- */

const tree = createTree({ api, showToast, openPath, focusTerminal, home: () => state.currentProject });
const tabs = createTabs({ api, showToast, onSwitch: switchBuffer, onClose: closeBuffer });
const statusbar = createStatusbar({ api });

/* ---------------- 1. 主题 ---------------- */

async function loadThemes() {
  try {
    const res = await fetch('/themes/manifest.json');
    const data = await res.json();
    THEMES_REGISTRY = data.themes || {};
  } catch {
    THEMES_REGISTRY = {};
  }
}

function applyTheme(themeKey) {
  state.currentTheme = themeKey;
  const themeObj = THEMES_REGISTRY[themeKey];
  document.documentElement.setAttribute('data-webtui-theme', themeObj ? themeObj.webtuiTheme : themeKey);

  const label = $('themeLabel');
  if (label && themeObj) label.textContent = themeObj.label;


  writePref('nvw_theme', themeKey);
  api.setTheme(themeKey).catch(() => {});
}

function initThemePicker() {
  const list = $('themePickerList');
  if (!list) return;

  list.innerHTML = Object.entries(THEMES_REGISTRY).map(([k, v]) => {
    const current = k === state.currentTheme;
    return `<button size-="small" variant-="${current ? 'foreground0' : 'background0'}"` +
      ` data-theme="${esc(k)}" title="${esc(v.label)}">${current ? '· ' : '  '}${esc(v.label)}</button>`;
  }).join('');

  list.querySelectorAll('button[data-theme]').forEach(btn => {
    btn.addEventListener('click', () => {
      applyTheme(btn.dataset.theme);
      $('themePanel')?.hidePopover();
      initThemePicker();
      focusTerminal();
    });
  });
}

/* ---------------- 2. 工作区 ---------------- */

async function loadWorkspaces() {
  try {
    const data = await api.getWorkspaces();
    state.currentProject = data.current || '';
    state.recentProjects = data.recent || [];

    const name = data.currentName || baseName(data.current) || 'Workspace';
    const wsText = $('currentWorkspaceText');
    if (wsText) { wsText.textContent = name; wsText.title = data.current || ''; }
    const root = $('explorerRoot');
    if (root) { root.textContent = data.current || ''; root.title = data.current || ''; }
    const sw = $('statusWorkspace');
    if (sw) { sw.textContent = name; sw.title = data.current || ''; }
    renderRecentWorkspaces();
  } catch {
    /* api.js 已 toast；工作区未就绪时保持空态 */
  }
}

function renderRecentWorkspaces() {
  const list = $('recentProjectsList');
  if (!list) return;

  if (!state.recentProjects.length) {
    list.innerHTML = '<span is-="badge" variant-="foreground2">no recent workspace</span>';
    return;
  }

  list.innerHTML = state.recentProjects.map(p => {
    const current = p === state.currentProject;
    const name = baseName(p) || p;
    return `<button size-="small" variant-="${current ? 'foreground0' : 'background0'}"` +
      ` data-path="${esc(p)}" title="${esc(p)}">${current ? '· ' : '  '}${esc(name)}</button>`;
  }).join('');

  list.querySelectorAll('button[data-path]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const target = btn.dataset.path;
      $('workspacePanel')?.hidePopover();
      if (target === state.currentProject) { focusTerminal(); return; }
      await handleWorkspaceSwitch(target);
    });
  });
}

/* ---------------- 3. nvim 常驻通道与网格渲染 ---------------- */

/**
 * 这里曾经是"终端模拟器 + DPR/字宽/行高补丁"的一整套：
 * xterm 的 5 个 addon、dpi-bootstrap、naturalLineHeight、calibrateCellHeight、
 * ensureRendererResolution、PTY 尺寸仲裁……全部删除。
 * 现在只有一条链路：nvim --embed 的语义事件 → 行级 DOM，输入直接回 nvim_input。
 */
const ui = {
  renderer: null, input: null, ws: null, probe: null,
  cols: 0, rows: 0, reconnectAttempts: 0, connectTimer: 0, resizeTimer: 0
};
/** 量一次字符宽（探针是 100 个 x）与用户的基准字号/行高倍数 */
function measureCh() {
  if (!ui.probe) return 0;
  const w = ui.probe.getBoundingClientRect().width;
  return w > 0 ? w / 100 : 0;
}
function baseFont() {
  const root = getComputedStyle(document.documentElement);
  return {
    size: parseFloat(root.getPropertyValue('--base-font-size')) || 18,
    ratio: parseFloat(root.getPropertyValue('--line-height')) || 1.4
  };
}

/**
 * 计算容器容量与网格行列数。
 * 由浏览器容器尺寸与用户设定字体大小主导行列计算，通过 nvim_ui_try_resize 动态适配。
 */
function calculateGrid() {
  const container = $('nvimTerminal');
  const base = baseFont();
  if (!container) return { cols: 100, rows: 30, ch: 10, lh: 20 };
  const root = document.documentElement;
  root.style.setProperty('--term-font-size', `${base.size}px`);
  const ch = measureCh() || base.size * 0.6;
  const lh = base.size * base.ratio;
  const cols = Math.max(20, Math.floor(container.clientWidth / ch));
  const rows = Math.max(5, Math.floor(container.clientHeight / lh));
  return { cols, rows, ch, lh };
}

/** 首连时给服务端一个建会话用的估算行列 */
function estimateGrid() {
  return calculateGrid();
}

function uiSend(msg) {
  if (ui.ws?.readyState === WebSocket.OPEN) ui.ws.send(JSON.stringify(msg));
}

/**
 * 视口或字体改变时，根据编辑器容器尺寸与用户设定字号重新计算行列并下发 resize 给 Neovim。
 */
function syncGridSize() {
  const { cols, rows, ch, lh } = calculateGrid();
  ui.renderer?.setCellSize(ch, lh);
  if (cols !== ui.cols || rows !== ui.rows) {
    ui.cols = cols;
    ui.rows = rows;
    ui.renderer?.setSize(cols, rows);
    uiSend({ t: 'resize', cols, rows });
  }
}

function initTerminal() {
  const container = $('nvimTerminal');
  if (!container) return;
  container.innerHTML = '';

  ui.renderer = createGridRenderer({ container });

  ui.probe = document.createElement('span');
  ui.probe.textContent = 'x'.repeat(100);
  ui.probe.setAttribute('data-nvw-probe', '');
  container.appendChild(ui.probe);

  ui.input = createInputLayer({
    root: container,
    getCellSize: () => ui.renderer.cellSize(),
    send: payload => {
      if (typeof payload === 'string') uiSend({ t: 'input', keys: payload });
      else if (payload?.paste !== undefined) uiSend({ t: 'paste', data: payload.paste });
      else if (payload?.mouse) uiSend({ t: 'mouse', ...payload.mouse, grid: 1 });
    }
  });

  // 行列数等 'ready' 里服务端告知（= nvim 当前的网格规模）

  container.addEventListener('mouseup', () => focusTerminal());
  window.addEventListener('resize', () => {
    clearTimeout(ui.resizeTimer);
    ui.resizeTimer = setTimeout(syncGridSize, 250);
  });
  Promise.resolve(document.fonts?.ready).then(() => syncGridSize()).catch(() => {});
  setTimeout(syncGridSize, 400);

  connectWebSocket();
}

function connectWebSocket() {
  try { ui.ws?.close(); } catch { /* 连接已关闭 */ }
  statusbar.setConnection('Connecting');

  // 首连用本页估算值建会话；服务端已有会话时以服务端为准（'ready' 会告知真实规模）
  const est = estimateGrid();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws/ui?cols=${est.cols}&rows=${est.rows}`);
  ui.ws = ws;

  // 后端不可达时必须"说出来"，否则页面只剩静态外壳
  clearTimeout(ui.connectTimer);
  ui.connectTimer = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) statusbar.setConnection('Disconnected');
  }, 4000);

  ws.onopen = () => {
    clearTimeout(ui.connectTimer);
    ui.reconnectAttempts = 0;
    statusbar.setConnection('Connected');
    api.setTheme(state.currentTheme).catch(() => {});
    refreshSession();
  };

  ws.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.t === 'snapshot') ui.renderer?.loadSnapshot(msg);
    else if (msg.t === 'clear') ui.renderer?.clear();
    else if (msg.t === 'frame') ui.renderer?.applyFrame(msg.events);
    else if (msg.t === 'colors') { ui.renderer?.setColors({ groups: msg.groups, normal: msg.normal }); syncGridSize(); }
    else if (msg.t === 'ready') {
      if (msg.cols && msg.rows) { ui.cols = msg.cols; ui.rows = msg.rows; }   // 以 nvim 的实际网格为准
      syncGridSize();
    }
    else if (msg.t === 'error') showToast(msg.message, 'error');
    else if (msg.t === 'closed') statusbar.setConnection('Disconnected');
  };

  ws.onclose = () => {
    statusbar.setConnection('Disconnected');
    const delay = Math.min(1000 * 1.5 ** ui.reconnectAttempts, 10000);
    ui.reconnectAttempts += 1;
    setTimeout(() => {
      if (ui.ws === ws && ws.readyState === WebSocket.CLOSED) connectWebSocket();
    }, delay);
  };

  ws.onerror = () => statusbar.setConnection('Error');
}

function reconnectNow() {
  ui.reconnectAttempts = 0;
  try { ui.ws?.close(); } catch { /* 已关闭 */ }
  connectWebSocket();
  refreshSession();
  showToast('Reconnecting…', 'info');
}

/* ---------------- 4. 会话轮询（替代原 2×2s 双请求） ---------------- */


function applySession(data) {
  const status = data && data.status ? data.status : null;
  const buffers = data && Array.isArray(data.buffers) ? data.buffers : [];
  state.lastStatus = status;   // 供 newBuffer() 判断"是不是已经在空的无名 buffer 上"


  state.status = status;
  state.buffers = buffers;

  tabs.render(buffers, status);
  statusbar.render(status, buffers);

  const active = buffers.find(b => b.active && b.name) || null;
  state.activePath = active ? active.name : '';
  Promise.resolve(tree.setActive(state.activePath)).catch(() => {});

}

async function refreshSession() {
  const seq = ++state.sessionSeq;
  try {
    const data = await api.getSession();
    if (seq !== state.sessionSeq) return;
    applySession(data);
  } catch {
    /* api.js 已 toast；断线提示由 WebSocket 状态驱动 */
  }
}

function startPolling(intervalMs = 1500) {
  stopPolling();
  state.pollTimer = setInterval(() => {
    if (document.hidden) return;
    refreshSession();
  }, intervalMs);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

/* ---------------- 5. 文件与 buffer 动作 ---------------- */

function focusTerminal() {
  ui.input?.focus();
}

const toAbs = p => (!p ? '' : (String(p).startsWith('/') ? p : `${state.currentProject}/${p}`));

async function openPath(path) {
  if (!path) return;
  const abs = toAbs(path);
  try {
    await api.openFile(abs);
    state.activePath = abs;
    await tree.setActive(abs);
    await refreshSession();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function switchBuffer(bufnr) {
  await api.switchBuffer(bufnr);
  await refreshSession();
  focusTerminal();
}

async function closeBuffer(bufnr, buf) {
  const known = buf || state.buffers.find(b => b.bufnr === bufnr) || { bufnr };
  // 关闭前先对齐一次真实状态：否则刚在 nvim 里改完就点关闭会用陈旧的 changed
  // 直接请求，服务端回 409（功能正确但会在控制台留下 error）。
  await refreshSession();
  const target = state.buffers.find(b => b.bufnr === bufnr) || known;
  const name = target.name ? baseName(target.name) : `[No Name ${bufnr}]`;
  if (target.changed) { openUnsavedGuard(bufnr, name); return; }
  try {
    await api.closeBuffer(bufnr);
    await refreshSession();
    showToast(`Closed ${name}`, 'info');
    focusTerminal();
  } catch (err) {
    if (err.status === 409) openUnsavedGuard(bufnr, name);
    else showToast(err.message, 'error');
  }
}

async function saveBuffer() {
  try {
    await api.nvimCommand('save');
    showToast('Buffer saved', 'success');
    await refreshSession();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function newBuffer() {
  // 已经在"空的无名 buffer"上时，Vim 的 :enew 会复用它（前一个空 buffer 被 wipe），
  // 标签数不会增加 —— 用户会以为按钮坏了。这里直接给一句解释，不做无意义的 RPC。
  const active = state.buffers.find(b => b.active);
  const st = state.lastStatus;
  const blankUnnamed = active && !active.name && !active.changed && (!st || st.total <= 1);
  if (blankUnnamed) {
    showToast('Already on an empty buffer — open a file or start typing', 'info');
    focusTerminal();
    return;
  }
  try {
    await api.nvimCommand('new');
    await refreshSession();
    showToast('New buffer', 'info');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function closeActiveBuffer() {
  const active = state.buffers.find(b => b.active);
  if (!active) { showToast('No active buffer', 'warn'); return; }
  await closeBuffer(active.bufnr);
}

async function cycleBuffer(direction) {
  const list = state.buffers;
  if (list.length < 2) { showToast('Only one buffer', 'info'); return; }
  const idx = Math.max(0, list.findIndex(b => b.active));
  const next = list[(idx + direction + list.length) % list.length];
  if (!next || next.active) return;
  await switchBuffer(next.bufnr);
}

/* ---------------- 6. 未保存守护 ---------------- */

function openUnsavedGuard(bufnr, name, onResolve) {
  state.pendingCloseBufnr = bufnr;
  state.pendingUnsavedCallback = onResolve;
  const msg = $('unsavedGuardMessage');
  if (msg) msg.textContent = `${name || '[No Name]'} has unsaved changes.`;
  const dialog = $('unsavedGuardDialog');
  if (dialog && !dialog.open) dialog.showModal();
}

function closeUnsavedGuard() {
  const dialog = $('unsavedGuardDialog');
  if (dialog?.open) dialog.close();
  state.pendingCloseBufnr = null;
  state.pendingUnsavedCallback = null;
  focusTerminal();
}

async function resolveUnsaved(mode) {
  if (state.pendingUnsavedCallback) {
    const cb = state.pendingUnsavedCallback;
    closeUnsavedGuard();
    await cb(mode);
    return;
  }
  const bufnr = state.pendingCloseBufnr;
  if (!bufnr) return;
  try {
    if (mode === 'save') {
      await api.closeBuffer(bufnr, { save: true });
      showToast('Saved and closed', 'success');
    } else {
      await api.closeBuffer(bufnr, { discard: true });
      showToast('Discarded changes', 'info');
    }
    closeUnsavedGuard();
    await refreshSession();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleWorkspaceSwitch(target) {
  try {
    await api.switchWorkspace(target);
  } catch (err) {
    if (err.hasUnsaved) {
      const names = err.modified?.map(m => baseName(m.name)).join(', ') || 'Buffers';
      openUnsavedGuard(null, `${names} (unsaved changes. Keep open and switch anyway?)`, async (mode) => {
        if (mode === 'discard' || mode === 'save') {
          try {
            await api.switchWorkspace(target, { force: true });
            showToast(`workspace → ${baseName(target)}`, 'success');
            await onWorkspaceChanged();
          } catch (e) {
            showToast(e.message, 'error');
          }
        }
      });
      return;
    }
    showToast(err.message, 'error');
    return;
  }
  showToast(`workspace → ${baseName(target)}`, 'success');
  await onWorkspaceChanged();
}

/* ---------------- 7. Zen / 弹窗 ---------------- */

function setZen(on) {
  state.zen = !!on;
  const topbar = $('topbar');
  const sidebar = $('sidebar');
  if (topbar) topbar.hidden = state.zen;
  if (sidebar) sidebar.hidden = state.zen;
  statusbar.setZen(state.zen);
  syncGridSize();
}

function toggleZen() {
  setZen(!state.zen);
}

function openDialog(id) {
  const dialog = $(id);
  if (dialog && !dialog.open) dialog.showModal();
}

function closeDialog(id) {
  const dialog = typeof id === 'string' ? $(id) : id;
  if (dialog?.open) dialog.close();
}

/** 任意 dialog / popover 打开时，Esc 归它们处理（修复 zen 双触发） */
function overlayOpen() {
  return !!document.querySelector('dialog[open]:not(#toastDialog), dialog:popover-open:not(#toastDialog), [popover]:popover-open:not(#toastDialog)');
}

/* ---------------- 8. 文件树侧栏 ---------------- */

function scopeDir() {
  const el = $('category-list');
  return String((el && el.dataset.scope) || '').replace(/^\/+|\/+$/g, '');
}

function initSidebar() {
  const buttons = [
    ['nav-btn-new-file', 'New file', () => openCreate('file')],
    ['nav-btn-new-folder', 'New directory', () => openCreate('dir')],
    ['nav-btn-refresh', 'Reload tree', async () => { await tree.load(); focusTerminal(); }],
    ['nav-btn-zen', 'Zen mode', () => { toggleZen(); focusTerminal(); }],
    ['nav-btn-find', 'Find file', () => { openFinder(); }],
    ['btnCollapseAll', 'Collapse all', () => { tree.reset(); focusTerminal(); }]
  ];
  for (const [id, label, fn] of buttons) {
    const btn = $(id);
    if (!btn) continue;
    if (!btn.getAttribute('title')) btn.setAttribute('title', label);
    if (!btn.getAttribute('aria-label')) btn.setAttribute('aria-label', label);
    btn.addEventListener('click', () => { Promise.resolve(fn()).catch(() => {}); });
  }
}

/* ---------------- 9. 新建文件 / 目录 ---------------- */

let newAction = 'file';

function openCreate(kind) {
  newAction = kind;
  const dialog = $('newItemDialog');
  const input = $('inputNewItemName');
  if (!dialog || !input) return;

  const title = $('newItemDialogTitle');
  if (title) title.textContent = kind === 'dir' ? 'New directory' : 'New file';
  const label = $('newItemPromptLabel');
  if (label) label.textContent = kind === 'dir' ? 'Directory name' : 'File name';
  const hint = $('newItemHint');
  if (hint) {
    const scope = scopeDir();
    hint.textContent = `./${scope ? `${scope}/` : ''}`;
    hint.title = `${state.currentProject}/${scope ? `${scope}/` : ''}`;
  }
  const err = $('newItemError');
  if (err) err.textContent = '';
  input.value = '';
  input.placeholder = kind === 'dir' ? 'src/components' : 'index.js';
  dialog.showModal();
  input.focus();
}

async function submitNewItem() {
  const input = $('inputNewItemName');
  const err = $('newItemError');
  const val = (input?.value || '').trim();
  if (!val) { if (err) err.textContent = '名称不能为空'; return; }
  if (/^([/\\]|[A-Za-z]:)/.test(val) || val.split('/').includes('..')) {
    if (err) err.textContent = '请输入工作区内的相对路径';
    return;
  }

  const kind = newAction === 'dir' ? 'dir' : 'file';
  const scope = scopeDir();

  try {
    // 同名预检：只发一次 200 的目录列举，命中就直接内联报错，
    // 避免用 409 做流程控制（浏览器会给失败请求记一条 console error）。
    // 服务端 409 仍是最终裁决（竞态 / 深层路径）。
    const parts = val.split('/').filter(Boolean);
    const leaf = parts[parts.length - 1];
    const parentRel = [scope, ...parts.slice(0, -1)].filter(Boolean).join('/');
    try {
      const listing = await api.getFiles(parentRel ? `${state.currentProject}/${parentRel}` : '');
      if ((listing.files || []).some(n => n.name === leaf)) {
        if (err) err.textContent = kind === 'dir' ? '该目录已存在' : '该文件已存在';
        return;
      }
    } catch { /* 父目录不可读时交给 create-item 裁决 */ }

    // 统一走 /api/create-item：不切工作区、不写 recentProjects，
    // 越权/已存在/校验错误都会带明确文案回来
    const created = await api.createItem({ kind, parent: scope, name: val });
    const rel = created?.rel || (scope ? `${scope}/${val}` : val);

    if (kind === 'file') {
      await api.openFile(created.path);
      state.activePath = created.path;
      showToast(`Created ${rel}`, 'success');
    } else {
      showToast(`Created ${rel}/`, 'success');
    }

    closeDialog('newItemDialog');
    await tree.load();
    if (kind === 'file') {
      await tree.reveal(created.path);
      await tree.setActive(created.path);
    } else {
      await tree.reveal(created.path);
    }
    await refreshSession();
    focusTerminal();
  } catch (e) {
    // 失败时保留弹窗与 #newItemError（焦点留在输入框，便于改名字重试）
    if (err) err.textContent = e.message;
  }
}

function initNewItemDialog() {
  $('btnCloseNewItemDialog')?.addEventListener('click', () => { closeDialog('newItemDialog'); focusTerminal(); });
  $('btnCancelNewItem')?.addEventListener('click', () => { closeDialog('newItemDialog'); focusTerminal(); });
  $('btnConfirmNewItem')?.addEventListener('click', () => { submitNewItem(); });
  $('inputNewItemName')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitNewItem(); }
  });
}

/* ---------------- 10. 查找（W3 finder） ---------------- */

async function openFinder() {
  if (!state.finder) {
    // 无运行时降级：finder.js 是构建产物的一部分，缺失即构建错误，应当直接暴露
    const mod = await import('./js/finder.js');
    state.finder = mod.createFinder({ api, showToast, openPath, focusTerminal });
  }
  state.finder.open();
}

/* ---------------- 11. 快捷键层（W3） ---------------- */

const actions = {
  find: () => openFinder(),
  findTree: () => {
    const el = $('treeFilter');
    if (el) { el.focus(); el.select?.(); }
    else openFinder();
  },
  zen: () => { toggleZen(); focusTerminal(); },
  settings: () => openDialog('settingsDialog'),
  docs: () => openDialog('keymapDialog'),
  save: () => saveBuffer(),
  closeBuffer: () => closeActiveBuffer(),
  newBuffer: () => newBuffer(),
  nextBuffer: () => cycleBuffer(1),
  prevBuffer: () => cycleBuffer(-1),
  focusTerminal: () => focusTerminal(),
  reconnect: () => reconnectNow()
};

async function initShortcutLayer() {
  try {
    const km = await import('./js/keymap.js');
    km.initHotkeyHints?.();
  } catch {
    /* W3 keymap 未就绪时静默降级 */
  }
  try {
    const sc = await import('./js/shortcuts.js');
    sc.initShortcuts({ actions });
  } catch {
    /* W3 shortcuts 未就绪时静默降级 */
  }
}

/* ---------------- 12. 设置 ---------------- */

const SETTINGS_KEYS = ['nvw_font_size', 'nvw_line_height', 'nvw_cursor_style', 'nvw_cursor_blink', 'nvw_renderer'];

function applyFontSize(v) {
  const size = parseFloat(v) || 18;
  // 字号只改 CSS 变量，剩下交给浏览器排版引擎（不再有行高换算/DPR 校准）
  document.documentElement.style.setProperty('--base-font-size', `${size}px`);
  document.documentElement.style.setProperty('--font-size', `${size}px`);
  document.documentElement.style.setProperty('--term-font-size', `${size}px`);
  const disp = $('settingFontSizeDisplay');
  if (disp) disp.textContent = `${size}px`;
  const range = $('settingFontSizeRange');
  if (range) range.value = String(size);
  syncGridSize();
}

function applyLineHeight(v) {
  const lh = parseFloat(v) || 1.4;
  document.documentElement.style.setProperty('--line-height', String(lh));
  const disp = $('settingLineHeightDisplay');
  if (disp) disp.textContent = lh.toFixed(2);
  const range = $('settingLineHeightRange');
  if (range) range.value = String(lh);
  syncGridSize();
}

function applyCursorStyle(v) {
  const style = v || 'block';
  ui.renderer?.setCursorShape?.(style);
  document.querySelectorAll('input[name="cursorStyle"]').forEach(r => { r.checked = r.value === style; });
}

function applyCursorBlink(on) {
  const sw = $('settingCursorBlink');
  if (sw) sw.checked = !!on;
}

function initSettings() {
  const savedFont = readPref('nvw_font_size', '18');
  const savedLine = readPref('nvw_line_height', '1.4');
  applyFontSize(savedFont);
  applyLineHeight(savedLine);
  applyCursorStyle(readPref('nvw_cursor_style', 'block'));
  applyCursorBlink(readPref('nvw_cursor_blink', 'true') !== 'false');

  document.querySelectorAll('input[name="cursorStyle"]').forEach(r => {
    r.addEventListener('change', e => {
      if (!e.target.checked) return;
      applyCursorStyle(e.target.value);
      writePref('nvw_cursor_style', e.target.value);
    });
  });

  $('settingFontSizeRange')?.addEventListener('input', e => {
    applyFontSize(e.target.value);
    writePref('nvw_font_size', e.target.value);
  });
  $('settingLineHeightRange')?.addEventListener('input', e => {
    applyLineHeight(e.target.value);
    writePref('nvw_line_height', e.target.value);
  });
  $('settingCursorBlink')?.addEventListener('change', e => {
    applyCursorBlink(e.target.checked);
    writePref('nvw_cursor_blink', String(e.target.checked));
  });

  $('btnResetSettings')?.addEventListener('click', () => {
    SETTINGS_KEYS.forEach(k => dropPref(k));
    applyFontSize(18);
    applyLineHeight(1.4);
    applyCursorStyle('block');
    applyCursorBlink(true);
    mountRenderer('auto');
    syncGridSize();
    showToast('Settings reset to defaults', 'info');
  });

  for (const id of ['btnCloseSettings', 'btnSaveSettings']) {
    $(id)?.addEventListener('click', () => { closeDialog('settingsDialog'); focusTerminal(); });
  }
}

/* ---------------- 13. 文档 ---------------- */

function initKeymapDialog() {
  $('btnCloseKeymap')?.addEventListener('click', () => { closeDialog('keymapDialog'); focusTerminal(); });
}

/* ---------------- 14. 工作区浏览器（W3） ---------------- */

async function openWorkspaceBrowser() {
  $('workspacePanel')?.hidePopover();
  if (!state.browser) {
    try {
      const mod = await import('./js/workspace-browser.js');
      state.browser = mod.createWorkspaceBrowser({
        api,
        showToast,
        onWorkspaceChanged,
        onRequestSwitch: (target) => handleWorkspaceSwitch(target)
      });
    } catch {
      state.browser = { open: () => showToast('Workspace browser unavailable', 'warn') };
    }
  }
  state.browser.open(state.currentProject);
}

async function onWorkspaceChanged() {
  tree.reset();
  await loadWorkspaces();
  await tree.load();
  await refreshSession();
  focusTerminal();
}

/* ---------------- 15. 顶栏 / 弹层 / 全局 ---------------- */

function initChrome() {
  $('search-button')?.addEventListener('click', () => { openFinder(); });
  $('btnWorkspaceClose')?.addEventListener('click', () => { $('workspacePanel')?.hidePopover(); focusTerminal(); });
  $('btnThemeClose')?.addEventListener('click', () => { $('themePanel')?.hidePopover(); focusTerminal(); });
  $('btnOpenSettings')?.addEventListener('click', () => openDialog('settingsDialog'));
  $('btnOpenKeymap')?.addEventListener('click', () => openDialog('keymapDialog'));
  $('btnOpenNewWorkspaceModal')?.addEventListener('click', () => { openWorkspaceBrowser(); });
  $('btnReconnect')?.addEventListener('click', () => { reconnectNow(); focusTerminal(); });
  $('btnNewBuffer')?.addEventListener('click', () => { newBuffer().finally(() => focusTerminal()); });

  for (const [id, label] of [
    ['btnOpenSettings', 'Settings'], ['btnOpenKeymap', 'Docs & keymaps'],
    ['search-button', 'Find file'], ['btnReconnect', 'Reconnect terminal'],
    ['btnNewBuffer', 'New buffer']
  ]) {
    const el = $(id);
    if (el && !el.getAttribute('aria-label')) el.setAttribute('aria-label', label);
    if (el && !el.getAttribute('title')) el.setAttribute('title', label);
  }

  $('btnCloseUnsavedDialog')?.addEventListener('click', closeUnsavedGuard);
  $('btnUnsavedCancel')?.addEventListener('click', closeUnsavedGuard);
  $('btnUnsavedDiscard')?.addEventListener('click', () => { resolveUnsaved('discard'); });
  $('btnUnsavedSaveClose')?.addEventListener('click', () => { resolveUnsaved('save'); });

  for (const id of ['settingsDialog', 'keymapDialog', 'unsavedGuardDialog', 'newItemDialog', 'search-dialog', 'workspaceBrowserDialog']) {
    $(id)?.addEventListener('close', () => {
      focusTerminal();
      setTimeout(() => focusTerminal(), 50);
    });
  }
}

function initGlobalKeys() {
  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    // 有弹窗/弹层打开时 Esc 归它们处理，绝不顺带退出 zen（修复双触发）
    if (overlayOpen()) return;
    if (state.zen) setZen(false);
  }, true);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    refreshSession();
    // 切回本标签页 → 本客户端才是前台，重新对齐并把尺寸"强制"写回共享 PTY。
    // 必须 force：去重是按 (cols×rows, focused) 做的，切回来时这两个值可能都没变，
    // 不强制就抢不回被别人改掉的网格。
    syncGridSize();
  });

  // 窗口重新获得焦点时同样夺回尺寸主导权（多客户端共存时避免被后台尺寸压着）
  window.addEventListener('focus', () => syncGridSize());

  window.addEventListener('beforeunload', e => {
    if (!state.buffers.some(b => b.changed)) return undefined;
    e.preventDefault();
    e.returnValue = '';
    return '';
  });
}

/* ---------------- 16. 启动 ---------------- */

async function initApp() {
  // 官方 --font-family 含 Symbols Nerd Font 回退，字体度量会改变字符宽度；
  // 必须等字体就绪再初始化终端，否则第一次 fit 的行列数是错的。
  try { await document.fonts?.ready; } catch { /* 无 Font Loading API 时跳过 */ }

  await loadThemes();
  initThemePicker();
  await loadWorkspaces();
  // 终端初始化失败（字体度量异常、WebGL 不可用…）不能拖垮整个启动：
  // 之前这里一抛，后面的文件树/会话/快捷键全部不执行，页面直接变成静态空壳。
  try {
    initTerminal();
  } catch (e) {
    console.error('[nvw] initTerminal failed', e);
    reportBootError('终端初始化失败', e);
  }
  initSettings();
  syncGridSize();
  initKeymapDialog();
  initSidebar();
  initNewItemDialog();
  initChrome();
  initGlobalKeys();

  await tree.load();
  await refreshSession();
  startPolling(1500);
  initShortcutLayer();
  // 向 js/boot-guard.js 宣告启动成功（它负责在失败时把原因写到页面上）
  window.__NVW_BOOTED__ = true;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', initApp);
  else initApp();
}
