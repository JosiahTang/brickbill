import { join } from 'node:path';
import { createReportingDemoContext } from '../src/core/adapters/demo-context.ts';
import { LocalResourceRepository, LocalSnapshotRepository, LocalTemplateRepository, LocalViewRepository } from './repositories/local.ts';
import { ReportingService, type RuntimeProject } from './services/generate.ts';
import { loadProjectRegistrations } from './project-registration.ts';

export async function createLocalReportingRuntime(dataDirectory = join(process.cwd(), 'var', 'brickbill-reporting')) {
  const demo = createReportingDemoContext();
  const projects = new Map<string, RuntimeProject>([
    [demo.dalipu.project.projectId, demo.dalipu],
    [demo.generalMes.project.projectId, demo.generalMes],
  ]);
  if (process.env.REPORTING_PROJECTS_FILE) for (const [projectId, context] of await loadProjectRegistrations(process.env.REPORTING_PROJECTS_FILE)) {
    if (projects.has(projectId)) throw new Error(`Project registration conflicts with built-in example: ${projectId}`);
    projects.set(projectId, context);
  }
  const templates = new LocalTemplateRepository(dataDirectory);
  const views = new LocalViewRepository(dataDirectory);
  const snapshots = new LocalSnapshotRepository(dataDirectory);
  const resources = new LocalResourceRepository(dataDirectory);
  for (const [projectId, context] of projects) for (const definition of context.views)
    await views.seedPublished(projectId, definition);
  const service = new ReportingService({ projects, templates, views, snapshots, resources });
  return { service, projects, templates, views, snapshots, resources, dataDirectory };
}
