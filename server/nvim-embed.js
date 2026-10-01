/**
 * NVW · nvim --embed 常驻通道
 *
 * 这是新架构唯一的 nvim 接入层，取代过去"PTY + 终端模拟器"那一整套：
 *   spawn nvim --embed  →  msgpack-rpc over stdio（一条常驻连接）
 *   nvim_ui_attach      →  收 grid_line / grid_scroll / mode_change … 语义事件
 *   nvim_input          ←  键盘 / 鼠标 / IME
 *
 * 协议规范（nvim 0.12.5+，参考 Neovim 官方 UI 协议与 docs/CURRENT-REVIEW-2026-09-29.md）：
 *  1. redraw 载荷是事件组数组：[[事件名, 参数组1, 参数组2, ...], [事件名, 参数组1, ...], ...]
 *     必须完整遍历外层所有事件组，再对内层遍历参数组。
 *  2. UI 高亮由 `hl_attr_define` 与 `default_colors_set` 提供权威定义。
 *  3. 帧边界以 `flush` 事件为标志落盘/发射。
 *  4. grid_line 的 cell 是 [文本, hl_id?, repeat?]：hl_id 与 repeat 都可省略，
 *     省略 hl_id 表示继承同行前一个格子的 hl_id（首格默认为 0）。
 */
import { spawn } from 'child_process';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { decodeMultiStream, encode } from '@msgpack/msgpack';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const NVIM_BIN = fs.existsSync('/opt/homebrew/bin/nvim') ? '/opt/homebrew/bin/nvim' : 'nvim';

/** 一次 Lua 拿全颜色表：id (字符串) → 最终属性（link 已就地解析）
 * 注意：在 Neovim 0.9.x 及更早版本的 msgpack-rpc 转换器中，含有整数键但存在空洞的 Lua table
 * 会报错 "E5100: Cannot convert given lua table: table should either have a sequence of positive integer keys or contain only string keys"
 * 将 groups[tostring(id)] 明确作为字符串键 map 序列化，兼容 Neovim 0.9.x ~ 0.12.x 全版本。
 */
const COLORS_LUA = `
local all = vim.api.nvim_get_hl(0, {})
local function resolve(def, depth)
  if not def or not def.link or depth > 8 then return def or {} end
  return resolve(all[def.link], depth + 1)
end
local groups = {}
for name, def in pairs(all) do
  local final = resolve(def, 0)
  local id = vim.api.nvim_get_hl_id_by_name(name)
  groups[tostring(id)] = {
    name = name,
    fg = final.fg, bg = final.bg, sp = final.sp,
    bold = final.bold, italic = final.italic, underline = final.underline,
    undercurl = final.undercurl, strikethrough = final.strikethrough, reverse = final.reverse,
  }
end
return { groups = groups, normal = all.Normal or {} }
`;

export class NvimEmbed extends EventEmitter {
  constructor({ cwd, cols = 100, rows = 30, workspace, args = [] } = {}) {
    super();
    this.cwd = cwd || process.cwd();
    this.workspace = workspace || this.cwd;
    this.cols = cols;
    this.rows = rows;
    this.args = args;
    this.child = null;
    this.chan = 0;
    this.msgid = 0;
    this.pending = new Map();
    this.colors = { groups: {}, normal: {} };
    this.exited = false;
    this.broken = false;
  }

  /** 启动 nvim 并完成 attach；resolve 时事件流已经在往外发（幂等：多次调用共用同一次启动） */
  async start() {
    if (this.started) return this.started;
    this.started = this._start();
    return this.started;
  }

