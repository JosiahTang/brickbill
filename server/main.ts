import { createLocalReportingRuntime } from './runtime.ts';
import { createReportingHttpServer, loopbackAuthorizer } from './http/app.ts';

const port = Number(process.env.REPORTING_PORT ?? 5174);
const dataDirectory = process.env.REPORTING_DATA_DIR;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('REPORTING_PORT 必须是 1 至 65535 的整数');
const runtime = await createLocalReportingRuntime(dataDirectory);
const server = createReportingHttpServer(runtime.service,
  loopbackAuthorizer(process.env.REPORTING_TOKENS_JSON, [...runtime.projects.keys()]));
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Brickbill reporting API listening at http://127.0.0.1:${port}/api\n`);
  process.stdout.write(`Data directory: ${runtime.dataDirectory}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
