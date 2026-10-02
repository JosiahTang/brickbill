import Ajv2020 from 'ajv/dist/2020.js';
import schema from '../../schemas/block.schema.json';
import { validateBlock } from './operations.ts';
import type { BlockDefinition } from './model.ts';
// At the boundary of any future user-supplied material library, validate unknown
// JSON with JSON Schema first, then validate coordinate/scope semantics.
const ajv = new Ajv2020({ allErrors: true, strict: true });
const valid = ajv.compile<BlockDefinition>(schema);
export function parseBlockJson(text: string): BlockDefinition {
  if (new TextEncoder().encode(text).byteLength > 1024 * 1024) throw new Error('积木 JSON 超过 1 MiB');
  const data: unknown = JSON.parse(text);
  if (!valid(data)) throw new Error(`积木结构不合法：${ajv.errorsText(valid.errors)}`);
  validateBlock(data);
  return data;
}
