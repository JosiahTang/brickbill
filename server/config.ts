import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { isIP } from 'node:net';
import { spawnSync } from 'node:child_process';

export interface ServerSettings {
  mode: 'development' | 'production';
  host: string;
  port: number;
  dataDirectory: string;
  includeDemoProjects: boolean;
  projectsFile?: string;
  tokensJson?: string;
}

export function parseTokenAuthorizations(value: string | undefined): Record<string, string[]> | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error('REPORTING_TOKENS_JSON 必须是有效 JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.keys(parsed).length
    || Object.entries(parsed).some(([token, projects]) => !token.trim() || !Array.isArray(projects)
      || !projects.length || projects.some(id => typeof id !== 'string' || !id.trim())))
    throw new Error('REPORTING_TOKENS_JSON 必须是令牌到非空项目 ID 列表的映射');
  return parsed as Record<string, string[]>;
}

export function readServerSettings(env: NodeJS.ProcessEnv = process.env): ServerSettings {
  const mode = env.REPORTING_MODE ?? 'development';
  if (mode !== 'development' && mode !== 'production') throw new Error('REPORTING_MODE 只能为 development 或 production');
  const host = env.REPORTING_HOST ?? '127.0.0.1';
  if (!isIP(host) && host !== 'localhost') throw new Error('REPORTING_HOST 必须是 IP 地址或 localhost');
  const port = Number(env.REPORTING_PORT ?? 5174);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('REPORTING_PORT 必须是 1 至 65535 的整数');
  if (mode === 'production' && !env.REPORTING_DATA_DIR)
    throw new Error('生产模式必须配置持久化 REPORTING_DATA_DIR');
  const dataDirectory = env.REPORTING_DATA_DIR ?? resolve('var', 'brickbill-reporting');
  if (mode === 'production' && !isAbsolute(dataDirectory)) throw new Error('生产模式的 REPORTING_DATA_DIR 必须是绝对路径');
  const projectsFile = env.REPORTING_PROJECTS_FILE || undefined;
  if (projectsFile && !isAbsolute(projectsFile)) throw new Error('REPORTING_PROJECTS_FILE 必须是绝对路径');
  const demoFlag = env.REPORTING_DEMO_PROJECTS;
  if (demoFlag && !['enabled', 'disabled'].includes(demoFlag))
    throw new Error('REPORTING_DEMO_PROJECTS 只能为 enabled 或 disabled');
  const includeDemoProjects = demoFlag === 'enabled' || (mode === 'development' && demoFlag !== 'disabled');
  if (!includeDemoProjects && !projectsFile) throw new Error('没有可用项目：配置 REPORTING_PROJECTS_FILE 或明确启用模拟项目');
  const tokensJson = env.REPORTING_TOKENS_JSON || undefined;
  parseTokenAuthorizations(tokensJson);
  if (mode === 'production' && !tokensJson) throw new Error('生产模式必须配置 REPORTING_TOKENS_JSON');
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !tokensJson)
    throw new Error('非本机监听必须配置 REPORTING_TOKENS_JSON');
  const pdfProjects = (env.REPORTING_PDF_ENABLED_PROJECTS ?? '').split(',').map(id => id.trim()).filter(Boolean);
  if (pdfProjects.length) {
    if (!env.REPORTING_PDF_PYTHON || !env.REPORTING_PDF_FALLBACK_FONT)
      throw new Error('开放 PDF 的项目必须配置 REPORTING_PDF_PYTHON 与 REPORTING_PDF_FALLBACK_FONT');
    if (!isAbsolute(env.REPORTING_PDF_PYTHON) || !isAbsolute(env.REPORTING_PDF_FALLBACK_FONT))
      throw new Error('PDF Python 和字体必须使用绝对路径');
  }
  return { mode, host, port, dataDirectory, includeDemoProjects, projectsFile, tokensJson };
}

export function validatePdfRuntime(env: NodeJS.ProcessEnv = process.env): void {
  const enabled = (env.REPORTING_PDF_ENABLED_PROJECTS ?? '').split(',').some(id => !!id.trim());
  if (!enabled) return;
  const python = env.REPORTING_PDF_PYTHON!, font = env.REPORTING_PDF_FALLBACK_FONT!;
  if (!existsSync(python) || !existsSync(font)) throw new Error('PDF Python 或字体文件不存在');
  if (env.REPORTING_PDF_FONT_MAP_JSON) {
    let map: unknown;
    try { map = JSON.parse(env.REPORTING_PDF_FONT_MAP_JSON); }
    catch { throw new Error('REPORTING_PDF_FONT_MAP_JSON 必须是有效 JSON'); }
    if (!map || typeof map !== 'object' || Array.isArray(map) || Object.values(map).some(path =>
      typeof path !== 'string' || !isAbsolute(path) || !existsSync(path)))
      throw new Error('PDF 字体映射必须指向存在的字体绝对路径');
  }
  const result = spawnSync(python, ['-c', 'import reportlab,PIL; print(reportlab.Version)'], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
    env: { ...env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONIOENCODING: 'utf-8' },
  });
  if (result.status !== 0 || result.stdout.trim() !== (env.REPORTING_PDF_REPORTLAB_VERSION ?? '4.4.9'))
    throw new Error('PDF 渲染依赖缺失或 ReportLab 版本不匹配');
}
