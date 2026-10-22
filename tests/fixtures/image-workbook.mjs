import ExcelJS from 'exceljs';
import { readFile } from 'node:fs/promises';

export const replacementPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

// Synthetic marks only; no customer logo or seal. Shared by Node and browser regressions.
export async function imageWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const bytes = await readFile(new URL('./pdf-seal.png', import.meta.url));
  const imageId = workbook.addImage({ buffer: bytes, extension: 'png' });
  const first = workbook.addWorksheet('图片主表');
  first.getCell('L60').value = '边界';
  first.mergeCells('B2:D3'); first.getCell('B2').value = '图片测试';
  first.getRow(2).height = 30; first.getColumn(2).width = 16;
  first.addImage(imageId, { tl: { row: 1.25, col: 1.2 }, br: { row: 3.5, col: 3.4 } });
  first.addImage(imageId, { tl: { row: 5, col: 4 }, ext: { width: 64, height: 36 } });
  const second = workbook.addWorksheet('图片附表');
  second.getCell('D20').value = '附表';
  second.addImage(imageId, { tl: { row: 2, col: 1 }, br: { row: 4, col: 2 } });
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
