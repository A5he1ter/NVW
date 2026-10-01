import puppeteer from 'puppeteer-core';
import { spawn } from 'child_process';
import http from 'node:http';

const CHROME = process.env.NVW_CHROME ||
  '/Users/Katomoshi/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const PORT = 54322;
const BASE_URL = `http://127.0.0.1:${PORT}`;

console.log('🧪 Starting Browser Interaction E2E Verification Suite on', BASE_URL);

// 1. 启动独立隔离的测试 NVW 服务器
const srv = spawn('node', ['server.js'], {
  env: { ...process.env, NVW_PORT: String(PORT), NVW_HOST: '127.0.0.1' },
  stdio: ['pipe', 'pipe', 'pipe']
});

let serverReady = false;
srv.stdout.on('data', d => {
  if (d.toString().includes('Web UI:')) serverReady = true;
});

for (let i = 0; i < 30; i++) {
  if (serverReady) break;
  await new Promise(r => setTimeout(r, 200));
}

if (!serverReady) {
  console.error('Failed to start NVW server for browser verification');
  srv.kill();
  process.exit(1);
}
console.log('Server is ready on port', PORT);

async function fetchStatus() {
  return new Promise((resolve, reject) => {
    http.get(`${BASE_URL}/api/status`, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function fetchBuffers() {
  return new Promise((resolve, reject) => {
    http.get(`${BASE_URL}/api/buffers`, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const results = {};

let browser;
try {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  await page.goto(BASE_URL);
  await new Promise(r => setTimeout(r, 1200));

  // 1. 中文合成输入事件测试（compositionstart -> input -> compositionend）
  console.log('\n--- 1. Testing Chinese Composition Events (IME simulation) ---');
  await page.evaluate(() => {
    const input = document.querySelector('textarea[data-nvw-input]');
    input.focus();
    input.value = 'i';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.value = '你好，世界！这是一段中文输入测试。';
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 600));

  const imeText = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('#nvimTerminal span')).map(s => s.textContent).join('');
  });
  const imeMatchCount = (imeText.match(/你好，世界！这是一段中文输入测试。/g) || []).length;
  results.imeSingleSubmit = (imeMatchCount === 1) ? 'PASS' : `FAIL (count: ${imeMatchCount})`;
  console.log('IME typing single commit assertion:', results.imeSingleSubmit);

  // 2. 内置 Terminal 测试：区分命令本身与独立执行输出，联合 AND 验证真实 buftype
  console.log('\n--- 2. Testing Builtin Terminal Interaction ---');
  await page.evaluate(() => {
    const input = document.querySelector('textarea[data-nvw-input]');
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 200));

  await page.click('#nvimTerminal');
  await page.keyboard.type(':terminal');
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 1500));

  // 进入终端插入模式
  await page.keyboard.type('i');
  await new Promise(r => setTimeout(r, 200));

  // 键入 printf '%s%s\n' TERMINAL_EXEC_ OUT_SUCCESS
  // 命令源码中不包含纯粹连续的 "TERMINAL_EXEC_OUT_SUCCESS"，只有在 shell 真实执行后才会拼接输出该行
  await page.keyboard.type("printf '%s%s\\n' TERMINAL_EXEC_ OUT_SUCCESS", { delay: 20 });
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 1200));

  const termText = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('#nvimTerminal span')).map(s => s.textContent).join('');
  });
  const hasExecutedOutput = termText.includes('TERMINAL_EXEC_OUT_SUCCESS');
  
  // 严格使用 AND 联合验证当前 buffer 的真实 buftype 与独立执行输出
  const termStatus = await fetchStatus();
  const isTerminalBuftype = termStatus.buftype === 'terminal';
  results.terminalExecution = (hasExecutedOutput && isTerminalBuftype)
    ? 'PASS' : `FAIL (hasOutput: ${hasExecutedOutput}, buftype: "${termStatus.buftype}")`;
  console.log('Terminal command execution & distinct output assertion:', results.terminalExecution);

  // 退出 Terminal 插入模式：发送 <C-\><C-n>
  await page.keyboard.down('Control');
  await page.keyboard.press('Backslash');
  await page.keyboard.press('KeyN');
  await page.keyboard.up('Control');
  await new Promise(r => setTimeout(r, 300));

  // 3. 补全菜单与选择落入 buffer 真实断言（消除前置行假阳性）
  console.log('\n--- 3. Testing Completion & Selection into Buffer ---');
  await page.click('#nvimTerminal');
  await page.keyboard.type(':enew');
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 500));

  // 键入前置代码段与候选前缀
  await page.keyboard.type('iauto_target_identifier_xyz = 1\nauto_target_identifier_abc = 2\nauto');
  await new Promise(r => setTimeout(r, 400));

  // 获取补全触发前第三行的实际内容（应当仅为 "auto"）
  const lineBeforeCompletion = await page.evaluate(() => {
    const layer = document.querySelector('[data-nvw-layer="1"]');
    return layer?.children[2]?.textContent?.trim() || '';
  });

  // 发送 Ctrl+n 弹出补全并选择第一项，再发送 Ctrl+y 确认选入
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyN');
  await page.keyboard.up('Control');
  await new Promise(r => setTimeout(r, 400));

  await page.keyboard.down('Control');
  await page.keyboard.press('KeyY');
  await page.keyboard.up('Control');
  await new Promise(r => setTimeout(r, 400));

  // 获取补全确认后第三行的实际内容（应当变为完整的 "auto_target_identifier_xyz"）
  const lineAfterCompletion = await page.evaluate(() => {
    const layer = document.querySelector('[data-nvw-layer="1"]');
    return layer?.children[2]?.textContent?.trim() || '';
  });

  const completionReplaced = (lineBeforeCompletion === 'auto' || lineBeforeCompletion.endsWith('auto')) &&
    lineAfterCompletion.includes('auto_target_identifier_xyz');

  results.completionInserted = completionReplaced ? 'PASS' : `FAIL (before: "${lineBeforeCompletion}", after: "${lineAfterCompletion}")`;
  console.log('Completion selection transformed third line assertion:', results.completionInserted);

  // 4. 刷新重连保持完整状态（buffer 身份/行号/列号/模式/内容/光标）与继续编辑能力断言
  console.log('\n--- 4. Testing Refresh & Reconnect Full State Retention ---');
  // 按 Escape 退出插入模式，保持在明确的 Normal 模式
  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 300));

  // 获取重连前详细状态
  const statusBefore = await fetchStatus();
  const buffersBefore = await fetchBuffers();
  const textBefore = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('#nvimTerminal span')).map(s => s.textContent).join('');
  });
  const cursorBefore = await page.evaluate(() => {
    const cur = document.querySelector('[data-nvw-cursor]');
    return cur ? {
      width: cur.style.width,
      height: cur.style.height,
      left: cur.style.left,
      top: cur.style.top
    } : null;
  });

  // 开启新页面模拟客户端重连
  const page2 = await browser.newPage();
  await page2.setViewport({ width: 1440, height: 900 });
  await page.close();
  await page2.goto(BASE_URL);
  await new Promise(r => setTimeout(r, 1200));

  const statusAfter = await fetchStatus();
  const buffersAfter = await fetchBuffers();
  const textAfter = await page2.evaluate(() => {
    return Array.from(document.querySelectorAll('#nvimTerminal span')).map(s => s.textContent).join('');
  });
  const cursorAfter = await page2.evaluate(() => {
    const cur = document.querySelector('[data-nvw-cursor]');
    return cur ? {
      width: cur.style.width,
      height: cur.style.height,
      left: cur.style.left,
      top: cur.style.top
    } : null;
  });

  // 深度比对重连前后：buffer ID 保持、活动 buffer 一致、光标坐标位置与几何尺寸一致、屏幕文本完全一致
  const bufferIdentityRetained = (statusBefore.bufnr === statusAfter.bufnr && statusBefore.winid === statusAfter.winid);
  const modeAndPosRetained = (statusBefore.mode === statusAfter.mode && statusBefore.line === statusAfter.line && statusBefore.col === statusAfter.col);
  const cursorPositionRetained = (cursorBefore && cursorAfter && cursorBefore.left === cursorAfter.left && cursorBefore.top === cursorAfter.top && cursorBefore.width === cursorAfter.width);
  const textContentRetained = (textBefore === textAfter && textAfter.includes('auto_target_identifier_xyz'));

  // 验证在重连后依然可以继续正常输入与编辑
  await page2.click('#nvimTerminal');
  await page2.keyboard.type('i\nCONTINUE_EDITING_RECONNECT_OK');
  await page2.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 600));

  const textAfterContinue = await page2.evaluate(() => {
    return Array.from(document.querySelectorAll('#nvimTerminal span')).map(s => s.textContent).join('');
  });
  const canContinueEditing = textAfterContinue.includes('CONTINUE_EDITING_RECONNECT_OK');

  const fullStateAndEditable = bufferIdentityRetained && modeAndPosRetained && cursorPositionRetained && textContentRetained && canContinueEditing;

  results.reconnectStateRetained = fullStateAndEditable ? 'PASS' :
    `FAIL (bufId: ${bufferIdentityRetained}, modePos: ${modeAndPosRetained}, cursor: ${cursorPositionRetained}, text: ${textContentRetained}, editable: ${canContinueEditing})`;
  console.log('Client reconnect retained full state & editable assertion:', results.reconnectStateRetained);

} finally {
  if (browser) await browser.close();
  srv.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 300));
  try { srv.kill('SIGKILL'); } catch {}
}

console.log('\n📊 Browser Verification Summary:');
console.log(JSON.stringify(results, null, 2));

const allPassed = Object.values(results).every(v => v === 'PASS');
if (!allPassed) {
  console.error('Some browser verification assertions failed!');
  process.exit(1);
}
console.log('🎉 All Browser E2E Interaction Assertions PASSED!');
