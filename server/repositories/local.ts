import { mkdir, readFile, rename, rm, readdir, writeFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { DataViewDefinition, GenerationSnapshot, Scalar, TemplatePackage } from '../../src/core/contracts/types.ts';

function key(value: string): string { return Buffer.from(value).toString('base64url'); }
async function exists(path: string): Promise<boolean> {
  try { await readFile(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export async function renameWithTransientRetry(source: string, target: string, options: {
  renameOperation?: typeof rename; wait?: typeof delay;
} = {}): Promise<void> {
  const retryable = new Set(['EPERM', 'EBUSY', 'EACCES']);
  const renameOperation = options.renameOperation ?? rename, wait = options.wait ?? delay;
  for (let attempt = 0; ; attempt++) {
    try { await renameOperation(source, target); return; }
    catch (error) {
      if (!retryable.has((error as NodeJS.ErrnoException).code ?? '') || attempt >= 4) throw error;
      await wait(25 * 2 ** attempt);
    }
  }
}
export async function atomicJson(path: string, value: unknown, retryOptions: Parameters<typeof renameWithTransientRetry>[2] = {}): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx' });
    await renameWithTransientRetry(temporary, path, retryOptions);
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
export interface TemplateMatchCandidate {
  templateId: string; version: number; disabled: boolean; priority: number; conditions: Record<string, string>;
}

/** Evaluate an already captured rule set without reading storage again. */
export function evaluateTemplateMatches(captured: TemplateMatchCandidate[], inputs: Record<string, string>, pendingKeys: string[] = []) {
  const pending = new Set(pendingKeys);
  const candidates = captured.map(item => {
    const mismatchedFields = Object.entries(item.conditions).filter(([key, value]) => !pending.has(key) && inputs[key] !== value).map(([key]) => key);
    const pendingFields = Object.keys(item.conditions).filter(key => pending.has(key));
    const matches = !mismatchedFields.length && !pendingFields.length;
    return { ...structuredClone(item), matches, mismatchedFields, pendingFields,
      status: item.disabled ? 'disabled' : mismatchedFields.length ? 'mismatch' : pendingFields.length ? 'pendingFacts' : 'matched' };
  });
  const activeMatches = candidates.filter(item => !item.disabled && item.matches);
  const maximumPriority = activeMatches.length ? Math.max(...activeMatches.map(item => item.priority)) : undefined;
  const winners = maximumPriority === undefined ? [] : activeMatches.filter(item => item.priority === maximumPriority);
  return { candidates, winner: winners.length === 1 ? winners[0] : undefined, ambiguous: winners.length > 1, maximumPriority };
}

export function selectTemplateMatch(inspection: ReturnType<typeof evaluateTemplateMatches>, documentType: string) {
  if (!inspection.winner && !inspection.ambiguous)
    throw Object.assign(new Error(`没有适用的已发布模板：${documentType}`), { code: 'DATA_NOT_FOUND' });
  if (inspection.ambiguous || !inspection.winner)
    throw Object.assign(new Error(`模板自动匹配结果不唯一：优先级 ${inspection.maximumPriority}`), { code: 'TEMPLATE_MATCH_AMBIGUOUS' });
  const { templateId, version, conditions, priority } = inspection.winner;
  return { templateId, version, conditions, priority };
}
export interface TemplateListItem {
  templateId: string;
  name: string;
  latestVersion?: number;
  draftRevision?: number;
  disabled: boolean;
}

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
  async publish(projectId: string, templateId: string, value: TemplatePackage, expectedDraftRevision: number): Promise<PublishedRecord<TemplatePackage>> {
    return exclusive(`template:${projectId}:${templateId}`, async () => {
      const draft = await this.getDraft(projectId, templateId);
      if (!draft || draft.revision !== expectedDraftRevision) throw Object.assign(
        new Error(`模板草稿修订冲突：预期 ${expectedDraftRevision}，当前 ${draft?.revision ?? 0}`), { code: 'REVISION_CONFLICT' });
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
  async listTemplates(projectId: string): Promise<TemplateListItem[]> {
    const folder = join(this.root, key(projectId), 'templates');
    let names: string[];
    try { names = await readdir(folder); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const items = await Promise.all(names.map(async name => {
      const templateId = Buffer.from(name, 'base64url').toString();
      if (!templateId) return undefined;
      const [draft, versions, disabled] = await Promise.all([
        this.getDraft(projectId, templateId), this.listVersions(projectId, templateId), this.isDisabled(projectId, templateId),
      ]);
      const latestVersion = versions.at(-1);
      const latest = latestVersion ? await this.getVersion(projectId, templateId, latestVersion.version) : undefined;
      const nameValue = latest?.value.name ?? draft?.value.name ?? templateId;
      return { templateId, name: nameValue, ...(latestVersion ? { latestVersion: latestVersion.version } : {}),
        ...(draft ? { draftRevision: draft.revision } : {}), disabled } satisfies TemplateListItem;
    }));
    return items.filter((item): item is TemplateListItem => !!item)
      .sort((a, b) => a.name.localeCompare(b.name) || a.templateId.localeCompare(b.templateId));
  }
  async setDisabled(projectId: string, templateId: string, disabled: boolean): Promise<void> {
    await atomicJson(join(this.base(projectId, templateId), 'state.json'), { disabled, updatedAt: new Date().toISOString() });
  }
  async isDisabled(projectId: string, templateId: string): Promise<boolean> {
    return (await readJson<{ disabled: boolean }>(join(this.base(projectId, templateId), 'state.json')))?.disabled ?? false;
  }
  async setMatchRule(projectId: string, templateId: string, version: number, rule: TemplateMatchRule): Promise<TemplateMatchRule> {
    return exclusive(`match-rule:${projectId}:${templateId}:${version}`, async () => {
      if (!(await this.getVersion(projectId, templateId, version))) throw Object.assign(new Error(`模板发布版本不存在：${templateId}@${version}`), { code: 'DATA_NOT_FOUND' });
      const saved = structuredClone(rule);
      await atomicJson(join(this.base(projectId, templateId), 'matches', `${version}.json`), saved);
      return saved;
    });
  }
  async getMatchRule(projectId: string, templateId: string, version: number): Promise<TemplateMatchRule | undefined> {
    return readJson(join(this.base(projectId, templateId), 'matches', `${version}.json`));
  }
  async deleteMatchRule(projectId: string, templateId: string, version: number): Promise<void> {
    await exclusive(`match-rule:${projectId}:${templateId}:${version}`, async () => {
      try { await unlink(join(this.base(projectId, templateId), 'matches', `${version}.json`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    });
  }
  async inspectMatches(projectId: string, documentType: string, businessKey: Record<string, string>) {
    const projectFolder = join(this.root, key(projectId), 'templates');
    let folders: string[];
    try { folders = await readdir(projectFolder); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') folders = []; else throw error; }
    const candidates: TemplateMatchCandidate[] = [];
    for (const folder of folders) {
      const templateId = Buffer.from(folder, 'base64url').toString();
      if (!templateId) continue;
      const latest = (await this.listVersions(projectId, templateId)).at(-1);
      if (!latest) continue;
      const rule = await this.getMatchRule(projectId, templateId, latest.version);
      if (!rule || rule.documentType !== documentType) continue;
      candidates.push({ templateId, version: latest.version, disabled: await this.isDisabled(projectId, templateId),
        priority: rule.priority, conditions: rule.conditions });
    }
    return evaluateTemplateMatches(candidates, businessKey);
  }
  async match(projectId: string, documentType: string, businessKey: Record<string, string>): Promise<{
    templateId: string; version: number; conditions: Record<string, string>; priority: number;
  }> {
    return selectTemplateMatch(await this.inspectMatches(projectId, documentType, businessKey), documentType);
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
  async publish(projectId: string, definition: DataViewDefinition, expectedDraftRevision: number): Promise<PublishedRecord<DataViewDefinition>> {
    return exclusive(`view:${projectId}:${definition.viewId}`, async () => {
      const draft = await this.getDraft(projectId, definition.viewId);
      if (!draft || draft.revision !== expectedDraftRevision) throw Object.assign(
        new Error(`视图草稿修订冲突：预期 ${expectedDraftRevision}，当前 ${draft?.revision ?? 0}`), { code: 'REVISION_CONFLICT' });
      const folder = join(this.base(projectId, definition.viewId), 'versions'); await mkdir(folder, { recursive: true });
      const comparable = (value: DataViewDefinition) => {
        const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize)
          : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => [name, normalize(child)])) : item;
        const { version: _version, ...content } = value;
        return JSON.stringify(normalize(content));
      };
      const existingFiles = await readdir(folder);
      for (const name of existingFiles.filter(item => item.endsWith('.json'))) {
        const existing = await readJson<PublishedRecord<DataViewDefinition>>(join(folder, name));
        if (existing && comparable(existing.value) === comparable(definition)) return existing;
      }
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
  signoff?: { actorId: string; signedAt: string };
}
export interface StoredGenerationHistory {
  generationId: string;
  documentType: string;
  businessKey: Record<string, Scalar>;
  templateRef: { packageId: string; revision: number };
  templateMatch?: GenerationSnapshot['templateMatch'];
  status: 'preview' | 'issue';
  createdAt: string;
  signoff?: { actorId: string; signedAt: string };
  pageCount: number;
  output?: GenerationSnapshot['output'];
}
function historySummary(record: StoredGeneration): StoredGenerationHistory {
  return {
    generationId: record.snapshot.generationId, documentType: record.snapshot.data.documentType,
    businessKey: structuredClone(record.snapshot.businessKey), templateRef: structuredClone(record.snapshot.templateRef),
    ...(record.snapshot.templateMatch ? { templateMatch: structuredClone(record.snapshot.templateMatch) } : {}),
    status: record.mode, createdAt: record.createdAt, ...(record.signoff ? { signoff: structuredClone(record.signoff) } : {}),
    pageCount: record.snapshot.pagePlan?.totalPages ?? 0, ...(record.snapshot.output ? { output: structuredClone(record.snapshot.output) } : {}),
  };
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
      await writeFile(join(staging, 'history.json'), JSON.stringify(historySummary(record)), { flag: 'wx' });
      await renameWithTransientRetry(staging, target);
    } catch (error) { await rm(staging, { recursive: true, force: true }).catch(() => {}); throw error; }
  }
  async get(projectId: string, generationId: string): Promise<StoredGeneration | undefined> {
    return readJson(join(this.path(projectId, generationId), 'record.json'));
  }
  async list(projectId: string): Promise<StoredGenerationHistory[]> {
    const folder = join(this.root, key(projectId), 'generations');
    let names: string[];
    try { names = await readdir(folder); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const records: StoredGenerationHistory[] = [];
    for (const name of names.filter(name => !name.endsWith('.tmp'))) {
      const generationId = Buffer.from(name, 'base64url').toString();
      const folderPath = this.path(projectId, generationId);
      let summary = await readJson<StoredGenerationHistory>(join(folderPath, 'history.json'));
      if (!summary) {
        const legacy = await this.get(projectId, generationId);
        if (!legacy) continue;
        summary = historySummary(legacy);
        await atomicJson(join(folderPath, 'history.json'), summary);
      }
      records.push(summary);
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.generationId.localeCompare(a.generationId));
  }
  async signoff(projectId: string, generationId: string, actorId: string): Promise<StoredGeneration> {
    return exclusive(`generation-signoff:${projectId}:${generationId}`, async () => {
      const record = await this.get(projectId, generationId);
      if (!record) throw Object.assign(new Error(`生成记录不存在：${generationId}`), { code: 'DATA_NOT_FOUND' });
      if (record.signoff) {
        await atomicJson(join(this.path(projectId, generationId), 'history.json'), historySummary(record));
        return record;
      }
      if (record.mode !== 'preview') throw Object.assign(new Error('只有预览记录可以确认签发'), { code: 'CONTRACT_INVALID' });
      const signed = { ...record, mode: 'issue' as const, signoff: { actorId, signedAt: new Date().toISOString() } };
      await atomicJson(join(this.path(projectId, generationId), 'record.json'), signed);
      await atomicJson(join(this.path(projectId, generationId), 'history.json'), historySummary(signed));
      return signed;
    });
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

export { sha256 } from '../../src/core/reporting/digest.ts';
