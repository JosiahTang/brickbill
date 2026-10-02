import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dalipuBulk from '../tests/fixtures/reporting/dalipu/multipage.json' with { type: 'json' };
import { createLocalReportingRuntime } from '../server/runtime.ts';
import { installExampleTemplates } from '../examples/projects/install.ts';
import { InMemoryProjectAdapter } from '../src/core/adapters/project-adapter.ts';
import { createExampleAdapterDefinition, toRuntimeAdapterConfig } from '../src/core/adapters/example-projects.ts';

const directory = await mkdtemp(join(tmpdir(), 'brickbill-benchmark-'));
try {
  const { service } = await createLocalReportingRuntime(directory);
  const versions = await installExampleTemplates(service);
  const project = service.project('dalipu-demo');
  const single = project.request;
  const template = versions.find(item => item.templateId === 'dalipu-certificate-v1');
  for (const [name, key] of [['single', single.businessKey], ['multipage', dalipuBulk.businessKey]]) {
    if (name === 'multipage') project.adapter = new InMemoryProjectAdapter(project.project,
      toRuntimeAdapterConfig(createExampleAdapterDefinition(project.project)), [dalipuBulk]);
    const start = performance.now();
    const result = await service.generate('dalipu-demo', { mode: 'preview', documentType: 'qualityCertificate',
      businessKey: key, templateRef: { id: template.templateId, version: template.version },
      idempotencyKey: `benchmark:${name}:${start}` });
    console.log(JSON.stringify({ scenario: name, elapsedMs: Math.round(performance.now() - start),
      pages: result.snapshot.pagePlan.totalPages, bytes: result.snapshot.output.byteLength,
      sourceVersion: result.snapshot.sourceVersion }));
  }
} finally { await rm(directory, { recursive: true, force: true }); }
