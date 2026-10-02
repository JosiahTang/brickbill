import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { newDocument } from '../src/domain/model.ts';
import { bindField } from '../src/domain/operations.ts';
import { createTemplatePackage, upsertPageDefinition } from '../src/core/templates/package.ts';
import { planFixedPages } from '../src/core/pagination/fixed.ts';
import { projectPagePlan } from '../src/core/render/page.ts';
import { exportFixedPdf } from '../server/pdf/index.ts';

const pdfRuntime = process.env.REPORTING_PDF_PYTHON && process.env.REPORTING_PDF_FALLBACK_FONT;
function sample() {
  const doc = newDocument(); doc.name = '质保证明'; doc.sheetName = '证书'; doc.rows = 16; doc.cols = 3;
  doc.rowHeightPx = Array(16).fill(26); doc.colWidthPx = [120, 135, 110];
  doc.cells['0:0'] = { text: '质量证明书  INSPECTION CERTIFICATE', style: { fontFamily: 'SimHei', fontSizePt: 13, bold: true,
    horizontal: 'center', vertical: 'middle', borders: { bottom: { style: 'medium', color: '#222222' } } } };
  doc.cells['1:0'] = { text: '炉号', style: { background: '#E8EFF7', borders: { bottom: { style: 'thin', color: '#333333' } } } };
  doc.cells['1:1'] = { text: '数量', style: { background: '#E8EFF7' } };
  doc.cells['10:0'] = { text: '检验结论：合格', style: { fontFamily: 'SimHei', fontSizePt: 10 } };
  doc.cells['12:0'] = { text: '技术质量部', style: { fontFamily: 'SimHei', fontSizePt: 10 } };
  doc.merges = [{ r: 0, c: 0, rows: 1, cols: 3 }, { r: 10, c: 0, rows: 1, cols: 3 }];
  doc.fields = [
    { fieldId: 'material.heatNo', path: 'heatNo', label: '炉号', format: 'text', sourceKind: 'view', viewId: 'view.material', sourceFieldId: 'heatNo' },
    { fieldId: 'material.quantity', path: 'quantity', label: '数量', format: 'number', sourceKind: 'view', viewId: 'view.material', sourceFieldId: 'quantity' },
    { fieldId: 'page.number', path: 'pageNumber', label: '页码', format: 'number', sourceKind: 'page', pageField: 'number' },
  ];
  bindField(doc, 3, 0, 'heatNo'); bindField(doc, 3, 1, 'quantity'); bindField(doc, 12, 2, 'pageNumber');
  let template = createTemplatePackage({ name: '质保证明', worksheets: [{ worksheetId: 'sheet.certificate', document: doc }] });
  template.resources = [{ resourceId: 'seal', mediaType: 'image/png',
    base64: readFileSync(new URL('./fixtures/pdf-seal.png', import.meta.url)).toString('base64') }];
  template = upsertPageDefinition(template, { pageDefinitionId: 'page.main', label: '主表', pageType: 'main', paginationMode: 'fixed',
    worksheetIds: ['sheet.certificate'], paperSize: 'A4', orientation: 'portrait', marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
    printableRect: { r: 0, c: 0, rows: 16, cols: 3 }, repeatHeaderRows: [0, 1],
    imagePlacements: [{ imageId: 'seal.1', resourceId: 'seal', worksheetId: 'sheet.certificate', rect: { r: 1, c: 2, rows: 2, cols: 1 } }],
    regions: [{ regionId: 'detail.material', worksheetId: 'sheet.certificate', label: '物料明细', kind: 'detail',
      rect: { r: 3, c: 0, rows: 1, cols: 2 }, viewId: 'view.material', paginationGroupId: 'certificate', groupBy: ['heatNo'],
      capacityRows: 2, recordHeight: 1, keepGroupsTogether: false, oversizedGroupPolicy: 'split-records' },
    { regionId: 'footer', worksheetId: 'sheet.certificate', label: '页尾', kind: 'footer', rect: { r: 10, c: 0, rows: 3, cols: 3 } }] });
  const records = Array.from({ length: 3 }, (_, index) => ({ recordId: `heat.${index}`, sourceRecordIds: [`source.${index}`],
    values: { heatNo: `炉号-${index + 1}`, quantity: index + 1 } }));
  const views = [{ viewId: 'view.material', viewVersion: '1.0.0', datasetId: 'material', outputFields: ['heatNo', 'quantity'],
    records, inputRecordCount: 3, outputRecordCount: 3, diagnostics: [] }];
  const pagePlan = planFixedPages(template, 'page.main', views);
  return { template, projection: projectPagePlan(template, pagePlan, views) };
}

test('fixed PDF uses the page projection, embeds font and image, and keeps two physical pages', { skip: !pdfRuntime && 'PDF runtime is not configured' }, async () => {
  const { template, projection } = sample();
  const original = structuredClone(projection);
  const pdf = await exportFixedPdf(template, projection, { fontMap: { SimHei: process.env.REPORTING_PDF_FALLBACK_FONT } });
  assert.equal(pdf.mediaType, 'application/pdf');
  assert.equal(pdf.renderer.pageCount, projection.pages.length);
  assert.equal(pdf.renderer.version, '4.4.9');
  assert.ok(pdf.bytes.length > 1000);
  assert.deepEqual(projection, original);
  if (process.env.T22_PDF_SAMPLE_OUTPUT) await writeFile(process.env.T22_PDF_SAMPLE_OUTPUT, pdf.bytes);
  const path = process.env.T22_PDF_SAMPLE_OUTPUT;
  if (path) {
    const result = JSON.parse(execFileSync(process.env.REPORTING_PDF_PYTHON, ['-c',
      'import json,sys; from pypdf import PdfReader; p=PdfReader(sys.argv[1]); fonts=p.pages[0]["/Resources"]["/Font"].values(); embedded=any("/FontFile2" in f.get_object()["/FontDescriptor"].get_object() for f in fonts if "/FontDescriptor" in f.get_object()); print(json.dumps({"pages":len(p.pages),"texts":[x.extract_text() for x in p.pages],"images":[len(x.images) for x in p.pages],"fontFile":embedded}))', path], { encoding: 'utf8' }));
    assert.equal(result.pages, 2);
    assert.ok(result.texts[0].includes('炉号-1'));
    assert.ok(result.texts[1].includes('炉号-3'));
    assert.deepEqual(result.images, [1, 1]);
    assert.ok(result.fontFile, 'the selected TTF must be embedded in the PDF');
  }
});

test('PDF rejects flow pages before invoking a renderer', async () => {
  const { template, projection } = sample();
  template.pageDefinitions[0].paginationMode = 'flow';
  await assert.rejects(() => exportFixedPdf(template, projection), error => error.code === 'CONTRACT_INVALID');
});

test('PDF fails with a cell address when a configured font lacks a glyph', { skip: !pdfRuntime && 'PDF runtime is not configured' }, async () => {
  const { template, projection } = sample();
  projection.pages[0].document.cells['1:0'].text = '炉号 🧪';
  await assert.rejects(() => exportFixedPdf(template, projection), error =>
    error.code === 'LAYOUT_OVERFLOW' && error.context?.cell === '1:0');
});

test('PDF rejects unevaluated spreadsheet formulas', { skip: !pdfRuntime && 'PDF runtime is not configured' }, async () => {
  const { template, projection } = sample();
  projection.pages[0].document.cells['1:0'].excelValue = { formula: '1+1', result: 2 };
  await assert.rejects(() => exportFixedPdf(template, projection), error => error.code === 'CONTRACT_INVALID');
});
