#!/usr/bin/env node
/**
 * NVW · UX E2E (verifier-owned, W4)
 * ---------------------------------------------------------------
 * 真实浏览器验收：puppeteer-core + 本机 Playwright Chromium。
 * 契约真源：docs/UX-CONTRACT.md（§5 验收清单）。
 *
 * 用法：
 *   node tests/test_ux_e2e.js                     # 截图 → docs/verification/ux/
 *   NVW_OUT=baseline node tests/test_ux_e2e.js    # 截图 → docs/verification/baseline/
 *   NVW_FULL=1 node tests/test_ux_e2e.js          # 追加会触碰 nvim 缓冲区的流程（开文件/标签页/切换工作区）
 *   NVW_STRICT=1 node tests/test_ux_e2e.js        # 有 fail 时 exit 1
 *
 * 纪律：
 *  - 不向终端输入任何内容（共享 nvim 会话），只点击 UI 控件。
 *  - 缺失元素 → 该项 fail，脚本继续，其余项照跑（基线可跑通）。
 *  - 所有结论都必须带截图路径或 DOM 数值证据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_NAME = process.env.NVW_OUT || 'ux';
const OUT_DIR = path.join(ROOT, 'docs/verification', OUT_NAME);
const BASE = process.env.NVW_BASE || 'http://127.0.0.1:4321';
const CHROME = process.env.NVW_CHROME ||
  '/Users/Katomoshi/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const FULL = process.env.NVW_FULL === '1';
const SKIP_WS_SWITCH = process.env.NVW_SKIP_WS_SWITCH === '1'; // dry-run FULL 时避免影响其他协作者
// Lead 已授权的受控终端输入（仅最终验收、仅无名 scratch buffer、不写盘）：i / scratch / Esc
const ALLOW_TERMINAL_INPUT = process.env.NVW_ALLOW_TERMINAL_INPUT === '1';
const STRICT = process.env.NVW_STRICT === '1';
const VIEWPORT = { width: 1440, height: 900 };

fs.mkdirSync(OUT_DIR, { recursive: true });

/* ------------------------------------------------------------------ 记录 */
let page;
let seq = 0;
const results = [];
const metrics = {};
const consoleErrors = [];
const pageErrors = [];
const badResponses = [];
const nativeDialogs = [];
let expectNetworkErrors = false; // 断线用例期间产生的网络错误属预期，单独归档
const testArtifacts = [];        // 本脚本创建的临时文件，收尾时清理
const testDirs = [];             // 本脚本创建的临时目录，收尾时清理
const baselineBufnrs = new Set(); // 运行开始时就存在的 nvim buffer —— 收尾时绝不关闭它们

class Skip extends Error {}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function shot(name) {
  const file = `${String(++seq).padStart(2, '0')}-${name.replace(/[^a-z0-9_-]+/gi, '_')}.png`;
  await page.screenshot({ path: path.join(OUT_DIR, file) });
  return `docs/verification/${OUT_NAME}/${file}`;
}

async function check(id, title, fn) {
  const evidence = [];
  const ctx = {
    shot: async n => { const p = await shot(n); evidence.push(p); return p; },
  };
  try {
    const detail = await fn(ctx);
    results.push({ id, title, status: 'pass', detail: detail ? String(detail) : '', evidence });
    console.log(`  PASS  ${id.padEnd(34)} ${title}${detail ? '  ::  ' + detail : ''}`);
  } catch (e) {
    const skipped = e instanceof Skip;
    const detail = String(e?.message || e);
    results.push({ id, title, status: skipped ? 'skip' : 'fail', detail, evidence });
    console.log(`  ${skipped ? 'SKIP' : 'FAIL'}  ${id.padEnd(34)} ${title}  ::  ${detail}`);
  }
}

/* -------------------------------------------------------------- DOM 工具 */
const $$ = sel => page.$(sel);
async function exists(sel) { return !!(await page.$(sel)); }
async function count(sel) { return page.$$eval(sel, els => els.length).catch(() => 0); }
async function text(sel) {
  return page.evaluate(s => document.querySelector(s)?.textContent?.replace(/\s+/g, ' ').trim() ?? null, sel);
}
async function attr(sel, a) {
  return page.evaluate((s, at) => document.querySelector(s)?.getAttribute(at) ?? null, sel, a);
}
async function visible(sel) {
  return page.evaluate(s => {
    const e = document.querySelector(s);
    if (!e) return false;
    const st = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    return !e.hidden && st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  }, sel);
}
async function clickSel(sel, desc) {
  const found = await page.waitForSelector(sel, { visible: true, timeout: 5000 }).catch(() => null);
  assert(found, `找不到可点击元素 ${sel}${desc ? `（${desc}）` : ''}`);
  await found.click();
}
async function dialogOpen(id) {
  return page.evaluate(i => {
    const d = document.getElementById(i);
    return !!d && (d.open === true || d.matches(':popover-open'));
  }, id);
}
async function openDialogProbe(id) {
  return page.evaluate(i => {
    const d = document.getElementById(i);
    if (!d) return false;
    if (d.open || d.matches(':popover-open')) return true;
    try { d.showModal(); return true; } catch { try { d.showPopover(); return true; } catch { return false; } }
  }, id);
}
async function closeAllOverlays() {
  await page.evaluate(() => {
    document.querySelectorAll('dialog[open]').forEach(d => { try { d.close(); } catch { /* noop */ } });
    document.querySelectorAll('[popover]:popover-open').forEach(p => { try { p.hidePopover(); } catch { /* noop */ } });
  });
}
/** 关闭所有浮层 + 退出 zen，把界面恢复到常规布局（避免上一条用例的副作用级联） */
async function resetUI() {
  for (let i = 0; i < 4; i++) {
    await closeAllOverlays();
    if (!await page.evaluate(() => { const t = document.getElementById('topbar'); return !!t && (t.hidden || getComputedStyle(t).display === 'none'); })) break;
    await page.keyboard.press('Escape');
    await sleep(250);
  }
  await sleep(120);
}
async function waitFor(fn, timeout = 6000, step = 120) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() - t0 > timeout) return false;
    await sleep(step);
  }
}
async function apiSession() {
  try {
    const r = await fetch(BASE + '/api/session');
    return await r.json();
  } catch { return null; }
}
function norm(s) { return String(s ?? '').replace(/[\s+]/g, '').toLowerCase(); }

/* ------------------------------------------------------------ KEYMAP 真源 */
function keymapFromDisk() {
  const p = path.join(ROOT, 'public/js/keymap.js');
  if (!fs.existsSync(p)) return null;
  const src = fs.readFileSync(p, 'utf8');
  const out = [];
  const blocks = src.match(/\{[^{}]*\}/g) || [];
  for (const b of blocks) {
    const id = b.match(/\bid\s*:\s*['"]([^'"]+)['"]/);
    const keys = b.match(/\bkeys\s*:\s*['"]([^'"]+)['"]/);
    if (!id || !keys) continue;
    const label = b.match(/\blabel\s*:\s*['"]([^'"]+)['"]/);
    const group = b.match(/\bgroup\s*:\s*['"]([^'"]+)['"]/);
    out.push({ id: id[1], keys: keys[1], label: label ? label[1] : null, group: group ? group[1] : null });
  }
  return out;
}

