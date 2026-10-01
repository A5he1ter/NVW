import { NvimEmbed } from '../server/nvim-embed.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvw-e05-test-'));
const testFile = path.join(tmpDir, 'test-doc.txt');

console.log('🚀 Running E05 Authentic Neovim Editing Suite...');
console.log('Temporary workspace:', tmpDir);

const n = new NvimEmbed({ cwd: tmpDir, cols: 80, rows: 24 });
await n.start();

const results = {};

try {
  // 1. 写盘测试 (Writing to disk)
  await n.command(`edit ${testFile}`);
  await n.input('iHello NVW WebUI World!\nSecond Line<Esc>');
  await n.command('write');
  const written = fs.readFileSync(testFile, 'utf8');
  results.write = written.includes('Hello NVW WebUI World!') ? 'PASS' : 'FAIL';
  console.log('1. Write to disk:', results.write);

  // 2. 撤销/重做测试 (Undo / Redo)
  await n.input('oExtra Line Added<Esc>');
  let linesAfterAdd = await n.rpc('nvim_buf_get_lines', 0, 0, -1, false);
  await n.input('u');
  let linesAfterUndo = await n.rpc('nvim_buf_get_lines', 0, 0, -1, false);
  results.undo = (linesAfterUndo.length === linesAfterAdd.length - 1) ? 'PASS' : 'FAIL';
  console.log('2. Undo:', results.undo);

  // 3. 寄存器与宏测试 (Registers & Macros)
  await n.input('gg0qqiPRE: <Esc>q');
  await n.input('j0@q');
  const firstLine = (await n.rpc('nvim_buf_get_lines', 0, 0, 1, false))[0];
  const secondLine = (await n.rpc('nvim_buf_get_lines', 0, 1, 2, false))[0];
  results.macro = (firstLine.startsWith('PRE: ') && secondLine.startsWith('PRE: ')) ? 'PASS' : 'FAIL';
  console.log('3. Register & Macro (@q):', results.macro);

  // 4. 分屏测试 (Splits)
  await n.command('vsplit');
  const winCount = (await n.rpc('nvim_list_wins')).length;
  results.split = (winCount === 2) ? 'PASS' : 'FAIL';
  console.log('4. Window split (vsplit):', results.split);

  // 5. 浮窗测试 (Floating Windows)
  const floatBuf = await n.rpc('nvim_create_buf', false, true);
  const floatWin = await n.rpc('nvim_open_win', floatBuf, true, {
    relative: 'editor',
    row: 3,
    col: 5,
    width: 20,
    height: 5,
    border: 'single'
  });
  const isFloat = await n.rpc('nvim_win_is_valid', floatWin);
  results.floating = isFloat ? 'PASS' : 'FAIL';
  await n.rpc('nvim_win_close', floatWin, true);
  console.log('5. Floating window:', results.floating);

  // 6. 内置 Terminal 测试 (Builtin Terminal)
  await n.command('enew');
  await n.command('terminal');
  await new Promise(r => setTimeout(r, 400));
  const buftype = await n.rpc('nvim_get_option_value', 'buftype', {});
  results.terminal = (buftype === 'terminal') ? 'PASS' : 'FAIL';
  console.log('6. Builtin terminal (:terminal):', results.terminal);

  // 7. 补全与弹出菜单测试 (Completion popup)
  await n.command('enew');
  await n.input('i');
  await n.rpc('nvim_exec_lua', 'vim.fn.complete(1, {\"autocompletion_test_variable\", \"auto_another\"})', []);
  const pumvisible = await n.rpc('nvim_exec_lua', 'return vim.fn.pumvisible()', []);
  results.completion = (pumvisible === 1) ? 'PASS' : 'FAIL';
  console.log('7. Native completion popup (vim.fn.complete):', results.completion);
  await n.input('<Esc>');

} finally {
  await n.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('\n📊 Summary of Editing Features:');
console.log(JSON.stringify(results, null, 2));

const allPass = Object.values(results).every(v => v === 'PASS');
if (!allPass) {
  console.error('Some tests failed!');
  process.exit(1);
}
console.log('🎉 All E05 Authentic Neovim Editing Tests PASSED!');
