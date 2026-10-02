import ExcelJS from 'exceljs';
import type { PageDefinition, PageRegionDefinition, TemplatePackage } from '../../src/core/contracts/types.ts';
import { importTemplatePackage } from '../../src/export/importExcel.ts';
import { bindField } from '../../src/domain/operations.ts';
import type { Field, TemplateDocument } from '../../src/domain/model.ts';
import { upsertPageDefinition, validateTemplatePackage } from '../../src/core/templates/package.ts';

type Section = 'material' | 'chemistry' | 'tensile' | 'inspection';
type SectionConfig = { viewId: string; label: string; columns: Array<[string, string, Field['format']]> };
const sections: Record<Section, SectionConfig> = {
  material: { viewId: 'view.certificate.material-print', label: '发货物料', columns: [
    ['material.heatNo', '炉号', 'text'], ['material.lotNo', '试批号', 'text'],
    ['material.pieces', '根数', 'number'], ['material.length', '长度 M', 'number'],
    ['material.weight', '重量 MT', 'number'], ['material.deliveryBundle', '捆数', 'number'],
  ] },
  chemistry: { viewId: 'view.certificate.chemistry-print', label: '化学成分 %', columns: [
    ['chem.heatNo', '炉号', 'text'], ['chem.analysisType', '分析类型', 'text'],
    ['chem.C', 'C', 'number'], ['chem.Si', 'Si', 'number'], ['chem.Mn', 'Mn', 'number'],
    ['chem.P', 'P', 'number'], ['chem.S', 'S', 'number'], ['chem.Cr', 'Cr', 'number'],
    ['chem.Ni', 'Ni', 'number'], ['chem.Cu', 'Cu', 'number'], ['chem.Mo', 'Mo', 'number'],
    ['chem.Al', 'Al', 'number'], ['chem.Nb', 'Nb', 'number'],
  ] },
  tensile: { viewId: 'view.certificate.tensile-print', label: '力学性能', columns: [
    ['tensile.heatNo', '炉号', 'text'], ['tensile.testType', '试验项目', 'text'],
    ['tensile.yieldStrength', '屈服 MPa', 'number'], ['tensile.tensileStrength', '抗拉 MPa', 'number'],
    ['tensile.yieldRatio', '屈强比', 'number'], ['tensile.elongation', '伸长率 %', 'number'],
    ['tensile.impactEnergyAverage', '冲击功 J', 'number'],
  ] },
  inspection: { viewId: 'view.certificate.inspection-print', label: '无损及工艺检验', columns: [
    ['inspection.heatNo', '炉号', 'text'], ['inspection.itemName', '检验项目', 'text'],
    ['inspection.method', '方法', 'text'], ['inspection.result', '结果', 'text'],
  ] },
};
const orderFields: Record<Section, string[]> = {
  material: ['material.lineId'], chemistry: ['chem.analysisType', 'chem.sequenceNo'],
  tensile: ['tensile.sequenceNo'], inspection: ['inspection.itemCode'],
};

export interface ExampleTemplateSpec {
  projectId: string; templateId: string; name: string; variant: 'certificate' | 'customer';
}

function addField(doc: TemplateDocument, row: number, col: number, field: Field): string {
  doc.fields ??= [];
  const path = `sample.${field.fieldId!.replaceAll('.', '_')}`;
  doc.fields.push({ ...field, path });
  bindField(doc, row, col, path, true);
  return field.fieldId!;
}

