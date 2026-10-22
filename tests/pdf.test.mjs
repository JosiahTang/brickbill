import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { newDocument } from '../src/domain/model.ts';
import { bindField } from '../src/domain/operations.ts';
import { createTemplatePackage, upsertPageDefinition } from '../src/core/templates/package.ts';
import { planFixedPages } from '../src/core/pagination/fixed.ts';
import { projectPagePlan } from '../src/core/render/page.ts';
import { exportFixedPdf, runRenderer } from '../server/pdf/index.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { imageWorkbook, replacementPng } from './fixtures/image-workbook.mjs';
import { importTemplatePackage } from '../src/export/importExcel.ts';
import { exportTemplatePackage } from '../src/export/excel.ts';
import { imagePixels } from '../src/domain/images.ts';

const pdfRuntime = process.env.REPORTING_PDF_PYTHON && process.env.REPORTING_PDF_FALLBACK_FONT;
if (process.env.BRICKBILL_REQUIRE_PDF_TESTS === '1' && !pdfRuntime)
  throw new Error('PDF verification requires REPORTING_PDF_PYTHON and REPORTING_PDF_FALLBACK_FONT');
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

test('T39.3: PDF rendering times out within a bound when its child ignores termination', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const signals = [];
  child.kill = signal => {
    signals.push(signal);
    if (signal === 'SIGKILL') setImmediate(() => child.emit('close', null));
    return true;
  };
  const startedAt = Date.now();
  await assert.rejects(runRenderer('python', 'input', 'output', 15, () => child, 15), error =>
    error.code === 'CONTRACT_INVALID' && /超过 15ms/.test(error.message));
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(Date.now() - startedAt < 1_000, 'the failed renderer must not leave the request waiting indefinitely');
});

