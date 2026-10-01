/**
 * NVW · 官方 WebTUI 通知（dialog[popover] + badge，零 class / 零行内样式）
 * type: info | success | error | warn —— 同文案去重、最多 4 条、点击消失、error 6s
 */

/* Nerd Font 图标（官方 plugin-nf 字形） */
const TYPES = {
  info:    { icon: '\uf05a', variant: 'background1' },
  success: { icon: '\uf00c', variant: 'foreground0' },
  error:   { icon: '\uf057', variant: 'foreground1' },
  warn:    { icon: '\uf071', variant: 'foreground2' }
};

const MAX_ITEMS = 4;
const DEFAULT_MS = 3200;
const ERROR_MS = 6000;

/** @type {Map<string, { el: HTMLElement, timer: number }>} */
const live = new Map();

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[m]);
}

function hideIfEmpty(dialog, list) {
  if (!list.children.length && dialog.matches(':popover-open')) {
    try { dialog.hidePopover(); } catch { /* 已关闭 */ }
  }
}

function dismiss(text, dialog, list) {
  const entry = live.get(text);
  if (entry) {
    clearTimeout(entry.timer);
    live.delete(text);
    entry.el.remove();
  }
  hideIfEmpty(dialog, list);
}

export function showToast(message, type = 'info', duration) {
  const dialog = document.getElementById('toastDialog');
  const list = document.getElementById('toastList');
  if (!dialog || !list) return;

  const text = String(message ?? '').trim();
  if (!text) return;

  const kind = TYPES[type] ? type : 'info';
  const ms = Number.isFinite(duration) && duration > 0
    ? duration
    : (kind === 'error' ? ERROR_MS : DEFAULT_MS);

  list.setAttribute('aria-live', 'polite');

  // 同文案去重：已存在则只续期，不再堆叠
  const existing = live.get(text);
  if (existing && existing.el.isConnected) {
    clearTimeout(existing.timer);
    existing.timer = window.setTimeout(() => dismiss(text, dialog, list), ms);
    return;
  }

  // 超过上限：先淘汰最旧的一条
  while (list.children.length >= MAX_ITEMS) {
    list.firstElementChild.remove();
    for (const [key, entry] of live) {
      if (!entry.el.isConnected) { clearTimeout(entry.timer); live.delete(key); }
    }
  }

  const { icon, variant } = TYPES[kind];
  const item = document.createElement('row');
  item.setAttribute('align-', 'center');
  item.setAttribute('gap-', '1');
  item.setAttribute('title', 'Dismiss');
  item.innerHTML = `<span is-="badge" variant-="${variant}">${icon}</span><span>${esc(text)}</span>`;
  item.addEventListener('click', () => dismiss(text, dialog, list));

  list.appendChild(item);

  if (!dialog.matches(':popover-open')) {
    try { dialog.showPopover(); } catch { /* popover 不可用时静默降级 */ }
  }

  live.set(text, { el: item, timer: window.setTimeout(() => dismiss(text, dialog, list), ms) });
}