function region(section: Section, doc: TemplateDocument, worksheetId: string, row: number, capacity: number): PageRegionDefinition {
  const config = sections[section];
  config.columns.forEach(([sourceFieldId, label, format], index) => addField(doc, row, index, {
    fieldId: `sample.${section}.${sourceFieldId.replaceAll('.', '_')}`, label, format,
    sourceKind: 'view', viewId: config.viewId, sourceFieldId,
  }));
  return { regionId: `region.${section}`, worksheetId, label: config.label, kind: 'detail',
    rect: { r: row, c: 0, rows: 1, cols: config.columns.length }, viewId: config.viewId,
    paginationGroupId: 'certificate.heat-lot', groupBy: ['report.heatNo', 'report.lotNo'],
    orderBy: orderFields[section].map(fieldId => ({ fieldId, direction: 'asc' as const })),
    recordHeight: 1, capacityRows: capacity, emptyPolicy: 'keep', keepGroupsTogether: false,
    oversizedGroupPolicy: 'split-records', blankRows: 'keep' };
}

function workbook(spec: ExampleTemplateSpec): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook();
  const main = book.addWorksheet(spec.variant === 'certificate' ? '质保书' : '客户版质保书');
  const appendix = book.addWorksheet('硬度检验附页');
  for (const sheet of [main, appendix]) {
    sheet.pageSetup = { paperSize: 8, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
    for (let c = 1; c <= 16; c++) sheet.getColumn(c).width = 12;
    for (let r = 1; r <= (sheet === main ? 44 : 22); r++) sheet.getRow(r).height = 18;
  }
  main.mergeCells('A1:P2'); main.getCell('A1').value = spec.name;
  main.getCell('A1').font = { bold: true, size: 18 };
  main.getCell('A4').value = '质保书编号'; main.getCell('E4').value = '客户';
  main.getCell('I4').value = '合同号'; main.getCell('M4').value = '第';
  main.getCell('A5').value = '产品名称'; main.getCell('I5').value = '执行标准';
  const order: Array<[Section, number]> = spec.variant === 'certificate'
    ? [['material', 8], ['chemistry', 15], ['tensile', 24], ['inspection', 33]]
    : [['material', 8], ['inspection', 17], ['chemistry', 25], ['tensile', 35]];
  for (const [key, row] of order) {
    main.getCell(row, 1).value = sections[key].label;
    sections[key].columns.forEach(([, label], i) => { main.getCell(row + 1, i + 1).value = label; });
  }
  main.getCell('A43').value = '本证书依照合同及执行标准签发。';
  appendix.mergeCells('A1:P2'); appendix.getCell('A1').value = '硬度检验附页';
  appendix.getCell('A4').value = '质保书编号'; appendix.getCell('M4').value = '第';
  ['炉号', '试批号', '试样', '类型', '外侧 1', '外侧 2', '外侧均值', '中部均值', '内侧均值']
    .forEach((label, i) => { appendix.getCell(7, i + 1).value = label; });
  return book.xlsx.writeBuffer().then(bytes => new Uint8Array(bytes));
}

