/**
 * NVW · 输入层：浏览器键盘/鼠标/IME → nvim_input
 *
 * 这是新架构相对"终端模拟器"最大的简化之一：
 * 不需要 VT 键盘编码（CSI-u / Kitty 协议 / modifyOtherKeys 那一堆），
 * 直接把语义按键交给 nvim —— `<C-w>` 就是 `<C-w>`，IME 组好的字就是文本。
 */

const SPECIAL = {
  Escape: 'Esc', Enter: 'CR', Backspace: 'BS', Delete: 'Del', Tab: 'Tab',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
  F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12'
};

/** nvim_input 里 `<` 必须转义，否则会被当成键记法的开头 */
const escText = s => s.replace(/</g, '<lt>');

export function createInputLayer({ root, send, getCellSize }) {
  // 隐藏输入框：承接 IME 合成、粘贴与移动端键盘
  const sink = document.createElement('textarea');
  sink.setAttribute('data-nvw-input', '');
  sink.setAttribute('autocomplete', 'off');
  sink.setAttribute('autocorrect', 'off');
  sink.setAttribute('autocapitalize', 'off');
  sink.setAttribute('spellcheck', 'false');
  sink.setAttribute('aria-label', 'terminal input');
  root.appendChild(sink);

  let composing = false;
  let lastClick = 0;

  const focus = () => { try { sink.focus({ preventScroll: true }); } catch { try { sink.focus(); } catch { /* 忽略 */ } } };

  // ---- 键盘 ----
  function onKeyDown(e) {
    if (composing) return;                       // 合成中的字符由 input 事件统一发出
    const mods = [];
    if (e.ctrlKey) mods.push('C');
    if (e.altKey) mods.push('A');
    if (e.metaKey) mods.push('D');               // nvim 用 D 表示 Cmd/Super
    if (e.shiftKey) mods.push('S');

    const special = SPECIAL[e.key];
    if (special) {
      e.preventDefault();
      // 一次性合并修饰键前缀，支持 Shift+Tab、Ctrl+Left、Ctrl+Alt+Left 等组合
      const modStr = mods.length ? mods.join('-') + '-' : '';
      send(`<${modStr}${special}>`);
      return;
    }

    if (e.key === 'Backspace' || e.key === 'Delete') return;   // 已被 SPECIAL 覆盖，保险

    // 可打印字符：交给 input/IME 通道，避免和合成重复
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) return;

    // Ctrl / Alt / Cmd 组合键
    if (e.key.length === 1) {
      e.preventDefault();
      const body = e.key.toLowerCase();
      const modStr = mods.map(m => m + '-').join('');
      send(`<${modStr}${body}>`);
      return;
    }
    // 其它多字符键名（如 'ContextMenu'）不处理
  }

  // ---- textarea 通道：普通字符 / IME 合成结果 / 粘贴 ----
  function flushSink() {
    const text = sink.value;
    if (!text) return;
    sink.value = '';
    send(escText(text));
  }

  function onInput() {
    if (composing) return;                        // 合成中先不发，等 compositionend
    flushSink();
  }

  sink.addEventListener('keydown', onKeyDown);
  sink.addEventListener('input', onInput);
  sink.addEventListener('compositionstart', () => { composing = true; });
  sink.addEventListener('compositionend', () => { composing = false; flushSink(); });
  sink.addEventListener('paste', e => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData)?.getData('text') ?? '';
    if (text) send({ paste: text });
  });
  sink.addEventListener('blur', () => { /* 保持简单：点击根节点会自动回焦 */ });
  root.addEventListener('mousedown', e => { if (e.target !== sink) { e.preventDefault(); focus(); } });
  root.addEventListener('focusin', e => { if (e.target !== sink) focus(); });

  // ---- 鼠标：交给 nvim 自己决定（它的鼠标模式/选择/拖拽都在编辑器侧） ----
  const buttons = { 0: 'left', 1: 'middle', 2: 'right' };
  function gridPos(e) {
    const { ch, lh } = getCellSize();
    if (!ch || !lh) return null;
    const rect = root.getBoundingClientRect();
    const col = Math.floor((e.clientX - rect.left) / ch);
    const row = Math.floor((e.clientY - rect.top) / lh);
    if (col < 0 || row < 0) return null;
    return { col, row };
  }

  root.addEventListener('mousedown', e => {
    const p = gridPos(e);
    if (!p) return;
    if (!e.shiftKey && !e.ctrlKey && e.altKey === false && e.button === 0) { /* 交给 nvim 判断是否进入可视模式 */ }
    send({ mouse: { button: buttons[e.button] || 'left', action: 'press', modifier: modifierOf(e), row: p.row, col: p.col } });
  });
  root.addEventListener('mouseup', e => {
    const p = gridPos(e);
    if (!p) return;
    send({ mouse: { button: buttons[e.button] || 'left', action: 'release', modifier: modifierOf(e), row: p.row, col: p.col } });
  });
  root.addEventListener('mousemove', e => {
    if (e.buttons === 0) return;                  // 只在拖拽时上报
    const p = gridPos(e);
    if (!p) return;
    send({ mouse: { button: buttons[e.button] || 'left', action: 'drag', modifier: modifierOf(e), row: p.row, col: p.col } });
  });
  root.addEventListener('wheel', e => {
    const p = gridPos(e);
    if (!p) return;
    e.preventDefault();
    const action = e.deltaY < 0 ? 'up' : 'down';
    send({ mouse: { button: 'wheel', action, modifier: modifierOf(e), row: p.row, col: p.col } });
  }, { passive: false });

  function modifierOf(e) {
    const m = [];
    if (e.shiftKey) m.push('S');
    if (e.ctrlKey) m.push('C');
    if (e.altKey) m.push('A');
    return m.join('-');
  }

  return { focus, sink };
}