  async _start() {
    const nvwDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const themeScript = path.join(nvwDir, 'nvim_theme.lua');
    // 使用 fnameescape / 表单转义空格与特殊符号，安全设置 rtp
    const escapedNvwDir = nvwDir.replace(/([\\,\s])/g, '\\$1');
    const nvimArgs = ['--embed', '-n', '-c', `set rtp+=${escapedNvwDir}`];
    if (fs.existsSync(themeScript)) nvimArgs.push('-S', themeScript);
    nvimArgs.push(...this.args);

    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', NVW_ACTIVE: '1' };
    delete env.TERMINFO;
    delete env.TERMINFO_DIRS;

    // 若系统 NVIM_LOG_FILE 未显式指定或默认位置不可写，自动指定安全可写的临时日志路径，
    // 防止 Neovim 启动时因无法写入日志触发 "Press ENTER or type command to continue" 的阻塞提示。
    if (!env.NVIM_LOG_FILE) {
      const defaultStateDir = path.join(os.homedir(), '.local', 'state', 'nvim');
      try {
        if (!fs.existsSync(defaultStateDir)) fs.mkdirSync(defaultStateDir, { recursive: true });
        fs.accessSync(defaultStateDir, fs.constants.W_OK);
      } catch {
        env.NVIM_LOG_FILE = path.join(os.tmpdir(), 'nvw-nvim.log');
      }
    }

    this.child = spawn(NVIM_BIN, nvimArgs, { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', err => {
      this.broken = true;
      this.exited = true;
      this._cleanupPending(new Error(`nvim 进程启动错误: ${err.message}`));
      if (this.listenerCount('error')) this.emit('error', err);
      else this.emit('handlerError', 'spawn', err);
    });
    this.child.stdin.on('error', err => {
      this.broken = true;
      this._cleanupPending(new Error(`nvim stdin 错误: ${err.message}`));
      if (this.listenerCount('error')) this.emit('error', err);
      else this.emit('handlerError', 'stdin', err);
      // 通道损坏时，主动终止并回收子进程
      this.dispose();
    });
    this.child.stderr.on('data', d => this.emit('stderr', d.toString()));
    this.child.on('exit', (code, signal) => {
      this.exited = true;
      this._cleanupPending(new Error(`nvim 已退出 (code: ${code}, signal: ${signal})`));
      this.emit('exit', { code, signal });
    });

    // msgpack 流式解码：自动处理粘包/半包
    const reader = (async () => {
      try {
        for await (const msg of decodeMultiStream(Readable.toWeb(this.child.stdout))) {
          try {
            this._onMessage(msg);
          } catch (e) {
            this.emit('handlerError', 'message', e);   // 单条消息出错不该终止整个流
          }
        }
      } catch (e) {
        this.broken = true;
        this._cleanupPending(new Error(`nvim stdout 流中断: ${e.message}`));
        if (this.listenerCount('error')) this.emit('error', e);
        else this.emit('handlerError', 'stream', e);
        // 流中断表示通信断开，可靠终止并回收子进程
        this.dispose();
      }
    })();

    const [chan, meta] = await this.rpc('nvim_get_api_info');
    this.chan = chan;
    this.version = meta.version;

    // 只用 ext_linegrid：**单网格 = 整屏**，nvim 自己把窗口/浮窗/消息合成好再发给我们。
    // ext_multigrid 要 UI 自己按 win_pos 合成多个网格（实测极易出错，且需要一整套布局逻辑），
    // 与"纯净、不臃肿"的目标相悖，故不用。
    await this.rpc('nvim_ui_attach', this.cols, this.rows, {
      ext_linegrid: true,
      rgb: true
    });

    // 颜色表 + 变更订阅（ColorScheme 时主动通知我们重取）
    await this.refreshColors();
    await this.rpc('nvim_exec_lua',
      "local ch = ... vim.api.nvim_create_autocmd('ColorScheme', {" +
      "  callback = function() vim.rpcnotify(ch, 'nvw', 'colors') end })",
      [this.chan]);

    // attach 后必须触发一次绘制，否则初始全屏不会推送
    await this.rpc('nvim_command', 'redraw!');
    return this;
  }

