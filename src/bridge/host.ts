import { downloadBlob, xlsxBlob } from '../export/excel.ts';
import { metadata } from '../domain/operations.ts';
import type { TemplateDocument } from '../domain/model.ts';
import type { TemplatePackage } from '../core/contracts/types.ts';

const CHANNEL = 'report-designer';
interface LegacyRequest {
  channel: typeof CHANNEL; version: 1; id: string; action: 'SAVE_TEMPLATE';
  payload: { fileName: string; byteLength: number; base64: string;
    metadata: ReturnType<typeof metadata>; document: TemplateDocument };
}
interface CapabilityRequest { channel: typeof CHANNEL; version: 1; id: string; action: 'GET_CAPABILITIES'; payload: Record<string, never> }
interface PackageRequest { channel: typeof CHANNEL; version: 2; id: string; action: 'SAVE_TEMPLATE_PACKAGE';
  payload: { fileName: string; byteLength: number; base64: string; templatePackage: TemplatePackage } }
interface GenerationRequest { channel: typeof CHANNEL; version: 2; id: string; action: 'SAVE_GENERATION';
  payload: { fileName: string; byteLength: number; base64: string; projectId: string; generationId: string; sha256: string } }
type Request = LegacyRequest | CapabilityRequest | PackageRequest | GenerationRequest;
interface Reply {
  channel: typeof CHANNEL; version: number; id: string; ok: boolean; result?: unknown; error?: string;
}
interface WebView {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', fn: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', fn: (event: MessageEvent) => void): void;
}
interface HostWindow {
  chrome?: { webview?: WebView };
  CefSharp?: { BindObjectAsync(name: string): Promise<unknown> };
  templateHost?: { invoke(json: string): Promise<string> | string; getCapabilities?(): Promise<unknown> | unknown };
}
function withTimeout<T>(promise: Promise<T>, ms = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('宿主响应超时；保存结果未知，请先核实再重试')), ms);
  })]).finally(() => clearTimeout(timer));
}
function checkReply(value: unknown, id: string, version: number): Reply {
  const data = typeof value === 'string' ? JSON.parse(value) : value;
  if (!data || typeof data !== 'object' || data.channel !== CHANNEL || data.version !== version ||
    data.id !== id || typeof data.ok !== 'boolean') throw new Error('非法宿主响应');
  if (!data.ok) throw new Error(typeof data.error === 'string' ? data.error : '宿主保存失败');
  return data as Reply;
}
function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result); const comma = text.indexOf(',');
      if (comma < 0) reject(new Error('Base64 编码失败')); else resolve(text.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.onabort = () => reject(new Error('读取已取消'));
    reader.readAsDataURL(blob);
  });
}
export async function createHostBridge() {
  const host = window as unknown as HostWindow;
  const webview = host.chrome?.webview;
  if (!webview && host.CefSharp && !host.templateHost)
    await withTimeout(host.CefSharp.BindObjectAsync('templateHost'));
  if (!webview && host.CefSharp && !host.templateHost)
    throw new Error('CefSharp 存在，但 templateHost 未注册；不自动降级为浏览器下载');
  const mode = webview ? 'webview2' : host.templateHost ? 'cefsharp' : 'browser';
  const pending = new Map<string, { version: number; resolve(v: unknown): void; reject(e: Error): void }>();
  let disposed = false;
  const onMessage = (event: MessageEvent) => {
    let data: unknown = event.data;
    try { if (typeof data === 'string') data = JSON.parse(data); } catch { return; }
    if (!data || typeof data !== 'object') return;
    const candidate = data as Partial<Reply>;
    if (candidate.channel !== CHANNEL || typeof candidate.version !== 'number' || typeof candidate.id !== 'string') return;
    const request = pending.get(candidate.id); if (!request) return;
    try { request.resolve(checkReply(candidate, candidate.id, request.version)); }
    catch (e) { request.reject(e instanceof Error ? e : new Error(String(e))); }
  };
  webview?.addEventListener('message', onMessage);
  async function request(message: Request, timeoutMs = 30_000): Promise<unknown> {
    if (disposed) throw new Error('桥接已经销毁');
    if (webview) {
      const response = new Promise<unknown>((resolve, reject) => {
        pending.set(message.id, { version: message.version, resolve, reject });
        try { webview.postMessage(message); }
        catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
      });
      try { return await withTimeout(response, timeoutMs); }
      finally { pending.delete(message.id); }
    }
    if (!host.templateHost) throw new Error('宿主代理不存在');
    const response = await withTimeout(Promise.resolve(host.templateHost.invoke(JSON.stringify(message))));
    return checkReply(response, message.id, message.version);
  }
  let supportedVersions = [1];
  if (webview) {
    try {
      const capability = await request({ channel: CHANNEL, version: 1, id: crypto.randomUUID(), action: 'GET_CAPABILITIES', payload: {} }, 700) as Reply;
      const versions = (capability.result as { supportedVersions?: unknown } | undefined)?.supportedVersions;
      if (Array.isArray(versions) && versions.every(version => Number.isInteger(version))) supportedVersions = versions as number[];
    } catch { /* Older v1 hosts may ignore capability discovery; only v1 messages will be sent. */ }
  } else if (host.templateHost?.getCapabilities) {
    try {
      const capabilities = await withTimeout(Promise.resolve(host.templateHost.getCapabilities()), 700) as { supportedVersions?: unknown };
      if (Array.isArray(capabilities?.supportedVersions) && capabilities.supportedVersions.every(version => Number.isInteger(version)))
        supportedVersions = capabilities.supportedVersions as number[];
    } catch { /* Keep the interoperable v1 fallback. */ }
  }
  const supportsPackageSave = supportedVersions.includes(2);
  return {
    mode,
    supportsPackageSave,
    async save(fileName: string, bytes: Uint8Array, doc: TemplateDocument) {
      if (disposed) throw new Error('桥接已经销毁');
      const base = fileName.replace(/\.xlsx$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 90);
      const safeName = `${base || 'template'}.xlsx`;
      const blob = xlsxBlob(bytes);
      if (mode === 'browser') {
        downloadBlob(blob, safeName);
        return { mode, status: 'download-requested' as const }; // NOT "saved successfully"
      }
      // Application-level contract, not a claimed WebView2/CEF transport limit.
      if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('示例限制单次宿主传输 8 MiB；大文件需扩展分块协议');
      const message: LegacyRequest = {
        channel: CHANNEL, version: 1, id: crypto.randomUUID(), action: 'SAVE_TEMPLATE',
        payload: { fileName: safeName, byteLength: bytes.byteLength,
          base64: await blobBase64(blob), metadata: metadata(doc), document: doc },
      };
      if (new TextEncoder().encode(JSON.stringify(message)).byteLength > 16 * 1024 * 1024)
        throw new Error('文件与元数据总消息超过示例限制 16 MiB');
      const result = await request(message);
      return { mode, status: 'acknowledged' as const, result };
    },
    async savePackage(fileName: string, bytes: Uint8Array, templatePackage: TemplatePackage) {
      if (disposed) throw new Error('桥接已经销毁');
      const base = fileName.replace(/\.xlsx$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 90);
      const safeName = `${base || 'template'}.xlsx`, blob = xlsxBlob(bytes);
      if (mode === 'browser' || !supportsPackageSave) {
        downloadBlob(blob, safeName);
        return { mode, status: 'download-requested' as const, result: mode === 'browser' ? undefined : '宿主未协商模板包协议 v2，已回退为浏览器下载' };
      }
      if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('宿主模板包传输上限为 8 MiB；请扩展宿主的分块协议');
      const message: PackageRequest = { channel: CHANNEL, version: 2, id: crypto.randomUUID(), action: 'SAVE_TEMPLATE_PACKAGE',
        payload: { fileName: safeName, byteLength: bytes.byteLength, base64: await blobBase64(blob), templatePackage } };
      if (new TextEncoder().encode(JSON.stringify(message)).byteLength > 16 * 1024 * 1024)
        throw new Error('模板包与元数据总消息超过宿主示例限制 16 MiB');
      const result = await request(message);
      return { mode, status: 'acknowledged' as const, result };
    },
    async saveGenerated(fileName: string, bytes: Uint8Array, artifact: { projectId: string; generationId: string; sha256: string }) {
      if (disposed) throw new Error('桥接已经销毁');
      const base = fileName.replace(/\.xlsx$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 90);
      const safeName = `${base || 'generation'}.xlsx`, blob = xlsxBlob(bytes);
      if (mode === 'browser' || !supportsPackageSave) {
        downloadBlob(blob, safeName);
        return { mode, status: 'download-requested' as const, result: mode === 'browser' ? undefined : '宿主未协商文件保存协议 v2，已回退为浏览器下载' };
      }
      if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('宿主生成文件传输上限为 8 MiB；请扩展宿主的分块协议');
      const message: GenerationRequest = { channel: CHANNEL, version: 2, id: crypto.randomUUID(), action: 'SAVE_GENERATION',
        payload: { fileName: safeName, byteLength: bytes.byteLength, base64: await blobBase64(blob), ...artifact } };
      if (new TextEncoder().encode(JSON.stringify(message)).byteLength > 16 * 1024 * 1024)
        throw new Error('生成文件总消息超过宿主示例限制 16 MiB');
      const result = await request(message);
      return { mode, status: 'acknowledged' as const, result };
    },
    dispose() {
      disposed = true; webview?.removeEventListener('message', onMessage);
      pending.forEach(p => p.reject(new Error('页面关闭，通信已取消'))); pending.clear();
    },
  };
}
