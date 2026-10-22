import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { atomicJson, LocalViewRepository, renameWithTransientRetry } from '../server/repositories/local.ts';

test('T30.6.2 rejects a stale view draft writer and preserves the accepted revision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-t30-revision-'));
  try {
    const repository = new LocalViewRepository(directory);
    const original = { contractVersion: 2, viewId: 'view.concurrent', label: 'original', version: '1.0.0', sourceDatasetId: 'items', outputFields: [], steps: [] };
    const first = await repository.saveDraft('project', original, 0);
    const competing = { ...original, label: 'competing' };
    const [accepted, stale] = await Promise.allSettled([
      repository.saveDraft('project', competing, first.revision),
      repository.saveDraft('project', { ...original, label: 'stale' }, first.revision),
    ]);
    assert.equal([accepted, stale].filter(item => item.status === 'fulfilled').length, 1);
    assert.equal([accepted, stale].filter(item => item.status === 'rejected' && item.reason.code === 'REVISION_CONFLICT').length, 1);
    assert.equal((await repository.getDraft('project', original.viewId)).revision, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('T30.6.3 reuses an already published view version on retry and creates a version only for changed content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-t30-publish-'));
  try {
    const repository = new LocalViewRepository(directory);
    const definition = { contractVersion: 2, viewId: 'view.retry', label: 'retry', version: '1.0.0', sourceDatasetId: 'items', outputFields: [], steps: [] };
    const draft = await repository.saveDraft('project', definition, 0);
    const first = await repository.publish('project', { ...definition, version: '1.0.1' }, draft.revision);
    const retry = await repository.publish('project', { ...definition, version: '1.0.2' }, draft.revision);
    assert.equal(retry.version, first.version);
    assert.equal((await repository.listPublished('project')).length, 1);

    const changed = { ...definition, label: 'changed' };
    const changedDraft = await repository.saveDraft('project', changed, draft.revision);
    const second = await repository.publish('project', { ...changed, version: '1.0.2' }, changedDraft.revision);
    assert.notEqual(second.version, first.version);
    assert.equal((await repository.listPublished('project')).length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('T30.6.4 retries transient Windows rename errors with bounded backoff and stops on permanent errors', async () => {
  const delays = []; let attempts = 0;
  await renameWithTransientRetry('from', 'to', {
    renameOperation: async () => { attempts++; if (attempts < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' }); },
    wait: async milliseconds => { delays.push(milliseconds); },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [25, 50]);

  attempts = 0; delays.length = 0;
  await assert.rejects(renameWithTransientRetry('from', 'to', {
    renameOperation: async () => { attempts++; throw Object.assign(new Error('locked'), { code: 'EBUSY' }); },
    wait: async milliseconds => { delays.push(milliseconds); },
  }), error => error.code === 'EBUSY');
  assert.equal(attempts, 5);
  assert.deepEqual(delays, [25, 50, 100, 200]);
});

test('T30.6.4 removes the temporary JSON file after persistent rename failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brickbill-t30-atomic-'));
  try {
    await assert.rejects(atomicJson(join(directory, 'record.json'), { complete: true }, {
      renameOperation: async () => { throw Object.assign(new Error('still locked'), { code: 'EPERM' }); },
      wait: async () => {},
    }), error => error.code === 'EPERM');
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
