/**
 * NVW · 快捷键唯一真源（docs/UX-CONTRACT.md §4）
 * 顶栏提示、键盘派发、文档表格全部从这里取，杜绝文档漂移。
 */

const MAC_RE = /Mac|iPhone|iPad|iPod/i;

export function isMac() {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator;
  const platform = (nav.userAgentData && nav.userAgentData.platform) || nav.platform || nav.userAgent || '';
  return MAC_RE.test(String(platform));
}

export const KEYMAP = [
  { id: 'find', keys: 'Mod+K', label: 'Find file', group: 'Navigate' },
  { id: 'findTree', keys: 'Mod+Shift+F', label: 'Filter file tree', group: 'Navigate' },
  { id: 'zen', keys: 'Mod+B', label: 'Toggle zen', group: 'View' },
  { id: 'settings', keys: 'Mod+,', label: 'Settings', group: 'View' },
  { id: 'docs', keys: 'Mod+/', label: 'Docs & keymaps', group: 'View' },
  { id: 'save', keys: 'Mod+S', label: 'Save buffer', group: 'Editor' },
  { id: 'closeBuffer', keys: 'Alt+W', label: 'Close current buffer', group: 'Editor' },
  { id: 'newBuffer', keys: 'Mod+Alt+N', label: 'New buffer', group: 'Editor' },
  { id: 'nextBuffer', keys: 'Alt+ArrowDown', label: 'Next buffer', group: 'Editor' },
  { id: 'prevBuffer', keys: 'Alt+ArrowUp', label: 'Previous buffer', group: 'Editor' },
  { id: 'focusTerminal', keys: 'Mod+J', label: 'Focus terminal', group: 'Editor' },
  { id: 'reconnect', keys: 'Mod+Alt+R', label: 'Reconnect terminal', group: 'Editor' }
];

const KEY_LABEL = {
  arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
  escape: 'Esc', esc: 'Esc', enter: '↵', return: '↵', tab: 'Tab',
  backspace: '⌫', delete: 'Del', space: 'Space',
  pageup: 'PgUp', pagedown: 'PgDn', home: 'Home', end: 'End'
};

const CODE_CHAR = {
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Space: ' '
};

function parseCombo(combo, mac) {
  const out = { ctrl: false, alt: false, shift: false, meta: false, key: '' };
  for (const raw of String(combo || '').split('+')) {
    const part = raw.trim();
    if (!part) continue;
    const low = part.toLowerCase();
    if (low === 'mod') { if (mac) out.meta = true; else out.ctrl = true; }
    else if (low === 'ctrl' || low === 'control') out.ctrl = true;
    else if (low === 'alt' || low === 'option') out.alt = true;
    else if (low === 'shift') out.shift = true;
    else if (low === 'meta' || low === 'cmd' || low === 'command') out.meta = true;
    else out.key = part;
  }
  return out;
}

function keyLabel(key) {
  const low = key.toLowerCase();
  if (KEY_LABEL[low]) return KEY_LABEL[low];
  if (key.length === 1) return /[a-z]/i.test(key) ? key.toUpperCase() : key;
  return key;
}

function eventKey(e) {
  const code = typeof e.code === 'string' ? e.code : '';
  const m = /^(?:Key([A-Z])|Digit([0-9])|Numpad([0-9]))$/.exec(code);
  if (m) return (m[1] || m[2] || m[3]).toLowerCase();
  if (code && CODE_CHAR[code]) return CODE_CHAR[code];
  const raw = typeof e.key === 'string' ? e.key : '';
  return raw === ' ' ? ' ' : raw.toLowerCase();
}

/** 'Mod+K' → '⌘K'（Mac，⌃⌥⇧⌘ 顺序）/ 'Ctrl+K'（其它平台） */
export function formatKeys(combo, mac = isMac()) {
  const p = parseCombo(combo, mac);
  const label = keyLabel(p.key);
  if (mac) {
    return `${p.ctrl ? '⌃' : ''}${p.alt ? '⌥' : ''}${p.shift ? '⇧' : ''}${p.meta ? '⌘' : ''}${label}`;
  }
  const mods = [];
  if (p.ctrl) mods.push('Ctrl');
  if (p.alt) mods.push('Alt');
  if (p.shift) mods.push('Shift');
  if (p.meta) mods.push('Meta');
  return [...mods, label].join('+');
}

/** 精确匹配：未声明的修饰键必须处于未按下状态（Mod+K 不会被 Mod+Shift+K 命中） */
export function matchEvent(e, combo) {
  if (!e || !combo) return false;
  const want = parseCombo(combo, isMac());
  if (!want.key) return false;
  if (!!e.ctrlKey !== want.ctrl) return false;
  if (!!e.altKey !== want.alt) return false;
  if (!!e.shiftKey !== want.shift) return false;
  if (!!e.metaKey !== want.meta) return false;
  return eventKey(e) === want.key.toLowerCase();
}

/** 把所有 [data-hotkey="<id>"] 徽标填成格式化按键 */
export function initHotkeyHints(root = document) {
  const byId = new Map(KEYMAP.map((entry) => [entry.id, entry]));
  for (const el of root.querySelectorAll('[data-hotkey]')) {
    const entry = byId.get(el.getAttribute('data-hotkey'));
    if (!entry) continue;
    const keys = formatKeys(entry.keys);
    el.textContent = keys;
    if (!el.hasAttribute('title')) el.setAttribute('title', `${entry.label} (${keys})`);
    el.setAttribute('aria-keyshortcuts', entry.keys.replace(/Mod/gi, isMac() ? 'Meta' : 'Control'));
  }
}
