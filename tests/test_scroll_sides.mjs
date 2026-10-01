import { GridState } from '../server/grid-state.js';
import { createGridRenderer } from '../public/js/grid-renderer.js';

console.log('🧪 Testing Scroll on both sides (server GridState + client GridRenderer), both positive and negative directions...');

class El {
  constructor() { this.style = {}; this.childNodes = []; this.isConnected = false; this.attrs = {}; }
  setAttribute(k, v) { this.attrs[k] = v; }
  appendChild(x) { this.childNodes.push(x); x.isConnected = true; return x; }
  replaceChildren(...xs) { this.childNodes = xs; }
  remove() { this.isConnected = false; }
}
globalThis.document = { createElement: () => new El(), createDocumentFragment: () => new El() };

const serverGrid = new GridState(5, 5);
serverGrid._ensure(1, 5, 5);
const SG = serverGrid.grids.get(1);

function resetGrid(G) {
  for (let r = 0; r < 5; r++) {
    G.rows[r] = [];
    for (let c = 0; c < 5; c++) G.rows[r][c] = { t: `${r}${c}`, hl: 0 };
  }
}

resetGrid(SG);
serverGrid.apply('grid_scroll', [1, 1, 4, 1, 4, 1, 0]);
if (SG.rows[1][1].t !== '21' || SG.rows[1][0].t !== '10' || SG.rows[3][1] !== null) {
  throw new Error('Server positive scroll assertion failed!');
}
console.log('1. Server positive scroll (rows > 0): PASS');

resetGrid(SG);
serverGrid.apply('grid_scroll', [1, 1, 4, 1, 4, -1, 0]);
if (SG.rows[3][1].t !== '21' || SG.rows[3][0].t !== '30' || SG.rows[1][1] !== null) {
  throw new Error('Server negative scroll assertion failed!');
}
console.log('2. Server negative scroll (rows < 0): PASS');

const root = new El();
const clientRenderer = createGridRenderer({ container: root });
clientRenderer.setCellSize(10, 20);

clientRenderer.applyFrame([
  ['grid_resize', [1, 5, 5]],
  ['grid_line', [1, 0, 0, [['00',0],['01',0],['02',0],['03',0],['04',0]]]],
  ['grid_line', [1, 1, 0, [['10',0],['11',0],['12',0],['13',0],['14',0]]]],
  ['grid_line', [1, 2, 0, [['20',0],['21',0],['22',0],['23',0],['24',0]]]],
  ['grid_line', [1, 3, 0, [['30',0],['31',0],['32',0],['33',0],['34',0]]]],
  ['grid_line', [1, 4, 0, [['40',0],['41',0],['42',0],['43',0],['44',0]]]]
]);

clientRenderer.applyFrame([
  ['grid_scroll', [1, 1, 4, 1, 4, 1, 0]]
]);
const layer1 = root.childNodes.find(x => 'data-nvw-layer' in x.attrs);
const row1Spans = layer1.childNodes[1].childNodes.map(f => f.childNodes.map(s => s.textContent)).flat().join('');
if (!row1Spans.includes('21') || !row1Spans.includes('10')) {
  throw new Error('Client positive scroll row 1 assertion failed: ' + row1Spans);
}
console.log('3. Client positive scroll (rows > 0): PASS');

clientRenderer.applyFrame([
  ['grid_line', [1, 1, 0, [['10',0],['11',0],['12',0],['13',0],['14',0]]]],
  ['grid_line', [1, 2, 0, [['20',0],['21',0],['22',0],['23',0],['24',0]]]],
  ['grid_line', [1, 3, 0, [['30',0],['31',0],['32',0],['33',0],['34',0]]]],
  ['grid_scroll', [1, 1, 4, 1, 4, -1, 0]]
]);
const row3Negative = layer1.childNodes[3].childNodes.map(f => f.childNodes.map(s => s.textContent)).flat().join('');
if (!row3Negative.includes('21') || !row3Negative.includes('30')) {
  throw new Error('Client negative scroll row 3 assertion failed: ' + row3Negative);
}
console.log('4. Client negative scroll (rows < 0): PASS');

console.log('🎉 Both sides positive and negative scroll assertions PASSED!');
