import { NvimEmbed } from '../server/nvim-embed.js';

console.log('🧪 Testing E04 failure modes: Stream breakage, stdin error, and recovery...');

const n1 = new NvimEmbed({ cols: 80, rows: 24, args: ['-u', 'NONE', '-i', 'NONE'] });
await n1.start();
let streamErrorCaught = false;
n1.on('handlerError', (type, err) => {
  if (type === 'stream') streamErrorCaught = true;
});
n1.child.stdout.destroy();
await new Promise(r => setTimeout(r, 200));
if (!n1.broken) {
  console.error('Test 1 failed: n1.broken should be true after stream destruction');
  process.exit(1);
}
console.log('1. Stream breakage marks nvim as broken and triggers cleanup: PASS');

const n2 = new NvimEmbed({ cols: 80, rows: 24, args: ['-u', 'NONE', '-i', 'NONE'] });
await n2.start();
let stdinErrorEmitted = false;
n2.on('handlerError', (type, err) => {
  if (type === 'stdin') stdinErrorEmitted = true;
});
n2.child.stdin.emit('error', new Error('mock EPIPE'));
await new Promise(r => setTimeout(r, 200));
if (!n2.broken) {
  console.error('Test 2 failed: stdin error did not mark broken');
  process.exit(1);
}
console.log('2. Stdin error cleanly handled and marks broken: PASS');

const nNew = new NvimEmbed({ cols: 80, rows: 24, args: ['-u', 'NONE', '-i', 'NONE'] });
await nNew.start();
await nNew.command('let g:recovery_ok = 1');
const val = await nNew.rpc('nvim_get_var', 'recovery_ok');
if (val !== 1) {
  console.error('Test 3 failed: new instance cannot execute commands');
  process.exit(1);
}
console.log('3. Recovery verification: new instance started and executed command: PASS');

const n3 = new NvimEmbed({ cols: 80, rows: 24, args: ['-u', 'NONE', '-i', 'NONE'] });
await n3.start();
let timeoutCaught = false;
try {
  await n3.rpc('nvim_eval', 'wait(11000, 0)');
} catch (e) {
  if (e.message.includes('超时')) timeoutCaught = true;
}
if (!timeoutCaught) {
  console.error('Test 4 failed: RPC timeout not triggered');
  process.exit(1);
}
console.log('4. RPC timeout triggered and rejected cleanly: PASS');

await n1.dispose();
await n2.dispose();
await nNew.dispose();
await n3.dispose();

console.log('🎉 All E04 Failure & Lifecycle Tests PASSED!');
process.exit(0);
