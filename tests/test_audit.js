/**
 * NVW · WebTUI 纯度审计
 * 目标：证明前端不存在任何自写样式，一切均来自官方 WebTUI 组件与属性。
 * 运行：node tests/test_audit.js
 *
 * 第 1~8 项为 v1 基线（始终 13 项全绿）；第 9~15 项为契约 v2 扩充断言
 * （docs/UX-CONTRACT.md §1.1 / §2），只加不减、不放宽任何红线。
 */

import { strict as assert } from 'assert';
import fs from 'fs';

let pass = 0;
const ok = (label) => { console.log(`  ✔ ${label}`); pass += 1; };

console.log('\n🧪 NVW · WebTUI 纯度审计\n');

/* ---------- 1. 主题契约 ---------- */
console.log('1. 主题契约 themes/manifest.json');
const manifest = JSON.parse(fs.readFileSync('themes/manifest.json', 'utf8'));
for (const key of ['catppuccin-mocha', 'catppuccin-latte', 'nord', 'gruvbox-dark', 'everforest-dark', 'vitesse-dark', 'osmium']) {
  assert(manifest.themes[key], `缺少主题 ${key}`);
}
ok(`官方主题契约完整（${Object.keys(manifest.themes).length} 套）`);

/* ---------- 2. index.html 零自写样式 ---------- */
console.log('\n2. index.html 零自写样式');
const html = fs.readFileSync('public/index.html', 'utf8');
const inlineStyles = html.match(/\sstyle\s*=\s*"/g) || [];
assert.equal(inlineStyles.length, 0, `发现 ${inlineStyles.length} 处行内 style`);
ok('行内 style 属性：0');

const classes = html.match(/\sclass\s*=\s*"/g) || [];
assert.equal(classes.length, 0, `发现 ${classes.length} 处 class`);
ok('自定义 class 属性：0');

const styleBlocks = html.match(/<style[\s>]/g) || [];
assert.equal(styleBlocks.length, 0, `发现 ${styleBlocks.length} 个 <style> 块`);
ok('<style> 内联样式块：0');

/* ---------- 3. style.css 结构：官方资源 + 变量 + 受控外壳 ---------- */
console.log('\n3. style.css 结构');
const css = fs.readFileSync('public/style.css', 'utf8');
const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

// 用括号感知的方式提取所有 CSS 规则前导，区分 at-rule 与选择器
function extractRules(src) {
  const rules = [];
  let depth = 0, buf = '';
  for (const ch of src) {
    if (ch === '{') {
      const prelude = buf.trim();
      if (prelude) rules.push({ prelude, depth, atRule: prelude.startsWith('@') });
      depth += 1; buf = '';
    } else if (ch === '}') { depth -= 1; buf = ''; }
    else if (ch === ';' && depth === 0) { buf = ''; }
    else { buf += ch; }
  }
  return rules;
}

// 按名字取出某个 @layer 的完整块体（花括号配对）
function layerBody(name) {
  const m = new RegExp('@layer\\s+' + name + '\\s*\\{').exec(withoutComments);
  if (!m) return null;
  let i = m.index + m[0].length, depth = 1, start = i;
  for (; i < withoutComments.length && depth > 0; i += 1) {
    if (withoutComments[i] === '{') depth += 1;
    else if (withoutComments[i] === '}') depth -= 1;
  }
  return withoutComments.slice(start, i - 1);
}

const baseBody = layerBody('base');
assert(baseBody, '未找到 @layer base 块');
const baseSelectors = extractRules(baseBody).filter(r => !r.atRule).map(r => r.prelude);
assert.deepEqual(baseSelectors, [':root'], `@layer base 内应只有 :root，实际: ${baseSelectors.join(' | ')}`);
ok('@layer base 仅 :root（官方 Theming 变量入口）');

const nvwBody = layerBody('nvw');
assert(nvwBody, '未找到 @layer nvw 外壳规则块');
const nvwSelectors = extractRules(nvwBody).filter(r => !r.atRule).map(r => r.prelude);

// 全文件里除 @layer base 与 @layer nvw 之外，不允许出现任何选择器
const outsideBase = withoutComments.replace(baseBody, '').replace(nvwBody, '');
const straySelectors = extractRules(outsideBase).filter(r => !r.atRule).map(r => r.prelude);
assert.equal(straySelectors.length, 0, `存在游离于 @layer 之外的选择器: ${straySelectors.join(' | ')}`);
ok(`自写规则全部锁在 @layer nvw（${nvwSelectors.length} 条外壳规则），无一游离`);

const FORBIDDEN = ['border-radius', 'box-shadow', 'gradient', 'backdrop-filter', 'text-shadow', 'transition'];
const lower = withoutComments.toLowerCase();
for (const bad of FORBIDDEN) assert(!lower.includes(bad), `style.css 含非 TUI 视觉属性: ${bad}`);
assert(!withoutComments.includes('--box-border-width'), '不应覆盖官方 --box-border-width');
ok('无圆角/阴影/渐变/毛玻璃/动画，且未覆盖官方 --box-border-width');

const imports = [...css.matchAll(/@import\s+'([^']+)'/g)].map(m => m[1]);
const strayImports = imports.filter(i => !i.startsWith('./webtui/'));
assert.equal(strayImports.length, 0, `style.css 引入了非 WebTUI 资源: ${strayImports.join(', ')}`);
ok(`@import 全部指向官方 webtui 资源（${imports.length} 条）`);

/* ---------- 4. 客户端 JS 零自写类名输出 ---------- */
console.log('\n4. 客户端 JS 输出纯度');
for (const f of ['public/app.js', 'public/js/toast.js', 'public/js/api.js']) {
  const js = fs.readFileSync(f, 'utf8');
  const emitted = js.match(/class\s*=\s*["'`]/g) || [];
  assert.equal(emitted.length, 0, `${f} 仍在输出 class: ${emitted.length} 处`);
  const inline = js.match(/\.style\.[a-zA-Z]+\s*=|setAttribute\(\s*['"]style['"]/g) || [];
  assert.equal(inline.length, 0, `${f} 仍在写行内样式: ${inline.length} 处`);
  // documentElement.style.setProperty('--*') 属于设计令牌同步，允许；
  // 但不得对任何元素直接写样式
  const elemStyle = js.match(/(?<!documentElement)\.style\.(?!setProperty)/g) || [];
  assert.equal(elemStyle.length, 0, `${f} 直接改写元素样式: ${elemStyle.length} 处`);
}
ok('app.js / toast.js / api.js：零 class 输出、零行内样式写入');

/* ---------- 5. 禁用原生弹窗 ---------- */
console.log('\n5. 原生弹窗禁令');
for (const f of ['public/app.js', 'public/js/toast.js', 'public/js/api.js']) {
  const js = fs.readFileSync(f, 'utf8');
  for (const bad of ['prompt(', 'alert(', 'confirm(']) {
    assert(!js.includes(bad), `${f} 含 ${bad}`);
  }
}
ok('零 prompt / alert / confirm');

/* ---------- 6. 未覆盖 WebTUI 框线伪元素 ---------- */
console.log('\n6. WebTUI 框线完整性');
// 严禁关闭或改写 box- 依赖的 ::before / ::after
assert(!/::(before|after)\s*\{[^}]*\b(display|content)\s*:\s*(none|['"]{2})/.test(withoutComments),
  'style.css 关闭了 ::before / ::after');
const boxRuleOverrides = withoutComments.match(/[^{}]*\[box-[^\]]*\][^{}]*\{/g) || [];
const allowedBoxShellRules = boxRuleOverrides.filter(rule => /dialog\[size-=\"default\"\]\s*>\s*\[box-\]/.test(rule));
assert.equal(boxRuleOverrides.length, allowedBoxShellRules.length, `style.css 存在非外壳 [box-] 规则: ${boxRuleOverrides.join(' | ')}`);
// 也不允许用普通 border 冒充字符框线
assert(!/\bborder\s*:/.test(withoutComments.replace(/\/\*[\s\S]*?\*\//g, '')) ||
       !/\bsolid\b/.test(withoutComments), 'style.css 用普通 border 冒充 WebTUI 框线');
const appJs = fs.readFileSync('public/app.js', 'utf8');
assert(!appJs.includes('display:none') && !appJs.includes('display: none'), 'app.js 含内联 display:none');
ok('未关闭/改写 box- 的 ::before · ::after，也未用普通 border 冒充');

/* ---------- 7. 使用的官方组件清单 ---------- */
console.log('\n7. 实际使用的官方 WebTUI 组件');
const used = new Set();
for (const m of html.matchAll(/is-="([^"]+)"/g)) m[1].split(/\s+/).forEach(t => used.add(t));
for (const m of html.matchAll(/<([a-z]+)[\s>]/g)) if (['row', 'column'].includes(m[1])) used.add(m[1]);
const official = new Set(['accordion', 'badge', 'button', 'checkbox', 'dialog', 'input', 'mark', 'popover',
  'pre', 'progress', 'radio', 'range', 'separator', 'spinner', 'switch', 'table', 'tooltip', 'textarea',
  'typography', 'view', 'view-content', 'row', 'column',
  // 官方 tooltip 组件的触发器与内容槽
  'tooltip-trigger', 'tooltip-content']);
const unknown = [...used].filter(u => !official.has(u));
assert.equal(unknown.length, 0, `使用了非官方 is- 值: ${unknown.join(', ')}`);
ok(`is- 取值全部为官方组件：${[...used].sort().join(', ')}`);

/* ---------- 8. 官方资源完整性 ---------- */
console.log('\n8. 官方资源与离线资产');
for (const f of ['public/webtui/css/full.css', 'public/webtui/plugin-declarative-layout/index.css',
  'public/webtui/plugin-nf/index.css', 'server/nvim-embed.js', 'public/js/grid-renderer.js', 'public/js/input.js']) {
  assert(fs.existsSync(f), `缺少 ${f}`);
}
ok('WebTUI 官方组件库/插件 + nvim 常驻通道/网格渲染器齐备');
// 旧栈必须彻底消失：终端模拟器、DPR 补丁、PTY 依赖都不该再出现在仓库里
for (const gone of ['public/vendor/xterm', 'public/js/dpi-bootstrap.js']) {
  assert(!fs.existsSync(gone), `旧栈残留: ${gone}`);
}
assert(!/"node-pty"/.test(fs.readFileSync('package.json', 'utf8')), 'package.json 仍依赖 node-pty');
assert(!/from 'node-pty'/.test(fs.readFileSync('server.js', 'utf8')), 'server.js 仍引用 node-pty');
ok('旧栈已清除：无 xterm / 无 dpi-bootstrap / 无 node-pty');

/* ======================================================================
   以下为契约 v2（docs/UX-CONTRACT.md）扩充断言
   ====================================================================== */

// 取 index.html 中包含某 id 的整个开标签
const tagFor = (id) => (html.match(new RegExp(`<[^>]*\\sid="${id}"[^>]*>`)) || [])[0] || '';

/* ---------- 9. 契约 §2 DOM 完整性 ---------- */
console.log('\n9. 契约 §2 DOM 完整性');
const CONTRACT_IDS = [
  // §2.1 顶栏
  'home-link', 'btnWorkspace', 'currentWorkspaceText', 'btnTheme', 'themeLabel',
  'btnOpenSettings', 'btnOpenKeymap', 'search-button',
  // §2.2 / §2.3 弹层
  'workspacePanel', 'recentProjectsList', 'btnOpenNewWorkspaceModal', 'btnWorkspaceClose',
  'themePanel', 'themePickerList', 'btnThemeClose',
  // §2.4 文件树
  'sidebar', 'sidebar-root', 'explorerRoot', 'treeCount', 'tree-filter-wrap', 'treeFilter',
  'category-container', 'category-list', 'sidebar-actions',
  'nav-btn-new-file', 'nav-btn-new-folder', 'nav-btn-refresh', 'nav-btn-zen', 'nav-btn-find', 'btnCollapseAll',
  // §2.5 编辑器
  'editorArticle', 'activeDocTitle', 'activeDocPath', 'editor-header-right', 'buffer-tabs',
  'bufferCount', 'btnNewBuffer', 'wsStatusBadge', 'editor-body', 'nvimTerminal',
  // §2.6 状态栏（R2-5 已删除 #statusBuffers：与标签栏 #bufferCount 重复）
  'statusline', 'statusMode', 'zenBadge', 'statusWorkspace', 'statusBuffer', 'statusRight',
  'statusConnection', 'btnReconnect', 'statusCursor', 'statusFiletype', 'statusWritable',
  // §2.7 查找
  'search-dialog', 'search-content', 'close-btn', 'search-input', 'searchSpinner', 'search-count',
  'search-results', 'search-results-container',
  // §2.8 目录浏览器（R2-7 新增 #wsBrowserListWrap 框线滚动容器）
  'workspaceBrowserDialog', 'wsBrowserClose', 'wsBrowserUp', 'wsBrowserPath', 'wsBrowserError',
  'wsBrowserListWrap', 'wsBrowserList', 'wsBrowserCancel', 'wsBrowserUse',
  'inputWorkspacePath', 'btnConfirmWorkspaceModal',
  // §2.9 其它模态
  'newItemDialog', 'newItemDialogTitle', 'newItemHint', 'newItemPromptLabel', 'inputNewItemName',
  'newItemError', 'btnCloseNewItemDialog', 'btnCancelNewItem', 'btnConfirmNewItem',
  'settingsDialog', 'btnCloseSettings', 'settingFontSizeDisplay', 'settingFontSizeRange',
  'settingLineHeightDisplay', 'settingLineHeightRange', 'settingCursorBlink', 'btnResetSettings', 'btnSaveSettings',
  'keymapDialog', 'keymapTableBody', 'btnCloseKeymap',
  'unsavedGuardDialog', 'unsavedGuardMessage', 'btnCloseUnsavedDialog', 'btnUnsavedCancel',
  'btnUnsavedDiscard', 'btnUnsavedSaveClose',
  'toastDialog', 'toastList'
];
const missingIds = CONTRACT_IDS.filter(id => !tagFor(id));
assert.equal(missingIds.length, 0, `index.html 缺少契约 §2 元素: ${missingIds.join(', ')}`);
ok(`契约 §2 全部 ${CONTRACT_IDS.length} 个 id 均在 HTML 中真实存在`);

// §2.8 明确「取代」的旧 id 必须消失（否则出现重复 id 与幽灵引用）
const REMOVED_IDS = ['workspaceModal', 'btnCloseWorkspaceModal', 'btnCancelWorkspaceModal', 'workspaceModalError'];
const leftovers = REMOVED_IDS.filter(id => tagFor(id));
assert.equal(leftovers.length, 0, `§2.8 已作废的旧 id 仍存在: ${leftovers.join(', ')}`);
ok('旧 #workspaceModal 系列 id 已彻底移除（§2.8 取代）');

// §2.1：原 <a href="#"> 必须改成 button，且 title / aria-label 齐备
for (const id of ['btnWorkspace', 'btnTheme', 'btnOpenSettings', 'btnOpenKeymap', 'search-button']) {
  const tag = tagFor(id);
  assert(/^<button\b/.test(tag), `#${id} 必须是 <button>：<a href="#"> 会把地址栏变成 /#`);
  assert(/\stitle="/.test(tag), `#${id} 缺 title`);
  assert(/\saria-label="/.test(tag), `#${id} 缺 aria-label`);
}
assert(/id="home-link"[^>]*\shref="\/"/.test(html) || /href="\/"[^>]*\sid="home-link"/.test(html),
  '#home-link 必须是 href="/"（原 href="#" 会污染地址栏）');
ok('顶栏 5 个按钮均为 <button> 且 title / aria-label 齐备，home-link 指向 /');

// §2.4：sidebar-actions 的 5 个既有按钮 tooltip 文案与 aria-label
const SIDEBAR_ACTIONS = [
  ['nav-btn-new-file', 'New file'], ['nav-btn-new-folder', 'New directory'],
  ['nav-btn-refresh', 'Reload tree'], ['nav-btn-zen', 'Zen mode'], ['nav-btn-find', 'Find file']
];
for (const [id, label] of SIDEBAR_ACTIONS) {
  const tag = tagFor(id);
  assert(new RegExp(`\\stitle="${label}"`).test(tag), `#${id} 的 title 应为 ${label}`);
  assert(new RegExp(`\\saria-label="${label}"`).test(tag), `#${id} 的 aria-label 应为 ${label}`);
  assert(html.includes(`>${label}</span>`), `#${id} 的 tooltip 文案应为 ${label}`);
}
const collapseTag = tagFor('btnCollapseAll');
assert(/title="Collapse all"/.test(collapseTag) && /aria-label="Collapse all"/.test(collapseTag),
  '#btnCollapseAll 的 title / aria-label 应为 Collapse all');
assert(html.includes('>&#xf102;</button>') && html.includes('>Collapse all</span>'),
  'R2-4：#btnCollapseAll 字形应为 Nerd Font &#xf102;（几何符号 ⤒ 在 JetBrains Mono 里渲染异常）');
assert(!html.includes('⤒'), 'R2-4：不应再出现几何符号 ⤒');
ok('侧栏 6 个动作按钮 tooltip 文案 + aria-label 与契约逐字一致，⤒ 已换 NF 字形');

/* ---------- 10. variant- / cap- 取值白名单（§1.1） ---------- */
console.log('\n10. variant- / cap- 白名单（契约 §1.1，防跨主题裸文字）');
const VARIANT_WHITELIST = new Set(['foreground0', 'foreground1', 'foreground2',
  'background0', 'background1', 'background2', 'background3']);

// spinner 的 variant- 是形态而非配色（官方 spinner.css：dots|arrows|cross|square|pie|half|bar-*|cursor）
const SPINNER_VARIANTS = new Set(['dots', 'arrows', 'cross', 'square', 'pie', 'half',
  'bar-vertical', 'bar-horizontal', 'cursor']);
const htmlVariantValues = [];
const badHtmlVariants = [];
for (const tag of html.match(/<[^>]*\svariant-[^>]*>/g) || []) {
  const allowed = /is-="spinner"/.test(tag) ? SPINNER_VARIANTS : VARIANT_WHITELIST;
  for (const m of tag.matchAll(/\svariant-[^=]*="([^"]*)"/g)) {
    for (const v of m[1].split(/\s+/).filter(Boolean)) {
      htmlVariantValues.push(v);
      if (!allowed.has(v)) badHtmlVariants.push(v);
    }
  }
}
assert(htmlVariantValues.length >= 10, `HTML variant- 扫描命中过少（${htmlVariantValues.length}），断言可能失效`);
assert.equal(badHtmlVariants.length, 0,
  `index.html 含非官方 variant- 值（跨主题会渲染成无底色裸文字）: ${[...new Set(badHtmlVariants)].join(', ')}`);

const BADGE_CAPS = new Set(['round', 'triangle', 'slant-top', 'slant-bottom', 'ribbon']);
const SEPARATOR_CAPS = new Set(['bisect', 'edge']);
const badCaps = [];
for (const tag of html.match(/<[^>]*\scap-[^>]*>/g) || []) {
  const allowed = /is-="separator"/.test(tag) ? SEPARATOR_CAPS : BADGE_CAPS;
  for (const m of tag.matchAll(/\scap-[^=]*="([^"]*)"/g)) {
    for (const v of m[1].split(/\s+/).filter(Boolean)) if (!allowed.has(v)) badCaps.push(v);
  }
}
assert.equal(badCaps.length, 0, `index.html 含非官方 cap- 取值: ${[...new Set(badCaps)].join(', ')}`);
ok(`HTML variant- 全部命中官方取值（配色 ${htmlVariantValues.length} 处 / 含 spinner 形态）；cap- 全部命中官方形状`);

// JS 端：防止再写回 green / red / mauve 等主题私有色名
function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
// 属性形式 variant-="X"/variant-="${…'X'…}"，以及 setAttribute('variant-', <表达式>) 里的值位字面量
function variantLiterals(src) {
  const out = [];
  const re = /variant-/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const component = /is-="spinner"/.test(src.slice(Math.max(0, m.index - 160), m.index)) ? 'spinner' : 'color';
    const rest = src.slice(m.index + 8, m.index + 8 + 600);
    const push = (v) => out.push({ v, component });
    const attr = /^\s*=\s*(["'`])([\s\S]*?)\1/.exec(rest);
    if (attr) {
      if (attr[2].includes('${')) {
        // 模板表达式：取其中的值位字面量（variant-="${a ? 'foreground0' : 'background0'}"）
        for (const lit of attr[2].matchAll(/'([A-Za-z0-9_-]+)'|"([A-Za-z0-9_-]+)"/g)) push(lit[1] || lit[2]);
      } else {
        for (const v of attr[2].split(/\s+/).filter(Boolean)) push(v);
      }
      continue;
    }
    const call = /^["']\s*,\s*([^;]{0,300})/.exec(rest);
    if (call) {
      const valPos = /(?:^|[?:,]|(?<![=!<>])=|\|\||&&|\()\s*(['"])([A-Za-z0-9_-]+)\1/g;
      for (const lit of call[1].matchAll(valPos)) push(lit[2]);
    }
  }
  return out;
}
const badJsVariants = [];
let jsVariantHits = 0;
const scannedJs = ['public/app.js', ...jsFiles('public/js')];
for (const f of scannedJs) {
  for (const { v, component } of variantLiterals(fs.readFileSync(f, 'utf8'))) {
    jsVariantHits += 1;
    const allowed = component === 'spinner' ? SPINNER_VARIANTS : VARIANT_WHITELIST;
    if (!allowed.has(v)) badJsVariants.push(`${f}:${v}`);
  }
}
assert(jsVariantHits >= 10, `JS variant- 扫描命中过少（${jsVariantHits}），断言可能失效`);
assert.equal(badJsVariants.length, 0,
  `JS 里出现非官方 variant- 字面量（主题私有色名跨主题失效）: ${[...new Set(badJsVariants)].join(', ')}`);
ok(`JS variant- 字面量全部合法（${scannedJs.length} 个文件 / ${jsVariantHits} 处）`);

/* ---------- 11. 模态属性合法性 ---------- */
console.log('\n11. 模态 size- / position- / container- 合法性');
const OFFICIAL_SIZE = new Set(['small', 'default', 'full']);
const OFFICIAL_AXIS = new Set(['start', 'end', 'center']);
const OFFICIAL_CONTAINER = new Set(['auto', 'fill']);
const dialogTags = [...html.matchAll(/<dialog\b[^>]*>/g)].map(m => m[0]);
assert(dialogTags.length >= 8, `dialog 数量异常: ${dialogTags.length}`);
const badDialogs = [];
for (const tag of dialogTags) {
  const id = (tag.match(/\sid="([^"]+)"/) || [])[1] || '(无 id)';
  const size = (tag.match(/\ssize-="([^"]+)"/) || [])[1];
  const position = ((tag.match(/\sposition-="([^"]+)"/) || [])[1] || '').split(/\s+/).filter(Boolean);
  const container = ((tag.match(/\scontainer-="([^"]+)"/) || [])[1] || '').split(/\s+/).filter(Boolean);
  if (size && !OFFICIAL_SIZE.has(size)) badDialogs.push(`${id}:size-="${size}"`);
  position.forEach((v, i) => { if (!OFFICIAL_AXIS.has(v)) badDialogs.push(`${id}:position-[${i}]=${v}`); });
  container.forEach((v, i) => { if (!OFFICIAL_CONTAINER.has(v)) badDialogs.push(`${id}:container-[${i}]=${v}`); });
}
assert.equal(badDialogs.length, 0, `非官方 dialog 取值: ${badDialogs.join(', ')}`);
// §2.8 依靠 size-="default" 继承滚动兜底；§2.7 保持 size-="small"
assert(/\ssize-="default"/.test(tagFor('workspaceBrowserDialog')),
  '#workspaceBrowserDialog 必须 size-="default" 才能继承 dialog[size-="default"] > [box-] 滚动兜底');
assert(/\scontainer-="fill auto"/.test(tagFor('workspaceBrowserDialog')), '#workspaceBrowserDialog container-="fill auto"');
assert(/\ssize-="small"/.test(tagFor('search-dialog')), '#search-dialog 应保持 size-="small"');
ok(`${dialogTags.length} 个 dialog 的 size- / position- / container- 全为官方取值，新模态可滚动兜底`);

/* ---------- 12. 快捷键徽标与文档表 ---------- */
console.log('\n12. data-hotkey 徽标 + #keymapTableBody');
const KEYMAP_IDS = new Set(['find', 'findTree', 'zen', 'settings', 'docs', 'save', 'closeBuffer',
  'newBuffer', 'nextBuffer', 'prevBuffer', 'focusTerminal', 'reconnect']);
const hotkeyTags = [...html.matchAll(/<span[^>]*\sdata-hotkey="([^"]+)"[^>]*>/g)];
assert.equal(hotkeyTags.length, 3, `[data-hotkey] 徽标应恰好 3 个（settings/docs/find），实际 ${hotkeyTags.length}`);
for (const m of hotkeyTags) {
  assert(KEYMAP_IDS.has(m[1]), `data-hotkey="${m[1]}" 不是契约 §4 的 KEYMAP id`);
  assert(/is-="badge"/.test(m[0]), `data-hotkey="${m[1]}" 的元素必须是 is-="badge"`);
  assert(/variant-="background2"/.test(m[0]), `data-hotkey="${m[1]}" 的徽标应为 variant-="background2"`);
}
assert(!/data-hotkey="[^"]*"[^>]*>[^<]/.test(html), '[data-hotkey] 徽标应是空元素（文案由 keymap.js 填充）');
assert(/<tbody id="keymapTableBody"><\/tbody>/.test(html),
  '#keymapTableBody 必须是空 <tbody>（行由 shortcuts.js 从 KEYMAP 单一真源生成）');
assert(/<thead>[\s\S]*?<th>Key<\/th>[\s\S]*?<th>Action<\/th>[\s\S]*?<th>Group<\/th>[\s\S]*?<\/thead>/.test(html),
  '#keymapDialog 表头应为 Key / Action / Group 三列');
ok('3 个 [data-hotkey] 徽标命中 KEYMAP id，文档表 tbody 为空且三列齐备');

/* ---------- 13. favicon ---------- */
console.log('\n13. favicon（控制台 404 必须消失）');
assert(/<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/.test(html), '缺少 favicon link');
assert(fs.existsSync('public/favicon.svg'), '缺少 public/favicon.svg');
const favicon = fs.readFileSync('public/favicon.svg', 'utf8');
assert(!/<style[\s>]/.test(favicon), 'favicon.svg 含 <style> 块');
assert(!/\sclass=/.test(favicon), 'favicon.svg 含 class');
assert(!/\sstyle=/.test(favicon), 'favicon.svg 含行内 style');
assert(/<svg[\s>]/.test(favicon) && favicon.includes('</svg>'), 'favicon.svg 不是完整 SVG');
assert((favicon.match(/#[0-9a-fA-F]{6}/g) || []).length >= 3, 'favicon.svg 应显式声明深色底 + 青/紫前景三色');
ok('favicon.svg 纯字符 TUI（深色底 + 青/紫前景，无 <style>/class/style=），link 已挂 head');

/* ---------- 14. hidden 显隐 + 新外壳规则落地 ---------- */
console.log('\n14. hidden 显隐与外壳规则落地');
for (const id of ['zenBadge', 'btnReconnect', 'searchSpinner']) {
  assert(/\shidden[\s>]/.test(tagFor(id)), `#${id} 应带 hidden 属性（初始隐藏）`);
}
// 官方组件把 display 写死在 badge/spinner/button 上，会盖掉 UA 的 [hidden]{display:none}
assert(/\[hidden\]\s*\{\s*display:\s*none/.test(withoutComments),
  'style.css 必须修回被官方组件 display 覆盖掉的 [hidden] 显隐');
for (const [selector, why] of [
  ['#wsBrowserList button', '目录浏览器条目左对齐'],
  ['#buffer-tabs > row', '标签页 label + 关闭按钮成组'],
  ['#treeFilter', '过滤框贴合 32ch 侧栏'],
  ['#wsBrowserList', '目录列表独立滚动']
]) {
  assert(nvwSelectors.includes(selector), `style.css 缺少外壳规则 ${selector}（${why}）`);
}
// 暗色 TUI 滚动条：系统亮色轨道会在暗色面板上拉出白条（Lead 实测缺陷）
assert(/#category-list[\s\S]{0,200}scrollbar-color:\s*var\(--background3\)\s+transparent/.test(withoutComments),
  'style.css 必须把 #category-list 等滚动条改成暗色（scrollbar-color: var(--background3) transparent）');
// 编辑器头部：标题/路径 与 标签栏 之间必须有官方纵向分隔线，否则路径会被误读成 tab
assert(/<span is-="separator" direction-="y" cap-="edge"><\/span>/.test(html),
  '编辑器头部缺少 is-="separator" direction-="y" 分隔线');
assert(/#buffer-tabs\s*\{[^}]*max-width:/.test(withoutComments),
  '#buffer-tabs 必须有 max-width 边界，防止标签栏吃掉标题与路径');
ok('#zenBadge / #btnReconnect / #searchSpinner 初始 hidden，[hidden] 兜底、暗色滚动条、头部纵向分隔线与 4 条外壳规则齐备');

/* ---------- 15. [box-] 选择器白名单精确性 ---------- */
console.log('\n15. [box-] 选择器白名单');
assert.equal(boxRuleOverrides.length, 1,
  `style.css 应仅 1 条 [box-] 选择器（官方模态滚动兜底），实际 ${boxRuleOverrides.length} 条: ${boxRuleOverrides.join(' | ')}`);
const boxRulePrelude = boxRuleOverrides[0].replace(/\{\s*$/, '').trim();
assert(/^dialog\[size-="default"\]\s*>\s*\[box-\]$/.test(boxRulePrelude),
  `[box-] 规则必须恰为 dialog[size-="default"] > [box-]，实际: ${boxRuleOverrides[0]}`);
ok('style.css 仅 1 条 [box-] 选择器，且是模态滚动兜底白名单项');

/* ---------- 16. Round 2 契约（R2-3 / R2-4 / R2-5 / R2-6 / R2-7 / R2-8） ---------- */
console.log('\n16. Round 2 契约（用户实机反馈）');

// R2-8 页面铺满：100vw/100vh 在滚动条存在时宽于可视区 → 改 100% + overflow:hidden
const viewportRule = /body,\s*html\s*\{[^}]*\}/.exec(withoutComments);
assert(viewportRule, 'style.css 缺少 body,html 视口规则');
assert(/width:\s*100%/.test(viewportRule[0]) && /height:\s*100%/.test(viewportRule[0]),
  'R2-8：body,html 必须用 100% / 100%');
assert(!/100vw|100vh/.test(withoutComments), 'R2-8：style.css 不得再出现 100vw / 100vh');
assert(/overflow:\s*hidden/.test(viewportRule[0]), 'R2-8：body,html 需要 overflow:hidden 兜底');

// R2-4 侧栏脚栏：带框 + 幽灵按钮 + NF 字形
const actionsTag = tagFor('sidebar-actions');
assert(/box-="square"/.test(actionsTag) && /shear-="top"/.test(actionsTag),
  'R2-4：#sidebar-actions 应为 box-="square" shear-="top" 带框脚栏');
const actionButtonTags = [...html.matchAll(/<button[^>]*\sid="(?:nav-btn-[a-z-]+|btnCollapseAll)"[^>]*>/g)];
assert.equal(actionButtonTags.length, 6, `R2-4：侧栏脚栏应有 6 个按钮，实际 ${actionButtonTags.length}`);
for (const m of actionButtonTags) {
  assert(/variant-="background0"/.test(m[0]),
    `R2-4：${(m[0].match(/id="([^"]+)"/) || [])[1]} 应为幽灵态 variant-="background0"（不再是灰方块）`);
}

// R2-5 状态栏：无 box-/shear-、满幅实底、删 #statusBuffers、filetype 空时 hidden
const statusTag = tagFor('statusline');
assert(!/\sbox-="/.test(statusTag), 'R2-5：#statusline 不应再有 box-（框线贴死窗口边）');
assert(!/\sshear-="/.test(statusTag), 'R2-5：#statusline 不应再有 shear-');
assert(!tagFor('statusBuffers'), 'R2-5：#statusBuffers 元素应已删除（与 #bufferCount 重复）');
assert(/\shidden[\s>]/.test(tagFor('statusFiletype')), 'R2-5：#statusFiletype 初始应 hidden（不再显示 no ft）');
assert(/#statusline\s*\{[^}]*background-color:\s*var\(--background1\)/.test(withoutComments),
  'R2-5：#statusline 应为 --background1 满幅实底条');
assert(/#statusline\s*\{[^}]*padding:\s*0\s+1ch/.test(withoutComments),
  'R2-5：#statusline 左右需各留 1ch 内边距');

// R2-6 工作区弹层：列表左对齐 + 分隔线 + Browse…/Esc 同排两端对齐 + 统一宽度
const wsPanelStart = html.indexOf('id="workspacePanel"');
const wsPanelEnd = html.indexOf('<!-- 主题弹层 -->');
assert(wsPanelStart > 0 && wsPanelEnd > wsPanelStart, '未定位到 #workspacePanel 区块');
const wsPanel = html.slice(wsPanelStart, wsPanelEnd);
assert(/<separator is-="separator" cap-="bisect"><\/separator>/.test(wsPanel),
  'R2-6：列表与动作区之间应有 is-="separator" cap-="bisect"');
assert(/<row align-="between" gap-="1">\s*<button size-="small" id="btnOpenNewWorkspaceModal"/.test(wsPanel),
  'R2-6：Browse… 与 Esc to close 必须在同一 row align-="between" 内，且留 1 格间距');
// 提示徽标必须"降噪"：foreground2 是亮底芯片，和按钮同权重会读成一个合并控件
assert(/id="workspacePanelHint"[^>]*variant-="background1"|variant-="background1"[^>]*id="workspacePanelHint"/.test(wsPanel),
  'R2-6：Esc to close 提示徽标应为 background1（降噪），不得用 foreground2');
assert(/#workspacePanel\s*\{\s*min-width:\s*26ch/.test(withoutComments),
  'R2-6：工作区弹层需统一最小宽度 26ch');

// R2-7 目录浏览器：列表套框线滚动容器、路径尾部可见、动作行与列表同左边距
assert(/<div box-="square" id="wsBrowserListWrap">\s*<div id="wsBrowserList"><\/div>/.test(html),
  'R2-7：#wsBrowserList 必须包在 box-="square" 的 #wsBrowserListWrap 内（id 不变，workspace-browser.js 依赖）');
assert(/#wsBrowserPath[\s\S]{0,240}text-align:\s*left/.test(withoutComments),
  'R2-7：路径徽标需左对齐');
// 尾部省略改由 JS 的 tailPath() 完成（direction:rtl 会把开头的 / 经 bidi 重排到行尾，已废弃）
assert(/function tailPath\(/.test(fs.readFileSync('public/js/workspace-browser.js', 'utf8')),
  'R2-7：路径尾部省略应由 workspace-browser.js 的 tailPath() 负责');
assert(!/#wsBrowserPath[\s\S]{0,240}direction:\s*rtl/.test(withoutComments),
  'R2-7：不应再用 direction: rtl 做首部省略（bidi 会重排开头的 /）');
assert(/#workspaceBrowserDialog row\s*\{\s*padding:\s*0\s+1ch/.test(withoutComments),
  'R2-7：动作行/输入行需与列表内容同左边距');

// R2-3 标签条：吃满剩余宽度 + 可见滚动条 + label 省略
assert(/#buffer-tabs\s*\{[^}]*flex:\s*1 1 auto/.test(withoutComments), 'R2-3：#buffer-tabs 应 flex: 1 1 auto');
assert(/#buffer-tabs\s*\{[^}]*max-width:\s*none/.test(withoutComments), 'R2-3：#buffer-tabs 应 max-width: none');
// 关键：官方 align-="center" 会同时命中 align-items 与 justify-content，
// 溢出时居中会让左侧溢出不属于可滚动区域（标签够不着）——必须钉死 flex-start
assert(/#buffer-tabs\s*\{[^}]*justify-content:\s*flex-start/.test(withoutComments),
  'R2-3：#buffer-tabs 必须 justify-content: flex-start（否则居中导致左侧溢出不可滚动到达）');
assert(!/#buffer-tabs::-webkit-scrollbar\s*\{\s*display:\s*none/.test(withoutComments),
  'R2-3：不得再隐藏标签条滚动条（用户没有任何抓手）');
assert(/#buffer-tabs\s*\{[^}]*scrollbar-color:\s*var\(--background3\)\s+transparent/.test(withoutComments),
  'R2-3：标签条滚动条应为暗色细条');
assert(/#buffer-tabs button\[data-bufnr\]\s*\{[^}]*max-width:\s*22ch/.test(withoutComments),
  'R2-3：label 按钮需限宽 22ch');
assert(/\[data-tab-label\]\s*\{[^}]*text-overflow:\s*ellipsis/.test(withoutComments),
  'R2-3：[data-tab-label] 需 display:block + 省略号');
ok('Round 2 六项：铺满 / 脚栏 / 状态栏满幅 / 工作区弹层 / 目录浏览器 / 标签条滚动条 全部落地');

const declaredVars = [...new Set([...withoutComments.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map(m => m[1].toLowerCase()))];
console.log(`\n  声明的 CSS 变量: ${declaredVars.join(', ')}`);
console.log(`  扫描的客户端 JS: ${scannedJs.join(', ')}`);
console.log(`\n🎉 审计全部通过（${pass} 项）\n`);