  _onMessage(msg) {
    // [0, msgid, method, params] = nvim 反过来请求我们
    if (msg[0] === 0) {
      const [, id, method] = msg;
      this._reply(id, null, null);           // 我们没有对外暴露的 RPC，一律应答 null
      if (method) this.emit('request', method);
      return;
    }
    // [1, msgid, error, result] = 我们的请求的应答
    if (msg[0] === 1) {
      const [, id, error, result] = msg;
      const p = this.pending.get(id);
      if (!p) return;
      if (p.timer) clearTimeout(p.timer);
      this.pending.delete(id);
      error ? p.reject(new Error(typeof error === 'string' ? error : JSON.stringify(error))) : p.resolve(result);
      return;
    }
    // [2, method, params] = 通知
    if (msg[0] === 2) {
      const [, method, params] = msg;
      if (method === 'redraw') return this._onRedraw(params);
      if (method === 'nvw') {                 // 我们自己的 Lua 回调
        if (params[0] === 'colors') this.refreshColors().catch(() => {});
        return;
      }
      this.emit('notify', method, params);
    }
  }

  /**
   * 消费 redraw 通知。
   * Neovim UI 协议：params 是多个事件组组成的数组，
   * 每个事件组的形状为 [事件名, 参数组1, 参数组2, ...]
   * 且只有遇到 'flush' 事件或批次结束时，才标志一帧完成。
   */
  _onRedraw(batches) {
    if (!Array.isArray(batches)) return;
    for (const batch of batches) {
      if (!Array.isArray(batch) || !batch.length) continue;
      const name = batch[0];
      for (let i = 1; i < batch.length; i++) {
        const args = batch[i];
        try {
          this.emit('ui', name, args);
        } catch (e) {
          this.emit('handlerError', name, e);
        }
      }
      if (name === 'flush') {
        try { this.emit('frame'); } catch (e) { this.emit('handlerError', 'frame', e); }
      }
    }
  }

