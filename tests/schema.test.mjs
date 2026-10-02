import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { BLOCKS } from '../src/domain/blocks.ts';
const schema = JSON.parse(readFileSync(new URL('../schemas/block.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
test('JSON Schema accepts all registered business blocks', () => {
  for (const block of BLOCKS) assert.ok(validate(block), JSON.stringify(validate.errors));
});
test('JSON Schema rejects simultaneous text and binding', () => {
  const block = structuredClone(BLOCKS[1]); block.cells[0].binding = { path:'orderNo', format:'text' };
  assert.equal(validate(block), false);
});
test('JSON Schema rejects unknown structural properties', () => {
  assert.equal(validate({ ...BLOCKS[1], injectedCommand: 'unsafe' }), false);
});
