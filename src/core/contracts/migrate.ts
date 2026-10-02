import { copy, type TemplateDocument } from '../../domain/model.ts';
import { validateDocument } from '../../domain/operations.ts';
import { ReportingError } from './errors.ts';
import { REPORTING_CONTRACT_VERSION, type TemplatePackage } from './types.ts';
import { validateContract } from './validate.ts';

export interface LegacyMigrationOptions {
  projectId: string;
  catalogVersion?: string;
  packageId?: string;
}

/** Upgrade one saved v0.2 document without changing coordinates, values, styles or path bindings. */
export function migrateV02Template(value: unknown, options: LegacyMigrationOptions): TemplatePackage {
  const wrapped = value && typeof value === 'object' && 'document' in value
    ? (value as { document: unknown }).document : value;
  if (!wrapped || typeof wrapped !== 'object' || Array.isArray(wrapped))
    throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'contract', message: '旧模板必须是 v0.2 模板文档或包含 document 的 JSON 对象' });
  const document = wrapped as TemplateDocument;
  if (document.schemaVersion !== 1)
    throw new ReportingError({ code: 'CONTRACT_VERSION_UNSUPPORTED', stage: 'contract',
      message: `旧模板版本 ${String((document as { schemaVersion?: unknown }).schemaVersion)} 不是受支持的 v0.2 文档版本` });
  try { validateDocument(document); }
  catch (error) {
    throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'contract',
      message: `旧模板校验失败：${error instanceof Error ? error.message : String(error)}` });
  }
  if (!options.projectId?.trim())
    throw new ReportingError({ code: 'CONTRACT_INVALID', stage: 'contract', message: '迁移模板必须指定所属项目' });

  const migrated = copy(document);
  const workbookBytes = migrated.excelSource?.base64;
  // Workbook bytes belong to the package and must only be retained once.
  if (migrated.excelSource) migrated.excelSource.base64 = '';
  const packageId = options.packageId ?? migrated.id;
  const result: TemplatePackage = {
    contractVersion: REPORTING_CONTRACT_VERSION,
    packageId, projectId: options.projectId, name: migrated.name, revision: migrated.revision,
    status: 'draft', catalogVersion: options.catalogVersion ?? 'legacy-v0.2',
    viewRefs: [], functionRefs: [],
    worksheets: [{ worksheetId: 'legacy.sheet.1', name: migrated.sheetName,
      visible: true, bindingMode: 'legacy-path', document: migrated }],
    ...(workbookBytes ? { sourceWorkbook: { fileName: migrated.excelSource?.fileName ?? `${migrated.name}.xlsx`, base64: workbookBytes } } : {}),
  };
  validateContract<TemplatePackage>('templatePackage', result);
  return result;
}
