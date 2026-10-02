import type { ReportingService } from '../../server/services/generate.ts';
import { buildExampleTemplate } from './quality-templates.ts';
import { dalipuTemplates } from './dalipu/index.ts';
import { generalMesTemplates } from './general-mes/index.ts';

/** Optional example installation. The reporting service remains project-agnostic. */
export async function installExampleTemplates(service: ReportingService) {
  const installed: Array<{ projectId: string; templateId: string; version: number }> = [];
  for (const spec of [...dalipuTemplates, ...generalMesTemplates]) {
    const versions = await service.templates.listVersions(spec.projectId, spec.templateId);
    if (versions.length) {
      installed.push({ projectId: spec.projectId, templateId: spec.templateId, version: versions.at(-1)!.version });
      continue;
    }
    const template = await buildExampleTemplate(spec);
    const draft = await service.templates.getDraft(spec.projectId, spec.templateId);
    await service.saveTemplateDraft(spec.projectId, spec.templateId, template, draft?.revision ?? 0);
    const published = await service.publishTemplate(spec.projectId, spec.templateId);
    installed.push({ projectId: spec.projectId, templateId: spec.templateId, version: published.version });
  }
  return installed;
}
