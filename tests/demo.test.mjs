import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoDocument } from '../src/domain/demo.ts';
import { validateDocument, metadata } from '../src/domain/operations.ts';

test('example uses valid blocks, merges and the intended detail band', () => {
  const doc = createDemoDocument();
  validateDocument(doc);
  assert.equal(doc.blocks.length, 4);
  assert.equal(doc.merges.length, 2);
  assert.equal(doc.cells['2:1'].binding.path, 'customer.name');
  assert.equal(doc.cells['6:2'].binding.path, 'items.price');
  assert.equal(doc.blocks.find(b => b.definitionId === 'items').rect.r, 5);
  assert.doesNotThrow(() => metadata(doc));
});

test('example factories do not share mutable objects', () => {
  const a = createDemoDocument(), b = createDemoDocument();
  a.cells['0:0'].text = 'modified';
  a.rowHeightPx[0] = 80;
  assert.equal(b.cells['0:0'].text, '销售订单');
  assert.equal(b.rowHeightPx[0], 48);
});
