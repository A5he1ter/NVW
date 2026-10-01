/**
 * NVW · Buffer 标签页（契约 §2.5）
 * 导出：createTabs({ api, showToast, onSwitch, onClose }) → { render(buffers, status) }
 * 每个 tab 是 <row> 分组：label 按钮 + 独立 close 按钮；dirty 用 " *"。
 */

const NF = {
  file: '\uf15b',
  ext: {
    js: '\ue74e', mjs: '\ue74e', cjs: '\ue74e', jsx: '\ue7ba',
    ts: '\ue628', tsx: '\ue7ba', json: '\ue60b', jsonc: '\ue60b',
    md: '\uf48a', mdx: '\uf48a', txt: '\uf15c',
    css: '\ue749', scss: '\ue749', html: '\uf13b', htm: '\uf13b', vue: '\ufd42',
    py: '\ue73c', lua: '\ue620', vim: '\ue62b', nvim: '\ue620',
    sh: '\uf489', bash: '\uf489', zsh: '\uf489',
    yml: '\uf481', yaml: '\uf481', toml: '\ue6b2', ini: '\ue615'
  }
};

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[m]);
}

function fileIcon(name) {
  const base = String(name || '').toLowerCase();
  if (base === 'dockerfile') return '\uf308';
  if (base === 'makefile') return '\uf489';
  const ext = base.includes('.') ? base.split('.').pop() : '';
  return NF.ext[ext] || NF.file;
}

const baseName = p => (p ? String(p).split('/').pop() : '');

export function createTabs({ api, showToast, onSwitch, onClose }) {
  let sig = '';
  let activeSig = '';

  function projectRoot() {
    const el = document.getElementById('explorerRoot');
    return ((el?.title || el?.textContent) || '').trim();
  }

  function relPath(abs) {
    const root = projectRoot();
    if (!abs) return '';
    if (root && abs.startsWith(root + '/')) return abs.slice(root.length + 1);
    return abs;
  }

  function label(buf) {
    const name = buf.name ? baseName(buf.name) : `[No Name ${buf.bufnr}]`;
    return `${fileIcon(name)} ${name}${buf.changed ? ' *' : ''}`;
  }

  function html(list) {
    return list.map(buf => {
      const dirty = !!buf.changed;
      const active = !!buf.active;
      const name = buf.name ? baseName(buf.name) : `[No Name ${buf.bufnr}]`;
      const title = buf.name || name;
      return `<row align-="center" gap-="1" data-tab="${buf.bufnr}">` +
        `<button size-="small" variant-="${active ? 'foreground0' : 'background0'}"` +
        ` data-bufnr="${buf.bufnr}" title="${esc(title)}" aria-label="${esc(title)}${dirty ? ' (modified)' : ''}">` +
        `<span data-tab-label>${esc(label(buf))}</span></button>` +
        `<button size-="small" variant-="background0" data-close="${buf.bufnr}"` +
        ` title="Close ${esc(name)}" aria-label="Close ${esc(name)}">x</button>` +
        '</row>';
    }).join('');
  }

  let bound = false;
  let current = [];

  function bind(container) {
    if (bound) return;
    bound = true;
    container.addEventListener('click', async e => {
      const closeBtn = e.target.closest('button[data-close]');
      if (closeBtn) {
        e.preventDefault();
        const n = parseInt(closeBtn.dataset.close, 10);
        const buf = current.find(b => b.bufnr === n) || { bufnr: n };
        try {
          if (onClose) await onClose(n, buf);
          else { await api.closeBuffer(n); await onSwitch?.(n); }
        } catch (err) { showToast(err.message, 'error'); }
        return;
      }
      const tab = e.target.closest('button[data-bufnr]');
      if (!tab) return;
      e.preventDefault();
      const n = parseInt(tab.dataset.bufnr, 10);
      try {
        if (onSwitch) await onSwitch(n);
        else await api.switchBuffer(n);
      } catch (err) { showToast(err.message, 'error'); }
    });
  }

  function render(buffers, status) {
    const list = Array.isArray(buffers) ? buffers : [];
    const active = list.find(b => b.active) || null;
    const container = document.getElementById('buffer-tabs');
    const next = list.map(b => `${b.bufnr}:${b.changed ? 1 : 0}:${b.active ? 1 : 0}:${b.name || ''}`).join('|');

    current = list;
    if (container && next !== sig) {
      container.innerHTML = html(list);
      sig = next;
      bind(container);
      const activeSigNext = active ? `${active.bufnr}:${active.name || ''}` : '';
      if (activeSigNext !== activeSig) {
        activeSig = activeSigNext;
        if (active) {
          container.querySelector(`[data-tab="${active.bufnr}"] button[data-bufnr]`)
            ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      }
    }
    const name = active ? (active.name ? baseName(active.name) : `[No Name ${active.bufnr}]`) : '[No Name]';
    const dirty = !!(active && active.changed);

    const title = document.getElementById('activeDocTitle');
    if (title) title.textContent = name;

    const pathEl = document.getElementById('activeDocPath');
    if (pathEl) {
      const rel = active && active.name ? relPath(active.name) : '';
      // 只显示"目录"信息：根目录文件的相对路径就是文件名本身，
      // 显示出来就是 #activeDocTitle 的截断重复（实测看着像坏掉的第二个 tab），直接隐藏。
      const hasDir = rel.includes('/');
      pathEl.textContent = hasDir ? rel : '';
      pathEl.title = (active && active.name) || '';
      pathEl.hidden = !hasDir;
    }

    const count = document.getElementById('bufferCount');
    if (count) {
      // 标签溢出时用「激活序号/总数」定位当前 tab（如 3/7）
      const idx = list.findIndex(b => b.active);
      count.textContent = list.length > 1 && idx >= 0 ? `${idx + 1}/${list.length}` : String(list.length);
      count.title = active ? `${name} — buffer ${idx + 1} of ${list.length}` : `${list.length} buffers`;
    }

    const sb = document.getElementById('statusBuffer');
    if (sb) sb.textContent = `${name}${dirty ? ' *' : ''}`;

    const sc = document.getElementById('statusBuffers');
    if (sc) sc.textContent = `${list.length} buffer${list.length === 1 ? '' : 's'}`;

    return active;
  }

  return { render };
}
