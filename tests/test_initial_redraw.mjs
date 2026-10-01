import { NvimEmbed } from '../server/nvim-embed.js';

console.log('🧪 Testing initial screen redraw events...');
const n = new NvimEmbed({ cols: 80, rows: 24, args: ['-u', 'NONE', '-i', 'NONE'] });
const events = [];
let frames = 0;
n.on('ui', (name, args) => events.push(name));
n.on('frame', () => frames++);

await n.start();

const eventCounts = {};
for (const ev of events) {
  eventCounts[ev] = (eventCounts[ev] || 0) + 1;
}

console.log('Total UI events collected:', events.length);
console.log('Total frames emitted:', frames);
console.log('Event breakdown:\n', JSON.stringify(eventCounts, null, 2));

await n.dispose();

if (events.length < 50 || !eventCounts.grid_line || !eventCounts.hl_attr_define) {
  console.error('Initial redraw events missing essential items!');
  process.exit(1);
}
console.log('✅ Initial Redraw Event Probe PASSED!');
