/**
 * NVW · 文件查找（契约 §2.7 / §3.3）
 * 服务端单次递归搜索 + 120ms 防抖 + 请求序号防竞态 + 空查询会话级缓存 + 全键盘导航。
 */

const LIMIT = 200;
const DEBOUNCE_MS = 120;

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[m]);
}

export function createFinder({ api, showToast, openPath, focusTerminal } = {}) {
  const dialog = document.getElementById('search-dialog');
  const input = document.getElementById('search-input');
  const container = document.getElementById('search-results-container');
  const spinner = document.getElementById('searchSpinner');
  const countEl = document.getElementById('search-count');
  const closeBtn = document.getElementById('close-btn');

  let rows = [];
  let buttons = [];
  let selected = -1;
  let seq = 0;
  let timer = 0;
  let emptyCache = null;
  let queried = null;

  const isOpen = () => !!(dialog && (dialog.open || dialog.hasAttribute('open')));
  const setLoading = (on) => { if (spinner) spinner.hidden = !on; };

  function message(text, variant = 'foreground2') {
    if (container) container.innerHTML = `<span is-="badge" variant-="${variant}">${esc(text)}</span>`;
  }

  function updateCount(data, shown) {
    if (!countEl) return;
    const total = Number(data && data.total);
    const t = Number.isFinite(total) ? total : shown;
    const truncated = !!(data && data.truncated) || t > shown;
    // 状态行与右侧快捷键提示共用一行，48ch 的弹窗里必须短到不触发省略号
    countEl.textContent = `${shown} / ${t}${truncated ? '+' : ''}`;
    countEl.title = `showing ${shown} of ${t}${truncated ? '+' : ''} matches`;
  }

  function paint(data, q) {
    rows = Array.isArray(data && data.results) ? data.results : [];
    selected = rows.length ? 0 : -1;
    if (!container) return;
    if (!rows.length) {
      buttons = [];
      message(q ? 'No matches' : 'No files');
    } else {
      container.innerHTML = rows.map((f, i) =>
        `<button size-="small" variant-="${i === 0 ? 'foreground0' : 'background0'}"` +
        ` data-path="${esc(f.path)}" data-index="${i}" title="${esc(f.fullPath || f.path)}">` +
        `▸ ${esc(f.name)}` +
        (f.dir ? ` <span is-="badge" variant-="background2">${esc(f.dir)}</span>` : '') +
        '</button>'
      ).join('');
      buttons = Array.from(container.querySelectorAll('button[data-path]'));
      buttons[0]?.scrollIntoView({ block: 'nearest' });
    }
    updateCount(data, rows.length);
  }

  function refresh(q, skipCache = false) {
    if (!skipCache && q === '' && emptyCache) return;
    const my = ++seq;
    setLoading(true);
    api.searchFiles(q, LIMIT).then((data) => {
      if (my !== seq) return;            // 过期响应直接丢弃
      if (q === '') emptyCache = data;
      queried = q;
      paint(data, q);
      setLoading(false);
    }).catch(() => {                      // api.js 已 toast
      if (my !== seq) return;
      setLoading(false);
      rows = [];
      buttons = [];
      selected = -1;
      message('search failed', 'foreground1');
      if (countEl) countEl.textContent = 'search unavailable';
    });
  }

  function select(next) {
    if (!buttons.length) return;
    const i = Math.max(0, Math.min(buttons.length - 1, next));
    if (i !== selected) {
      buttons[selected]?.setAttribute('variant-', 'background0');
      selected = i;
      buttons[selected].setAttribute('variant-', 'foreground0');
    }
    buttons[selected].scrollIntoView({ block: 'nearest' });
  }

  function close() {
    clearTimeout(timer);
    if (!dialog) return;
    if (dialog.open) dialog.close();
    else dialog.removeAttribute('open');
  }

  async function activate() {
    const file = rows[selected];
    if (!file) return;
    close();
    try {
      await openPath?.(file.path);
    } catch { /* api.js 已 toast，保持弹窗已关的干净状态 */ }
    focusTerminal?.();
    setTimeout(() => focusTerminal?.(), 50);
  }

  function open() {
    if (!dialog) return;
    if (!isOpen()) {
      try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
    }
    if (input) { input.value = ''; input.focus(); input.select(); }
    queried = null;
    if (emptyCache) {
      paint(emptyCache, '');
      setLoading(false);
      refresh('', true);                  // 后台静默校验一次
    } else {
      rows = [];
      buttons = [];
      selected = -1;
      message('searching…');
      setLoading(true);
      refresh('');
    }
  }

  dialog?.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); select(selected + 1); }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); select(selected - 1); }
    else if (e.key === 'Home') { e.preventDefault(); select(0); }
    else if (e.key === 'End') { e.preventDefault(); select(buttons.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); activate(); }
  });
  dialog?.addEventListener('close', () => focusTerminal?.());
  dialog?.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  closeBtn?.addEventListener('click', close);

  container?.addEventListener('click', (e) => {
    const btn = e.target.closest?.('button[data-path]');
    if (!btn) return;
    const i = Number(btn.getAttribute('data-index'));
    if (Number.isFinite(i)) selected = i;
    activate();
  });
  container?.addEventListener('mouseover', (e) => {
    const btn = e.target.closest?.('button[data-path]');
    if (!btn) return;
    const i = Number(btn.getAttribute('data-index'));
    if (Number.isFinite(i) && i !== selected) select(i);
  });

  input?.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (q === queried) return;
    if (q === '' && emptyCache) {
      seq += 1;                           // 让在途请求失效，避免覆盖缓存渲染
      queried = '';
      setLoading(false);
      paint(emptyCache, '');
      return;
    }
    timer = setTimeout(() => refresh(q), DEBOUNCE_MS);
  });

  return {
    open,
    close,
    selectedIndex: () => selected,
    refresh: () => refresh((input?.value || '').trim(), true)
  };
}
