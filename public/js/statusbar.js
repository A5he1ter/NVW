/**
 * NVW · 状态栏（契约 §2.6）
 * 导出：createStatusbar({ api }) → { setConnection, render, setZen }
 * 真实 filetype / line:col / encoding / modified 全部来自 /api/session。
 */

/* 官方 variant 白名单（foreground0-2 / background0-3）；跨主题不存在的私有色会整条失效 */
const MODE_VARIANT = {
  NORMAL: 'background2',
  INSERT: 'foreground0',
  VISUAL: 'background3',
  'V-LINE': 'background3',
  'V-BLOCK': 'background3',
  COMMAND: 'background3',
  'S-LINE': 'background3',
  'S-BLOCK': 'background3',
  REPLACE: 'foreground1',
  'V-REPLACE': 'foreground1'
};
const MODE_FALLBACK = 'background1';

const CONNECTION_VARIANT = {
  Connected: 'background2',
  Connecting: 'background1',
  Disconnected: 'foreground0',
  Error: 'foreground0'
};

export function createStatusbar({ api }) {
  void api;

  function setConnection(text) {
    const t = String(text || 'Disconnected');
    for (const id of ['statusConnection', 'wsStatusBadge']) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.textContent = t;
      el.setAttribute('variant-', CONNECTION_VARIANT[t] || MODE_FALLBACK);
      el.setAttribute('title', `Terminal: ${t}`);
    }
    const btn = document.getElementById('btnReconnect');
    if (btn) btn.hidden = !(t === 'Disconnected' || t === 'Error');
  }

  function render(status, buffers) {
    const s = status || {};
    const list = Array.isArray(buffers) ? buffers : [];

    const mode = document.getElementById('statusMode');
    if (mode) {
      const m = s.mode || 'NORMAL';
      mode.textContent = m;
      mode.setAttribute('variant-', MODE_VARIANT[m] || MODE_FALLBACK);
    }

    const cursor = document.getElementById('statusCursor');
    if (cursor) {
      cursor.textContent = `${s.line || 1}:${s.col || 1}`;
      cursor.title = `line ${s.line || 1}, column ${s.col || 1}${s.total ? ` / ${s.total} lines` : ''}`;
    }

    const ft = document.getElementById('statusFiletype');
    if (ft) {
      // 无 filetype 时整个元素隐藏（不再显示 "no ft"，R2-5）
      const v = s.filetype || '';
      ft.textContent = v;
      ft.hidden = !v;
      ft.title = v ? `filetype: ${v}` : '';
    }

    const enc = document.getElementById('statusWritable');
    if (enc) {
      enc.textContent = s.encoding || 'utf-8';
      enc.title = s.modified ? 'modified — unsaved changes' : 'saved';
    }
  }

  function setZen(on) {
    const badge = document.getElementById('zenBadge');
    if (badge) badge.hidden = !on;
  }

  return { setConnection, render, setZen };
}
