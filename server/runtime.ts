import { join } from 'node:path';
import { createReportingDemoContext } from '../src/core/adapters/demo-context.ts';
import { LocalResourceRepository, LocalSnapshotRepository, LocalTemplateRepository, LocalViewRepository } from './repositories/local.ts';
import { ReportingService, type RuntimeProject } from './services/generate.ts';
import { loadProjectRegistrations } from './project-registration.ts';

export async function createLocalReportingRuntime(dataDirectory = join(process.cwd(), 'var', 'brickbill-reporting'),
  options: { includeDemoProjects?: boolean; projectsFile?: string } = {}) {
  const projects = new Map<string, RuntimeProject>();
  if (options.includeDemoProjects ?? true) {
    const demo = createReportingDemoContext();
    projects.set(demo.dalipu.project.projectId, demo.dalipu);
    projects.set(demo.generalMes.project.projectId, demo.generalMes);
  }
  const projectsFile = options.projectsFile ?? process.env.REPORTING_PROJECTS_FILE;
  if (projectsFile) for (const [projectId, context] of await loadProjectRegistrations(projectsFile)) {
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
