/**
 * NVW · 文件树（官方 ul[marker-=tree] + details[is-=accordion]）
 * 导出：createTree({ api, showToast, openPath, focusTerminal, home })
 *       → { load, setActive, reveal, setFilter, reset }
 * 约定：目录展开态只在同一工作区内保留；#category-list 的 data-scope 记录
 *       最近交互目录（新建文件/目录的相对前缀），由 app.js 读取。
 */

const NF = {
  folder: '\uf07b',
  file: '\uf15b',
  ext: {
    js: '\ue74e', mjs: '\ue74e', cjs: '\ue74e', jsx: '\ue7ba',
    ts: '\ue628', tsx: '\ue7ba',
    json: '\ue60b', jsonc: '\ue60b',
    md: '\uf48a', mdx: '\uf48a', txt: '\uf15c',
    css: '\ue749', scss: '\ue749', sass: '\ue74b', less: '\ue758',
    html: '\uf13b', htm: '\uf13b', vue: '\ufd42',
    py: '\ue73c', pyi: '\ue73c', ipynb: '\ue73c',
    lua: '\ue620', nvim: '\ue620', vim: '\ue62b',
    sh: '\uf489', bash: '\uf489', zsh: '\uf489', fish: '\uf489',
    yml: '\uf481', yaml: '\uf481', toml: '\ue6b2', ini: '\ue615', conf: '\ue615', env: '\ue615',
    png: '\uf1c5', jpg: '\uf1c5', jpeg: '\uf1c5', gif: '\uf1c5', svg: '\uf1c5', webp: '\uf1c5',
    pdf: '\uf1c1', log: '\uf18d', lock: '\uf023', sql: '\uf1c0', db: '\uf1c0',
    rs: '\ue7a8', go: '\ue627', rb: '\ue739', php: '\ue73d',
    c: '\ue61e', h: '\ue61e', cpp: '\ue61d', hpp: '\ue61d', java: '\ue738', kt: '\ue634', swift: '\ue755'
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

const dirnameRel = rel => {
  const s = String(rel || '');
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i) : '';
};

function ancestorDirs(root, target) {
  const r = String(root).split('/').filter(Boolean);
  const t = String(target).split('/').filter(Boolean);
  const out = [];
  for (let i = r.length; i < t.length; i += 1) out.push('/' + t.slice(0, i).join('/'));
  return out;
}

export function createTree({ api, showToast, openPath, focusTerminal, home }) {
  const st = {
    root: '',
    roots: [],
    cache: new Map(),        // absDirPath -> nodes[]
    expanded: new Set(),     // absDirPath
    loading: new Set(),
    active: '',
    filter: '',
    index: null,             // 过滤索引（全量遍历一次，之后纯客户端过滤）
    indexToken: 0
  };

  const rootPath = () => (typeof home === 'function' ? home() : (home || ''));
  const listEl = () => document.getElementById('category-list');
  const filterEl = () => document.getElementById('treeFilter');
  const countEl = () => document.getElementById('treeCount');
  const rootEl = () => document.getElementById('explorerRoot');
  const keyOf = dir => dir || st.root || rootPath();

  function setRootLabel(p) {
    if (!p) return;
    st.root = p;
    const el = rootEl();
    if (el && el.textContent !== p) { el.textContent = p; el.title = p; }
  }

  async function fetchDir(dir) {
    const key = keyOf(dir);
    if (st.cache.has(key)) return st.cache.get(key);
    if (st.loading.has(key)) return st.cache.get(key) || [];
    st.loading.add(key);
    try {
      const res = await api.getFiles(key);
      if (res && res.project) setRootLabel(res.project);
      const nodes = (res && res.files) || [];
      st.cache.set(key, nodes);
      return nodes;
    } finally {
      st.loading.delete(key);
    }
  }

  async function hydrate(nodes) {
    for (const node of nodes || []) {
      if (node.type !== 'directory' || !st.expanded.has(node.path)) continue;
      let kids = st.cache.get(node.path);
      if (!kids) {
        try { kids = await fetchDir(node.path); } catch { kids = []; }
      }
      await hydrate(kids);
    }
  }

  const loadingHtml = () => '<li><span is-="spinner" variant-="dots" speed-="fast"></span></li>';

  function fileHtml(node) {
    const active = !!st.active && node.path === st.active;
    return `<a data-path="${esc(node.path)}" data-active="${active ? 'true' : 'false'}"` +
      ` title="${esc(node.relativePath || node.path)}" aria-label="${esc(node.name)}">` +
      `${fileIcon(node.name)} ${esc(node.name)}</a>`;
  }

  function nodeHtml(node) {
    if (node.type === 'directory') {
      const open = st.expanded.has(node.path);
      const kids = open ? (st.cache.has(node.path) ? renderNodes(st.cache.get(node.path)) : loadingHtml()) : '';
      return `<li><details is-="accordion"${open ? ' open' : ''} data-path="${esc(node.path)}">` +
        `<summary title="${esc(node.relativePath || node.name)}">${esc(node.name)}</summary>` +
        `<ul marker-="tree">${kids}</ul></details></li>`;
    }
    return `<li>${fileHtml(node)}</li>`;
  }

  function renderNodes(nodes) {
    if (!nodes || !nodes.length) return '';
    return nodes.map(nodeHtml).join('');
  }

  function renderFlat(q) {
    const hits = st.index.filter(e => e.rel.toLowerCase().includes(q)).slice(0, 400);
    if (!hits.length) return '<ul marker-="tree"><li><span is-="badge" variant-="foreground2">no match</span></li></ul>';
    const items = hits.map(e => {
      const dir = e.dir ? `<span is-="badge" variant-="background2">${esc(e.dir)}</span>` : '';
      const icon = e.type === 'directory' ? NF.folder : fileIcon(e.name);
      const active = !!st.active && e.path === st.active;
      return `<li><a data-path="${esc(e.path)}" data-active="${active ? 'true' : 'false'}"` +
        ` title="${esc(e.rel)}" aria-label="${esc(e.name)}">${icon} ${esc(e.name)}</a>${dir}</li>`;
    }).join('');
    return `<ul marker-="tree">${items}</ul>`;
  }

  function renderAll() {
    const el = listEl();
    if (!el) return;
    const q = st.filter.trim().toLowerCase();
    el.innerHTML = (q && st.index) ? renderFlat(q) : `<ul marker-="tree">${renderNodes(st.roots)}</ul>`;
    const c = countEl();
    if (c) c.textContent = String(el.querySelectorAll('li').length);
  }

  function paintActive() {
    const el = listEl();
    if (!el) return;
    el.querySelectorAll('a[data-path]').forEach(a => {
      a.setAttribute('data-active', String(!!st.active && a.dataset.path === st.active));
    });
  }

  function scrollToActive() {
    if (!st.active) return;
    let hit = null;
    listEl()?.querySelectorAll('a[data-path]').forEach(a => {
      if (!hit && a.dataset.path === st.active) hit = a;
    });
    if (hit) hit.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  async function buildIndex() {
    const token = ++st.indexToken;
    const root = st.root || rootPath();
    const out = [];
    const seen = new Set();
    const walk = async (dir, depth) => {
      if (token !== st.indexToken || depth > 10 || out.length > 4000 || seen.has(dir)) return;
      seen.add(dir);
      let nodes;
      try { nodes = await fetchDir(dir); } catch { return; }
      for (const n of nodes) {
        out.push({
          rel: n.relativePath || n.name,
          dir: dirnameRel(n.relativePath || n.name),
          name: n.name,
          path: n.path,
          type: n.type
        });
        if (n.type === 'directory') await walk(n.path, depth + 1);
      }
    };
    await walk(root, 0);
    if (token === st.indexToken) st.index = out;
  }

  function bind() {
    const el = listEl();
    if (!el || el.dataset.bound === '1') return;
    el.dataset.bound = '1';
    if (!el.dataset.scope) el.dataset.scope = '';

    el.addEventListener('click', async e => {
      const a = e.target.closest('a[data-path]');
      if (!a) return;
      e.preventDefault();
      const p = a.dataset.path;
      el.dataset.scope = dirnameRel(a.getAttribute('title') || '');
      st.active = p;
      paintActive();
      await openPath(p);
      focusTerminal?.();
    });

    // toggle 事件不冒泡，用捕获阶段接收
    el.addEventListener('toggle', async e => {
      const details = e.target;
      if (!details || details.tagName !== 'DETAILS' || !details.dataset.path) return;
      const p = details.dataset.path;
      if (!details.open) {
        // 用户收起目录也算「最近交互」；但重渲染/reset 引起的收拢不算
        if (st.expanded.delete(p)) {
          el.dataset.scope = details.querySelector('summary')?.getAttribute('title') || '';
        }
        return;
      }
      // 重渲染写入 open 属性同样会触发 toggle（规范如此）：此时 expanded 里已有该项，
      // 属于状态恢复而非用户操作 —— 不得改写 data-scope（否则新建目标会被别的目录顶掉）
      if (st.expanded.has(p)) return;
      st.expanded.add(p);
      el.dataset.scope = details.querySelector('summary')?.getAttribute('title') || '';
      if (st.cache.has(p)) return;
      const slot = details.querySelector(':scope > ul');
      if (slot) slot.innerHTML = loadingHtml();
      try {
        await fetchDir(p);
        if (slot && slot.isConnected) {
          slot.innerHTML = renderNodes(st.cache.get(p) || []);
          const c = countEl();
          if (c) c.textContent = String(el.querySelectorAll('li').length);
        }
      } catch (err) {
        st.expanded.delete(p);
        details.open = false;
        if (slot && slot.isConnected) slot.innerHTML = '';
        showToast(`目录读取失败: ${err.message}`, 'error');
      }
    }, true);

    filterEl()?.addEventListener('input', e => setFilter(e.target.value));
  }

  async function load() {
    try {
      const res = await api.getFiles();
      const project = (res && res.project) || rootPath();
      if (project && st.root && project !== st.root) {
        // 跨工作区：展开态/缓存/索引/index 全部丢弃，避免残留
        st.indexToken += 1;
        st.expanded.clear();
        st.index = null;
        st.filter = '';
        const f = filterEl();
        if (f) f.value = '';
        const el = listEl();
        if (el) el.dataset.scope = '';
      }
      setRootLabel(project);
      // 显式 load（工作区切换 / r 重载 / 新建后刷新）必须让已展开目录的缓存失效，
      // 否则新建的文件不会出现在展开目录里（旧实现只重拉根层）
      st.cache.clear();
      st.index = null;
      const nodes = (res && res.files) || [];
      st.cache.set(keyOf(project), nodes);
      st.roots = nodes;
      bind();
      await hydrate(st.roots);
      renderAll();
      if (st.active) await reveal(st.active, false);
    } catch (e) {
      showToast(`文件树加载失败: ${e.message}`, 'error');
    }
  }

  async function reveal(absPath, scroll = true) {
    const root = st.root || rootPath();
    if (!absPath || !root || !absPath.startsWith(root)) { paintActive(); return; }
    let changed = false;
    for (const dir of ancestorDirs(root, absPath)) {
      if (!st.expanded.has(dir)) { st.expanded.add(dir); changed = true; }
      if (!st.cache.has(dir)) {
        try { await fetchDir(dir); } catch { /* 无权限目录跳过 */ }
        changed = true;
      }
    }
    if (changed) { await hydrate(st.roots); renderAll(); } else { paintActive(); }
    if (scroll) scrollToActive();
  }

  async function setActive(absPath) {
    const p = absPath || '';
    if (p === st.active) { paintActive(); return; }
    st.active = p;
    if (!p || st.filter.trim()) { paintActive(); return; }
    await reveal(p, false);
  }

  function setFilter(text) {
    st.filter = String(text || '');
    renderAll();
    if (!st.filter.trim()) return;
    if (st.index) { renderAll(); return; }
    buildIndex().then(() => { if (st.filter.trim()) renderAll(); }).catch(() => {});
  }

  function reset() {
    st.indexToken += 1;
    st.expanded.clear();
    st.cache.clear();
    st.index = null;
    st.filter = '';
    const f = filterEl();
    if (f) f.value = '';
    renderAll();
  }

  return { load, setActive, reveal, setFilter, reset };
}
