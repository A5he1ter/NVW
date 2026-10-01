/**
 * NVW · 服务端网格镜像
 *
 * 为什么需要它：nvim 的 UI 协议是增量的，而且它只认"我这条通道上那个 UI"的状态。
 * 一个 nvim 只 attach 一次，但浏览器可能有很多个（多标签、刷新页面）——
 * 新客户端拿到的是一个空网格，而 nvim 认为屏幕内容早就同步过了，于是什么都不发。
 * 所以服务端把事件流同步维护成一份权威网格及高亮表，客户端一连上就先发快照，再发增量。
 */

export class GridState {
  constructor(cols = 100, rows = 30) {
    this.cols = cols;
    this.rows = rows;
    this.grids = new Map();     // grid → { w, h, rows: (Cell|null)[][] }
    this.cursor = { grid: 1, row: 0, col: 0 };
    this.mode = 'normal';
    this.modeIdx = 0;
    this.modeInfo = [];
    this.hlTable = {};          // id → attr object (rgb)
    this.defaultColors = { fg: null, bg: null, sp: null };
  }

  _ensure(g, w, h) {
    let G = this.grids.get(g);
    if (!G || (w && G.w !== w) || (h && G.h !== h)) {
      const nw = w || G?.w || this.cols;
      const nh = h || G?.h || this.rows;
      G = { w: nw, h: nh, rows: Array.from({ length: nh }, () => new Array(nw).fill(null)) };
      this.grids.set(g, G);
    }
    return G;
  }

  apply(name, args) {
    switch (name) {
      case 'grid_resize':
        this._ensure(args[0], args[1], args[2]);
        break;

      case 'grid_clear': {
        const G = this.grids.get(args[0]);
        if (G) G.rows = Array.from({ length: G.h }, () => new Array(G.w).fill(null));
        break;
      }

      case 'grid_destroy':
        this.grids.delete(args[0]);
        break;

      case 'grid_line': {
        const [g, row, colStart, cells] = args;
        const G = this._ensure(g);
        if (row < 0 || row >= G.h) break;
        let col = colStart;
        let lastHl = 0;
        for (const cu of cells) {
          const [text, hl, repeat] = cu;
          if (hl !== undefined) lastHl = hl;          // 省略 = 继承同行前一格
          const n = repeat === undefined ? 1 : repeat;
          for (let i = 0; i < n; i++, col++) {
            if (col >= 0 && col < G.w) G.rows[row][col] = { t: text, hl: lastHl };
          }
        }
        break;
      }

      case 'grid_scroll': {
        // [grid, top, bot, left, right, rows, cols]
        const [g, top, bot, left, right, nrows] = args;
        const G = this.grids.get(g);
        if (!G || !nrows) break;
        const cLeft = Math.max(0, left ?? 0);
        const cRight = Math.min(G.w, right ?? G.w);
        const rTop = Math.max(0, top);
        const rBot = Math.min(G.h, bot);

        if (nrows > 0) {
          // 向上滚动：行向上移，从第 top 行到 bot - 1 行
          for (let r = rTop; r < rBot; r++) {
            const srcRow = r + nrows;
            for (let c = cLeft; c < cRight; c++) {
              G.rows[r][c] = (srcRow < rBot && G.rows[srcRow]) ? G.rows[srcRow][c] : null;
            }
          }
        } else if (nrows < 0) {
          // 向下滚动：行向下移，从第 bot - 1 行向下到 top 行
          for (let r = rBot - 1; r >= rTop; r--) {
            const srcRow = r + nrows;
            for (let c = cLeft; c < cRight; c++) {
              G.rows[r][c] = (srcRow >= rTop && G.rows[srcRow]) ? G.rows[srcRow][c] : null;
            }
          }
        }
        break;
      }

      case 'grid_cursor_goto':
        this.cursor = { grid: args[0], row: args[1], col: args[2] };
        break;

      case 'mode_info_set': {
        // [cursor_style_enabled, mode_info_list]
        if (args && args[1]) this.modeInfo = args[1];
        break;
      }

      case 'mode_change': {
        this.mode = args[0];
        if (args[1] !== undefined) this.modeIdx = args[1];
        break;
      }

      case 'default_colors_set': {
        // [rgb_fg, rgb_bg, rgb_sp, cterm_fg, cterm_bg]
        this.defaultColors = {
          fg: args[0] !== undefined && args[0] !== -1 ? args[0] : null,
          bg: args[1] !== undefined && args[1] !== -1 ? args[1] : null,
          sp: args[2] !== undefined && args[2] !== -1 ? args[2] : null
        };
        break;
      }

      case 'hl_attr_define': {
        // [id, rgb_attr, cterm_attr, info]
        const [id, rgb] = args;
        if (id !== undefined && rgb) {
          this.hlTable[id] = rgb;
        }
        break;
      }

      default:
        break;
    }
  }

  /** 客户端上报的尺寸：保留已有内容，只做扩边/裁剪 */
  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    for (const G of this.grids.values()) {
      const old = G.rows;
      G.w = cols;
      G.h = rows;
      G.rows = Array.from({ length: rows }, (_, r) => {
        const line = old[r] || [];
        if (line.length === cols) return line;
        if (line.length > cols) return line.slice(0, cols);
        return line.concat(new Array(cols - line.length).fill(null));
      });
    }
  }

  reset() {
    for (const G of this.grids.values()) {
      G.rows = Array.from({ length: G.h }, () => new Array(G.w).fill(null));
    }
  }

  snapshot() {
    let cursorShape = 'block';
    if (this.modeInfo && this.modeInfo[this.modeIdx]?.cursor_shape) {
      cursorShape = this.modeInfo[this.modeIdx].cursor_shape;
    }
    return {
      cols: this.cols,
      rows: this.rows,
      cursor: this.cursor,
      mode: this.mode,
      modeIdx: this.modeIdx,
      modeInfo: this.modeInfo,
      cursorShape,
      defaultColors: this.defaultColors,
      hlTable: this.hlTable,
      grids: [...this.grids.entries()].map(([g, G]) => [g, G.w, G.h, G.rows])
    };
  }
}