test('fixed PDF uses the page projection, embeds font and image, and keeps two physical pages', { skip: !pdfRuntime && 'PDF runtime is not configured' }, async () => {
  const { template, projection } = sample();
  const original = structuredClone(projection);
  const pdf = await exportFixedPdf(template, projection, { fontMap: { SimHei: process.env.REPORTING_PDF_FALLBACK_FONT } });
  assert.equal(pdf.mediaType, 'application/pdf');
  assert.equal(pdf.renderer.pageCount, projection.pages.length);
  assert.equal(pdf.renderer.version, '4.4.9');
  assert.ok(pdf.bytes.length > 1000);
  assert.deepEqual(projection, original);
  const temporary = await mkdtemp(join(tmpdir(), 'brickbill-pdf-inspect-'));
  try {
    const inspectionPath = join(temporary, 'sample.pdf');
    await writeFile(inspectionPath, pdf.bytes);
    const result = JSON.parse(execFileSync(process.env.REPORTING_PDF_PYTHON, ['-c',
      'import json,sys; from pypdf import PdfReader; p=PdfReader(sys.argv[1]); fonts=p.pages[0]["/Resources"]["/Font"].values(); embedded=any("/FontFile2" in f.get_object()["/FontDescriptor"].get_object() for f in fonts if "/FontDescriptor" in f.get_object()); print(json.dumps({"pages":len(p.pages),"texts":[x.extract_text() for x in p.pages],"images":[len(x.images) for x in p.pages],"fontFile":embedded}))', inspectionPath], { encoding: 'utf8' }));
    assert.equal(result.pages, 2);
    assert.ok(result.texts[0].includes('炉号-1'));
    assert.ok(result.texts[1].includes('炉号-3'));
    assert.deepEqual(result.images, [1, 1]);
    assert.ok(result.fontFile, 'the selected TTF must be embedded in the PDF');
    if (process.env.T22_PDF_SAMPLE_OUTPUT) await writeFile(process.env.T22_PDF_SAMPLE_OUTPUT, pdf.bytes);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('PDF rejects flow pages before invoking a renderer', async () => {
  const { template, projection } = sample();
  template.pageDefinitions[0].paginationMode = 'flow';
  await assert.rejects(() => exportFixedPdf(template, projection), error => error.code === 'CONTRACT_INVALID');
});

test('T43.5: edited native images are drawn with matching content and fractional position on each PDF page', { skip: !pdfRuntime && 'PDF runtime is not configured' }, async () => {
  const template = await importTemplatePackage(await imageWorkbook(), 'native-images.xlsx');
  const worksheet = template.worksheets[0], doc = worksheet.document;
  doc.images[0].rect = { r: 2.25, c: 2.2, rows: 2.5, cols: 1.25 };
  // A fixed header image on two physical pages; no dependence on the source one-cell extent path.
  template.pageDefinitions = [{ pageDefinitionId: 'native.page', label: '图片', pageType: 'main', paginationMode: 'fixed',
    worksheetIds: [worksheet.worksheetId], paperSize: 'A4', orientation: 'portrait', marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
    printableRect: { r: 0, c: 0, rows: 20, cols: 8 },
    regions: [{ regionId: 'rows', worksheetId: worksheet.worksheetId, label: '明细', kind: 'detail',
      rect: { r: 10, c: 0, rows: 1, cols: 2 }, viewId: 'rows', paginationGroupId: 'rows', groupBy: ['id'],
      recordHeight: 1, capacityRows: 1, keepGroupsTogether: true, oversizedGroupPolicy: 'error' }] }];
  const records = [1, 2].map(id => ({ recordId: `r.${id}`, sourceRecordIds: [`s.${id}`], values: { id } }));
  const views = [{ viewId: 'rows', viewVersion: '1.0.0', datasetId: 'rows', outputFields: ['id'], records,
    inputRecordCount: 2, outputRecordCount: 2, diagnostics: [] }];
  const projection = projectPagePlan(template, planFixedPages(template, 'native.page', views), views);
  const pdf = await exportFixedPdf(template, projection);
  const root = await mkdtemp(join(tmpdir(), 'brickbill-native-pdf-'));
  try {
    const file = join(root, 'images.pdf'), source = join(root, 'image.png');
    await writeFile(file, pdf.bytes); await writeFile(source, Buffer.from(template.resources[0].base64, 'base64'));
    const script = `import json,sys,hashlib
from pypdf import PdfReader
from PIL import Image
expected=Image.open(sys.argv[2]).convert('RGB').tobytes()
pages=[]
for p in PdfReader(sys.argv[1]).pages:
    matrix=None; draws=[]
    for args,op in p.get_contents().operations:
        if op==b'cm': matrix=[float(x) for x in args]
        if op==b'Do': draws.append(matrix)
    pages.append({'draws':draws,'contentMatches':all(x.image.convert('RGB').tobytes()==expected for x in p.images),'images':len(p.images),'height':float(p.mediabox.height)})
print(json.dumps(pages))`;
    const pages = JSON.parse(execFileSync(process.env.REPORTING_PDF_PYTHON, ['-c', script, file, source], { encoding: 'utf8' }));
    assert.equal(pages.length, 2);
    const box = imagePixels(doc.images[0].rect, doc), unit = 72 / 96, margin = 10 * 72 / 25.4;
    for (const [index, page] of pages.entries()) {
      assert.ok(page.contentMatches); assert.ok(page.images > 0);
      assert.equal(page.draws.length, 2, 'two native placements must both be drawn, even when sharing one resource');
      const actual = page.draws[0], scale = pdf.renderer.scales[index];
      const expected = [box.width * unit * scale, 0, 0, box.height * unit * scale,
        margin + box.x * unit * scale, page.height - margin - (box.y + box.height) * unit * scale];
      actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 0.05, `PDF image transform ${i}: ${value} != ${expected[i]}`));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('PDF fails with a cell address when a configured font lacks a glyph', { skip: !pdfRuntime && 'PDF runtime is not configured' }, async () => {
  const { template, projection } = sample();
  projection.pages[0].document.cells['1:0'].text = '炉号 🧪';
  await assert.rejects(() => exportFixedPdf(template, projection), error =>
    error.code === 'LAYOUT_OVERFLOW' && error.context?.cell === '1:0');
});

test('T44.6: empty and replaced native image manifests remain authoritative in real PDF after two Excel saves', { skip: !pdfRuntime && 'PDF runtime is not configured' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'brickbill-image-authority-pdf-'));
  try {
    for (const count of [0, 1]) {
      let template = await importTemplatePackage(await imageWorkbook(), 'images.xlsx');
      const worksheetId = template.worksheets[0].worksheetId;
      template.worksheets[0].document.images = count ? [template.worksheets[0].document.images[1]] : [];
      template.resources[0].base64 = replacementPng;
      template.pageDefinitions = [{ pageDefinitionId: 'images', label: '图片', pageType: 'main', paginationMode: 'fixed',
        worksheetIds: [worksheetId], paperSize: 'A4', orientation: 'portrait', marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
        printableRect: { r: 0, c: 0, rows: 20, cols: 8 }, regions: [] }];
      for (let i = 0; i < 2; i++) template = await importTemplatePackage(await exportTemplatePackage(template), 'saved.xlsx');
      const projection = projectPagePlan(template, planFixedPages(template, 'images', []), []);
      const pdf = await exportFixedPdf(template, projection), file = join(root, `images-${count}.pdf`);
      await writeFile(file, pdf.bytes);
      const result = JSON.parse(execFileSync(process.env.REPORTING_PDF_PYTHON, ['-c',
        "import json,sys; from pypdf import PdfReader; p=PdfReader(sys.argv[1]); images=list(p.pages[0].images); print(json.dumps({'pages':len(p.pages),'images':len(images),'sizes':[list(x.image.size) for x in images],'pixels':[list(x.image.convert('RGB').getpixel((0,0))) for x in images]}))", file], { encoding: 'utf8' }));
      assert.equal(result.pages, 1); assert.equal(result.images, count);
      if (count) { assert.deepEqual(result.sizes, [[1, 1]]); assert.deepEqual(result.pixels, [[255, 255, 255]]); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('PDF rejects unevaluated spreadsheet formulas', { skip: !pdfRuntime && 'PDF runtime is not configured' }, async () => {
  const { template, projection } = sample();
  projection.pages[0].document.cells['1:0'].excelValue = { formula: '1+1', result: 2 };
  await assert.rejects(() => exportFixedPdf(template, projection), error => error.code === 'CONTRACT_INVALID');
});
