import dalipuSource from '../../../tests/fixtures/reporting/dalipu/source.json' with { type: 'json' };
import dalipuMultipageSource from '../../../tests/fixtures/reporting/dalipu/multipage.json' with { type: 'json' };
import generalSource from '../../../tests/fixtures/reporting/general-mes/source.json' with { type: 'json' };
import type { FieldCatalog, ProjectSourceEnvelope } from '../contracts/types.ts';
import { buildFieldCatalog, validateCatalogAgainstProject } from '../catalog/catalog.ts';
import { createQualityFunctionRegistry } from '../functions/hardness.ts';
import { createQualityDataViews, createDalipuDemoProject, createExampleAdapterDefinition,
  createSecondDemoProject, toRuntimeAdapterConfig } from './example-projects.ts';
import { InMemoryProjectAdapter } from './project-adapter.ts';
import { createPrintViews } from '../../../examples/projects/quality-views.ts';

/** Explicit local/demo context. Importing this module is the only path that bundles sample records. */
export function createReportingDemoContext() {
  const dalipuProject = createDalipuDemoProject();
  const generalProject = createSecondDemoProject();
  const baseViews = createQualityDataViews();
  const views = [...baseViews, ...createPrintViews(baseViews)];
  const dalipuCatalog = buildFieldCatalog(dalipuProject);
  const generalCatalog: FieldCatalog = buildFieldCatalog(generalProject);
  validateCatalogAgainstProject(dalipuCatalog, dalipuProject, views);
  validateCatalogAgainstProject(generalCatalog, generalProject, views);
  return {
    dalipu: {
      project: dalipuProject, catalog: dalipuCatalog, views,
      functions: createQualityFunctionRegistry(),
      adapter: new InMemoryProjectAdapter(dalipuProject, toRuntimeAdapterConfig(createExampleAdapterDefinition(dalipuProject)),
        [dalipuSource as ProjectSourceEnvelope, dalipuMultipageSource as ProjectSourceEnvelope]),
      request: { documentType: 'qualityCertificate', businessKey: { printNo: 'DEMO-CERT-001', productPart: 'T' } },
    },
    generalMes: {
      project: generalProject, catalog: generalCatalog, views,
      functions: createQualityFunctionRegistry(),
      adapter: new InMemoryProjectAdapter(generalProject, toRuntimeAdapterConfig(createExampleAdapterDefinition(generalProject)),
        [generalSource as ProjectSourceEnvelope]),
      request: { documentType: 'qualityCertificate', businessKey: { certificateRequestId: 'MES-DEMO-9001' } },
    },
  };
}
