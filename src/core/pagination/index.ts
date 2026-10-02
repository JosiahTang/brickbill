import type { DataViewResult, PagePlan, Scalar, TemplatePackage } from '../contracts/types.ts';
import { ReportingError } from '../contracts/errors.ts';
import { planFixedPages } from './fixed.ts';
import { planFlowPages } from './flow.ts';

export function planPages(template: TemplatePackage, pageDefinitionId: string, views: DataViewResult[],
  options: { parameters?: Record<string, Scalar> } = {}): PagePlan {
  const definition = template.pageDefinitions?.find(page => page.pageDefinitionId === pageDefinitionId);
  if (!definition) throw new ReportingError({ code: 'FIELD_NOT_FOUND', stage: 'layout', message: `页面定义不存在：${pageDefinitionId}` });
  return definition.paginationMode === 'flow' ? planFlowPages(template, pageDefinitionId, views, options.parameters)
    : planFixedPages(template, pageDefinitionId, views);
}
