/**
 * NVW · 网格 → DOM 渲染器
 *
 * 输入是 nvim UI 协议的事件流（grid_line / grid_scroll / grid_cursor_goto …），
 * 输出是 DOM：**一行一个节点，一段同样式文本一个 <span>**（不是一格一个）。
 *
 * 为什么这样最快最清晰：
 *  · 文本交给浏览器排版引擎 → 原生分辨率、原生字形、原生选中与 IME，没有 DPR 数学；
 *  · 每帧只重建"被 nvim 改动过的行"，其余行原地不动；
 *  · 定位用 CSS 的 ch / lh 单位，天然与字符网格对齐，不需要测量字符宽高。
 *
 * 注：#nvimTerminal 内部允许写样式（它是渲染面，与 canvas 同理），
 * 这是本项目唯一豁免"零行内样式"的地方。
 */

const hex = n => (typeof n === 'number' ? '#' + n.toString(16).padStart(6, '0') : null);

export function createGridRenderer({ container, onResize }) {
  /** grids: gridId → { w, h, rows: Cell[][] } */
  const grids = new Map();
  /** 每帧被改动的行：gridId+row */
  const dirty = new Set();
  const layers = new Map();          // gridId → { el, rowEls: HTMLElement[] }
  let colors = { groups: {}, normal: {} };
  let hlTable = {};                  // UI 高亮表：id → rgb_attr
  let defaultColors = { fg: null, bg: null, sp: null };
  let modeInfo = [];
  let cursor = { grid: 1, row: 0, col: 0, visible: true };
  let renderer = 'block';
  let cols = 0, rows = 0;
  let chPx = 0, lhPx = 0;

  container.setAttribute('data-nvw-grid', '');
  const cursorEl = document.createElement('div');
  cursorEl.setAttribute('data-nvw-cursor', '');

  // ---------- 网格状态 ----------
  function ensureGrid(g, w, h, blank = false) {
    let G = grids.get(g);
    if (!G || (w && G.w !== w) || (h && G.h !== h)) {
      G = { w: w || G?.w || cols, h: h || G?.h || rows, rows: [] };
      G.rows = Array.from({ length: G.h }, () => new Array(G.w).fill(null));
      grids.set(g, G);
      markAllDirty(g);
    } else if (blank) {
      G.rows = Array.from({ length: G.h }, () => new Array(G.w).fill(null));
      markAllDirty(g);
    }
    return G;
  }

  const markAllDirty = g => { const G = grids.get(g); if (G) for (let r = 0; r < G.h; r++) dirty.add(`${g}:${r}`); };
  const markDirty = (g, r) => dirty.add(`${g}:${r}`);

  function setCell(g, r, c, cell) {
    const G = grids.get(g);
    if (!G || r < 0 || r >= G.h) return;
    if (c < 0 || c >= G.w) return;
    G.rows[r][c] = cell;
  }

  function applyDefaultColors(bgHex) {
    if (bgHex) {
      container.style.backgroundColor = bgHex;
    }
  }

  function applyEvent(name, args) {
    switch (name) {
      case 'grid_resize': {
        const [g, w, h] = args;
        ensureGrid(g, w, h, false);
        break;
      }
      case 'grid_clear': {
        const g = args[0];
        const G = grids.get(g);
        if (G) { G.rows = Array.from({ length: G.h }, () => new Array(G.w).fill(null)); markAllDirty(g); }
        break;
      }
      case 'grid_destroy': {
        grids.delete(args[0]);
        const L = layers.get(args[0]);
        if (L) { L.el.remove(); layers.delete(args[0]); }
        break;
      }
      case 'grid_line': {
        const [g, row, colStart, cells] = args;
        const G = ensureGrid(g, 0, 0, false);
        let col = colStart;
        let lastHl = 0;
        for (const cu of cells) {
          const [text, hl, repeat] = cu;
          if (hl !== undefined) lastHl = hl;         // 省略 hl_id = 继承同行前一格
          const n = repeat === undefined ? 1 : repeat;
          for (let i = 0; i < n; i++) setCell(g, row, col++, { t: text, hl: lastHl });
        }
        markDirty(g, row);
        break;
      }
      case 'grid_scroll': {
        // [grid, top, bot, left, right, rows, cols]
        const [g, top, bot, left, right, nrows] = args;
        const G = grids.get(g);
        if (!G || !nrows) break;
        const cLeft = Math.max(0, left ?? 0);
        const cRight = Math.min(G.w, right ?? G.w);
        const rTop = Math.max(0, top);
        const rBot = Math.min(G.h, bot);

        if (nrows > 0) {
          // 向上滚动：内容往 top 移动，从第 top 行到 bot - 1 行
          for (let r = rTop; r < rBot; r++) {
            const srcRow = r + nrows;
            for (let c = cLeft; c < cRight; c++) {
              G.rows[r][c] = (srcRow < rBot && G.rows[srcRow]) ? G.rows[srcRow][c] : null;
            }
          }
        } else if (nrows < 0) {
          // 向下滚动：内容往 bot 移动，从第 bot - 1 行向下到 top 行
          for (let r = rBot - 1; r >= rTop; r--) {
            const srcRow = r + nrows;
            for (let c = cLeft; c < cRight; c++) {
              G.rows[r][c] = (srcRow >= rTop && G.rows[srcRow]) ? G.rows[srcRow][c] : null;
            }
          }
        }
        for (let r = rTop; r < rBot; r++) markDirty(g, r);
        break;
      }
      case 'grid_cursor_goto': {
        const [g, row, col] = args;
        cursor = { ...cursor, grid: g, row, col };
        break;
      }
      case 'mode_info_set': {
        if (args && args[1]) modeInfo = args[1];
        break;
      }
      case 'mode_change': {
        const [modeName, modeIdx] = args;
        const info = modeInfo[modeIdx];
        if (info && info.cursor_shape) renderer = info.cursor_shape;
        break;
      }
      case 'default_colors_set': {
        defaultColors = {
          fg: args[0] !== undefined && args[0] !== -1 ? args[0] : null,
          bg: args[1] !== undefined && args[1] !== -1 ? args[1] : null,
          sp: args[2] !== undefined && args[2] !== -1 ? args[2] : null
        };
        applyDefaultColors(hex(defaultColors.bg));
        for (const g of grids.keys()) markAllDirty(g);
        break;
      }
      case 'hl_attr_define': {
        const [id, rgb] = args;
        if (id !== undefined && rgb) {
          hlTable[id] = rgb;
          // 有高亮定义变更时，触发重绘
          for (const g of grids.keys()) markAllDirty(g);
        }
        break;
      }
      default:
        break;
    }
  }

  // ---------- DOM 渲染 ----------
  function styleFor(hlId, span) {
    // 优先从 UI 协议的 hlTable 读取；回退到 colors.groups
    const uiAttr = hlId ? hlTable[hlId] : null;
    const a = uiAttr || colors.groups?.[hlId] || {};
    let fg = a.foreground ?? a.fg;
    let bg = a.background ?? a.bg;
    const defFg = defaultColors.fg ?? colors.normal?.fg;
    const defBg = defaultColors.bg ?? colors.normal?.bg;

    if (a.reverse) {
      const f = fg ?? defFg;
      const b = bg ?? defBg;
      fg = b; bg = f;
    } else {
      // 普通格子若未指定颜色，明确使用协议 defaultColors 或 Normal 默认色彩
      if (fg === undefined) fg = defFg;
      if (bg === undefined) bg = defBg;
    }
    const fgHex = hex(fg);
    const bgHex = hex(bg);
    if (fgHex) span.style.color = fgHex;
    if (bgHex) span.style.backgroundColor = bgHex;
    if (a.bold) span.style.fontWeight = 'bold';
    if (a.italic) span.style.fontStyle = 'italic';
    if (a.underline || a.undercurl || a.underdouble || a.underdotted || a.underdashed) span.style.textDecoration = 'underline';
    if (a.strikethrough) span.style.textDecoration = 'line-through';
  }

  function isVisibleHl(hlId) {
    if (!hlId) return false;
    const uiAttr = hlTable[hlId];
    const a = uiAttr || colors.groups?.[hlId];
    if (!a) return false;
    return !!(a.background !== undefined || a.bg !== undefined ||
              a.reverse || a.underline || a.undercurl || a.underdouble ||
              a.underdotted || a.underdashed || a.strikethrough);
  }

  function buildRow(G, r) {
    const cells = G.rows[r] || [];
    let last = -1;                                  // 末尾无样式的纯空白不必进 DOM
    for (let c = cells.length - 1; c >= 0; c--) {
      const cell = cells[c];
      if (cell && ((cell.t && cell.t !== ' ') || isVisibleHl(cell.hl))) {
        last = c;
        break;
      }
    }
    const frag = document.createDocumentFragment();
    let runHl = null, runText = '';
    const flush = () => {
      if (!runText) return;
      const span = document.createElement('span');
      styleFor(runHl, span);
      span.textContent = runText;
      frag.appendChild(span);
      runText = '';
    };
    for (let c = 0; c <= last; c++) {
      const cell = cells[c];
      const t = cell?.t ?? ' ';
      const hl = cell?.hl ?? 0;
      if (hl !== runHl) { flush(); runHl = hl; }
      runText += t;
    }
    flush();
    const rowEl = document.createElement('div');
    rowEl.appendChild(frag);
    return rowEl;
  }

  function ensureLayer(g) {
    let L = layers.get(g);
    const G = grids.get(g);
    if (!L) {
      const el = document.createElement('div');
      el.setAttribute('data-nvw-layer', String(g));
      container.appendChild(el);
      L = { el, rowEls: [] };
      layers.set(g, L);
    }
    if (G && L.rowEls.length !== G.h) {
      L.el.textContent = '';
      L.rowEls = Array.from({ length: G.h }, () => { const d = document.createElement('div'); L.el.appendChild(d); return d; });
      markAllDirty(g);
    }
    return L;
  }

  /** 把某一帧攒下的改动落到 DOM —— 重建脏行并更新光标 */
  function commit() {
    if (dirty.size) {
      for (const key of dirty) {
        const [g, r] = key.split(':').map(Number);
        const G = grids.get(g);
        if (!G) continue;
        const L = ensureLayer(g);
        const rowEl = L.rowEls[r];
        if (!rowEl) continue;
        const next = buildRow(G, r);
        rowEl.replaceChildren(...next.childNodes);
      }
      dirty.clear();
    }
    drawCursor();
  }

  function drawCursor() {
    const L = layers.get(cursor.grid) || [...layers.values()][0];
    if (!L || !chPx || !lhPx || !cursor.visible) { cursorEl.remove(); return; }
    if (!cursorEl.isConnected) container.appendChild(cursorEl);
    cursorEl.style.left = `${cursor.col * chPx}px`;
    cursorEl.style.top = `${cursor.row * lhPx}px`;
    cursorEl.style.width = renderer === 'vertical' ? '2px' : `${chPx}px`;
    cursorEl.style.height = renderer === 'horizontal' ? '2px' : `${lhPx}px`;
    if (renderer === 'horizontal') {
      cursorEl.style.top = `${(cursor.row + 1) * lhPx - 2}px`;
    }
    const defFg = defaultColors.fg ?? colors.normal?.fg;
    cursorEl.style.backgroundColor = hex(defFg) || '#fff';
    cursorEl.style.mixBlendMode = renderer === 'block' ? 'difference' : 'normal';
    cursorEl.style.opacity = renderer === 'hidden' ? '0' : '1';
  }

  // ---------- 对外 ----------
  return {
    /** 应用一帧（服务端把一个 nvim 通知里的事件攒成一批发过来） */
    applyFrame(events) {
      for (const [name, args] of events) applyEvent(name, args);
      commit();
    },
    /** 清空 */
    clear() {
      for (const g of grids.keys()) {
        const G = grids.get(g);
        G.rows = Array.from({ length: G.h }, () => new Array(G.w).fill(null));
        markAllDirty(g);
      }
      commit();
    },
    /** 载入服务端快照（新客户端/刷新页面时用） */
    loadSnapshot(snap) {
      for (const L of layers.values()) L.el.remove();
      layers.clear();
      grids.clear();
      if (snap.hlTable) hlTable = { ...snap.hlTable };
      if (snap.defaultColors) {
        defaultColors = { ...snap.defaultColors };
        applyDefaultColors(hex(defaultColors.bg));
      }
      if (snap.modeInfo) modeInfo = snap.modeInfo;
      if (snap.cursorShape) renderer = snap.cursorShape;
      else if (snap.modeInfo && snap.modeIdx !== undefined && snap.modeInfo[snap.modeIdx]?.cursor_shape) {
        renderer = snap.modeInfo[snap.modeIdx].cursor_shape;
      }
      for (const [g, w, h, rows] of snap.grids || []) {
        grids.set(g, {
          w, h,
          rows: Array.from({ length: h }, (_, r) => {
            const line = rows[r] || [];
            return Array.from({ length: w }, (_, c) => {
              const cell = line[c];
              return cell && cell.t !== undefined ? { t: cell.t, hl: cell.hl ?? 0 } : null;
            });
          })
        });
        markAllDirty(g);
      }
      if (snap.cursor) cursor = { ...cursor, ...snap.cursor, visible: true };
      commit();
    },
    setColors(c) {
      colors = c;
      const defBg = hex(c.normal?.bg) || hex(defaultColors.bg);
      applyDefaultColors(defBg);
      for (const g of grids.keys()) markAllDirty(g);
      commit();
    },
    setSize(nextCols, nextRows) {
      if (nextCols === cols && nextRows === rows) return;
      cols = nextCols; rows = nextRows;
      for (const [g, G] of grids) {
        const old = G.rows;
        G.w = nextCols;
        G.h = nextRows;
        G.rows = Array.from({ length: nextRows }, (_, r) => {
          const line = old[r] || [];
          if (line.length === nextCols) return line;
          if (line.length > nextCols) return line.slice(0, nextCols);
          return line.concat(new Array(nextCols - line.length).fill(null));
        });
        markAllDirty(g);
      }
      commit();
    },
    setCursorVisible(v) { cursor.visible = v; drawCursor(); },
    setCursorShape(shape) { renderer = shape; drawCursor(); },
    /** 字符单元尺寸由客户端测量后告诉我们（布局归客户端，渲染器只负责画） */
    setCellSize(ch, lh) { chPx = ch; lhPx = lh; drawCursor(); },
    /** 供输入层做鼠标→(行,列) 换算 */
    cellSize() { return { ch: chPx, lh: lhPx }; },
    colorsRef: () => colors
  };
}
