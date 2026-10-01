/**
 * NVW · 工作区目录浏览器（契约 §2.8 / §3.3）
 * 后端 /api/browse-dirs 双通道：TUI 目录浏览（↑ / 进子目录 / 打开当前目录）+ 手输绝对路径。
 */

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[m]);
}

export function createWorkspaceBrowser({ api, showToast, onWorkspaceChanged, onRequestSwitch } = {}) {
  const dialog = document.getElementById('workspaceBrowserDialog') || document.getElementById('workspaceModal');
  const list = document.getElementById('wsBrowserList');
  const pathBadge = document.getElementById('wsBrowserPath');
  const upBtn = document.getElementById('wsBrowserUp');
  const errorEl = document.getElementById('wsBrowserError') || document.getElementById('workspaceModalError');
  const closeBtn = document.getElementById('wsBrowserClose') || document.getElementById('btnCloseWorkspaceModal');
  const cancelBtn = document.getElementById('wsBrowserCancel') || document.getElementById('btnCancelWorkspaceModal');
  const useBtn = document.getElementById('wsBrowserUse');
  const confirmBtn = document.getElementById('btnConfirmWorkspaceModal');
  const input = dialog?.querySelector('#inputWorkspacePath') || document.getElementById('inputWorkspacePath');

  let current = null;
  let parent = null;
  let seq = 0;
  let listing = false;
  let switching = false;

  const isOpen = () => !!(dialog && (dialog.open || dialog.hasAttribute('open')));
  const setError = (text) => { if (errorEl) errorEl.textContent = text || ''; };

  // listing：目录列表在途（此时 current 可能已过期）；switching：切换工作区在途（防重复提交）
  function syncButtons() {
    const lock = listing || switching;
    for (const btn of [upBtn, useBtn, confirmBtn]) {
      if (!btn) continue;
      if (lock) btn.setAttribute('disabled', '');
      else btn.removeAttribute('disabled');
    }
    if (upBtn && !lock && !parent) upBtn.setAttribute('disabled', '');
  }

  function setListing(on) { listing = on; syncButtons(); }
  function setSwitching(on) { switching = on; syncButtons(); }

  function setList(html) {
    if (list) list.innerHTML = html;
  }

  function renderList(folders) {
    if (!folders.length) {
      setList('<span is-="badge" variant-="foreground2">No subdirectories</span>');
      return;
    }
    setList(folders.map((f) =>
      `<button size-="small" variant-="background0" data-dir="${esc(f.path)}" title="${esc(f.path)}">${esc(f.name)}</button>`
    ).join(''));
  }

  /**
   * 路径徽标只展示"尾部"：`…/public/webtui/plugin-x`。
   * 不用 CSS 的 direction:rtl 做首部省略——那会让 bidi 重排路径开头的 `/`（显示成 `…xxx/`），
   * 也不动 DOM 里的完整路径（`title` 保留全文，程序里另有 `current` 作为真源）。
   */
  function tailPath(p, keep = 3) {
    const parts = String(p || '').split('/').filter(Boolean);
    if (parts.length <= keep) return String(p || '');
    const prefix = String(p).startsWith('/') ? '/…/' : '…/';
    return prefix + parts.slice(-keep).join('/');
  }

  async function load(dir) {    const target = String(dir || '').trim();
    if (!target) { setError('No directory to open'); return; }
    const my = ++seq;
    setError('');
    setList('<span is-="spinner" variant-="dots" speed-="fast"></span>');
    setListing(true);
    try {
      const data = await api.browseDirs(target);
      if (my !== seq) return;
      current = data.current;
      parent = data.parent || null;
      if (pathBadge) { pathBadge.textContent = tailPath(current); pathBadge.title = current; }
      if (upBtn) {
        if (parent) upBtn.removeAttribute('disabled');
        else upBtn.setAttribute('disabled', '');
      }
      renderList(Array.isArray(data.folders) ? data.folders : (data.dirs || []));
    } catch (err) {                        // api.js 已 toast，这里补内联错误
      if (my !== seq) return;
      current = null;
      parent = null;
      setError(err?.message || 'Cannot open directory');
      setList('<span is-="badge" variant-="foreground1">unavailable</span>');
    } finally {
      if (my === seq) setListing(false);
    }
  }

  function close() {
    if (!dialog) return;
    if (dialog.open) dialog.close();
    else dialog.removeAttribute('open');
  }

  async function use(target) {
    const dir = String(target || current || '').trim();
    if (switching) return;
    if (!dir) { setError('Enter a path first'); return; }
    setError('');
    switching = true;
    setSwitching(true);
    try {
      if (onRequestSwitch) {
        close();
        await onRequestSwitch(dir);
        return;
      }
      const res = await api.switchWorkspace(dir);
      const finalPath = res?.current || dir;
      close();
      showToast?.(`Workspace → ${res?.currentName || finalPath.split('/').filter(Boolean).pop() || finalPath}`, 'success');
      try {
        await onWorkspaceChanged?.(finalPath);
      } catch (err) {
        console.warn('[nvw] onWorkspaceChanged failed:', err);
      }
    } catch (err) {
      setError(err?.message || 'Failed to switch workspace');
    } finally {
      switching = false;
      setSwitching(false);
    }
  }

  function open(initialDir) {
    if (!dialog) return;
    // 真源是 current / initialDir；徽标只是展示（可能已被 tailPath 缩短），不能拿来当路径解析
    const start = String(initialDir || current || input?.value || '/').trim() || '/';
    setError('');
    current = null;
    parent = null;
    if (input) input.value = start;
    if (pathBadge) { pathBadge.textContent = tailPath(start); pathBadge.title = start; }
    if (!isOpen()) {
      try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
    }
    load(start);
  }

  list?.addEventListener('click', (e) => {
    const btn = e.target.closest?.('button[data-dir]');
    if (btn) load(btn.getAttribute('data-dir'));
  });
  list?.addEventListener('keydown', (e) => {
    const items = Array.from(list.querySelectorAll('button[data-dir]'));
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); (items[i + 1] || items[0])?.focus(); }
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (i <= 0) input?.focus(); else items[i - 1].focus();
    } else if (e.key === 'ArrowLeft') { e.preventDefault(); if (parent) load(parent); }
    else if (e.key === 'Enter' && i < 0) { e.preventDefault(); items[0]?.focus(); }
  });

  upBtn?.addEventListener('click', () => { if (parent) load(parent); });
  useBtn?.addEventListener('click', () => use(current));
  confirmBtn?.addEventListener('click', () => use(input?.value));
  cancelBtn?.addEventListener('click', close);
  closeBtn?.addEventListener('click', close);
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); use(input.value); } });
  dialog?.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  dialog?.addEventListener('close', () => setError(''));

  return {
    open,
    close,
    currentPath: () => current,
    navigate: (dir) => load(dir)
  };
}
