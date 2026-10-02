import { mkdir, readFile, rename, rm, readdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DataViewDefinition, GenerationSnapshot, TemplatePackage } from '../../src/core/contracts/types.ts';

function key(value: string): string { return Buffer.from(value).toString('base64url'); }
async function exists(path: string): Promise<boolean> {
  try { await readFile(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

function compareVersion(a: string, b: string): number {
  const numeric = (value: string) => /^\d+(?:\.\d+)*$/.test(value) ? value.split('.').map(Number) : undefined;
  const left = numeric(a), right = numeric(b);
  if (left && right) {
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      const delta = (left[index] ?? 0) - (right[index] ?? 0);
      if (delta) return delta;
    }
  }
  return a.localeCompare(b, undefined, { numeric: true });
}

const locks = new Map<string, Promise<void>>();
async function exclusive<T>(lockKey: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  locks.set(lockKey, current);
  await previous;
  try { return await operation(); }
  finally { release(); if (locks.get(lockKey) === current) locks.delete(lockKey); }
}

export interface DraftRecord<T> { projectId: string; itemId: string; revision: number; value: T }
export interface PublishedRecord<T> { projectId: string; itemId: string; version: number; publishedAt: string; value: T }
export interface TemplateMatchRule { documentType: string; conditions: Record<string, string>; priority: number }

export class LocalTemplateRepository {
  private readonly root: string;
  constructor(root: string) { this.root = join(root, 'projects'); }
  private base(projectId: string, templateId: string): string { return join(this.root, key(projectId), 'templates', key(templateId)); }
  async saveDraft(template: TemplatePackage, expectedRevision: number): Promise<DraftRecord<TemplatePackage>> {
    const lock = `template:${template.projectId}:${template.packageId}`;
    return exclusive(lock, async () => {
      const path = join(this.base(template.projectId, template.packageId), 'draft.json');
      const old = await readJson<DraftRecord<TemplatePackage>>(path);
      const actual = old?.revision ?? 0;
      if (actual !== expectedRevision) throw Object.assign(new Error(`模板草稿修订冲突：预期 ${expectedRevision}，当前 ${actual}`), { code: 'REVISION_CONFLICT' });
      if (template.status !== 'draft') throw Object.assign(new Error('只能保存模板草稿'), { code: 'CONTRACT_INVALID' });
      const record = { projectId: template.projectId, itemId: template.packageId, revision: actual + 1, value: structuredClone(template) };
      await atomicJson(path, record);
      return record;
    });
  }
  async getDraft(projectId: string, templateId: string): Promise<DraftRecord<TemplatePackage> | undefined> {
    return readJson(join(this.base(projectId, templateId), 'draft.json'));
  }
  async publish(projectId: string, templateId: string, value: TemplatePackage): Promise<PublishedRecord<TemplatePackage>> {
    return exclusive(`template:${projectId}:${templateId}`, async () => {
      const versionsPath = join(this.base(projectId, templateId), 'versions');
      await mkdir(versionsPath, { recursive: true });
      const files = await readdir(versionsPath);
      const version = files.reduce((max, name) => Math.max(max, Number(name.replace(/\.json$/, '')) || 0), 0) + 1;
      const pinned = structuredClone(value); pinned.revision = version; pinned.status = 'published';
      const record = { projectId, itemId: templateId, version, publishedAt: new Date().toISOString(), value: pinned };
      await atomicJson(join(versionsPath, `${version}.json`), record);
      return record;
    });
  }
  async getVersion(projectId: string, templateId: string, version: number): Promise<PublishedRecord<TemplatePackage> | undefined> {
    return readJson(join(this.base(projectId, templateId), 'versions', `${version}.json`));
  }
  async listVersions(projectId: string, templateId: string): Promise<Array<Pick<PublishedRecord<TemplatePackage>, 'itemId' | 'version' | 'publishedAt'>>> {
    const folder = join(this.base(projectId, templateId), 'versions');
    let names: string[]; try { names = await readdir(folder); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const records = await Promise.all(names.filter(name => name.endsWith('.json')).map(name => readJson<PublishedRecord<TemplatePackage>>(join(folder, name))));
    return records.filter((record): record is PublishedRecord<TemplatePackage> => !!record)
      .map(({ itemId, version, publishedAt }) => ({ itemId, version, publishedAt })).sort((a, b) => a.version - b.version);
  }
  async setDisabled(projectId: string, templateId: string, disabled: boolean): Promise<void> {
    await atomicJson(join(this.base(projectId, templateId), 'state.json'), { disabled, updatedAt: new Date().toISOString() });
  }
  async isDisabled(projectId: string, templateId: string): Promise<boolean> {
    return (await readJson<{ disabled: boolean }>(join(this.base(projectId, templateId), 'state.json')))?.disabled ?? false;
  }
  async setMatchRule(projectId: string, templateId: string, version: number, rule: TemplateMatchRule): Promise<TemplateMatchRule> {
    if (!(await this.getVersion(projectId, templateId, version))) throw Object.assign(new Error(`模板发布版本不存在：${templateId}@${version}`), { code: 'DATA_NOT_FOUND' });
    const saved = structuredClone(rule);
    await atomicJson(join(this.base(projectId, templateId), 'matches', `${version}.json`), saved);
    return saved;
  }
  async getMatchRule(projectId: string, templateId: string, version: number): Promise<TemplateMatchRule | undefined> {
    return readJson(join(this.base(projectId, templateId), 'matches', `${version}.json`));
  }
  async match(projectId: string, documentType: string, businessKey: Record<string, string>): Promise<{ templateId: string; version: number }> {
    const projectFolder = join(this.root, key(projectId), 'templates');
    let templateFolders: string[]; try { templateFolders = await readdir(projectFolder); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') templateFolders = []; else throw error; }
    const candidates: Array<{ templateId: string; version: number; priority: number }> = [];
    for (const folder of templateFolders) {
      const templateId = Buffer.from(folder, 'base64url').toString();
      if (!templateId || await this.isDisabled(projectId, templateId)) continue;
      const versions = await this.listVersions(projectId, templateId), latest = versions.at(-1);
      if (!latest) continue;
      const rule = await this.getMatchRule(projectId, templateId, latest.version);
      if (!rule || rule.documentType !== documentType || !Object.entries(rule.conditions).every(([name, value]) => businessKey[name] === value)) continue;
      candidates.push({ templateId, version: latest.version, priority: rule.priority });
    }
    if (!candidates.length) throw Object.assign(new Error(`没有适用的已发布模板：${documentType}`), { code: 'DATA_NOT_FOUND' });
    const maxPriority = Math.max(...candidates.map(candidate => candidate.priority));
    const best = candidates.filter(candidate => candidate.priority === maxPriority);
    if (best.length !== 1) throw Object.assign(new Error(`模板自动匹配结果不唯一：优先级 ${maxPriority} 命中 ${best.length} 个版本`), { code: 'TEMPLATE_MATCH_AMBIGUOUS' });
    return { templateId: best[0].templateId, version: best[0].version };
  }
}

export class LocalViewRepository {
  private readonly root: string;
  constructor(root: string) { this.root = join(root, 'projects'); }
  private base(projectId: string, viewId: string): string { return join(this.root, key(projectId), 'views', key(viewId)); }
  async seedPublished(projectId: string, definition: DataViewDefinition): Promise<void> {
    const path = join(this.base(projectId, definition.viewId), 'versions', `${key(definition.version)}.json`);
    if (!(await exists(path))) await atomicJson(path, { projectId, itemId: definition.viewId, version: definition.version,
      publishedAt: new Date().toISOString(), value: structuredClone(definition) });
  }
  async saveDraft(projectId: string, definition: DataViewDefinition, expectedRevision: number): Promise<DraftRecord<DataViewDefinition>> {
    return exclusive(`view:${projectId}:${definition.viewId}`, async () => {
      const path = join(this.base(projectId, definition.viewId), 'draft.json');
      const old = await readJson<DraftRecord<DataViewDefinition>>(path); const actual = old?.revision ?? 0;
      if (actual !== expectedRevision) throw Object.assign(new Error(`视图草稿修订冲突：预期 ${expectedRevision}，当前 ${actual}`), { code: 'REVISION_CONFLICT' });
      const record = { projectId, itemId: definition.viewId, revision: actual + 1, value: structuredClone(definition) };
      await atomicJson(path, record); return record;
    });
  }
  async getDraft(projectId: string, viewId: string): Promise<DraftRecord<DataViewDefinition> | undefined> {
    return readJson(join(this.base(projectId, viewId), 'draft.json'));
  }
  async publish(projectId: string, definition: DataViewDefinition): Promise<PublishedRecord<DataViewDefinition>> {
    return exclusive(`view:${projectId}:${definition.viewId}`, async () => {
      const folder = join(this.base(projectId, definition.viewId), 'versions'); await mkdir(folder, { recursive: true });
      const path = join(folder, `${key(definition.version)}.json`);
      if (await exists(path)) throw Object.assign(new Error(`视图版本已存在：${definition.viewId}@${definition.version}`), { code: 'DUPLICATE_KEY' });
      const record = { projectId, itemId: definition.viewId, version: definition.version, publishedAt: new Date().toISOString(), value: structuredClone(definition) };
      await atomicJson(path, record); return record;
    });
  }
  async getPublished(projectId: string, viewId: string, version: string): Promise<PublishedRecord<DataViewDefinition> | undefined> {
    return readJson(join(this.base(projectId, viewId), 'versions', `${key(version)}.json`));
  }
  async latest(projectId: string, viewId: string): Promise<PublishedRecord<DataViewDefinition> | undefined> {
    const folder = join(this.base(projectId, viewId), 'versions');
    let names: string[]; try { names = await readdir(folder); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    const records = await Promise.all(names.filter(name => name.endsWith('.json')).map(name => readJson<PublishedRecord<DataViewDefinition>>(join(folder, name))));
    return records.filter((item): item is PublishedRecord<DataViewDefinition> => !!item)
      .sort((a, b) => compareVersion(b.version, a.version) || b.publishedAt.localeCompare(a.publishedAt))[0];
  }
  async listPublished(projectId: string): Promise<Array<PublishedRecord<DataViewDefinition>>> {
    const root = join(this.root, key(projectId), 'views');
    let viewDirs: string[]; try { viewDirs = await readdir(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const versions: Array<PublishedRecord<DataViewDefinition>> = [];
    for (const viewDir of viewDirs) {
      const folder = join(root, viewDir, 'versions');
      let names: string[]; try { names = await readdir(folder); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      for (const name of names.filter(value => value.endsWith('.json'))) {
        const record = await readJson<PublishedRecord<DataViewDefinition>>(join(folder, name));
        if (record) versions.push(record);
      }
    }
    return versions.sort((a, b) => a.itemId.localeCompare(b.itemId) || compareVersion(a.version, b.version) || a.publishedAt.localeCompare(b.publishedAt));
  }
}

export interface StoredGeneration {
  snapshot: GenerationSnapshot;
  projection: unknown;
  mode: 'preview' | 'issue';
  idempotencyKey: string;
  requestHash: string;
  createdAt: string;
}

export interface StoredPdfArtifact {
  bytes: Uint8Array;
  byteLength: number;
  fileName: string;
  mediaType: 'application/pdf';
  sha256: string;
  renderer: { name: 'ReportLab'; version: string; fontPaths: string[]; pageCount: number; scales: number[] };
}

export class LocalSnapshotRepository {
  private readonly root: string;
  constructor(root: string) { this.root = join(root, 'projects'); }
  private path(projectId: string, generationId: string): string { return join(this.root, key(projectId), 'generations', key(generationId)); }
  async commit(record: StoredGeneration, xlsx: Uint8Array): Promise<void> {
    const serialized = JSON.stringify(record);
    const maxSnapshotBytes = Number(process.env.REPORTING_MAX_SNAPSHOT_BYTES ?? 80 * 1024 * 1024);
    if (!Number.isInteger(maxSnapshotBytes) || maxSnapshotBytes < 1024)
      throw Object.assign(new Error('REPORTING_MAX_SNAPSHOT_BYTES 配置无效'), { code: 'CONTRACT_INVALID' });
    if (Buffer.byteLength(serialized) > maxSnapshotBytes)
      throw Object.assign(new Error(`生成快照超过 ${maxSnapshotBytes} 字节限制`), { code: 'RESOURCE_LIMIT_EXCEEDED' });
    const parent = join(this.root, key(record.snapshot.projectId), 'generations');
    const target = this.path(record.snapshot.projectId, record.snapshot.generationId);
    const staging = `${target}.${randomUUID()}.tmp`;
    await mkdir(parent, { recursive: true }); await mkdir(staging, { recursive: false });
    try {
      await writeFile(join(staging, 'record.json'), serialized, { flag: 'wx' });
      await writeFile(join(staging, 'output.xlsx'), xlsx, { flag: 'wx' });
      await rename(staging, target);
    } catch (error) { await rm(staging, { recursive: true, force: true }).catch(() => {}); throw error; }
  }
  async get(projectId: string, generationId: string): Promise<StoredGeneration | undefined> {
    return readJson(join(this.path(projectId, generationId), 'record.json'));
  }
  async readFile(projectId: string, generationId: string): Promise<Uint8Array | undefined> {
    try { return new Uint8Array(await readFile(join(this.path(projectId, generationId), 'output.xlsx'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async readPdf(projectId: string, generationId: string): Promise<StoredPdfArtifact | undefined> {
    const folder = this.path(projectId, generationId);
    const meta = await readJson<Omit<StoredPdfArtifact, 'bytes'>>(join(folder, 'output.pdf.json'));
    if (!meta) return undefined;
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await readFile(join(folder, 'output.pdf'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (bytes.byteLength !== meta.byteLength || createHash('sha256').update(bytes).digest('hex') !== meta.sha256)
      throw Object.assign(new Error('PDF 快照文件校验失败'), { code: 'CONTRACT_INVALID' });
    return { ...meta, bytes };
  }
  async putPdf(projectId: string, generationId: string, artifact: Omit<StoredPdfArtifact, 'sha256' | 'byteLength'>): Promise<StoredPdfArtifact> {
    return exclusive(`pdf:${projectId}:${generationId}`, async () => {
      const existing = await this.readPdf(projectId, generationId);
      if (existing) return existing;
      const folder = this.path(projectId, generationId);
      if (!await readJson(join(folder, 'record.json'))) throw Object.assign(new Error('生成快照不存在'), { code: 'DATA_NOT_FOUND' });
      const sha256 = createHash('sha256').update(artifact.bytes).digest('hex');
      const temporary = join(folder, `output.${randomUUID()}.pdf.tmp`);
      try {
        await writeFile(temporary, artifact.bytes, { flag: 'wx' });
        await rename(temporary, join(folder, 'output.pdf'));
        await atomicJson(join(folder, 'output.pdf.json'), { fileName: artifact.fileName, mediaType: artifact.mediaType,
          byteLength: artifact.bytes.byteLength, sha256, renderer: artifact.renderer });
      } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
      return { ...artifact, byteLength: artifact.bytes.byteLength, sha256 };
    });
  }
  async findByIdempotency(projectId: string, idempotencyKey: string): Promise<StoredGeneration | undefined> {
    const folder = join(this.root, key(projectId), 'generations');
    let dirs: string[]; try { dirs = await readdir(folder); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    for (const dir of dirs.filter(name => !name.endsWith('.tmp'))) {
      const record = await this.get(projectId, Buffer.from(dir, 'base64url').toString());
      if (record?.idempotencyKey === idempotencyKey) return record;
    }
    return undefined;
  }
}

export class LocalResourceRepository {
  private readonly root: string;
  constructor(root: string) { this.root = join(root, 'projects'); }
  async put(projectId: string, resourceId: string, mediaType: string, base64: string): Promise<{ resourceId: string; sha256: string; byteLength: number }> {
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length || bytes.toString('base64') !== base64) throw Object.assign(new Error('资源必须是有效的 base64 数据'), { code: 'CONTRACT_INVALID' });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const folder = join(this.root, key(projectId), 'resources');
    await mkdir(folder, { recursive: true });
    const path = join(folder, `${sha256}.bin`);
    if (!(await exists(path))) {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, path); }
      catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
    }
    await atomicJson(join(folder, `${key(resourceId)}.json`), { resourceId, mediaType, sha256, byteLength: bytes.byteLength, path: `${sha256}.bin` });
    return { resourceId, sha256, byteLength: bytes.byteLength };
  }
  async get(projectId: string, resourceId: string): Promise<{ mediaType: string; base64: string; sha256: string } | undefined> {
    const folder = join(this.root, key(projectId), 'resources');
    const meta = await readJson<{ mediaType: string; sha256: string; path: string }>(join(folder, `${key(resourceId)}.json`));
    if (!meta) return undefined;
    return { mediaType: meta.mediaType, sha256: meta.sha256, base64: (await readFile(join(folder, meta.path))).toString('base64') };
  }
}

export function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
