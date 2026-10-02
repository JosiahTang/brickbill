import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, copy, keyOf, displayText, numberFormat } from '../src/domain/model.ts';
import { BLOCKS, CUSTOMER_BLOCK } from '../src/domain/blocks.ts';
import * as ops from '../src/domain/operations.ts';
const title = BLOCKS[0], items = BLOCKS[2];
const placed = (block = CUSTOMER_BLOCK, r = 0, c = 0) => ops.transaction(newDocument(), d => ops.placeBlock(d, block, r, c, 'instance-1'));
const blank = { schemaVersion: 1, id: 'blank', name: 'blank', rows: 2, cols: 2, cells: [], merges: [] };

test('all preset definitions are valid', () => BLOCKS.forEach(ops.validateBlock));
test('2x4 block places at absolute coordinates', () => {
  const d = placed(CUSTOMER_BLOCK, 5, 2);
  assert.equal(d.cells['5:3'].binding.path, 'customer.name');
  assert.equal(d.cells['6:5'].binding.path, 'customer.phone');
  assert.equal(Object.keys(d.cells).length, 8);
});
test('blank cells reserve the entire block footprint', () => {
  const d = placed(blank); assert.equal(d.cells['1:1'].owner, 'instance-1');
  assert.throws(() => ops.transaction(d, x => ops.placeBlock(x, blank, 1, 1, 'other')));
});
test('style-only cells block placement', () => {
  const d = ops.transaction(newDocument(), x => ops.styleRange(x, { r: 0, c: 0, rows: 1, cols: 1 }, { bold: true }));
  assert.match(ops.placementError(d, CUSTOMER_BLOCK, 0, 0), /内容、样式/);
});
for (const [r, c] of [[-1,0],[0,-1],[59,0],[0,9],[0.5,0],[0,NaN]])
  test(`invalid placement rejected (${r}, ${c})`, () => assert.throws(() => placed(CUSTOMER_BLOCK, r, c)));
