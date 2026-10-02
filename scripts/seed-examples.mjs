import { createLocalReportingRuntime } from '../server/runtime.ts';
import { installExampleTemplates } from '../examples/projects/install.ts';

const runtime = await createLocalReportingRuntime();
for (const item of await installExampleTemplates(runtime.service))
  console.log(`${item.projectId}: ${item.templateId}@${item.version}`);
