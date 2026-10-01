import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encode, decodeMultiStream } from '@msgpack/msgpack';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class NvimEmbedSession {
  constructor(cwd, cols = 120, rows = 35) {
    this.cwd = cwd;
    this.cols = Math.max(10, Math.min(500, cols));
    this.rows = Math.max(5, Math.min(200, rows));
    this.clients = new Set();
    this.reqId = 1;
    this.pendingRequests = new Map();
    this.attached = false;
    this.themeInit = path.resolve(__dirname, 'nvim_theme.lua');

    this.spawnProcess();
  }

  spawnProcess() {
    const cleanEnv = { ...process.env };
    delete cleanEnv.TERMINFO;
    delete cleanEnv.TERMINFO_DIRS;
    cleanEnv.TERM = 'xterm-256color';
    cleanEnv.COLORTERM = 'truecolor';

    const args = ['--embed'];
    if (fs.existsSync(this.themeInit)) {
      args.push('-u', this.themeInit);
    }

    this.proc = spawn('nvim', args, {
      cwd: this.cwd,
      env: cleanEnv,
      stdio: ['pipe', 'pipe', 'inherit']
    });

    this.startReader();
    this.attachUi();
  }

  async startReader() {
    try {
      for await (const msg of decodeMultiStream(this.proc.stdout)) {
        this.handleMessage(msg);
      }
    } catch (err) {
      if (!this.proc.killed) {
        console.error('[NvimEmbedSession Reader Error]:', err);
      }
    }
  }

  handleMessage(msg) {
    const type = msg[0];

    // Handle responses to internal session requests
    if (type === 1) {
      const [, msgId, error, result] = msg;
      const resolver = this.pendingRequests.get(msgId);
      if (resolver) {
        this.pendingRequests.delete(msgId);
        if (error) resolver.reject(new Error(JSON.stringify(error)));
        else resolver.resolve(result);
      }
    }

    // Broadcast redraw notifications and responses to all connected WebSocket clients
    const encoded = encode(msg);
    for (const ws of this.clients) {
      if (ws.readyState === 1 /* OPEN */) {
        try {
          ws.send(encoded);
        } catch (e) {
          console.error('[NvimEmbedSession WS Send Error]:', e);
        }
      }
    }
  }

  sendRequest(method, params = []) {
    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      this.pendingRequests.set(id, { resolve, reject });
      const packet = encode([0, id, method, params]);
      try {
        this.proc.stdin.write(packet);
      } catch (err) {
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  sendNotification(method, params = []) {
    const packet = encode([2, method, params]);
    try {
      this.proc.stdin.write(packet);
    } catch (err) {
      console.error('Failed to send notification:', err);
    }
  }

  attachUi() {
    this.sendRequest('nvim_ui_attach', [
      this.cols,
      this.rows,
      {
        ext_linegrid: true,
        rgb: true
      }
    ]).then(() => {
      this.attached = true;
    }).catch(err => {
      console.error('nvim_ui_attach failed:', err);
    });
  }

  resize(cols, rows) {
    this.cols = Math.max(10, Math.min(500, cols));
    this.rows = Math.max(5, Math.min(200, rows));
    return this.sendNotification('nvim_ui_try_resize', [this.cols, this.rows]);
  }

  input(keys) {
    return this.sendRequest('nvim_input', [keys]);
  }

  inputMouse(button, action, modifier, grid, row, col) {
    return this.sendNotification('nvim_input_mouse', [button, action, modifier, grid, row, col]);
  }

  command(cmd) {
    return this.sendRequest('nvim_command', [cmd]);
  }

  evalExpr(expr) {
    return this.sendRequest('nvim_eval', [expr]);
  }

  close() {
    try {
      for (const [, p] of this.pendingRequests) {
        p.reject(new Error('Session closed'));
      }
      this.pendingRequests.clear();
      this.proc.kill('SIGTERM');
    } catch {}
  }
}