test('exact bottom-right placement is accepted', () => assert.equal(placed(CUSTOMER_BLOCK, 58, 8).blocks.length, 1));
test('adjacent blocks do not overlap', () => {
  const d = ops.transaction(placed(), x => ops.placeBlock(x, CUSTOMER_BLOCK, 0, 4, 'instance-2'));
  assert.equal(d.blocks.length, 2);
});
test('instances and source definitions are deep-cloned', () => {
  const d = ops.transaction(placed(), x => ops.placeBlock(x, CUSTOMER_BLOCK, 4, 0, 'instance-2'));
  d.cells['0:1'].binding.path = 'orderNo';
  assert.equal(d.cells['4:1'].binding.path, 'customer.name');
  assert.equal(CUSTOMER_BLOCK.cells.find(c => c.r === 0 && c.c === 1).binding.path, 'customer.name');
});
test('failed transaction leaves original unchanged', () => {
  const d = placed(); const before = JSON.stringify(d);
  assert.throws(() => ops.transaction(d, x => { ops.setText(x, 0, 0, 'edited'); ops.placeBlock(x, title, 0, 0, 'new'); }));
  assert.equal(JSON.stringify(d), before);
});
test('move preserves edits and removes old occupancy', () => {
  let d = ops.transaction(placed(), x => ops.setText(x, 0, 0, 'custom label'));
  d = ops.transaction(d, x => ops.moveBlock(x, 'instance-1', 4, 2));
  assert.equal(d.cells['4:2'].text, 'custom label'); assert.equal(d.cells['0:0'], undefined);
});
test('move can partially overlap its own former rectangle', () => assert.equal(ops.transaction(placed(blank), d => ops.moveBlock(d, 'instance-1', 0, 1)).blocks[0].rect.c, 1));
test('failed move rolls back both removal and placement', () => {
  const d = placed(); const before = JSON.stringify(d);
  assert.throws(() => ops.transaction(d, x => ops.moveBlock(x, 'instance-1', 59, 0)));
  assert.equal(JSON.stringify(d), before);
});
test('missing block move reports meaningful error', () => assert.throws(() => ops.transaction(newDocument(), d => ops.moveBlock(d, 'missing', 0, 0)), /找不到积木/));
test('field drop maps a merged slave to the anchor', () => {
  const block = { ...blank, merges: [{ r: 0, c: 0, rows: 1, cols: 2 }] };
  const d = ops.transaction(placed(block), x => ops.bindField(x, 0, 1, 'orderNo'));
  assert.equal(d.cells['0:0'].binding.path, 'orderNo'); assert.equal(d.cells['0:1'].binding, undefined);
});
test('dragging a field must not overwrite an existing literal', () => assert.throws(() => ops.transaction(placed(), d => ops.bindField(d, 0, 0, 'orderNo')), /已有内容/));
test('explicit property-panel replacement retains cell ownership and style', () => {
  const d = ops.transaction(placed(), x => ops.bindField(x, 0, 0, 'orderNo', true));
  assert.equal(d.cells['0:0'].text, undefined); assert.equal(d.cells['0:0'].owner, 'instance-1');
  assert.ok(d.cells['0:0'].style.background);
});
test('literal zero counts as occupied', () => {
  const d = ops.transaction(newDocument(), x => ops.setText(x, 0, 0, '0'));
  assert.throws(() => ops.transaction(d, x => ops.bindField(x, 0, 0, 'orderNo')));
});
test('unknown field paths are rejected', () => assert.throws(() => ops.transaction(newDocument(), x => ops.bindField(x, 0, 0, '__proto__.secret')), /未知字段/));
test('raw placeholder bypass is rejected', () => assert.throws(() => ops.transaction(newDocument(), x => ops.setText(x, 0, 0, '{{unknown}}')), /字段绑定/));
test('list fields outside matching repeat band are rejected', () => assert.throws(() => ops.transaction(newDocument(), x => ops.bindField(x, 0, 0, 'items.price')), /重复区域/));
test('list fields in their repeat band are valid', () => {
  const d = placed(items, 4, 1); assert.equal(d.cells['5:3'].binding.path, 'items.price');
});
test('removing repeat config while list fields exist is rejected', () => assert.throws(() => ops.transaction(placed(items), d => { delete d.blocks[0].repeat; }), /重复区域/));
test('parallel full-row repeat bands are rejected', () => assert.throws(() => ops.transaction(placed(items), d => ops.placeBlock(d, items, 0, 5, 'other')), /整行扩展/));
test('sequential repeat bands are accepted', () => assert.equal(ops.transaction(placed(items), d => ops.placeBlock(d, items, 4, 0, 'other')).blocks.length, 2));
test('duplicate local coordinates are rejected', () => {
  const b = copy(CUSTOMER_BLOCK); b.cells.push(copy(b.cells[0])); assert.throws(() => ops.validateBlock(b), /重复单元格/);
});
test('merged slave content is rejected in presets', () => {
  const b = copy(title); b.cells.push({ r: 0, c: 1, text: 'hidden' }); assert.throws(() => ops.validateBlock(b), /从属格/);
});
test('overlapping merges are rejected', () => {
  const b = copy(title); b.merges.push({ r: 0, c: 1, rows: 1, cols: 2 }); assert.throws(() => ops.validateBlock(b), /重叠/);
});
test('merge refuses to discard non-anchor values', () => assert.throws(() => ops.transaction(placed(), d => ops.mergeRange(d, { r:0,c:0,rows:1,cols:2 })), /丢失/));
test('merge cannot cross a block ownership boundary', () => assert.throws(() => ops.transaction(placed(blank), d => ops.mergeRange(d, { r:0,c:1,rows:1,cols:2 })), /跨积木/));
test('merge cannot cross repeat band boundary', () => {
  const b = { ...blank, repeat: { source:'items', rowOffset:1, rowCount:1, mode:'insert', empty:'remove' } };
  assert.throws(() => ops.transaction(placed(b), d => ops.mergeRange(d, { r:0,c:0,rows:2,cols:1 })), /重复单元/);
});
test('merge normalization has perimeter-only borders and uniform fill', () => {
  const d = placed(title); const cells = ops.renderCells(d);
  assert.ok(cells['0:0'].style.borders.left); assert.equal(cells['0:0'].style.borders.right, undefined);
  assert.equal(cells['0:1'].style.borders.left, undefined); assert.ok(cells['0:3'].style.borders.right);
  assert.equal(cells['0:3'].style.background, cells['0:0'].style.background);
});
test('deleting block also removes owned merges and cells', () => {
  const d = ops.transaction(placed(title), x => ops.removeBlock(x, 'instance-1'));
  assert.equal(d.blocks.length, 0); assert.equal(d.merges.length, 0); assert.deepEqual(d.cells, {});
});
test('clearing only part of an independent merge is rejected', () => {
  const d = ops.transaction(newDocument(), x => ops.mergeRange(x, { r:0,c:0,rows:1,cols:2 }));
  assert.throws(() => ops.transaction(d, x => ops.clearRange(x, { r:0,c:0,rows:1,cols:1 })), /完整选中/);
});
test('clearing independent cells releases placement occupancy', () => {
  let d = ops.transaction(newDocument(), x => ops.setText(x, 0, 0, 'x'));
  d = ops.transaction(d, x => ops.clearRange(x, { r:0,c:0,rows:1,cols:1 }));
  assert.equal(ops.placementError(d, CUSTOMER_BLOCK, 0, 0), null);
});
test('invalid row dimensions are rejected atomically', () => assert.throws(() => ops.transaction(newDocument(), d => { d.rowHeightPx[0] = 0; }), /行高/));
test('placeholder syntax and numeric formatting are independent', () => {
  const cell = { binding:{ path:'items.price', format:'number' } };
  assert.equal(displayText(cell, 'mustache'), '{{items.price}}');
  assert.equal(displayText(cell, 'dollar'), '${items.price}'); assert.equal(numberFormat(cell), '#,##0.00');
});
test('metadata contains explicit repeat coordinates and A1 scalar addresses', () => {
  const d = placed(items, 5, 2), meta = ops.metadata(d);
  assert.equal(meta.bindings[2].address, 'E7'); assert.equal(meta.repeats[0].coordinateBase, 0);
  assert.equal(meta.repeats[0].r, 6); assert.equal(meta.repeats[0].rows, 1);
});
test('A1 conversion supports columns after Z', () => { assert.equal(ops.a1(0,26), 'AA1'); assert.equal(keyOf(1,2),'1:2'); });
test('deterministic placement fuzz preserves invariants and rollback', () => {
  let d = newDocument(); let seed = 7;
  for (let i = 0; i < 100; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0; const r = seed % 62;
    seed = (seed * 1664525 + 1013904223) >>> 0; const c = seed % 14;
    const before = JSON.stringify(d);
    try { d = ops.transaction(d, x => ops.placeBlock(x, blank, r, c, `fuzz-${i}`)); }
    catch { assert.equal(JSON.stringify(d), before); }
    ops.validateDocument(d);
  }
});
