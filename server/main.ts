import { createLocalReportingRuntime } from './runtime.ts';
import { createReportingHttpServer, loopbackAuthorizer } from './http/app.ts';
import { parseTokenActorIds, parseTokenAuthorizations, readServerSettings, validatePdfRuntime } from './config.ts';

const settings = readServerSettings();
const runtime = await createLocalReportingRuntime(settings.dataDirectory,
  { includeDemoProjects: settings.includeDemoProjects, projectsFile: settings.projectsFile });
if (!runtime.projects.size) throw new Error('项目注册文件没有可用项目');
for (const projectIds of Object.values(parseTokenAuthorizations(settings.tokensJson) ?? {}))
  for (const projectId of projectIds) if (!runtime.projects.has(projectId))
    throw new Error(`令牌配置引用不存在的项目：${projectId}`);
for (const token of Object.keys(parseTokenActorIds(settings.tokenActorsJson, settings.tokensJson) ?? {}))
  if (!parseTokenAuthorizations(settings.tokensJson)?.[token]) throw new Error('操作者映射引用了未授权令牌');
const pdfProjects = (process.env.REPORTING_PDF_ENABLED_PROJECTS ?? '').split(',').map(id => id.trim()).filter(Boolean);
for (const projectId of pdfProjects) if (!runtime.projects.has(projectId))
  throw new Error(`PDF 项目开关引用不存在的项目：${projectId}`);
validatePdfRuntime();
const server = createReportingHttpServer(runtime.service,
  loopbackAuthorizer(settings.tokensJson, [...runtime.projects.keys()], settings.tokenActorsJson));
server.listen(settings.port, settings.host, () => {
  process.stdout.write(`Brickbill reporting API listening at http://${settings.host}:${settings.port}/api\n`);
  process.stdout.write(`Data directory: ${runtime.dataDirectory}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