  _cleanupPending(err) {
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err || new Error('nvim 通道已断开'));
    }
    this.pending.clear();
  }


  /**
   * 逼 nvim 重画行号列。
   *
   * 为什么需要：nvim 的增量只发"内容变了"的格子，**文字没变、只有高亮变**的格子不发。
   * 于是打开文件后，首行的行号（"  1"）会一直空着 —— 它在空缓冲区时就已经是 "1"，
   * 打开文件后只是换了高亮组，nvim 认为无需下发。改一次 numberwidth 会让整条 gutter
   * 重画，缺口即刻补齐（实测：基线 ❌ / numberwidth 往返 ✅）。
   * 只动一个度量选项、立刻还原，不影响用户设置，也不会触发 BufEnter（无递归）。
   */
  async refreshGutter() {
    try {
      const w = Number(await this.rpc('nvim_get_option_value', 'numberwidth', {})) || 4;
      await this.rpc('nvim_set_option_value', 'numberwidth', w + 1, {});
      await this.rpc('nvim_set_option_value', 'numberwidth', w, {});
      return true;
    } catch {
      return false;
    }
  }

  _write(obj) {
    if (!this.child || this.exited || this.broken) return false;
    try { this.child.stdin.write(encode(obj)); return true; } catch { return false; }
  }

  rpc(method, ...params) {
    const id = ++this.msgid;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`nvim RPC 超时 (${method})`));
        }
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      if (!this._write([0, id, method, params])) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('nvim 通道已关闭'));
      }
    });
  }

  _reply(id, error, result) { this._write([1, id, error, result]); }

  // ---- 输入 ----
  /** keys 用 nvim 的键记法：可打印文本原样，特殊键写 <Esc> <C-w> <CR> … */
  async input(keys) {
    if (typeof keys !== 'string' || !keys) return;
    const CHUNK_BYTES = 1024;
    let str = keys;
    while (str.length > 0 && !this.broken && !this.exited) {
      // 若剩余字节数较大，按 1024 字节切片并留出微延迟排队，防止击穿 Neovim typeahead 缓冲区上限 (16KB)
      const buf = Buffer.from(str, 'utf-8');
      const chunkBuf = buf.subarray(0, CHUNK_BYTES);
      const chunkStr = chunkBuf.toString('utf-8');
      const accepted = await this.rpc('nvim_input', chunkStr);
      const acceptedBytes = typeof accepted === 'number' && accepted > 0 ? accepted : Buffer.byteLength(chunkStr, 'utf-8');
      if (acceptedBytes >= buf.length) {
        break;
      }
      str = buf.subarray(acceptedBytes).toString('utf-8');
      if (str.length > 0) {
        await new Promise(r => setTimeout(r, 10));
      }
    }
  }

  /** 使用结构化 nvim_paste API 传输大段粘贴文本，分块注入，防止键位映射干扰或大文本截断 */
  async paste(text) {
    if (typeof text !== 'string' || !text) return false;
    const CHUNK_SIZE = 16384;
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
      const chunk = text.slice(i, i + CHUNK_SIZE);
      const isFirst = i === 0;
      await this.rpc('nvim_paste', chunk, true, -1);
    }
    return true;
  }
  inputMouse(button, action, modifier, grid, row, col) {
    return this.rpc('nvim_input_mouse', button, action, modifier, grid, row, col);
  }
  /** 由浏览器主导尺寸：算好行列后告诉 nvim */
  tryResize(cols, rows) {
    this.cols = cols; this.rows = rows;
    return this.rpc('nvim_ui_try_resize', cols, rows);
  }

  command(cmd) { return this.rpc('nvim_command', cmd); }

  async setCwd(target) {
    await this.rpc('nvim_exec_lua', `
      local target = ...
      vim.cmd('cd ' .. vim.fn.fnameescape(target))
      for _, win in ipairs(vim.api.nvim_list_wins()) do
        vim.api.nvim_win_call(win, function()
          pcall(vim.cmd, 'cd ' .. vim.fn.fnameescape(target))
        end)
      end
    `, [target]);
    this.cwd = target;
    this.workspace = target;
  }


  async refreshColors() {
    const res = await this.rpc('nvim_exec_lua', COLORS_LUA, []);
    this.colors = res || { groups: {}, normal: {} };
    this.emit('colors', this.colors);
    return this.colors;
  }

  async dispose(timeoutMs = 1500) {
    if (!this.child || this.exited) {
      this.broken = true;
      this._cleanupPending(new Error('nvim 已主动销毁'));
      return;
    }

    // 在标记 broken 之前尝试主动终止处于运行状态的 terminal job 通道
    try {
      if (this.chan && !this.broken) {
        await this.rpc('nvim_exec_lua', `
          for _, c in ipairs(vim.api.nvim_list_chans()) do
            if c.mode == 'terminal' then pcall(vim.fn.jobstop, c.id) end
          end
        `, []).catch(() => {});
      }
    } catch { /* 忽略清理错误 */ }

    this.broken = true;
    this._cleanupPending(new Error('nvim 已主动销毁'));

    try { this.child.stdin?.end(); } catch { /* 已关闭 */ }
    if (!this.exited) {
      try { this.child.kill('SIGTERM'); } catch { /* 已退出 */ }
    }

    // 等待子进程退出，若超时则 SIGKILL 兜底强制回收并等待其 exit 事件
    if (!this.exited) {
      await new Promise(resolve => {
        let timer = null;
        const onExit = () => {
          if (timer) clearTimeout(timer);
          resolve();
        };
        this.child.once('exit', onExit);
        timer = setTimeout(async () => {
          if (!this.exited) {
            try { this.child.kill('SIGKILL'); } catch { /* 已退出 */ }
            if (!this.exited) {
              await new Promise(r => this.child.once('exit', r));
            }
          }
          resolve();
        }, timeoutMs);
      });
    }
  }
}
