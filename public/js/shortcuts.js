/**
 * NVW · 全局快捷键派发 + 文档表格（契约 §2.9 / §3.3）
 * xterm 会在目标元素上 stopPropagation，冒泡收不到按键 → 必须在 window 捕获阶段拦截。
 */
import { KEYMAP, matchEvent, formatKeys } from './keymap.js';

function renderKeymapTable() {
  const tbody = document.getElementById('keymapTableBody');
  if (!tbody) return false;

  tbody.replaceChildren(...KEYMAP.map((entry) => {
    const tr = document.createElement('tr');
    const tdKey = document.createElement('td');
    const code = document.createElement('code');
    code.textContent = formatKeys(entry.keys);
    tdKey.appendChild(code);
    const tdLabel = document.createElement('td');
    tdLabel.textContent = entry.label;
    const tdGroup = document.createElement('td');
    tdGroup.textContent = entry.group;
    tr.append(tdKey, tdLabel, tdGroup);
    return tr;
  }));

  const headRow = tbody.closest('table')?.querySelector('thead tr');
  if (headRow && headRow.children.length !== 3) {
    headRow.replaceChildren(...['Key', 'Action', 'Group'].map((text) => {
      const th = document.createElement('th');
      th.textContent = text;
      return th;
    }));
  }
  return true;
}

/**
 * @param {{actions?: Record<string, Function>}} options  actions 的键是 KEYMAP id
 */
export function initShortcuts({ actions = {} } = {}) {
  const bound = KEYMAP.filter((entry) => typeof actions[entry.id] === 'function');

  const onKeyDown = (e) => {
    if (e.defaultPrevented || e.repeat || e.isComposing || e.keyCode === 229) return;
    for (const entry of bound) {
      if (!matchEvent(e, entry.keys)) continue;
      e.preventDefault();
      e.stopPropagation();
      try {
        actions[entry.id](e);
      } catch (err) {
        console.warn(`[nvw] shortcut ${entry.id} failed:`, err);
      }
      return;
    }
  };

  window.addEventListener('keydown', onKeyDown, true);
  renderKeymapTable();

  return {
    bindings: bound.map((entry) => entry.id),
    renderKeymapTable,
    destroy() { window.removeEventListener('keydown', onKeyDown, true); }
  };
}