/* ------------------------------------------------------------------ 主流程 */
async function main() {
  console.log(`NVW UX E2E  →  ${BASE}   out=${path.relative(ROOT, OUT_DIR)}   full=${FULL}`);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900'],
    defaultViewport: VIEWPORT,
  });
  page = await browser.newPage();
  // 焦点仿真：新仲裁只让"前台"客户端决定 PTY 网格，而 headless 页面默认 document.hasFocus()=false
  // （app.js: focused = !document.hidden && document.hasFocus()）→ 必须显式开启，否则本页永远抢不到网格。
  try {
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  } catch (e) { console.warn('focus emulation unavailable:', e.message); }
  // 探针：CDP setOfflineMode 不会切断已建立的 WebSocket（见 docs/verification/tools/probe-disconnect.mjs），
  // 因此记录每个 WebSocket 实例，用真实的 socket.close() 复现"掉线"（服务端确实看到连接关闭）。
  await page.evaluateOnNewDocument(() => {
    const Orig = window.WebSocket;
    window.__nvwSockets = [];
    try {
      window.WebSocket = class NVWProbeSocket extends Orig {
        constructor(...a) { super(...a); window.__nvwSockets.push(this); }
      };
    } catch { window.WebSocket = Orig; }
  });

  page.on('console', m => {
    if (m.type() === 'error') consoleErrors.push({ text: m.text(), url: m.location()?.url || '', expected: expectNetworkErrors });
  });
  page.on('pageerror', e => pageErrors.push({
    text: String(e?.message || e),
    stack: String(e?.stack || '').split('\n').slice(0, 4).join(' | '),
    expected: expectNetworkErrors,
  }));
  page.on('response', r => {
    if (r.status() >= 400) badResponses.push({ status: r.status(), url: r.url(), expected: expectNetworkErrors });
  });
  page.on('dialog', async d => { nativeDialogs.push(`${d.type()}: ${d.message()}`); await d.dismiss().catch(() => {}); });

  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(1200);
  const startSession = await apiSession();
  (startSession?.buffers || []).forEach(b => baselineBufnrs.add(b.bufnr));
  try {
    const pj = await (await fetch(BASE + '/api/projects')).json();
    metrics.currentAtStart = pj.current;
    metrics.recentBefore = pj.recent || [];
  } catch { /* noop */ }
  await page.screenshot({ path: path.join(OUT_DIR, `${String(++seq).padStart(2, '0')}-00-boot.png`) });

  /* ============================ 1. 启动骨架 ============================ */
  await check('boot.shell', '页面骨架与网格渲染挂载', async ctx => {
    assert(await exists('#nvimTerminal'), '#nvimTerminal 不存在');
    assert(await exists('#topbar'), '#topbar 不存在');
    assert(await exists('#sidebar'), '#sidebar 不存在');
    assert(await exists('#statusline'), '#statusline 不存在');
    // 新架构：渲染面是 DOM 网格（一行一个节点），不再是 canvas/xterm
    const layers = await count('#nvimTerminal [data-nvw-layer]');
    const rows = await count('#nvimTerminal [data-nvw-layer] > div');
    assert(layers > 0, '网格渲染层未挂载到 #nvimTerminal');
    assert(rows > 5, `网格行数异常：${rows}`);
    assert(await exists('#nvimTerminal [data-nvw-cursor]'), '光标未渲染');
    await ctx.shot('boot-shell');
    return `title="${await page.title()}" 网格 ${rows} 行 / ${layers} 层 · 光标已挂载`;
  });
  await check('boot.favicon', 'favicon 存在且 200（无 404）', async ctx => {
    const href = await attr('head link[rel~="icon"]', 'href');
    assert(href, 'head 缺少 <link rel="icon">');
    const res = await fetch(new URL(href, BASE)).catch(() => null);
    assert(res && res.status === 200, `/favicon.svg 返回 ${res ? res.status : 'network error'}`);
    return `href=${href} status=200`;
  });

  await check('boot.topbar-affordances', '顶栏按钮齐全 + title/aria-label', async ctx => {
    const missing = [];
    for (const sel of ['#btnWorkspace', '#btnTheme', '#btnOpenSettings', '#btnOpenKeymap', '#search-button']) {
      if (!await exists(sel)) missing.push(sel);
    }
    assert(!missing.length, `缺少顶栏元素: ${missing.join(', ')}`);
    for (const sel of ['#btnWorkspace', '#btnTheme', '#btnOpenSettings', '#btnOpenKeymap', '#search-button']) {
      const t = await attr(sel, 'title');
      const a = await attr(sel, 'aria-label');
      assert(t && t.trim(), `${sel} 缺 title`);
      assert(a && a.trim(), `${sel} 缺 aria-label`);
    }
    const aSettings = await page.$eval('#btnOpenSettings', e => e.tagName.toLowerCase());
    const aKeymap = await page.$eval('#btnOpenKeymap', e => e.tagName.toLowerCase());
    assert(aSettings === 'button', `#btnOpenSettings 应为 button，实际 <${aSettings}>`);
    assert(aKeymap === 'button', `#btnOpenKeymap 应为 button，实际 <${aKeymap}>`);
    await ctx.shot('topbar');
    return 'workspace/theme/settings/docs/search 均含 title+aria-label';
  });

  await check('boot.hotkey-hints', '所有 [data-hotkey] 徽标非空', async ctx => {
    const rows = await page.$$eval('[data-hotkey]', els => els.map(e => ({
      id: e.dataset.hotkey, text: (e.textContent || '').trim(), tag: e.tagName.toLowerCase(),
    })));
    assert(rows.length > 0, '页面没有任何 [data-hotkey] 元素');
    const bad = rows.filter(r => !r.text || /undefined|null|\[object/i.test(r.text));
    assert(!bad.length, `空白/异常 hotkey 徽标: ${JSON.stringify(bad)}`);
    await ctx.shot('hotkey-badges');
    return rows.map(r => `${r.id}=${r.text}`).join(' ');
  });

  /* ============================ 2. 顶栏弹层 ============================ */
  await check('topbar.workspace-popover', '工作区弹层打开/Esc 关闭/提示行', async ctx => {
    await resetUI();
    const trigger = await exists('#btnWorkspace') ? '#btnWorkspace' : '[popovertarget="workspacePanel"]';
    await clickSel(trigger, '工作区按钮');
    assert(await waitFor(() => dialogOpen('workspacePanel')), '#workspacePanel 未打开');
    const items = await count('#recentProjectsList > *');
    const hint = await text('#workspacePanel');
    await ctx.shot('workspace-popover-open');
    assert(/Esc to close/i.test(hint || ''), '#workspacePanel 缺 "Esc to close" 提示行');
    assert(await exists('#btnOpenNewWorkspaceModal'), '缺 #btnOpenNewWorkspaceModal');
    await page.keyboard.press('Escape');
    assert(await waitFor(async () => !(await dialogOpen('workspacePanel'))), 'Esc 未关闭 #workspacePanel');
    await ctx.shot('workspace-popover-closed');
    return `recent=${items} 项；Esc 关闭成功`;
  });

  await check('topbar.theme-popover', '主题弹层打开 + 切主题生效 + Esc 关闭', async ctx => {
    await resetUI();
    const before = await attr('html', 'data-webtui-theme');
    const trigger = await exists('#btnTheme') ? '#btnTheme' : '[popovertarget="themePanel"]';
    await clickSel(trigger, '主题按钮');
    assert(await waitFor(() => dialogOpen('themePanel')), '#themePanel 未打开');
    const options = await count('#themePickerList button, #themePickerList [data-theme]');
    assert(options > 1, `主题选项过少: ${options}`);
    await ctx.shot('theme-popover-open');
    // 选一个与当前不同的主题
    const picked = await page.evaluate(current => {
      const btns = [...document.querySelectorAll('#themePickerList button, #themePickerList [data-theme]')];
      const target = btns.find(b => {
        const v = b.dataset.theme || b.getAttribute('data-theme') || b.textContent.trim();
        return v && v !== current;
      });
      if (!target) return null;
      target.click();
      return target.dataset.theme || target.getAttribute('data-theme') || target.textContent.trim();
    }, before);
    assert(picked, '找不到可切换的主题项');
    const changed = await waitFor(async () => (await attr('html', 'data-webtui-theme')) !== before, 5000);
    await ctx.shot('theme-switched');
    assert(changed, `点击主题 "${picked}" 后 data-webtui-theme 仍为 ${before}`);
    // 还原
    await page.evaluate(t => {
      const btns = [...document.querySelectorAll('#themePickerList button, #themePickerList [data-theme]')];
      const target = btns.find(b => (b.dataset.theme || b.getAttribute('data-theme') || b.textContent.trim()) === t);
      target?.click();
    }, before);
    await sleep(700);
    await page.keyboard.press('Escape');
    assert(await waitFor(async () => !(await dialogOpen('themePanel'))), 'Esc 未关闭 #themePanel');
    return `${before} → ${picked} → ${before}；Esc 关闭成功`;
  });

  /* ============================ 3. 查找弹窗 ============================ */
  const finderInfo = { opened: false, ms: null, selectionSupported: false, selectedPath: null };
  await check('finder.open-and-latency', '查找弹窗打开 + 出结果耗时 + 计数徽标', async ctx => {
    await resetUI();
    assert(await exists('#search-dialog'), '缺 #search-dialog');
    const t0 = Date.now();
    await clickSel('#search-button', '顶栏搜索按钮');
    assert(await waitFor(() => dialogOpen('search-dialog'), 4000), '#search-dialog 未打开');
    const got = await waitFor(async () => (await count('#search-results-container button[data-path]')) > 0, 20000, 100);
    finderInfo.ms = Date.now() - t0;
    metrics.finderFirstResultMs = finderInfo.ms;
    finderInfo.opened = true;
    assert(got, `${finderInfo.ms}ms 内未出现任何结果按钮`);
    await ctx.shot('finder-open');
    // 交互式过滤
    await page.click('#search-input');
    await page.type('#search-input', 'js', { delay: 20 });
    await sleep(400);
    const shown = await count('#search-results-container button[data-path]');
    assert(shown > 0, "输入 'js' 后 0 条结果");
    const total = await count('#search-results-container button[data-path]');
    const badge = await text('#search-count');
    await ctx.shot('finder-filtered');
    assert(badge !== null, `#search-count 计数徽标不存在（契约 §2.7）；打开→首结果 ${finderInfo.ms}ms，结果 ${total} 条`);
    assert(await exists('#searchSpinner'), '缺 #searchSpinner（契约 §2.7）');
    // 计数徽标里出现的数字必须与当前结果数一致（徽标文案可带 "showing N / M" 等包装）
    const numsOf = s => (String(s).match(/\d+/g) || []).map(Number);
    const counts = numsOf(badge);
    assert(counts.includes(total), `#search-count="${badge}" 未反映结果数 ${total}`);
    // 收窄查询 → 结果数减少，徽标必须跟着变（用 evaluate 清空，避免 clickCount 选中失效）
    await page.evaluate(() => {
      const i = document.getElementById('search-input');
      i.focus(); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(300);
    await page.type('#search-input', 'server', { delay: 20 });
    await sleep(500);
    const narrow = await count('#search-results-container button[data-path]');
    const badge2 = await text('#search-count');
    await ctx.shot('finder-narrowed');
    assert(narrow > 0 && narrow < total, `收窄到 'server' 后结果数异常（${total} → ${narrow}）`);
    assert(numsOf(badge2).includes(narrow), `结果数变为 ${narrow} 但 #search-count="${badge2}" 未同步`);
    return `打开→首结果 ${finderInfo.ms}ms；'js' → ${total} 条 (${badge})；'server' → ${narrow} 条 (${badge2})`;
  });

  await check('finder.keyboard-selection', '↑↓ 移动选中项（data-path 变化）', async ctx => {
    if (!finderInfo.opened) throw new Skip('查找弹窗未打开，依赖上一步');
    const sel = () => page.evaluate(() => {
      const btns = [...document.querySelectorAll('#search-results-container button[data-path]')];
      const i = btns.findIndex(b => b.getAttribute('variant-') === 'foreground0'
        || b.getAttribute('aria-selected') === 'true'
        || b.hasAttribute('data-selected')
        || /is-selected/.test(b.className));
      return { total: btns.length, index: i, path: i >= 0 ? btns[i].dataset.path : null };
    });
    let s0 = await sel();
    if (s0.total < 2) throw new Skip(`结果不足 2 条（${s0.total}），无法验证 ↑↓`);
    if (s0.index < 0) throw new Error('没有任何结果项被标记为选中（契约要求选中项 variant-="foreground0"）');
    finderInfo.selectionSupported = true;
    const first = s0.path;
    await page.keyboard.press('ArrowDown');
    await sleep(250);
    s0 = await sel();
    await ctx.shot('finder-after-arrowdown');
    assert(s0.index >= 0, 'ArrowDown 后选中项消失');
    assert(s0.path !== first, `ArrowDown 后选中项仍是同一条 (${first})`);
    const second = s0.path;
    await page.keyboard.press('ArrowUp');
    await sleep(250);
    const s2 = await sel();
    assert(s2.path === first, `ArrowUp 未回到上一项（期望 ${first}，实际 ${s2.path}）`);
    finderInfo.selectedPath = second;
    await page.keyboard.press('ArrowDown');
    await sleep(200);
    return `选中项 ${first} → ${second} → ${first}（index=${s2.index}）`;
  });

  await check('finder.enter-opens-selected', 'Enter 打开的是选中项', async ctx => {
    if (!finderInfo.selectionSupported) throw new Skip('选中项机制尚未实现，依赖上一步');
    if (!FULL) throw new Skip('基线运行不打开文件（避免影响共享 nvim 会话）；用 NVW_FULL=1 执行');
    const selected = finderInfo.selectedPath;
    assert(selected, '没有记录到选中项');
    await page.keyboard.press('Enter');
    const closed = await waitFor(async () => !(await dialogOpen('search-dialog')), 4000);
    await sleep(1200);
    const s = await apiSession();
    const openedName = s?.status?.name || '';
    await ctx.shot('finder-enter-opened');
    assert(closed, 'Enter 后 #search-dialog 未关闭');
    assert(openedName && path.basename(selected) === path.basename(openedName),
      `Enter 打开的 buffer 是 "${openedName}"，而选中项是 "${path.basename(selected)}"`);
    return `选中 ${path.basename(selected)} → 打开 ${path.basename(openedName)}`;
  });

  await check('finder.esc-closes', 'Esc 关闭查找弹窗', async ctx => {
    if (!finderInfo.opened) throw new Skip('查找弹窗未打开，依赖前面的步骤');
    if (!await dialogOpen('search-dialog')) await clickSel('#search-button', '顶栏搜索按钮');
    assert(await waitFor(() => dialogOpen('search-dialog'), 4000), '无法重新打开 #search-dialog');
    await page.keyboard.press('Escape');
    assert(await waitFor(async () => !(await dialogOpen('search-dialog'))), 'Esc 未关闭 #search-dialog');
    await ctx.shot('finder-esc-closed');
    return 'Esc 关闭成功';
  });

  /* ============================ 4. 设置 / 文档 ============================ */
  await check('settings.dialog', '设置弹窗：分组/Reset/控件/Esc', async ctx => {
    await resetUI();
    await clickSel('#btnOpenSettings', 'Settings 按钮');
    assert(await waitFor(() => dialogOpen('settingsDialog')), '#settingsDialog 未打开');
    await ctx.shot('settings-open');
    const controls = ['#settingFontSizeRange', '#settingLineHeightRange', '#settingCursorBlink', '#btnSaveSettings'];
    for (const c of controls) assert(await exists(c), `设置弹窗缺控件 ${c}`);
    assert(await exists('#btnResetSettings'), '缺 #btnResetSettings（契约 §2.9）');
    const groups = await count('#settingsDialog label');
    await page.keyboard.press('Escape');
    assert(await waitFor(async () => !(await dialogOpen('settingsDialog'))), 'Esc 未关闭 #settingsDialog');
    await ctx.shot('settings-closed');
    return `控件齐全，label=${groups}，Reset 存在，Esc 关闭成功`;
  });

  await check('docs.keymap-table-matches-KEYMAP', '文档表 === KEYMAP 真源（磁盘/运行时/DOM 三方一致）', async ctx => {
    await resetUI();
    await clickSel('#btnOpenKeymap', 'Docs 按钮');
    assert(await waitFor(() => dialogOpen('keymapDialog')), '#keymapDialog 未打开');
    assert(await exists('#keymapTableBody'), '缺 <tbody id="keymapTableBody">（契约 §2.9）');
    const domRows = await page.$$eval('#keymapTableBody tr', trs => trs.map(tr => {
      const cells = [...tr.querySelectorAll('td,th')].map(td => td.textContent.replace(/\s+/g, ' ').trim());
      return cells;
    }));
    assert(domRows.length > 0, '#keymapTableBody 是空的（未由 KEYMAP 生成）');
    let runtime = null, runtimeFmt = null, runtimeErr = null;
    try {
      const m = await page.evaluate(async () => {
        const mod = await import('/js/keymap.js');
        return {
          KEYMAP: mod.KEYMAP || null,
          sample: typeof mod.formatKeys === 'function' ? mod.formatKeys('Mod+K') : null,
        };
      });
      runtime = m.KEYMAP;
      runtimeFmt = m.sample;
    } catch (e) { runtimeErr = e.message; }
    const disk = keymapFromDisk();
    await ctx.shot('docs-keymap');
    assert(runtime, `无法从页面导入 /js/keymap.js 的 KEYMAP: ${runtimeErr || 'export 缺失'}`);
    assert(disk, 'public/js/keymap.js 不存在或无法解析出 KEYMAP');
    // 磁盘 vs 运行时
    assert(disk.length === runtime.length, `磁盘 KEYMAP=${disk.length} 条，运行时=${runtime.length} 条（服务端文件不同步？）`);
    for (let i = 0; i < disk.length; i++) {
      assert(disk[i].id === runtime[i].id && disk[i].keys === runtime[i].keys,
        `第 ${i + 1} 条 磁盘(${disk[i].id}/${disk[i].keys}) ≠ 运行时(${runtime[i].id}/${runtime[i].keys})`);
    }
    // 运行时 vs DOM
    assert(domRows.length === runtime.length, `KEYMAP=${runtime.length} 条，文档表=${domRows.length} 行`);
    const fmt = await page.evaluate(async keys => {
      const mod = await import('/js/keymap.js');
      if (typeof mod.formatKeys === 'function') return keys.map(k => mod.formatKeys(k));
      return null;
    }, runtime.map(e => e.keys));
    assert(fmt, 'keymap.js 未导出 formatKeys（契约 §3.3）');
    const table = runtime.map((e, i) => ({ i, id: e.id, keys: e.keys, label: e.label, fmt: fmt[i], dom: domRows[i] }));
    const badKeys = table.filter(r => norm(r.dom[0]) !== norm(r.fmt));
    const badLabel = table.filter(r => r.label && !r.dom[1]?.includes(r.label));
    await page.keyboard.press('Escape');
    assert(await waitFor(async () => !(await dialogOpen('keymapDialog'))), 'Esc 未关闭 #keymapDialog');
    assert(!badKeys.length, `按键列不一致: ${badKeys.map(r => `[${r.id}] 期望"${r.fmt}" 实际"${r.dom[0]}"`).join('; ')}`);
    assert(!badLabel.length, `动作列不一致: ${badLabel.map(r => `[${r.id}] 期望含"${r.label}" 实际"${r.dom[1]}"`).join('; ')}`);
    return `${runtime.length} 条 × 3 方一致；formatKeys('Mod+K')=${runtimeFmt}`;
  });

  /* ==================== 4.5 快捷键派发（KEYMAP 真的接上了） ==================== */
  await check('hotkeys.dispatch-core', 'KEYMAP 核心快捷键真实触发对应动作', async ctx => {
    const results9 = [];
    const chord = async keys => {
      for (const k of keys) await page.keyboard.down(k);
      for (const k of [...keys].reverse()) await page.keyboard.up(k);
    };
    const failed = [];
    const step = async (name, keys, verify, opts = {}) => {
      if (opts.reset !== false) await resetUI();
      await chord(keys);
      const ok = await waitFor(verify, 2500, 100);
      results9.push(`${name}=${ok ? 'ok' : 'FAIL'}`);
      if (!ok) failed.push(name);
      await sleep(150);
    };

    await step('Mod+K→查找', ['Meta', 'k'], () => dialogOpen('search-dialog'));
    // zen 两步必须背靠背：resetUI() 会按 Esc 退出 zen，会掩盖"第二次 Mod+B 退出 zen"的真实行为
    await resetUI();
    await step('Mod+B→zen', ['Meta', 'b'], async () => !(await visible('#topbar')), { reset: false });
    await step('Mod+B→退出 zen', ['Meta', 'b'], async () => await visible('#topbar'), { reset: false });
    await step('Mod+,→设置', ['Meta', ','], () => dialogOpen('settingsDialog'));
    await step('Mod+/→文档', ['Meta', '/'], () => dialogOpen('keymapDialog'));
    await step('Mod+Shift+F→树过滤焦点', ['Meta', 'Shift', 'f'],
      () => page.evaluate(() => document.activeElement?.id === 'treeFilter'));
    await step('Mod+J→终端聚焦', ['Meta', 'j'],
      () => page.evaluate(() => !!document.activeElement?.closest?.('#nvimTerminal')));
    const socks0 = await page.evaluate(() => (window.__nvwSockets || []).length);
    await step('Mod+Alt+R→重连', ['Meta', 'Alt', 'r'], async () =>
      (await page.evaluate(() => (window.__nvwSockets || []).length)) > socks0);
    await resetUI();
    await ctx.shot('hotkeys-core');
    assert(!failed.length, `以下快捷键未触发动作: ${failed.join(', ')}（明细 ${results9.join(' ')}）`);
    return results9.join(' ');
  });

  await check('hotkeys.dispatch-editor', '编辑器快捷键：新建/切换/关闭 buffer', async ctx => {
    if (!FULL) throw new Skip('涉及真实 buffer 操作；用 NVW_FULL=1 执行');
    const failed = [];
    const out = [];
    const chord = async keys => {
      for (const k of keys) await page.keyboard.down(k);
      for (const k of [...keys].reverse()) await page.keyboard.up(k);
    };
    await resetUI();
    const bufnrOf = async () => (await apiSession())?.buffers?.find(b => b.active)?.bufnr ?? null;
    const n0 = (await apiSession())?.buffers?.length ?? 0;
    await chord(['Meta', 'Alt', 'n']);
    const grown = await waitFor(async () => ((await apiSession())?.buffers?.length ?? 0) > n0, 5000);
    out.push(`Mod+Alt+N 新建 buffer=${grown ? 'ok' : 'FAIL'}`);
    if (!grown) failed.push('Mod+Alt+N');
    await sleep(800);
    const before = await bufnrOf();
    await chord(['Alt', 'ArrowDown']);
    const moved = await waitFor(async () => (await bufnrOf()) !== before, 4000);
    out.push(`Alt+↓ 下一个 buffer=${moved ? 'ok' : 'FAIL'}`);
    if (!moved) failed.push('Alt+ArrowDown');
    await sleep(500);
    const before2 = await bufnrOf();
    await chord(['Alt', 'ArrowUp']);
    const back = await waitFor(async () => (await bufnrOf()) !== before2, 4000);
    out.push(`Alt+↑ 上一个 buffer=${back ? 'ok' : 'FAIL'}`);
    if (!back) failed.push('Alt+ArrowUp');
    await ctx.shot('hotkeys-editor');
    await resetUI();
    assert(!failed.length, `编辑器快捷键未生效: ${failed.join(', ')}（${out.join(' ')}）`);
    return out.join(' ');
  });

  /* ============================ 5. 文件树 ============================ */
  await check('ui.search-count-no-truncation', '查找状态行不被省略号截断（scrollWidth<=clientWidth+1）', async ctx => {
    await resetUI();
    await clickSel('#search-button', '顶栏搜索按钮');
    assert(await waitFor(() => dialogOpen('search-dialog'), 4000), '#search-dialog 未打开');
    assert(await waitFor(async () => (await count('#search-results-container button[data-path]')) > 0, 20000, 100),
      '查找无结果，无法测量状态行');
    await sleep(300);
    const m = await page.evaluate(() => {
      const el = document.getElementById('search-count');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        text: el.textContent.trim(), sw: el.scrollWidth, cw: el.clientWidth,
        sh: el.scrollHeight, ch: el.clientHeight,
        overflow: cs.overflow, textOverflow: cs.textOverflow, whiteSpace: cs.whiteSpace,
        rect: Math.round(el.getBoundingClientRect().width),
      };
    });
    await ctx.shot('search-count-fit');
    assert(m, '缺 #search-count');
    // Lead 裁定 3.1：不得被省略号截断 → 横向不得溢出；文本必须是 "N / M"(+ 表示 truncated)，不带 "showing"
    assert(m.sw <= m.cw + 1, `#search-count 被截断："${m.text}" scrollWidth=${m.sw} > clientWidth=${m.cw}（text-overflow=${m.textOverflow}）`);
    assert(!/…|\.\.\./.test(m.text), `#search-count 文本里出现省略号："${m.text}"`);
    assert(/^\d+\s*\/\s*\d+\+?$/.test(m.text.trim()), `#search-count 文本格式应为 "N / M"，实际 "${m.text}"`);
    assert(!/showing/i.test(m.text), `#search-count 仍带 "showing" 前缀："${m.text}"`);
    // 纵向仅作参考：徽标是 1lh 盒，字体度量上 2px 差属正常，只有真正 overflow:hidden 裁切才算失败
    if (/hidden/.test(m.overflow) && m.sh > m.ch + 4) {
      throw new Error(`#search-count 纵向被裁切 scrollHeight=${m.sh} > clientHeight=${m.ch}（overflow=${m.overflow}）`);
    }
    await page.keyboard.press('Escape');
    await waitFor(async () => !(await dialogOpen('search-dialog')), 3000);
    return `"${m.text}" 横向 ${m.sw}/${m.cw}px，纵向 ${m.sh}/${m.ch}px（overflow=${m.overflow}），无截断`;
  });

  await check('ui.sidebar-scrollbar-theme', '侧栏滚动条主题一致（scrollbar-color 非 auto）', async ctx => {
    await resetUI();
    // 尽量制造溢出：展开若干目录
    const dirs = await page.$$('#category-list details[data-path]');
    for (const d of dirs.slice(0, 3)) { await d.click().catch(() => {}); await sleep(350); }
    await sleep(400);
    const m = await page.evaluate(() => {
      const list = document.getElementById('category-list');
      const wrap = document.getElementById('category-container');
      const target = list || wrap;
      const cs = getComputedStyle(target);
      const csWrap = wrap ? getComputedStyle(wrap) : null;
      return {
        hasList: !!list,
        scrollbarColor: cs.scrollbarColor,
        wrapScrollbarColor: csWrap ? csWrap.scrollbarColor : null,
        scrollH: target.scrollHeight, clientH: target.clientHeight,
        overflowing: target.scrollHeight > target.clientHeight + 2,
        overflowY: cs.overflowY,
      };
    });
    await ctx.shot('sidebar-scrollbar');
    assert(m.scrollbarColor !== 'auto' && m.scrollbarColor !== '',
      `#category-list 的 scrollbar-color=${m.scrollbarColor}（auto=跟随系统亮色滚动条）`);
    return `scrollbar-color=${m.scrollbarColor}；overflowY=${m.overflowY}；溢出=${m.overflowing}（${m.scrollH}/${m.clientH}）`;
  });

  await check('ui.editor-header-dedup', '编辑器头部去重：左组徽标≤2 + 分组分隔符', async ctx => {
    await resetUI();
    const m = await page.evaluate(() => {
      const header = document.querySelector('#editorArticle > header') || document.querySelector('#editorArticle header');
      if (!header) return { error: 'no header' };
      const right = document.getElementById('editor-header-right');
      const left = header.firstElementChild;
      const badges = left ? [...left.querySelectorAll('[is-="badge"]')] : [];
      const rect = el => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) }; };
      const seps = [...header.querySelectorAll('[is-="separator"]')].map(e => ({ ...rect(e), text: e.textContent.trim().slice(0, 12) }));
      const tabs = document.getElementById('buffer-tabs');
      return {
        leftText: left ? left.textContent.replace(/\s+/g, ' ').trim() : null,
        badgeCount: badges.length,
        badgeIds: badges.map(b => b.id || b.querySelector('[id]')?.id || '(no-id)'),
        leftRect: left ? rect(left) : null,
        rightRect: right ? rect(right) : null,
        tabsRect: tabs ? rect(tabs) : null,
        seps,
      };
    });
    await ctx.shot('editor-header');
    assert(!m.error, '找不到编辑器 header');
    assert(m.badgeCount === 2, `编辑器头部左组徽标 ${m.badgeCount} 个（应为恰好 2 个）：${m.badgeIds.join(',')} "${m.leftText}"`);
    assert(m.badgeIds.length === 2 && m.badgeIds.includes('activeDocTitle') && m.badgeIds.includes('activeDocPath'),
      `头部左组徽标应为 [#activeDocTitle, #activeDocPath]，实际 [${m.badgeIds.join(',')}]`);
    assert(m.seps.length > 0, '编辑器头部找不到 is-="separator"（tab strip 与左侧组之间缺分隔）');
    const between = m.tabsRect
      ? m.seps.some(s => s.r <= m.tabsRect.l + 2 && s.l >= (m.leftRect?.r ?? 0) - 60)
      : true;
    assert(between, `分隔符位置不在左侧组与 tab strip 之间：seps=${JSON.stringify(m.seps)} left=${JSON.stringify(m.leftRect)} tabs=${JSON.stringify(m.tabsRect)}`);
    return `左组 ${m.badgeCount} 个徽标 [${m.badgeIds.join(',')}]；separator ${m.seps.length} 个`;
  });

  /* ============================ 5b. 文件树过滤 ============================ */
  await check('tree.filter', '文件树过滤：输入减少 / 清空恢复', async ctx => {
    await resetUI();
    assert(await exists('#treeFilter'), '缺 #treeFilter（契约 §2.4）');
    assert(await exists('#treeCount'), '缺 #treeCount（契约 §2.4）');
    const total = await count('#category-list a[data-path], #category-list details[data-path]');
    assert(total > 1, `文件树节点过少: ${total}`);
    await page.click('#treeFilter');
    await page.type('#treeFilter', 'zzz-no-such-node-zzz', { delay: 10 });
    await sleep(350);
    const filtered = await page.$$eval('#category-list a[data-path], #category-list details[data-path]',
      els => els.filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length);
    await ctx.shot('tree-filtered');
    assert(filtered < total, `过滤后可见节点数未减少（${total} → ${filtered}）`);
    await page.evaluate(() => { const i = document.getElementById('treeFilter'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(350);
    const restored = await page.$$eval('#category-list a[data-path], #category-list details[data-path]',
      els => els.filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length);
    await ctx.shot('tree-filter-cleared');
    assert(restored === total, `清空过滤后节点数 ${restored} ≠ 原 ${total}`);
    const badge = await text('#treeCount');
    assert(badge !== null && String(badge).trim() !== '', '#treeCount 为空');
    return `${total} → ${filtered} → ${restored}；#treeCount=${badge}`;
  });

  await check('tree.expand-collapse', '文件树展开目录 + Collapse all', async ctx => {
    const dir = await page.$('#category-list details[data-path]');
    assert(dir, '文件树里没有可展开的目录');
    await dir.click();
    await sleep(600);
    const opened = await page.$eval('#category-list details[data-path]', d => d.open);
    await ctx.shot('tree-expanded');
    assert(opened, '点击目录后未展开');
    if (await exists('#btnCollapseAll')) {
      await clickSel('#btnCollapseAll', 'Collapse all');
      await sleep(400);
      const anyOpen = await page.$$eval('#category-list details[data-path]', ds => ds.some(d => d.open));
      await ctx.shot('tree-collapsed');
      assert(!anyOpen, 'Collapse all 后仍有目录处于展开态');
      return '展开成功；Collapse all 生效';
    }
    return '展开成功（#btnCollapseAll 尚未实现）';
  });

  /* ---- #category-list[data-scope]（新建目标目录）语义 + 重渲染漂移回归 ---- */
  await check('tree.scope-no-drift', '#category-list data-scope 语义 + 重渲染不漂移', async ctx => {
    await resetUI();
    const scopeOf = () => page.evaluate(() => document.getElementById('category-list')?.dataset.scope ?? null);
    const expand = rel => page.evaluate(p => {
      const d = [...document.querySelectorAll('#category-list details[data-path]')].find(x => x.dataset.path === p);
      if (!d) return false;
      if (!d.open) d.querySelector('summary')?.click();
      return true;
    }, rel);
    const collapse = rel => page.evaluate(p => {
      const d = [...document.querySelectorAll('#category-list details[data-path]')].find(x => x.dataset.path === p);
      if (!d) return false;
      if (d.open) d.querySelector('summary')?.click();
      return true;
    }, rel);

    assert(await exists('#category-list'), '缺 #category-list');
    const rels = await page.$$eval('#category-list details[data-path]', ds => ds.map(d => d.dataset.path));
    assert(rels.length >= 2, `可展开目录不足 2 个：${JSON.stringify(rels)}`);
    const [d1abs, d2abs] = rels;
    // 契约语义是**相对**路径（与 scopeDir() / #newItemHint="./bin/" 一致）
    const d1 = path.relative(ROOT, d1abs), d2 = path.relative(ROOT, d2abs);

    assert(await expand(d1abs), `无法展开 ${d1abs}`);
    await sleep(600);
    const s1 = await scopeOf();
    await ctx.shot('tree-scope-expand');
    assert(s1 === d1, `展开 ${d1} 后 data-scope="${s1}"，期望相对路径 "${d1}"`);

    if (FULL) {
      // 点该目录内的文件 → scope 应为该文件所在目录（相对）
      const inside = await page.$(`#category-list a[data-path^="${d1}/"]`);
      if (inside) {
        const title = await page.evaluate(el => el.getAttribute('title') || el.dataset.path, inside);
        const expectDir = path.relative(ROOT, path.dirname(title));
        await inside.click();
        await sleep(1800);
        const sFile = await scopeOf();
        await ctx.shot('tree-scope-file');
        assert(sFile === expectDir, `在 ${d1} 内点文件后 data-scope="${sFile}"，期望 "${expectDir}"`);
      }
    }

    assert(await expand(d2abs), `无法展开 ${d2abs}`);
    await sleep(600);
    assert((await scopeOf()) === d2, `展开 ${d2} 后 data-scope="${await scopeOf()}"，期望 "${d2}"`);

    // 关键回归：收起 d1（用户操作，scope=d1）后触发整树重渲染，
    // 恢复展开态产生的 toggle 事件不得改写 scope（否则会漂到 d2）
    assert(await collapse(d1abs), `无法收起 ${d1abs}`);
    await sleep(500);
    const sUser = await scopeOf();
    assert(sUser === d1, `收起 ${d1} 后 data-scope="${sUser}"，期望 "${d1}"`);
    await page.evaluate(() => document.getElementById('nav-btn-refresh')?.click());
    await sleep(1500);
    const sAfter = await scopeOf();
    await ctx.shot('tree-scope-after-rerender');
    assert(sAfter === d1, `重渲染后 data-scope 漂移为 "${sAfter}"（期望保持用户最后交互的 "${d1}"）—— 即 toggle 恢复态改写了 scope`);

    // Lead 追加的反向断言：走真实交互路径 ⌘⇧F（聚焦过滤框 → 输入 → 清空，全程重渲染），
    // scope 必须仍等于用户最后一次展开/收起产生的值，不能是重渲染意外写入的
    await page.keyboard.down('Meta');
    await page.keyboard.down('Shift');
    await page.keyboard.down('f');
    await page.keyboard.up('f');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Meta');
    const focused = await waitFor(() => page.evaluate(() => document.activeElement?.id === 'treeFilter'), 2500, 100);
    assert(focused, '⌘⇧F 未聚焦 #treeFilter');
    await page.keyboard.type('nvw', { delay: 30 });
    await sleep(500);
    const sFiltered = await scopeOf();
    await ctx.shot('tree-scope-after-hotkey-filter');
    assert(sFiltered === d1, `⌘⇧F 过滤期间 data-scope 被改写为 "${sFiltered}"（期望 "${d1}"）`);
    await page.evaluate(() => {
      const i = document.getElementById('treeFilter');
      i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(500);
    const sCleared = await scopeOf();
    assert(sCleared === d1, `清空过滤后 data-scope 变为 "${sCleared}"（期望 "${d1}"）`);
    return `展开 ${d1}→"${s1}"；展开 ${d2}→"${d2}"；收起 ${d1}→"${d1}"；重渲染后 "${sAfter}"；⌘⇧F 过滤后 "${sCleared}"，全程无漂移`;
  });

  /* ============================ 6. 新建文件 ============================ */
  await check('newitem.create-file', '新建文件：Hint 指向的目录 + 真实落盘 + 树刷新 + toast', async ctx => {
    await resetUI();
    const name = `nvw-verify-${Date.now()}.txt`;
    await clickSel('#nav-btn-new-file', 'New file 按钮');
    assert(await waitFor(() => dialogOpen('newItemDialog')), '#newItemDialog 未打开');
    assert(await exists('#newItemHint'), '缺 #newItemHint（契约 §2.9）');
    // #newItemHint 形如 "./bin/"，是 app 自己声明的落盘目录 → 用它反推期望路径（可失败：hint 与实际不符即失败）
    const hint = (await text('#newItemHint')) || '';
    const scope = hint.replace(/^\.\/?/, '').replace(/\/$/, '').trim();
    const expected = scope ? path.join(ROOT, scope, name) : path.join(ROOT, name);
    await page.click('#inputNewItemName');
    await page.type('#inputNewItemName', name, { delay: 10 });
    await ctx.shot('newitem-filled');
    await clickSel('#btnConfirmNewItem', 'Create');
    const created = await waitFor(() => fs.existsSync(expected), 6000);
    await sleep(600);
    await ctx.shot('newitem-created');
    assert(created, `确认后 ${name} 未出现在 hint 所指目录 (${path.relative(ROOT, expected)})`);
    testArtifacts.push(expected);
    const inTree = await waitFor(async () => (await count(`#category-list [title*="${name}"]`)) > 0, 5000);
    const toast = await count('#toastList > *');
    await ctx.shot('newitem-tree-toast');
    assert(inTree, `新建文件 ${name} 未出现在文件树`);
    assert(toast > 0, '新建成功后没有 toast');
    await page.evaluate(() => document.getElementById('nav-btn-refresh')?.click());
    await sleep(800);
    return `hint="${hint}" → 落盘 ${path.relative(ROOT, expected)}；树已刷新；toast=${toast}`;
  });

  /* ---- Lead review 发现的缺陷回归：+d 不得切换工作区 / 不得污染 recentProjects ---- */
  await check('newitem.create-dir-no-side-effects', '新建目录：落盘 + 不切换工作区 + 不污染 recent', async ctx => {
    await resetUI();
    const projects = async () => {
      try { return await (await fetch(BASE + '/api/projects')).json(); } catch { return null; }
    };
    const p0 = await projects();
    assert(p0?.current, '无法读取 /api/projects');
    const recentBefore = JSON.stringify(p0?.recent || []);
    const rootBefore = await text('#explorerRoot');
    const dirName = `nvw-verify-dir-${Date.now()}`;

    await clickSel('#nav-btn-new-folder', 'New directory 按钮');
    assert(await waitFor(() => dialogOpen('newItemDialog')), '#newItemDialog 未打开');
    const hint = (await text('#newItemHint')) || '';
    const scope = hint.replace(/^\.\/?/, '').replace(/\/$/, '').trim();
    const expectedDir = scope ? path.join(ROOT, scope, dirName) : path.join(ROOT, dirName);
    await page.click('#inputNewItemName');
    await page.type('#inputNewItemName', dirName, { delay: 10 });
    await ctx.shot('newdir-filled');
    await clickSel('#btnConfirmNewItem', 'Create');
    const created = await waitFor(() => fs.existsSync(expectedDir) && fs.statSync(expectedDir).isDirectory(), 6000);
    await sleep(1200);
    const p1 = await projects();
    const rootAfter = await text('#explorerRoot');
    const inTree = await waitFor(async () => (await count(`#category-list [title*="${dirName}"]`)) > 0, 5000);
    await ctx.shot('newdir-created');
    assert(created, `确认后目录未落盘：${path.relative(ROOT, expectedDir)}`);
    assert(p1?.current === p0.current,
      `新建目录把工作区切换了：${p0.current} → ${p1?.current}（旧实现走 createWorkspace 的副作用）`);
    assert(rootAfter === rootBefore, `#explorerRoot 变了："${rootBefore}" → "${rootAfter}"`);
    assert(inTree, `新建目录 ${dirName} 未出现在文件树`);
    await sleep(600);
    const p2 = await projects();
    // 断言"这次操作没有改动 recent"，而不是断言 recent 的绝对值 ——
    // 绝对值取决于本机历史（recent 是用户级状态），在共享环境里必然抖动。
    assert(JSON.stringify(p2?.recent || []) === recentBefore,
      `新建目录改动了 recent：${recentBefore} → ${JSON.stringify(p2?.recent || [])}`);
    const polluted = (p2?.recent || []).filter(p => p.includes(dirName) || p === expectedDir);
    assert(!polluted.length, `recent 被新建目录污染：${polluted.join(', ')}`);
    // 收尾：删除测试目录并刷新
    testDirs.push(expectedDir);
    await page.evaluate(() => document.getElementById('nav-btn-refresh')?.click());
    await sleep(700);
    return `落盘 ${path.relative(ROOT, expectedDir)}；工作区保持 ${p1?.current}；recent 未变（${(p2?.recent || []).length} 项），无污染`;
  });

  /* ---- /api/create-item 语义守卫（Lead 新增端点：不切工作区 / 越权 403 / 重复 409） ---- */
  await check('api.create-item-guards', 'create-item：400/403/409 + 不切工作区、不污染 recent', async ctx => {
    const projects = async () => (await (await fetch(BASE + '/api/projects')).json());
    const post = async body => {
      const r = await fetch(BASE + '/api/create-item', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const p0 = await projects();
    const name = `nvw-verify-api-${Date.now()}.txt`;
    const empty = await post({ kind: 'file', name: '' });
    assert(empty.status === 400, `空名称应 400，实际 ${empty.status}`);
    const escape = await post({ kind: 'dir', name: '../nvw-verify-escape' });
    assert(escape.status === 403, `越权路径应 403，实际 ${escape.status}（${JSON.stringify(escape.body)}）`);
    assert(!fs.existsSync(path.resolve(ROOT, '..', 'nvw-verify-escape')), '越权创建竟然落盘了（403 失效）');
    const ok = await post({ kind: 'file', name });
    assert(ok.status === 200 && ok.body.success, `正常创建应 200，实际 ${ok.status} ${JSON.stringify(ok.body)}`);
    const target = path.join(ROOT, name);
    testArtifacts.push(target);
    assert(fs.existsSync(target), `200 响应但文件未落盘：${name}`);
    const dup = await post({ kind: 'file', name });
    assert(dup.status === 409, `重复创建应 409，实际 ${dup.status}`);
    await sleep(400);
    const p1 = await projects();
    await ctx.shot('create-item-guards');
    assert(p1.current === p0.current, `create-item 改变了工作区：${p0.current} → ${p1.current}`);
    assert(!(p1.recent || []).some(x => x.includes('nvw-verify')), `recent 被污染：${JSON.stringify(p1.recent)}`);
    return `400/403/409 正确；创建后 current=${p1.current} 未变；recent 无污染`;
  });

  /* ============================ 7. 目录浏览器 ============================ */
  await check('wsbrowser.navigate', '目录浏览器：进入子目录 → ↑ 返回', async ctx => {
    await resetUI();
    // 必须先在顶栏打开工作区弹层，Browse… 才可点
    const trigger = await exists('#btnWorkspace') ? '#btnWorkspace' : '[popovertarget="workspacePanel"]';
    await clickSel(trigger, '工作区按钮');
    assert(await waitFor(() => dialogOpen('workspacePanel')), '#workspacePanel 未打开');
    await clickSel('#btnOpenNewWorkspaceModal', 'Browse…');
    const browserId = await exists('#workspaceBrowserDialog') ? 'workspaceBrowserDialog' : 'workspaceModal';
    assert(await waitFor(() => dialogOpen(browserId), 5000), `目录浏览器未打开（#${browserId}）`);
    await ctx.shot('wsbrowser-open');
    if (browserId !== 'workspaceBrowserDialog') {
      throw new Error('缺 #workspaceBrowserDialog（契约 §2.8），当前仍是旧的 #workspaceModal');
    }
    const dirs = await count('#wsBrowserList button[data-dir]');
    assert(dirs > 0, '#wsBrowserList 内没有子目录按钮');
    const startPath = await text('#wsBrowserPath');
    const childName = await page.$eval('#wsBrowserList button[data-dir]', b => b.textContent.trim());
    await page.$eval('#wsBrowserList button[data-dir]', b => b.click());
    const moved = await waitFor(async () => (await text('#wsBrowserPath')) !== startPath, 5000);
    await ctx.shot('wsbrowser-entered');
    assert(moved, `点击子目录 "${childName}" 后 #wsBrowserPath 未变化（仍为 ${startPath}）`);
    const inPath = await text('#wsBrowserPath');
    assert(inPath.endsWith(childName), `路径 "${inPath}" 未包含子目录 "${childName}"`);
    await clickSel('#wsBrowserUp', '↑ 上级目录');
    const back = await waitFor(async () => (await text('#wsBrowserPath')) === startPath, 5000);
    await ctx.shot('wsbrowser-up');
    assert(back, `↑ 未返回上级（期望 ${startPath}，实际 ${await text('#wsBrowserPath')}）`);
    await page.keyboard.press('Escape');
    assert(await waitFor(async () => !(await dialogOpen('workspaceBrowserDialog'))), 'Esc 未关闭目录浏览器');
    await ctx.shot('wsbrowser-closed');
    return `${startPath} → ${inPath} → ${startPath}；Esc 关闭成功`;
  });

  /* ============================ 8. 标签页 ============================ */
  await check('tabs.structure', '标签页结构（data-tab/data-bufnr/data-close）', async ctx => {
    await resetUI();
    if (!FULL) throw new Skip('基线运行不打开文件（共享 nvim）；用 NVW_FULL=1 执行');
    const s = await apiSession();
    assert(s?.buffers?.length, '/api/session 没有 buffer');
    if (s.buffers.length < 2) {
      // 通过文件树点开第二个文件（UI 点击，不向终端输入）
      const first = await page.$('#category-list a[data-path]');
      assert(first, '文件树没有可点击的文件');
      await first.click();
      await sleep(2000);
    }
    const tabs = await page.$$eval('#buffer-tabs [data-tab]', els => els.map(e => ({
      bufnr: e.dataset.tab,
      hasSwitch: !!e.querySelector('button[data-bufnr]'),
      hasClose: !!e.querySelector('button[data-close]'),
      labelSpan: !!e.querySelector('[data-tab-label]'),
      labelText: (e.querySelector('[data-tab-label]')?.textContent || '').trim(),
    })));
    assert(tabs.length > 0, '#buffer-tabs 里没有 [data-tab] 行（契约 §2.5）');
    assert(tabs.every(t => t.hasSwitch && t.hasClose), `标签行缺少切换/关闭按钮: ${JSON.stringify(tabs)}`);
    assert(await exists('#bufferCount'), '缺 #bufferCount（契约 §2.5）');
    assert(await exists('#btnNewBuffer'), '缺 #btnNewBuffer（契约 §2.5）');
    assert(await exists('#activeDocPath'), '缺 #activeDocPath（契约 §2.5）');
    // R2-3：label 必须包在 <span data-tab-label> 里（截断/滚动样式的挂载点）
    assert(tabs.every(t => t.labelSpan), `标签 label 未包在 <span data-tab-label> 内（R2-3）：${JSON.stringify(tabs)}`);
    const badge = (await text('#bufferCount')) || '';
    await ctx.shot('tabs-structure');
    // R2-3：buffer > 1 时 #bufferCount 显示「激活序号/总数」（如 3/7）；单 buffer 仍可以是纯数字
    if (tabs.length > 1) {
      assert(/^\d+\s*\/\s*\d+$/.test(badge.trim()),
        `buffer=${tabs.length} 时 #bufferCount 应为「激活序号/总数」，实际 "${badge}"（R2-3）`);
      const [idx, total] = badge.trim().split('/').map(n => parseInt(n, 10));
      assert(total === tabs.length, `#bufferCount="${badge}" 的总数与标签数 ${tabs.length} 不一致`);
      assert(idx >= 1 && idx <= total, `#bufferCount="${badge}" 的激活序号越界`);
      const activeBufnr = String((await apiSession())?.buffers?.find(b => b.active)?.bufnr);
      const activeIdx = tabs.findIndex(t => t.bufnr === activeBufnr);
      assert(activeIdx + 1 === idx, `#bufferCount 的激活序号 ${idx} 与 /api/session 的激活标签位置 ${activeIdx + 1} 不一致`);
    } else {
      assert(norm(badge) === String(tabs.length) || badge.trim() === '1/1',
        `单 buffer 时 #bufferCount="${badge}" 既不是 "1" 也不是 "1/1"`);
    }
    return `${tabs.length} 个标签（含 [data-tab-label]），#bufferCount=${badge}`;
  });

  await check('tabs.switch-close-new', '标签页：切换 / 关闭 / 新建 buffer', async ctx => {
    await resetUI();
    if (!FULL) throw new Skip('基线运行不打开文件；用 NVW_FULL=1 执行');
    const countTabs = () => count('#buffer-tabs [data-tab]');
    let n0 = await countTabs();
    assert(n0 >= 2, `标签数 ${n0} < 2，无法验证切换`);
    const title0 = await text('#activeDocTitle');
    const clicked = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#buffer-tabs [data-tab]')];
      const inactive = rows.find(r => (r.querySelector('button[data-bufnr]')?.getAttribute('variant-') || '') !== 'foreground0');
      if (!inactive) return false;
      inactive.querySelector('button[data-bufnr]').click();
      return true;
    });
    if (clicked) {
      await sleep(1500);
      const title1 = await text('#activeDocTitle');
      await ctx.shot('tabs-switched');
      assert(title1 !== title0, `切换标签后 #activeDocTitle 未变化（仍为 ${title0}）`);
    }
    // 关闭一个 buffer
    const nBefore = await countTabs();
    await page.$eval('#buffer-tabs [data-tab] button[data-close]', b => b.click());
    const closed = await waitFor(async () => (await countTabs()) < nBefore, 6000);
    await sleep(400);
    await ctx.shot('tabs-closed');
    assert(closed, `点击关闭按钮后标签数未减少（${nBefore}）`);
    // 新建 buffer
    const nMid = await countTabs();
    await clickSel('#btnNewBuffer', '新建 buffer');
    const added = await waitFor(async () => (await countTabs()) > nMid, 6000);
    await sleep(400);
    await ctx.shot('tabs-new');
    assert(added, `点击 #btnNewBuffer 后标签数未增加（${nMid}）`);
    return `切换=${clicked}；关闭 ${nBefore}→${nMid}；新建 →${await countTabs()}`;
  });

  /* ============================ 9. 未保存守护 ============================ */
  await check('unsaved.guard-flow', '未保存守护：带修改的 buffer 关闭时弹守护框', async ctx => {
    await resetUI();
    if (!FULL) throw new Skip('基线运行不触碰 buffer；用 NVW_FULL=1 执行');
    const name0 = 'changed buffer';
    let target = (await apiSession())?.buffers?.find(b => b.changed);
    // Lead 授权的受控路径（仅最终验收、仅无名 scratch buffer、不写盘）：
    // POST /api/new-buffer → xterm 输入 i/scratch/Esc → 得到 changed buffer
    if (!target && ALLOW_TERMINAL_INPUT) {
      const btnNew = await exists('#btnNewBuffer');
      if (btnNew) await clickSel('#btnNewBuffer', '新建 buffer');
      else await fetch(BASE + '/api/new-buffer', { method: 'POST' });
      await sleep(1500);
      await page.click('#nvimTerminal');
      await sleep(400);
      await page.keyboard.type('i', { delay: 60 });
      await page.keyboard.type('scratch', { delay: 80 });
      await page.keyboard.press('Escape');
      await sleep(1200);
      target = (await apiSession())?.buffers?.find(b => b.changed && !b.name);
      await ctx.shot('unsaved-guard-scratch-made');
      assert(target, '授权输入后仍未得到 changed 的无名 scratch buffer');
    }
    if (!target) throw new Skip('当前 nvim 没有 changed buffer，且未授权终端输入（NVW_ALLOW_TERMINAL_INPUT=1）→ 未覆盖项');
    const row = `#buffer-tabs [data-tab="${target.bufnr}"]`;
    assert(await exists(row), `找不到 changed buffer ${target.bufnr} 的标签行`);
    await page.$eval(`${row} button[data-close]`, b => b.click());
    assert(await waitFor(() => dialogOpen('unsavedGuardDialog'), 5000), '关闭带修改 buffer 时未弹出 #unsavedGuardDialog');
    await ctx.shot('unsaved-guard');
    for (const id of ['#btnUnsavedCancel', '#btnUnsavedDiscard', '#btnUnsavedSaveClose']) {
      assert(await exists(id), `守护框缺按钮 ${id}`);
    }
    const msg = await text('#unsavedGuardMessage');
    const shown = target.name ? target.name.split('/').pop() : `[No Name ${target.bufnr}]`;
    assert(msg && msg.includes(shown), `守护框文案 "${msg}" 未包含 buffer 名 "${shown}"`);
    if (ALLOW_TERMINAL_INPUT && !target.name) {
      // 授权路径走到 Discard 终态
      await clickSel('#btnUnsavedDiscard', 'Discard');
      const gone = await waitFor(async () => !((await apiSession())?.buffers || []).some(b => b.bufnr === target.bufnr), 6000);
      await ctx.shot('unsaved-guard-discarded');
      assert(gone, `Discard 后 bufnr ${target.bufnr} 仍出现在 /api/session`);
      await resetUI();
      return `scratch buffer ${target.bufnr} 触发守护框（"${msg}"）→ Discard 后已从 session 消失`;
    }
    await clickSel('#btnUnsavedCancel', 'Cancel');
    assert(await waitFor(async () => !(await dialogOpen('unsavedGuardDialog'))), 'Cancel 未关闭守护框');
    const still = (await apiSession())?.buffers?.some(b => b.bufnr === target.bufnr);
    assert(still, `Cancel 之后 buffer 竟然被关闭了（${name0}）`);
    return `buffer ${target.bufnr} 触发守护框，Cancel 后仍存在`;
  });

  await check('unsaved.guard-dom', '守护框结构（无 changed buffer 时的静态断言）', async ctx => {
    await resetUI();
    assert(await exists('#unsavedGuardDialog'), '缺 #unsavedGuardDialog');
    for (const id of ['#unsavedGuardMessage', '#btnUnsavedCancel', '#btnUnsavedDiscard', '#btnUnsavedSaveClose']) {
      assert(await exists(id), `守护框缺 ${id}`);
    }
    assert(await openDialogProbe('unsavedGuardDialog'), '守护框无法打开');
    await ctx.shot('unsaved-guard-dom');
    await page.keyboard.press('Escape');
    assert(await waitFor(async () => !(await dialogOpen('unsavedGuardDialog'))), 'Esc 未关闭守护框');
    return '结构完整 + Esc 可关';
  });

  /* ============================ 10. zen ============================ */
  await check('zen.enter-hint-exit', 'zen：顶栏/侧栏隐藏 + 可见提示 + Esc 退出', async ctx => {
    await resetUI();
    assert(await exists('#nav-btn-zen'), '缺 zen 按钮');
    await clickSel('#nav-btn-zen', 'Zen mode');
    assert(await waitFor(async () => !(await visible('#topbar')) && !(await visible('#sidebar')), 4000), '进入 zen 后顶栏/侧栏仍可见');
    const badgeVisible = await visible('#zenBadge');
    await ctx.shot('zen-on');
    assert(badgeVisible, 'zen 下没有可见提示（#zenBadge hidden/缺失）');
    await page.keyboard.press('Escape');
    assert(await waitFor(async () => (await visible('#topbar')), 4000), 'Esc 未退出 zen');
    await ctx.shot('zen-off');
    return '进入隐藏 OK；提示可见；Esc 退出 OK';
  });

  await check('zen.esc-closes-dialog-only', 'zen 下 Esc 只关弹窗、不退出 zen', async ctx => {
    await resetUI();
    await clickSel('#nav-btn-zen', 'Zen mode');
    assert(await waitFor(async () => !(await visible('#topbar')), 4000), '进入 zen 失败');
    // zen 下顶栏/侧栏不可点，优先用快捷键，再退化为程序化 click（记录方式）
    let how = 'hotkey';
    await page.keyboard.down('Meta');
    await page.keyboard.press(',');
    await page.keyboard.up('Meta');
    let opened = await waitFor(() => dialogOpen('settingsDialog'), 1200);
    if (!opened) {
      how = 'js-click-fallback（快捷键未生效）';
      await page.evaluate(() => document.getElementById('btnOpenSettings')?.click());
      opened = await waitFor(() => dialogOpen('settingsDialog'), 2500);
    }
    assert(opened, 'zen 下无法打开设置弹窗');
    await ctx.shot('zen-dialog-open');
    await page.keyboard.press('Escape');
    const dlgClosed = await waitFor(async () => !(await dialogOpen('settingsDialog')), 3000);
    await sleep(400);
    const stillZen = !(await visible('#topbar')) && !(await visible('#sidebar'));
    await ctx.shot('zen-dialog-esc');
    assert(dlgClosed, 'Esc 未关闭弹窗');
    assert(stillZen, `Esc 关弹窗时顺带退出了 zen（契约 §3.4.4 双触发回归；弹窗打开方式=${how}）`);
    await page.keyboard.press('Escape');
    await waitFor(async () => await visible('#topbar'), 3000);
    return `打开方式=${how}；Esc 只关弹窗，zen 保持`;
  });

  /* ============================ 11. 模态溢出扫描 ============================ */
  await check('modals.no-overflow', '每个模态：无横向溢出 / 内容不被裁切 / Esc 可关', async ctx => {
    const ids = ['workspacePanel', 'themePanel', 'search-dialog', 'newItemDialog', 'settingsDialog',
      'keymapDialog', 'unsavedGuardDialog', 'workspaceBrowserDialog', 'toastDialog'];
    // 契约 §2.8 已用 #workspaceBrowserDialog 取代旧 #workspaceModal；旧 id 仅在其仍存在时检查
    const legacyIds = ['workspaceModal'];
    const report = [];
    const problems = [];
    for (const id of [...ids, ...legacyIds]) {
      const legacy = legacyIds.includes(id);
      if (!await exists(`#${id}`)) {
        report.push(legacy ? `${id}(legacy,已移除)` : `${id}:缺失`);
        if (!legacy) problems.push(`缺少契约要求的模态 #${id}`);
        continue;
      }
      await resetUI();
      const ok = await openDialogProbe(id);
      if (!ok) { problems.push(`${id} 无法打开`); continue; }
      await sleep(250);
      const m = await page.evaluate(i => {
        const d = document.getElementById(i);
        const inner = d.querySelector('[box-]') || null;
        const cs = getComputedStyle(d);
        const innerCs = inner ? getComputedStyle(inner) : null;
        // 找出真正撑宽容器的后代（给 writer 精确定位用）
        const dRect = d.getBoundingClientRect();
        const cs2 = getComputedStyle(d);
        const padR = parseFloat(cs2.paddingRight) || 0;
        const padL = parseFloat(cs2.paddingLeft) || 0;
        const limit = dRect.right - padR;
        const offenders = [...d.querySelectorAll('*')].map(e => {
          const r = e.getBoundingClientRect();
          return { tag: e.tagName.toLowerCase(), id: e.id || '', text: (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40), right: Math.round(r.right), width: Math.round(r.width) };
        }).filter(o => o.right > Math.round(limit) + 1)
          .sort((a, b) => b.right - a.right).slice(0, 4);
        return {
          sw: d.scrollWidth, cw: d.clientWidth, sh: d.scrollHeight, ch: d.clientHeight,
          oy: cs.overflowY, ox: cs.overflowX,
          contentRight: Math.round(limit), padL: Math.round(padL),
          innerSh: inner ? inner.scrollHeight : null,
          innerCh: inner ? inner.clientHeight : null,
          innerOy: innerCs ? innerCs.overflowY : null,
          docSw: document.documentElement.scrollWidth, win: window.innerWidth,
          offenders,
        };
      }, id);
      await ctx.shot(`modal-${id}`);
      const tags = [];
      if (m.sw > m.cw + 1) {
        problems.push(`${id} 横向溢出 ${m.sw}>${m.cw}；越界元素=${m.offenders.map(o => `${o.tag}${o.id ? '#' + o.id : ''}"${o.text}" right=${o.right}`).join(', ') || '未定位到（scrollWidth 由子元素 margin/绝对定位造成）'}`);
        tags.push('H-OVERFLOW');
      }
      if (m.docSw > m.win + 1) { problems.push(`${id} 撑破视口 ${m.docSw}>${m.win}`); tags.push('DOC-OVERFLOW'); }
      const dialogClipped = m.sh > m.ch + 2 && !/auto|scroll/.test(m.oy);
      if (dialogClipped) { problems.push(`${id} 内容被裁切 dialog scrollH=${m.sh}>clientH=${m.ch} overflow-y=${m.oy}`); tags.push('V-CLIP'); }
      const innerClipped = m.innerSh !== null && m.innerSh > m.innerCh + 2 && !/auto|scroll/.test(m.innerOy || '');
      if (innerClipped) { problems.push(`${id} 内层被裁切 ${m.innerSh}>${m.innerCh} overflow-y=${m.innerOy}`); tags.push('INNER-CLIP'); }
      if (!tags.length) tags.push('ok');
      report.push(`${id}[${tags.join(',')} ${m.sw}/${m.cw} ${m.sh}/${m.ch}]`);
      if (!/popover/.test(id)) {
        await page.keyboard.press('Escape');
        const closed = await waitFor(async () => !(await dialogOpen(id)), 1500);
        if (!closed) { problems.push(`${id} Esc 无法关闭`); tags.push('NO-ESC'); }
      }
    }
    await resetUI();
    assert(!problems.length, problems.join(' | '));
    return report.join(' ');
  });

  /* ============================ 12. 断线 / 重连 ============================ */
  await check('conn.disconnect-reconnect', '断线状态可见 + Reconnect 可恢复', async ctx => {
    await resetUI();
    const sockets0 = await page.evaluate(() => (window.__nvwSockets || []).length);
    assert(sockets0 > 0, '页面没有建立过 WebSocket（无法测试断线）');
    // 真实断开：close() 掉当前 OPEN 的终端 WebSocket（等价于网络掉线，服务端会收到 close）
    const severed = await page.evaluate(() => {
      const ws = (window.__nvwSockets || []).filter(w => w.readyState === 1).pop();
      if (!ws) return false;
      ws.close();
      return true;
    });
    assert(severed, '没有处于 OPEN 状态的 WebSocket');
    const wentOffline = await waitFor(async () => /disconnect/i.test((await text('#statusConnection')) || ''), 8000, 100);
    const btnVisible = await visible('#btnReconnect');
    await ctx.shot('conn-disconnected');
    assert(wentOffline, `socket 断开后 #statusConnection 未变为 Disconnected（当前 "${await text('#statusConnection')}"）`);
    expectNetworkErrors = true; // 断线窗口内的网络错误属预期
    if (btnVisible) {
      await clickSel('#btnReconnect', 'Reconnect');
    }
    const back = await waitFor(async () =>
      /connected/i.test((await text('#statusConnection')) || ''), 15000);
    await ctx.shot('conn-reconnected');
    expectNetworkErrors = false;
    assert(back, `重连后 #statusConnection 仍为 "${await text('#statusConnection')}"`);
    const sockets1 = await page.evaluate(() => (window.__nvwSockets || []).length);
    assert(sockets1 > sockets0, `未建立新的 WebSocket（${sockets0} → ${sockets1}）`);
    assert(btnVisible, '断线窗口内 #btnReconnect 不可见（契约 §2.6）');
    return `断开：状态→Disconnected，Reconnect 可见；重连：状态→Connected，socket ${sockets0}→${sockets1}`;
  });

  await check('r3.reconnect-keeps-screen', '重连后画面必须完整（服务端网格快照兜底）', async ctx => {
    await resetUI();
    if (!FULL) throw new Skip('需要真实断线重连；用 NVW_FULL=1 执行');
    // 断线前把可见文本记下来
    const readScreen = () => page.evaluate(() => {
      const rows = [...document.querySelectorAll('#nvimTerminal [data-nvw-layer] > div')];
      const text = rows.map(r => r.textContent.replace(/\s+$/, '')).filter(t => t.trim());
      return { rows: rows.length, nonEmpty: text.length, sample: text.slice(0, 3).join(' | ').slice(0, 80) };
    });
    const before = await readScreen();
    assert(before.nonEmpty > 0, '断线前画面就是空的，无法验证恢复');

    const severed = await page.evaluate(() => {
      const ws = (window.__nvwSockets || []).filter(w => w.readyState === 1).pop();
      if (!ws) return false;
      ws.close();
      return true;
    });
    assert(severed, '没有 OPEN 的 WebSocket');
    await waitFor(async () => /disconnect/i.test((await text('#statusConnection')) || ''), 8000, 100);
    expectNetworkErrors = true;
    if (await visible('#btnReconnect')) await clickSel('#btnReconnect', 'Reconnect');
    // 重连后：新连接拿的是服务端网格快照，画面必须还在，且行列与 nvim 一致
    const ok = await waitFor(async () => {
      const now = await readScreen();
      return now.nonEmpty >= Math.max(1, before.nonEmpty - 1) && now.rows === before.rows;
    }, 15000, 400);
    const after = await readScreen();
    const st = await apiSession();
    await ctx.shot('r3-after-reconnect');
    expectNetworkErrors = false;
    assert(ok, `重连后 15s 内画面未恢复：断线前 ${before.nonEmpty} 行非空/${before.rows} 行，重连后 ${after.nonEmpty} 行非空/${after.rows} 行`);
    assert(st?.status?.lines === after.rows,
      `重连后网格与 nvim 不一致：nvim=${st?.status?.lines} 行，网格=${after.rows} 行`);
    return `断开→重连：画面 ${after.nonEmpty} 行非空保持，网格 ${after.rows} 行 = nvim ${st?.status?.lines} 行`;
  });
  /* ============================ 13. 工作区切换（FULL） ============================ */
  await check('workspace.switch-refreshes-tree', '切换工作区后文件树刷新', async ctx => {
    if (!FULL) throw new Skip('切换工作区会影响其他协作者，仅在最终验收（NVW_FULL=1）执行');
    if (SKIP_WS_SWITCH) throw new Skip('NVW_SKIP_WS_SWITCH=1：dry-run 不切换全局工作区');
    await resetUI();
    const root0 = await text('#explorerRoot');
    const apiCurrent = async () => {
      try { return (await (await fetch(BASE + '/api/projects')).json())?.current ?? null; } catch { return null; }
    };
    const cur0 = await apiCurrent();
    assert(cur0, '无法从 /api/projects 读到 current（切换前基线缺失）');
    assert(cur0 === ROOT, `/api/projects current=${cur0}，期望工作区 ${ROOT}（切换用例前必须已在 NVW）`);
    const tree0 = await count('#category-list a[data-path], #category-list details[data-path]');
    const trigger = await exists('#btnWorkspace') ? '#btnWorkspace' : '[popovertarget="workspacePanel"]';
    await clickSel(trigger, '工作区按钮');
    assert(await waitFor(() => dialogOpen('workspacePanel')), '#workspacePanel 未打开');
    await clickSel('#btnOpenNewWorkspaceModal', 'Browse…');
    assert(await waitFor(() => dialogOpen('workspaceBrowserDialog'), 5000), '目录浏览器未打开');
    // F2 修复：列表由异步 load() 填充，必须先等子目录按钮出现再取元素（原先直接 $eval 会竞态失败）
    const listed = await waitFor(async () => (await count('#wsBrowserList button[data-dir]')) > 0, 6000, 100);
    assert(listed, `#wsBrowserList 在 6s 内没有子目录按钮（#wsBrowserPath="${await text('#wsBrowserPath')}"）`);
    // 路径徽标现在是 tailPath() 尾部截断显示，完整路径在 title 上（Lead 已改实现）
    const startPath = await page.evaluate(() => {
      const e = document.getElementById('wsBrowserPath');
      return e ? { text: e.textContent.trim(), title: e.title || null } : null;
    });
    assert(startPath && (startPath.title || startPath.text) === root0,
      `目录浏览器起始路径 title="${startPath?.title}" text="${startPath?.text}"，期望当前工作区 "${root0}"`);
    await page.$eval('#wsBrowserList button[data-dir]', b => b.click());
    const startFull = startPath.title || startPath.text;
    const pathFull = () => page.evaluate(() => {
      const e = document.getElementById('wsBrowserPath');
      return e ? (e.title || e.textContent.trim()) : null;
    });
    const moved = await waitFor(async () => (await pathFull()) !== startFull, 6000, 100);
    assert(moved, `点击子目录后 #wsBrowserPath 未变化（仍为 ${startFull}）`);
    const target = await pathFull();
    await clickSel('#wsBrowserUse', 'Open this folder');
    const changed = await waitFor(async () => (await text('#explorerRoot')) !== root0, 8000);
    await sleep(1200);
    const tree1 = await count('#category-list a[data-path], #category-list details[data-path]');
    await ctx.shot('workspace-switched');
    assert(changed, `切换工作区后 #explorerRoot 未变化（仍为 ${root0}）`);
    assert(target !== root0 && target.startsWith(root0), `切换目标 "${target}" 不是工作区子目录`);
    assert(tree1 > 0, '切换工作区后文件树为空（未刷新）');
    // 还原
    await page.evaluate(p => {
      const d = document.getElementById('workspaceBrowserDialog');
      if (d?.open) d.close();
      const w = document.getElementById('workspaceModal');
      if (w && !w.open) w.showModal();
      const i = document.getElementById('inputWorkspacePath');
      if (i) i.value = p;
    }, root0);
    await page.evaluate(p => {
      const i = document.getElementById('inputWorkspacePath');
      if (i) i.value = p;
      document.getElementById('btnConfirmWorkspaceModal')?.click();
    }, root0);
    const restored = await waitFor(async () => (await text('#explorerRoot')) === root0, 8000);
    await ctx.shot('workspace-restored');
    // 纪律（Lead 裁定）：全局状态变更必须断言 /api/projects.current 恢复原值，恢复失败即 fail
    const restoredApi = await waitFor(async () => (await apiCurrent()) === cur0, 8000);
    const cur1 = await apiCurrent();
    assert(restored && restoredApi, `未能还原工作区：explorerRoot=${await text('#explorerRoot')}（期望 ${root0}），/api/projects current=${cur1}（期望 ${cur0}）`);
    // 记录本次切换新增的 recent 条目，交给 Lead 收尾清理
    try {
      const pj = await (await fetch(BASE + '/api/projects')).json();
      metrics.recentAfter = pj.recent || [];
      metrics.recentNew = (pj.recent || []).filter(p => !(metrics.recentBefore || []).includes(p));
    } catch { /* noop */ }
    return `${root0}(${tree0} 节点) → ${target}(${tree1} 节点) → 还原 OK（api.current=${cur1}；新增 recent=${JSON.stringify(metrics.recentNew || [])}）`;
  });

  /* ============================ 14. toast ============================ */
  await check('toast.visible', 'toast 可见且可自动消失', async ctx => {
    await resetUI();
    const tag = `verifier-probe-${Date.now()}`;
    await page.evaluate(t => {
      const l = document.getElementById('toastList');
      if (l) l.innerHTML = '';
      return import('/js/toast.js').then(m => m.showToast(t, 'info', 1200));
    }, tag);
    const has = () => page.evaluate(t => [...document.querySelectorAll('#toastList *')].some(e => e.textContent.includes(t)), tag);
    const shown = await waitFor(has, 3000);
    await ctx.shot('toast-visible');
    assert(shown, 'toast 未出现（showToast 无效果）');
    const gone = await waitFor(async () => !(await has()), 6000);
    await ctx.shot('toast-gone');
    assert(gone, 'toast 超过 duration 后仍未消失');
    return '出现 → 自动消失 OK';
  });

  /* ==================== R2：Round 2 契约量化验收（docs/UX-CONTRACT.md 附录） ==================== */

  /** 终端/画布度量：与 docs/ux-review/probe-terminal.mjs 同口径，便于 before/after 对比 */
  /** 网格度量（新架构口径）：DOM 行级渲染，关注"铺满 + 行高一致 + 无位图" */
  const measureTerminal = () => page.evaluate(async () => {
    const term = document.getElementById('nvimTerminal');
    const layer = term?.querySelector('[data-nvw-layer]');
    const rowEls = layer ? [...layer.children] : [];
    const termBox = term?.getBoundingClientRect();
    const cs = term ? getComputedStyle(term) : null;
    // 行高以**网格层**为准：铺满校准（--grid-lh）落在层上，终端盒子本身仍是用户设定值
    const layerCs = layer ? getComputedStyle(layer) : null;
    const lineHeight = layerCs ? parseFloat(layerCs.lineHeight) : (cs ? parseFloat(cs.lineHeight) : 0);
    const fontSize = cs ? parseFloat(cs.fontSize) : 0;
    const heights = rowEls.map(el => el.getBoundingClientRect().height);
    const lastBox = rowEls.length ? rowEls[rowEls.length - 1].getBoundingClientRect() : null;
    const probe = term?.querySelector('[data-nvw-probe]');
    const chPx = probe ? probe.getBoundingClientRect().width / 100 : null;
    let session = null;
    try { session = await (await fetch('/api/session')).json(); } catch { /* noop */ }
    const nvimRows = session?.status?.lines ?? null;
    const nvimCols = session?.status?.columns ?? null;
    const idealRows = termBox && lineHeight ? Math.floor(termBox.height / lineHeight) : null;
    const ls = {};
    try { for (const k of ['nvw_font_size', 'nvw_line_height']) ls[k] = localStorage.getItem(k); } catch { /* noop */ }
    const rootCs = getComputedStyle(document.documentElement);
    return {
      dpr: window.devicePixelRatio,
      localStorage: ls,
      font: { size: fontSize, lineHeight },
      fontProbe: {
        cssVarFontFamily: rootCs.getPropertyValue('--font-family').trim().slice(0, 80),
        cssVarFontSize: rootCs.getPropertyValue('--font-size').trim(),
        cssVarLineHeight: rootCs.getPropertyValue('--line-height').trim(),
        fontsStatus: document.fonts?.status ?? null,
      },
      grid: {
        rows: rowEls.length,
        spans: term ? term.querySelectorAll('[data-nvw-layer] span').length : 0,
        canvasCount: term ? term.querySelectorAll('canvas').length : -1,   // 新架构必须为 0
        rowH: heights.length ? +heights[0].toFixed(3) : null,
        rowHSpread: heights.length ? +(Math.max(...heights) - Math.min(...heights)).toFixed(3) : null,
        // 只有缩放/旋转/斜切会让文字发虚；纯平移（WebTUI view-content 的居中）不影响清晰度
        hasTransform: term ? (() => {
          const cs = getComputedStyle(term);
          const z = cs.zoom;
          if (z && z !== '1' && z !== 'normal') return true;
          const t = cs.transform;
          if (!t || t === 'none') return false;
          const m = t.match(/matrix\(([^)]+)\)/);
          if (!m) return true;
          const [a, b, c, d] = m[1].split(',').map(Number);
          return Math.abs(a - 1) > 1e-6 || Math.abs(b) > 1e-6 || Math.abs(c - 1e-6) > 1e-6 || Math.abs(d - 1) > 1e-6;
        })() : null,
        boxW: termBox ? +termBox.width.toFixed(2) : null,
        boxH: termBox ? +termBox.height.toFixed(2) : null,
        unusedPx: termBox && lastBox ? +Math.max(0, termBox.bottom - lastBox.bottom).toFixed(2) : null,
        gridW: rowEls.length ? +rowEls[0].getBoundingClientRect().width.toFixed(2) : null,
        gridH: rowEls.length ? +(lastBox.bottom - rowEls[0].getBoundingClientRect().top).toFixed(2) : null,
      },
      nvim: { rows: nvimRows, cols: nvimCols },
      derived: {
        idealRows,
        cellW: chPx === null ? null : +chPx.toFixed(3),
        cellH: lineHeight ? +lineHeight.toFixed(3) : null,
        unusedRows: idealRows !== null && nvimRows !== null ? idealRows - nvimRows : null,
        unusedPx: termBox && lineHeight ? +(termBox.height - rowEls.length * lineHeight).toFixed(2) : null,
      },
    };
  });
  await check('r3.grid-fills-editor', 'R3-1 网格铺进编辑器：不溢出 + 至少一方向贴边，两个视口', async ctx => {
    await resetUI();
    await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
    await page.bringToFront().catch(() => {});
    await sleep(2500);

    const viewports = [{ w: 1440, h: 900 }, { w: 1512, h: 982 }];
    const rowsReport = [];
    const problems = [];
    for (const vp of viewports) {
      await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 1 });
      await sleep(1600);
      const m = await measureTerminal();
      await ctx.shot(`r3-grid-${vp.w}x${vp.h}`);
      const tag = `${vp.w}x${vp.h}`;
      if (m.grid.canvasCount !== 0) problems.push(`${tag}: 渲染面出现 canvas（应为纯 DOM 网格）`);
      if (m.grid.gridH === null || m.grid.gridW === null) { problems.push(`${tag}: 无法测量网格几何`); continue; }
      // 契约：网格必须**完整放进**编辑器区域（不裁切），且在至少一个方向上贴边
      //（= 已经放大到该尺寸下的最大；网格行列数由 nvim 决定，不由本页改写）。
      const slackY = m.grid.boxH - m.grid.gridH;
      const slackX = m.grid.boxW - m.grid.gridW;
      if (slackY < -1 || slackX < -1) {
        problems.push(`${tag}: 网格溢出容器（横向余 ${slackX.toFixed(1)}px / 纵向余 ${slackY.toFixed(1)}px）`);
      }
      if (Math.min(slackX, slackY) > 2) {
        problems.push(`${tag}: 两个方向都没贴边（横向余 ${slackX.toFixed(1)}px / 纵向余 ${slackY.toFixed(1)}px），字号缩放没生效`);
      }
      if (m.nvim.rows !== null && m.grid.rows !== m.nvim.rows) {
        problems.push(`${tag}: 网格 ${m.grid.rows} 行 ≠ nvim ${m.nvim.rows} 行（网格规模必须与 nvim 一致）`);
      }
      rowsReport.push(`${tag}: 网格=${m.grid.rows}行 nvim=${m.nvim.rows}行 ${m.grid.gridW}×${m.grid.gridH} 容器 ${m.grid.boxW}×${m.grid.boxH} 余量 ${slackX.toFixed(1)}/${slackY.toFixed(1)}px 字号=${m.font.size}px`);
    }
    metrics['r3.grid.fill'] = rowsReport;
    assert(problems.length === 0, problems.join('；'));
    return rowsReport.join('  ·  ');
  });
  await check('r3.grid-crisp-text', 'R3-2 文字清晰：纯 DOM 文本 + 行高严格一致 + 无缩放', async ctx => {
    await resetUI();
    const m = await measureTerminal();
    assert(m.grid.canvasCount === 0, `#nvimTerminal 内出现 ${m.grid.canvasCount} 个 canvas（应为纯 DOM 文本，位图才会糊）`);
    assert(m.grid.rows > 5, `网格行数异常：${m.grid.rows}`);
    assert(m.grid.spans > 0, '没有任何文本 span');
    assert(m.grid.rowHSpread !== null && m.grid.rowHSpread < 0.02,
      `各行高度不一致：极差 ${m.grid.rowHSpread}px（网格会错位/发虚）`);
    assert(Math.abs(m.grid.rowH - m.font.lineHeight) < 0.5,
      `行高 ${m.grid.rowH}px ≠ line-height ${m.font.lineHeight}px`);
    assert(m.grid.hasTransform === false, '渲染面存在 transform/zoom，会让文本发虚');
    await ctx.shot('r3-grid-crisp');
    return `canvas=0 spans=${m.grid.spans} rowH=${m.grid.rowH}px(=lh ${m.font.lineHeight}px) 行高极差=${m.grid.rowHSpread}px`;
  });
  await check('r3.grid-crisp-dpr1.5', 'R3-2 DPR1.5：分数像素比下依然是纯 DOM 文本且行高一致', async ctx => {
    await resetUI();
    // 旧架构在这里要"把 devicePixelRatio 吸附成整数 + 画布取整"才不会糊；
    // DOM 文本与 DPR 无关，所以 DPR=1.5 下这些性质必须原样成立。
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });
    await sleep(1800);
    const m = await measureTerminal();
    assert(Math.abs(m.dpr - 1.5) < 0.01, `devicePixelRatio 未生效：${m.dpr}`);
    assert(m.grid.canvasCount === 0, `#nvimTerminal 内出现 ${m.grid.canvasCount} 个 canvas（应为纯 DOM 文本，位图才会糊）`);
    assert(m.grid.rows > 5, `网格行数异常：${m.grid.rows}`);
    assert(m.grid.spans > 0, '没有任何文本 span');
    assert(m.grid.rowHSpread !== null && m.grid.rowHSpread < 0.02,
      `各行高度不一致：极差 ${m.grid.rowHSpread}px（网格会错位/发虚）`);
    assert(Math.abs(m.grid.rowH - m.font.lineHeight) < 0.5,
      `行高 ${m.grid.rowH}px ≠ line-height ${m.font.lineHeight}px`);
    assert(m.grid.hasTransform === false, '渲染面存在 transform/zoom，会让文本发虚');
    await ctx.shot('r3-grid-crisp-dpr15');
    return `canvas=0 spans=${m.grid.spans} rowH=${m.grid.rowH}px(=lh ${m.font.lineHeight}px) 行高极差=${m.grid.rowHSpread}px`;
  });
  await check('r2.tabs-reachable', 'R2-3 标签可达：7 buffer 溢出 + 滚动条可用 + 真实点击第 1 个标签切换', async ctx => {
    await resetUI();
    if (!FULL) throw new Skip('需要创建 buffer；用 NVW_FULL=1 执行');
    const countTabs = () => count('#buffer-tabs [data-tab]');
    // 造 ≥7 个标签走**真实用户路径**：点击文件树里的文件。
    // 注意 #btnNewBuffer 走 Vim 的 :enew —— 当前是无名空 buffer 时会被复用，连点只 +1（见报告 Round 2 观察项）。
    const openedPaths = new Set();
    let guard = 0;
    while ((await countTabs()) < 7 && guard++ < 16) {
      const next = await page.$$eval('#category-list a[data-path]',
        (els, seen) => els.map(e => e.dataset.path).find(p => !seen.includes(p)) || null, [...openedPaths]);
      if (!next) break;
      openedPaths.add(next);
      await page.evaluate(sel => {
        const a = [...document.querySelectorAll('#category-list a[data-path]')].find(e => e.dataset.path === sel);
        a?.click();
      }, next);
      await sleep(1100);
    }
    const n = await countTabs();
    assert(n >= 7, `只创建出 ${n} 个标签（需要 ≥7 才能复现溢出；已点开 ${openedPaths.size} 个文件）`);
    await sleep(600);
    const m = await page.evaluate(() => {
      const el = document.getElementById('buffer-tabs');
      const cs = getComputedStyle(el);
      const rows = [...el.querySelectorAll('[data-tab]')];
      const first = rows[0]?.querySelector('button[data-bufnr]');
      const fr = first?.getBoundingClientRect();
      return {
        sw: el.scrollWidth, cw: el.clientWidth, scrollLeft: el.scrollLeft,
        scrollbarWidth: cs.scrollbarWidth, overflowX: cs.overflowX, maxWidth: cs.maxWidth, flex: cs.flex,
        rows: rows.length,
        firstBufnr: first?.dataset.bufnr ?? null,
        firstRect: fr ? { x: fr.x, y: fr.y, w: fr.width, h: fr.height } : null,
      };
    });
    await ctx.shot('r2-tabs-overflow');
    metrics['r2.tabs'] = m;
    assert(m.sw > m.cw, `7 个标签时 #buffer-tabs 未溢出（scrollWidth=${m.sw} ≤ clientWidth=${m.cw}），无法验证可滚动`);
    assert(m.scrollbarWidth !== 'none', `#buffer-tabs 的 scrollbar-width=${m.scrollbarWidth}（不得为 none，否则用户没有抓手）`);
    assert(m.overflowX === 'auto' || m.overflowX === 'scroll' || m.overflowX === 'overlay',
      `#buffer-tabs overflow-x=${m.overflowX}，应为 auto/scroll 以允许滚动`);
    // 把视口滚到最左，然后用**真实鼠标**点击第 1 个标签
    await page.evaluate(() => { document.getElementById('buffer-tabs').scrollLeft = 0; });
    await sleep(400);
    const r = await page.evaluate(() => {
      const first = document.querySelector('#buffer-tabs [data-tab] button[data-bufnr]');
      const b = first.getBoundingClientRect();
      const el = document.getElementById('buffer-tabs').getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2, visible: b.left >= el.left - 1 && b.right <= el.right + 1 };
    });
    const diag = await page.evaluate(() => {
      const el = document.getElementById('buffer-tabs');
      const cs = getComputedStyle(el);
      const first = el.querySelector('[data-tab]');
      const f = first.getBoundingClientRect(), p = el.getBoundingClientRect();
      return {
        justifyContent: cs.justifyContent, direction: cs.direction, flexWrap: cs.flexWrap,
        scrollLeft: el.scrollLeft, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
        firstLeft: +f.left.toFixed(1), panelLeft: +p.left.toFixed(1), delta: +(f.left - p.left).toFixed(1),
        unreachableLeftOverflow: f.left < p.left - 1,
      };
    });
    metrics['r2.tabs.geometry'] = { ...m, geometry: diag };
    assert(r.visible,
      `scrollLeft=0 后第 1 个标签仍不在可视区内：firstLeft=${diag.firstLeft} panelLeft=${diag.panelLeft}（Δ=${diag.delta}px）` +
      `，justify-content=${diag.justifyContent} direction=${diag.direction} flex-wrap=${diag.flexWrap}` +
      `，scrollWidth=${diag.scrollWidth} clientWidth=${diag.clientWidth} scrollLeft=${diag.scrollLeft}` +
      `；根因：flex 容器 justify-content=${diag.justifyContent} 时溢出向两侧排布，左侧溢出不可滚动到达（用户"选不中前几个标签"）`);
    await page.mouse.click(r.x, r.y);
    await sleep(1500);
    const active = (await apiSession())?.buffers?.find(b => b.active)?.bufnr;
    await ctx.shot('r2-tabs-first-clicked');
    assert(String(active) === String(m.firstBufnr),
      `真实点击第 1 个标签（bufnr=${m.firstBufnr}）后 active 仍是 bufnr=${active} —— 用户"选不中标签"的缺陷仍在`);
    return `7 标签 scrollWidth=${m.sw} > clientWidth=${m.cw}，scrollbar-width=${m.scrollbarWidth}，点击 bufnr=${m.firstBufnr} → active=${active}`;
  });

  await check('r2.statusline-no-dup', 'R2-5 状态栏去重：无 #statusBuffers / 无 "N buffer" / 满幅实底', async ctx => {
    await resetUI();
    const m = await page.evaluate(() => {
      const sl = document.getElementById('statusline');
      const probe = document.createElement('div');
      probe.style.backgroundColor = 'var(--background1)';
      document.body.appendChild(probe);
      const wantBg = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const ft = document.getElementById('statusFiletype');
      return {
        hasStatusBuffers: !!document.getElementById('statusBuffers'),
        textNoBuffer: !/\d+\s*buffers?/i.test(sl.textContent || ''),
        text: (sl.textContent || '').replace(/\s+/g, ' ').trim(),
        hasBoxAttr: sl.hasAttribute('box-'),
        boxAttr: sl.getAttribute('box-'),
        bg: getComputedStyle(sl).backgroundColor,
        wantBg,
        filetype: ft ? { text: (ft.textContent || '').trim(), hidden: ft.hidden } : null,
        // 标签栏在 buffer>1 时显示 N/M，状态栏不应再出现同样的计数
        bufferCount: (document.getElementById('bufferCount')?.textContent || '').trim(),
      };
    });
    await ctx.shot('r2-statusline');
    metrics['r2.statusline'] = m;
    assert(!m.hasStatusBuffers, '#statusBuffers 仍存在于 DOM（R2-5 要求删除该元素）');
    assert(m.textNoBuffer, `状态栏仍出现 "N buffer" 文本："${m.text}"`);
    assert(!m.hasBoxAttr, `#statusline 仍带 box-="${m.boxAttr}"（R2-5 要求改为满幅实底条）`);
    assert(m.bg === m.wantBg, `#statusline 背景色 ${m.bg} ≠ var(--background1)=${m.wantBg}`);
    assert(m.filetype, '缺 #statusFiletype 元素');
    if (!m.filetype.text) {
      assert(m.filetype.hidden, '#statusFiletype 文本为空但未 hidden（会显示 no ft）');
    }
    assert(!/no ft/i.test(m.filetype.text), `#statusFiletype 仍显示 "no ft"："${m.filetype.text}"`);
    return `无 #statusBuffers；无 "N buffer"；box- 已移除；bg=${m.bg}；filetype="${m.filetype.text}"(hidden=${m.filetype.hidden})；#bufferCount=${m.bufferCount}`;
  });

  await check('r2.shell-fill', 'R2-8 外壳铺满：scrollWidth===clientWidth 且状态栏贴底 ≤1px', async ctx => {
    await resetUI();
    const m = await page.evaluate(() => {
      const html = document.documentElement;
      const sl = document.getElementById('statusline');
      const b = sl.getBoundingClientRect();
      const column = document.querySelector('body > column');
      return {
        sw: html.scrollWidth, cw: html.clientWidth, sh: html.scrollHeight, ch: html.clientHeight,
        statusBottom: +b.bottom.toFixed(2), statusRight: +b.right.toFixed(2), statusLeft: +b.left.toFixed(2),
        innerH: window.innerHeight, innerW: window.innerWidth,
        bottomGap: +(window.innerHeight - b.bottom).toFixed(2),
        rightGap: +(window.innerWidth - (column?.getBoundingClientRect().right ?? 0)).toFixed(2),
      };
    });
    await ctx.shot('r2-shell-fill');
    metrics['r2.shell'] = m;
    assert(m.sw === m.cw, `documentElement.scrollWidth=${m.sw} ≠ clientWidth=${m.cw}（存在横向溢出，R2-8）`);
    assert(Math.abs(m.bottomGap) <= 1, `#statusline 底边距视口底部 ${m.bottomGap}px（要求 ≤1，R2-8）`);
    return `scrollWidth=clientWidth=${m.cw}；bottomGap=${m.bottomGap}px；rightGap=${m.rightGap}px`;
  });

  await check('r2.sidebar-toolbar', 'R2-4 侧栏脚栏：box- 框 + 6 按钮单行不换行 + variant 合法', async ctx => {
    await resetUI();
    const OFFICIAL = ['foreground0', 'foreground1', 'foreground2', 'background0', 'background1', 'background2', 'background3'];
    const m = await page.evaluate(() => {
      const bar = document.getElementById('sidebar-actions');
      if (!bar) return { error: 'no bar' };
      const btns = [...bar.querySelectorAll('button')];
      const rects = btns.map(b => { const r = b.getBoundingClientRect(); return { top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2), left: +r.left.toFixed(2), right: +r.right.toFixed(2), variant: b.getAttribute('variant-'), text: (b.textContent || '').trim() }; });
      const br = bar.getBoundingClientRect();
      const html = getComputedStyle(document.documentElement);
      return {
        hasBox: bar.hasAttribute('box-'), boxVal: bar.getAttribute('box-'),
        shear: bar.getAttribute('shear-'), align: bar.getAttribute('align-'),
        count: btns.length,
        barRect: { w: +br.width.toFixed(1), h: +br.height.toFixed(1) },
        rowH: +(Math.max(...rects.map(r => r.bottom)) - Math.min(...rects.map(r => r.top))).toFixed(2),
        singleLine: Math.max(...rects.map(r => r.top)) - Math.min(...rects.map(r => r.top)) <= 1,
        overflow: bar.scrollWidth - bar.clientWidth,
        lh: parseFloat(html.lineHeight),
        variants: rects.map(r => r.variant),
        texts: rects.map(r => r.text),
        offscreen: rects.filter(r => r.right > br.right + 1 || r.left < br.left - 1).length,
      };
    });
    await ctx.shot('r2-sidebar-toolbar');
    metrics['r2.sidebar'] = m;
    assert(!m.error, '找不到 #sidebar-actions');
    assert(m.hasBox, '#sidebar-actions 没有 box-（R2-4 要求带框脚栏）');
    assert(m.count === 6, `#sidebar-actions 里 ${m.count} 个按钮，期望 6 个`);
    assert(m.singleLine, `6 个按钮不在同一行（top 差 >1px）：rowH=${m.rowH}`);
    assert(m.overflow <= 1, `#sidebar-actions 内容溢出 ${m.overflow}px（32ch 侧栏内不应换行/溢出）`);
    assert(m.offscreen === 0, `有 ${m.offscreen} 个按钮越出脚栏边界`);
    const badVariants = m.variants.filter(v => v && !OFFICIAL.includes(v));
    assert(!badVariants.length, `按钮 variant- 非法：${badVariants.join(', ')}`);
    assert(m.variants.every(v => v === 'background0'), `6 个按钮应统一 variant-="background0"（幽灵态），实际 ${JSON.stringify(m.variants)}`);
    return `box-="${m.boxVal}" 6 按钮单行(rowH=${m.rowH}px, 1lh=${m.lh}) 无溢出；variant=${[...new Set(m.variants)].join('/')}`;
  });

  await check('r2.workspace-panel-alignment', 'R2-6 工作区弹层：所有可见子元素不越出面板内框', async ctx => {
    await resetUI();
    const trigger = await exists('#btnWorkspace') ? '#btnWorkspace' : '[popovertarget="workspacePanel"]';
    await clickSel(trigger, '工作区按钮');
    assert(await waitFor(() => dialogOpen('workspacePanel'), 4000), '#workspacePanel 未打开');
    await sleep(400);
    const m = await page.evaluate(() => {
      const d = document.getElementById('workspacePanel');
      const r = d.getBoundingClientRect();
      // 内框 = 去掉 border 后的 padding box
      const frame = { l: r.left + d.clientLeft, t: r.top + d.clientTop, r: r.left + d.clientLeft + d.clientWidth, b: r.top + d.clientTop + d.clientHeight };
      const vis = [...d.querySelectorAll('*')].filter(e => {
        const b = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return b.width > 0 && b.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
      });
      const offenders = vis.map(e => {
        const b = e.getBoundingClientRect();
        return { tag: e.tagName.toLowerCase(), id: e.id || '', text: (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24), left: +b.left.toFixed(1), right: +b.right.toFixed(1) };
      }).filter(o => o.left < frame.l - 1 || o.right > frame.r + 1);
      return { frame: { l: +frame.l.toFixed(1), r: +frame.r.toFixed(1) }, offenders, total: vis.length, sepCount: d.querySelectorAll('[is-="separator"]').length };
    });
    await ctx.shot('r2-workspace-panel');
    await page.keyboard.press('Escape');
    await waitFor(async () => !(await dialogOpen('workspacePanel')), 3000);
    metrics['r2.workspacePanel'] = m;
    assert(!m.offenders.length,
      `越出面板内框 [${m.frame.l}, ${m.frame.r}] 的元素：${m.offenders.map(o => `${o.tag}${o.id ? '#' + o.id : ''}"${o.text}"(${o.left}~${o.right})`).join(', ')}`);
    assert(m.sepCount > 0, '#workspacePanel 内没有 is-="separator"（R2-6 要求列表与动作区之间加分隔）');
    return `${m.total} 个可见元素全部落在 [${m.frame.l}, ${m.frame.r}]，separator ×${m.sepCount}`;
  });

  await check('r2.wsbrowser-alignment', 'R2-7 目录浏览器：listWrap 存在 + 按钮左边缘对齐 ≤1px', async ctx => {
    await resetUI();
    const trigger = await exists('#btnWorkspace') ? '#btnWorkspace' : '[popovertarget="workspacePanel"]';
    await clickSel(trigger, '工作区按钮');
    assert(await waitFor(() => dialogOpen('workspacePanel'), 4000), '#workspacePanel 未打开');
    await clickSel('#btnOpenNewWorkspaceModal', 'Browse…');
    assert(await waitFor(() => dialogOpen('workspaceBrowserDialog'), 5000), '#workspaceBrowserDialog 未打开');
    const listed = await waitFor(async () => (await count('#wsBrowserList button[data-dir]')) > 0, 6000, 100);
    assert(listed, '#wsBrowserList 内没有子目录按钮');
    const m = await page.evaluate(() => {
      const wrap = document.getElementById('wsBrowserListWrap');
      const list = document.getElementById('wsBrowserList');
      const dlg = document.getElementById('workspaceBrowserDialog');
      const btns = [...list.querySelectorAll('button[data-dir]')];
      const lefts = btns.map(b => +b.getBoundingClientRect().left.toFixed(2));
      const listRect = list.getBoundingClientRect();
      const wrapRect = wrap ? wrap.getBoundingClientRect() : null;
      // 底部动作行：含 Cancel / Open this folder 的那一行；手输路径行 = #inputWorkspacePath 所在 row
      const actionRows = [...dlg.querySelectorAll('row')].filter(r => r.querySelector('#wsBrowserUse') || r.querySelector('#wsBrowserCancel'));
      const actionBtn = document.getElementById('wsBrowserUse') || actionRows[0] || null;
      const inputRow = document.getElementById('inputWorkspacePath') || null;   // 比"输入元素本身"而不是它所在的 row 容器
      const L = e => e ? +e.getBoundingClientRect().left.toFixed(2) : null;
      const R = e => e ? +e.getBoundingClientRect().right.toFixed(2) : null;
      const dirLeft = lefts.length ? lefts[0] : null;
      return {
        hasWrap: !!wrap,
        wrapBox: wrapRect ? { w: +wrapRect.width.toFixed(1), h: +wrapRect.height.toFixed(1) } : null,
        buttonCount: btns.length,
        lefts,
        leftSpread: lefts.length ? +(Math.max(...lefts) - Math.min(...lefts)).toFixed(2) : null,
        listLeft: +listRect.left.toFixed(2),
        listRight: +listRect.right.toFixed(2),
        dirLeft,
        // 视觉同一对齐轴：目录按钮 vs 手输路径行（都应落在 box 内边距之后的同一条线上）
        inputRowLeft: L(inputRow),
        inputDelta: (dirLeft !== null && L(inputRow) !== null) ? +Math.abs(dirLeft - L(inputRow)).toFixed(2) : null,
        // 底部动作行与列表同宽：比较右边缘
        actionRight: R(actionBtn),
        actionRightDelta: (R(actionBtn) !== null) ? +Math.abs(R(actionBtn) - listRect.right).toFixed(2) : null,
        actionRowLeft: L(actionRows[0]),
        wrapLeft: wrapRect ? +wrapRect.left.toFixed(2) : null,
        listOverflowY: getComputedStyle(wrap || list).overflowY,
      };
    });
    await ctx.shot('r2-wsbrowser');
    await page.keyboard.press('Escape');
    await waitFor(async () => !(await dialogOpen('workspaceBrowserDialog')), 3000);
    metrics['r2.wsbrowser'] = m;
    assert(m.hasWrap, '缺 #wsBrowserListWrap（R2-7 要求子目录列表外套滚动容器）');
    assert(m.buttonCount > 0, '#wsBrowserList 内没有按钮');
    assert(m.leftSpread !== null && m.leftSpread <= 1,
      `子目录按钮左边缘参差 ${m.leftSpread}px（要求 ≤1）：${JSON.stringify(m.lefts)}`);
    assert(m.inputDelta !== null && m.inputDelta <= 1,
      `手输路径行与目录按钮不在同一左边缘：dirLeft=${m.dirLeft} inputRowLeft=${m.inputRowLeft}（差 ${m.inputDelta}px，要求 ≤1）—— 即存在两套对齐轴`);
    assert(m.actionRightDelta !== null && m.actionRightDelta <= 1,
      `底部动作行右边缘与列表右边缘相差 ${m.actionRightDelta}px（要求 ≤1；action=${m.actionRight} list=${m.listRight}）`);
    return `#wsBrowserListWrap ${m.wrapBox?.w}×${m.wrapBox?.h}；${m.buttonCount} 个按钮左边缘差 ${m.leftSpread}px；输入行与按钮差 ${m.inputDelta}px；动作行右边缘差 ${m.actionRightDelta}px；overflowY=${m.listOverflowY}`;
  });

  /* ============================ 15. 收尾清理（共享 nvim 会话复原） ============================ */
  await check('cleanup.restore-session', '清理临时文件与本次运行打开的 buffer', async ctx => {
    const closedBufs = [];
    for (let i = 0; i < 20; i++) {
      // 用只读 API 把 bufnr 映射到文件名，且绝不关闭运行前就存在的 buffer（保护共享 nvim 会话）
      const s = await apiSession();
      // 本轮运行打开/创建的所有 buffer（运行前快照里的绝不碰）
      const victim = (s?.buffers || []).find(b => !baselineBufnrs.has(b.bufnr));
      if (!victim) break;
      const clicked = await page.evaluate(n => {
        const btn = document.querySelector(`#buffer-tabs button[data-close="${n}"]`);
        if (!btn) return false;
        btn.click();
        return true;
      }, victim.bufnr);
      if (!clicked) break;
      closedBufs.push(victim.bufnr);
      await sleep(900);
      if (await dialogOpen('unsavedGuardDialog')) { await clickSel('#btnUnsavedDiscard', 'Discard'); await sleep(700); }
    }
    let removed = 0;
    for (const f of testArtifacts) {
      if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed++; }
    }
    for (const d of testDirs) {
      if (fs.existsSync(d)) { fs.rmSync(d, { recursive: true, force: true }); removed++; }
    }
    // 目录名兜底清理
    const sweepDirs = dir => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const q = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (/^nvw-verify-dir-/.test(e.name)) { fs.rmSync(q, { recursive: true, force: true }); removed++; }
          else sweepDirs(q);
        }
      }
    };
    sweepDirs(ROOT);
    // 兜底：扫描任何残留的 nvw-verify-* 文件
    const leftovers = [];
    const walk = dir => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/^nvw-verify-/.test(e.name)) leftovers.push(p);
      }
    };
    walk(ROOT);
    leftovers.forEach(p => { fs.rmSync(p, { force: true }); removed++; });
    await page.evaluate(() => document.getElementById('nav-btn-refresh')?.click());
    await sleep(700);
    // Lead 追加验收点：/api/projects 的 recent[0] 必须是 NVW，且无新建目录残留
    let recent = [];
    try { recent = (await (await fetch(BASE + '/api/projects')).json())?.recent || []; } catch { /* noop */ }
    metrics.recentAfter = recent;
    // 子目录残留（非 nvw-verify 的也算）：作为证据上报，nvw-verify 直接 fail
    metrics.subdirResidue = recent.filter(p => p !== ROOT && p.startsWith(ROOT + '/'));
    const residue = recent.filter(p => /nvw-verify/.test(p));
    await ctx.shot('cleanup');
    assert(recent[0] === ROOT, `recent[0]="${recent[0]}"，期望 ${ROOT}`);
    assert(!residue.length, `recent 里仍有测试目录残留：${residue.join(', ')}`);
    return `删除临时文件/目录 ${removed} 个；关闭测试 buffer [${closedBufs.join(',')}]；recent[0]=${recent[0]}（${recent.length} 项，无残留）`;
  });

  /* ============================ 16. 控制台 ============================ */
  await check('console.zero-error', '控制台 0 error / 0 pageerror / 无 4xx 资源', async ctx => {
    const hardConsole = consoleErrors.filter(e => !e.expected);
    const hardPage = pageErrors.filter(e => !e.expected);
    const hardHttp = badResponses.filter(r => r.status >= 400 && !r.expected);
    const faviconOnly = hardHttp.filter(r => /favicon/i.test(r.url));
    assert(!hardConsole.length,
      `console error ${hardConsole.length} 条: ${hardConsole.slice(0, 6).map(e => `${e.text} @${e.url}`).join(' | ')}`);
    assert(!hardPage.length, `pageerror ${hardPage.length} 条: ${hardPage.slice(0, 4).map(e => `${e.text} @ ${e.stack}`).join(' | ')}`);
    assert(!hardHttp.length, `HTTP>=400: ${hardHttp.slice(0, 6).map(r => `${r.status} ${r.url}`).join(' | ')}`);
    assert(!nativeDialogs.length, `出现了原生弹窗（红线禁止）: ${nativeDialogs.join(' | ')}`);
    return `0 console error / 0 pageerror / 0 个 4xx（favicon 相关 ${faviconOnly.length} 条）` +
      `；断线用例期间预期网络错误 ${consoleErrors.length - hardConsole.length} 条已归档`;
  });

  await browser.close();

  /* ---------------------------------------------------------------- 汇总 */
  const pass = results.filter(r => r.status === 'pass').length;
  const fail = results.filter(r => r.status === 'fail');
  const skip = results.filter(r => r.status === 'skip');
  const summary = {
    base: BASE, out: `docs/verification/${OUT_NAME}`, full: FULL,
    startedAt: new Date().toISOString(),
    totals: { pass, fail: fail.length, skip: skip.length, checks: results.length },
    metrics,
    failed: fail.map(r => ({ id: r.id, title: r.title, detail: r.detail, evidence: r.evidence })),
    skipped: skip.map(r => ({ id: r.id, title: r.title, detail: r.detail })),
    consoleErrors, pageErrors, badResponses, nativeDialogs,
    results,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(summary, null, 2));
  console.log(`\n=== ${pass} pass / ${fail.length} fail / ${skip.length} skip  (out=${path.relative(ROOT, OUT_DIR)}) ===`);
  if (fail.length) {
    console.log('FAILED:');
    for (const f of fail) console.log(`  - ${f.id}: ${f.detail}`);
  }
  if (skip.length) {
    console.log('SKIPPED:');
    for (const s of skip) console.log(`  - ${s.id}: ${s.detail}`);
  }
  console.log('JSON:', JSON.stringify({ pass, fail: fail.length, skip: skip.length }));
  if (STRICT && fail.length) process.exit(1);
}

main().catch(e => {
  console.error('FATAL', e);
  process.exit(2);
});
