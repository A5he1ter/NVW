/**
 * NVW • Official API Client with WebTUI Error Feedback
 */

import { showToast } from './toast.js';

export async function request(url, options = {}) {
  try {
    const res = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      ...options
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errorMsg = data.error || `HTTP ${res.status} ${res.statusText}`;
      const err = new Error(errorMsg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  } catch (err) {
    if (err.name !== 'AbortError') {
      showToast(err.message, 'error');
    }
    throw err;
  }
}

export const api = {
  getFiles: (dir = '') => request(`/api/files${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`),
  openFile: (filePath) => request('/api/open-file', {
    method: 'POST',
    body: JSON.stringify({ file: filePath, filePath })
  }),
  getBuffers: () => request('/api/buffers'),
  // 一次请求拿回状态 + buffer 列表（服务端单次 RPC），替代原先的双请求轮询
  getSession: () => request('/api/session'),
  // 服务端递归搜索：一次调用替代前端逐目录 N+1 请求
  searchFiles: (q = '', limit = 200) =>
    request(`/api/search-files?q=${encodeURIComponent(q)}&limit=${limit}`),
  // 白名单语义命令：save / close / new / reload
  nvimCommand: (cmd) => request('/api/nvim-cmd', {
    method: 'POST',
    body: JSON.stringify({ cmd })
  }),
  switchBuffer: (bufnr) => request('/api/switch-buffer', {
    method: 'POST',
    body: JSON.stringify({ bufnr })
  }),
  closeBuffer: (bufnr, options = {}) => request('/api/close-buffer', {
    method: 'POST',
    body: JSON.stringify({ bufnr, discard: options.discard, save: options.save })
  }),
  newBuffer: () => request('/api/new-buffer', { method: 'POST' }),
  setTheme: (theme) => request('/api/set-theme', {
    method: 'POST',
    body: JSON.stringify({ theme })
  }),
  getWorkspaces: () => request('/api/projects'),
  switchWorkspace: (projectPath, options = {}) => request('/api/project/switch', {
    method: 'POST',
    body: JSON.stringify({ path: projectPath, projectPath, force: options.force })
  }),
  createWorkspace: (parentDir, name) => request('/api/create-workspace', {
    method: 'POST',
    body: JSON.stringify({ parentDir, name })
  }),
  // 在工作区内新建文件 / 目录，**不切换工作区**（+f / +d 专用）
  createItem: ({ kind = 'file', parent = '', name }) => request('/api/create-item', {
    method: 'POST',
    body: JSON.stringify({ kind, parent, name })
  }),
  browseDirs: (dirPath) => request(`/api/browse-dirs?dir=${encodeURIComponent(dirPath)}`),
  getStatus: () => request('/api/status')
};
