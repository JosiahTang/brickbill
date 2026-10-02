import { copy, type TemplateDocument } from '../domain/model.ts';
import { validateDocument } from '../domain/operations.ts';
import type { TemplatePackage } from '../core/contracts/types.ts';
import { validateTemplatePackage } from '../core/templates/package.ts';

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('brickbill-designer', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法打开本地草稿存储，请使用保存模板文件'));
  });
}
export type SavedDraft = TemplateDocument | TemplatePackage;
export async function saveDraft(document: SavedDraft): Promise<void> {
  if ('worksheets' in document) validateTemplatePackage(document); else validateDocument(document);
  const db = await database();
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('drafts', 'readwrite'); tx.objectStore('drafts').put(copy(document), 'current');
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(new Error('本地草稿保存失败，可能存储空间不足')); tx.onabort = tx.onerror;
  }); } finally { db.close(); }
}
export async function loadDraft(): Promise<SavedDraft | undefined> {
  const db = await database();
  try { return await new Promise((resolve, reject) => {
    const request = db.transaction('drafts').objectStore('drafts').get('current');
    request.onsuccess = () => { try {
      if (request.result) {
        if (typeof request.result === 'object' && 'worksheets' in request.result) validateTemplatePackage(request.result);
        else validateDocument(request.result);
      }
      resolve(request.result);
    } catch (e) { reject(e); } };
    request.onerror = () => reject(new Error('本地草稿读取失败'));
  }); } finally { db.close(); }
}