/** Imports an ordinary XLSX, then uses the same field binding and page contracts as the designer. */
export async function buildExampleTemplate(spec: ExampleTemplateSpec): Promise<TemplatePackage> {
  let template = await importTemplatePackage(await workbook(spec), `${spec.templateId}.xlsx`, spec.projectId);
  template.packageId = spec.templateId; template.name = spec.name; template.catalogVersion = '1.0.0';
  const [main, appendix] = template.worksheets;
  if (!main || !appendix) throw new Error('Example workbook must contain main and appendix sheets');
  const mainDoc = main.document, appendixDoc = appendix.document;
  const header = (row: number, col: number, sourceFieldId: string, label: string) => addField(mainDoc, row, col, {
    fieldId: `sample.header.${sourceFieldId.replaceAll('.', '_')}`, label, format: 'text',
    sourceKind: 'view', viewId: 'view.certificate-header', sourceFieldId,
  });
  header(3, 2, 'cert.certificateNo', '证书编号');
  header(3, 6, 'cert.customer', '客户');
  header(3, 10, 'contract.orderNo', '合同号');
  header(4, 2, 'cert.productDescription', '产品名称');
  header(4, 10, 'contract.standard', '执行标准');
  for (const [doc, row] of [[mainDoc, 3], [appendixDoc, 3]] as const) {
    addField(doc, row, 14, { fieldId: 'sample.page.number', label: '页码', format: 'number', sourceKind: 'page', pageField: 'number' });
    addField(doc, row, 15, { fieldId: 'sample.page.total', label: '总页数', format: 'number', sourceKind: 'page', pageField: 'total' });
  }
  addField(appendixDoc, 3, 2, { fieldId: 'sample.appendix.certificateNo', label: '证书编号', format: 'text',
    sourceKind: 'view', viewId: 'view.certificate-header', sourceFieldId: 'cert.certificateNo' });
  const layout: Array<[Section, number, number]> = spec.variant === 'certificate'
    ? [['material', 9, 4], ['chemistry', 16, 6], ['tensile', 25, 5], ['inspection', 34, 5]]
    : [['material', 9, 6], ['inspection', 18, 5], ['chemistry', 26, 7], ['tensile', 36, 5]];
  const regions = layout.map(([key, row, capacity]) => region(key, mainDoc, main.worksheetId, row, capacity));
  const hardnessColumns: Array<[string, string, Field['format']]> = [
    ['hardness.sample.heatNo', '炉号', 'text'], ['hardness.sample.lotNo', '试批号', 'text'],
    ['hardness.sample.sampleId', '试样', 'text'], ['hardness.sample.hardType', '类型', 'text'],
    ['hardness.q1.out.1', '外侧 1', 'number'], ['hardness.q1.out.2', '外侧 2', 'number'],
    ['hardness.q1.out.average', '外侧均值', 'number'],
    ['hardness.q1.mid.average', '中部均值', 'number'],
    ['hardness.q1.in.average', '内侧均值', 'number'],
  ];
  hardnessColumns.forEach(([sourceFieldId, label, format], index) => addField(appendixDoc, 7, index, {
    fieldId: `sample.hardness.${sourceFieldId.replaceAll('.', '_')}`, label, format,
    sourceKind: 'view', viewId: 'view.certificate.hardness-print', sourceFieldId,
  }));
  const page: PageDefinition = { pageDefinitionId: 'page.main', label: '质保书', pageType: 'main',
    worksheetIds: [main.worksheetId], paperSize: 'A3', orientation: 'landscape',
    marginsMm: { top: 8, right: 8, bottom: 8, left: 8 },
    printableRect: { r: 0, c: 0, rows: 44, cols: 16 }, repeatHeaderRows: [0, 1, 2, 3, 4], regions };
  const appendixPage: PageDefinition = { pageDefinitionId: 'page.hardness', label: '硬度检验附页', pageType: 'appendix',
    worksheetIds: [appendix.worksheetId], paperSize: 'A3', orientation: 'landscape',
    marginsMm: { top: 8, right: 8, bottom: 8, left: 8 },
    printableRect: { r: 0, c: 0, rows: 22, cols: 16 }, repeatHeaderRows: [0, 1, 2, 3], regions: [{
      regionId: 'region.hardness', worksheetId: appendix.worksheetId, label: '硬度检验', kind: 'detail',
      rect: { r: 7, c: 0, rows: 1, cols: hardnessColumns.length }, viewId: 'view.certificate.hardness-print',
      paginationGroupId: 'certificate.hardness', groupBy: ['report.heatNo', 'report.lotNo'],
      orderBy: ['hardness.sample.sampleId', 'hardness.sample.sequenceNo'].map(fieldId => ({ fieldId, direction: 'asc' as const })),
      recordHeight: 1, capacityRows: 12, keepGroupsTogether: false, oversizedGroupPolicy: 'split-records',
      emptyPolicy: 'keep', appendixIfViewHasRecords: 'view.certificate.hardness-print',
    }] };
  template = upsertPageDefinition(template, page);
  template = upsertPageDefinition(template, appendixPage);
  validateTemplatePackage(template);
  return template;
}
