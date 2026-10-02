import { readFileSync, writeFileSync } from 'node:fs';

const basePath = new URL('./dalipu/source.json', import.meta.url);
const outputPath = new URL('./dalipu/multipage.json', import.meta.url);
const source = JSON.parse(readFileSync(basePath, 'utf8'));
const bulk = structuredClone(source);
const printNo = 'DEMO-CERT-BULK-001';
bulk.businessKey.printNo = printNo;
bulk.sourceVersion = 'dalipu-synthetic-multipage-v1';

const records = name => bulk.datasets.find(dataset => dataset.datasetId === name).records;
const base = name => records(name)[0];
const setCertificateKey = row => {
  row.CERTI_PRINT_NO = printNo;
  row.TUBE_COUP_FLAG = 'T';
};
const heatNo = index => `BULK-H${String(index + 1).padStart(2, '0')}`;
const lotNo = index => `BULK-L${String(index + 1).padStart(3, '0')}`;

const header = records('header_by_print_no')[0];
header.CERTI_PRINT_NO = printNo;
header.SALE_ORDER_SUB_NO = 'BULK-SO-001';
header.P_O_NO = 'BULK-PO-001';
records('contract_by_sub_order')[0].saleOrderSubNo = 'BULK-SO-001';
records('contract_by_sub_order')[0].orderNo = 'BULK-SO-001';

records('material_lines').splice(0, Infinity, ...Array.from({ length: 42 }, (_, index) => {
  const row = structuredClone(base('material_lines'));
  setCertificateKey(row);
  row.lineId = `BULK-LINE-${String(index + 1).padStart(3, '0')}`;
  row.HEAT_NO = heatNo(Math.floor(index / 7));
  row.SAMPLE_LOT_NO = lotNo(index);
  row.MAT_NUM = (index % 9) + 1;
  row.TOTAL_LEN = 45 + index * 2.25;
  row.weight = Number((row.TOTAL_LEN * 0.061).toFixed(3));
  row.deliveryBundle = (index % 12) + 1;
  return row;
}));

records('chemistry_rows').splice(0, Infinity, ...Array.from({ length: 84 }, (_, index) => {
  const row = structuredClone(base('chemistry_rows'));
  row.printNo = printNo;
  row.partFlag = 'T';
  row.heatNo = heatNo(Math.floor(index / 14));
  row.lotNo = lotNo(Math.floor(index / 2));
  row.analysisId = `BULK-CHEM-${String(index + 1).padStart(3, '0')}`;
  row.analysisType = index % 2 ? 'C' : 'R';
  row.sampleId = `BULK-CS-${String(index + 1).padStart(3, '0')}`;
  row.sequenceNo = index + 1;
  return row;
}));

records('mechanical_rows').splice(0, Infinity, ...Array.from({ length: 42 }, (_, index) => {
  const row = structuredClone(records('mechanical_rows')[index % 3]);
  row.printNo = printNo;
  row.partFlag = 'T';
  row.heatNo = heatNo(Math.floor(index / 7));
  row.lotNo = lotNo(index);
  row.resultId = `BULK-MECH-${String(index + 1).padStart(3, '0')}`;
  row.sampleId = `BULK-TS-${String(index + 1).padStart(3, '0')}`;
  row.sequenceNo = index + 1;
  return row;
}));

records('hardness_points').splice(0, Infinity, ...Array.from({ length: 24 }, (_, sampleIndex) => {
  const pointCount = (sampleIndex % 4) + 1;
  return Array.from({ length: pointCount }, (_, pointIndex) => {
    const row = structuredClone(base('hardness_points'));
    setCertificateKey(row);
    row.HEAT_NO = heatNo(Math.floor(sampleIndex / 4));
    row.SAMPLE_LOT_NO = lotNo(sampleIndex);
    row.sampleId = `BULK-HS-${String(sampleIndex + 1).padStart(3, '0')}`;
    row.sequenceNo = '1';
    row.spotNo = String(pointIndex + 1);
    row.value = 18 + (sampleIndex % 6) + pointIndex / 10;
    return row;
  });
}).flat());

records('inspection_rows').splice(0, Infinity, ...Array.from({ length: 21 }, (_, index) => {
  const row = structuredClone(base('inspection_rows'));
  setCertificateKey(row);
  row.HEAT_NO = heatNo(Math.floor(index / 3));
  row.SAMPLE_LOT_NO = lotNo(Math.floor(index / 2));
  row.resultId = `BULK-INSPECT-${String(index + 1).padStart(3, '0')}`;
  row.itemCode = ['UT', 'VI', 'PT'][index % 3];
  row.itemName = ['无损检测', '外观检验', '渗透检验'][index % 3];
  return row;
}));

writeFileSync(outputPath, `${JSON.stringify(bulk, null, 2)}\n`);
