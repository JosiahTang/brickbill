import { readFile } from 'node:fs/promises';
import type { DataViewDefinition, ProjectDefinition, ProjectAdapterDefinition } from '../src/core/contracts/types.ts';
import { validateContract, validateProjectSemantics } from '../src/core/contracts/validate.ts';
import { buildFieldCatalog, validateCatalogAgainstProject } from '../src/core/catalog/catalog.ts';
import { HttpProjectAdapter } from '../src/core/adapters/project-adapter.ts';
import { createQualityFunctionRegistry } from '../src/core/functions/hardness.ts';
import { DataViewEngine } from '../src/core/views/engine.ts';
import type { RuntimeProject } from './services/generate.ts';

export interface ProjectRegistration {
  project: ProjectDefinition;
  adapter: ProjectAdapterDefinition;
  views: DataViewDefinition[];
  source: { endpoint: string; timeoutMs?: number; maxResponseBytes?: number; bearerTokenEnv?: string };
}

export async function readProjectRegistrationFile(fileName: string): Promise<ProjectRegistration[]> {
  const source = JSON.parse(await readFile(fileName, 'utf8')) as unknown;
  if (!Array.isArray(source)) throw new Error('Project registration file must be an array');
  for (const item of source) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid project registration');
  }
  return source as ProjectRegistration[];
}

/** Loads declarative projects, reusing the existing HTTP adapter and view engine. */
export async function loadProjectRegistrations(fileName: string, options: { requireSecrets?: boolean; projectId?: string } = {}): Promise<Map<string, RuntimeProject>> {
  const source = await readProjectRegistrationFile(fileName);
  const projects = new Map<string, RuntimeProject>();
  for (const item of source) {
    const registration = item;
    validateContract<ProjectDefinition>('project', registration.project);
    validateProjectSemantics(registration.project);
    validateContract<ProjectAdapterDefinition>('projectAdapter', registration.adapter);
    if (!Array.isArray(registration.views) || !registration.source?.endpoint)
      throw new Error(`Incomplete project registration: ${registration.project.projectId}`);
    for (const view of registration.views) validateContract<DataViewDefinition>('dataView', view);
    const catalog = buildFieldCatalog(registration.project);
    validateCatalogAgainstProject(catalog, registration.project, registration.views);
    const functions = createQualityFunctionRegistry();
    new DataViewEngine({ project: registration.project, catalog: catalog.fields, views: registration.views, functions });
    const tokenEnv = registration.source.bearerTokenEnv;
    if (tokenEnv && !/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv)) throw new Error('Invalid bearerTokenEnv');
    const shouldRequireSecret = options.requireSecrets !== false
      && (!options.projectId || options.projectId === registration.project.projectId);
    if (shouldRequireSecret && tokenEnv && !process.env[tokenEnv])
      throw new Error(`Missing project source token environment variable ${tokenEnv}`);
    const adapter = new HttpProjectAdapter(registration.project, registration.adapter, {
      endpoint: registration.source.endpoint, timeoutMs: registration.source.timeoutMs,
      maxResponseBytes: registration.source.maxResponseBytes,
      ...(tokenEnv ? { headers: () => {
        const token = process.env[tokenEnv];
        if (!token) throw new Error(`Missing project source token environment variable ${tokenEnv}`);
        return { authorization: `Bearer ${token}` };
      } } : {}),
    });
    if (projects.has(registration.project.projectId)) throw new Error(`Duplicate project ${registration.project.projectId}`);
    projects.set(registration.project.projectId, { project: registration.project, catalog, views: registration.views, functions, adapter });
  }
  return projects;
}
