import { newDocument, type TemplateDocument } from './model.ts';
import { BLOCKS } from './blocks.ts';
import { placeBlock, transaction } from './operations.ts';

/** Deterministic example shared by the full Vue app and the dependency-free preview. */
export function createDemoDocument(): TemplateDocument {
  return transaction(newDocument(), draft => {
    draft.name = '销售订单模板';
    draft.colWidthPx = Array(draft.cols).fill(174);
    draft.rowHeightPx[0] = 48;
    for (const [id, r, c] of [
      ['title', 0, 0], ['customer-info', 2, 0], ['items', 5, 0], ['approval', 8, 0],
    ] as const) {
      const block = BLOCKS.find(value => value.id === id);
      if (!block) throw new Error(`缺少示例积木：${id}`);
      placeBlock(draft, block, r, c, `demo-${id}`);
    }
  });
}
