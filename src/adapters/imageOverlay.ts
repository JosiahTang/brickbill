import type { TemplatePackage } from '../core/contracts/types.ts';
import type { Rect, TemplateDocument } from '../domain/model.ts';
import { axisPosition, imagePixels, imageRect } from '../domain/images.ts';

/** DOM image projection on the existing Univer viewport; no independent grid or undo stack. */
export function mountImageOverlay(container: HTMLElement, viewport: () => { left: number; top: number; scrollX: number; scrollY: number; zoom: number } | undefined,
  update: (imageId: string, rect: Rect) => void) {
  const layer = document.createElement('div'); layer.className = 'template-images';
  Object.assign(layer.style, { position: 'absolute', right: '18px', bottom: '18px', overflow: 'hidden', pointerEvents: 'none', zIndex: '9' });
  container.appendChild(layer);
  let doc: TemplateDocument, resources: NonNullable<TemplatePackage['resources']> = [], frame = 0, disposed = false;
  const nodes = new Map<string, HTMLDivElement>();
  let selected = '', gesture: { node: HTMLDivElement; pointerId: number; id: string; x: number; y: number; resize: boolean;
    box: ReturnType<typeof imagePixels>; startScrollX: number; startScrollY: number; next: ReturnType<typeof imagePixels>; revision: number } | undefined;
  function select(id: string) {
    selected = id;
    for (const [key, node] of nodes) {
      node.style.outline = key === id ? '2px solid #2563eb' : '';
      const handle = node.querySelector<HTMLElement>('.image-resize-handle'); if (handle) handle.hidden = key !== id;
    }
  }
  function begin(event: PointerEvent, id: string, node: HTMLDivElement) {
    if (event.button !== 0 || gesture) return;
    const image = doc.images?.find(item => item.imageId === id), view = viewport(); if (!image || !view) return;
    event.preventDefault(); event.stopPropagation(); select(id); node.focus();
    const box = imagePixels(image.rect, doc);
    gesture = { node, pointerId: event.pointerId, id, x: event.clientX, y: event.clientY,
      resize: (event.target as HTMLElement).classList.contains('image-resize-handle'), box, next: box,
      startScrollX: view.scrollX, startScrollY: view.scrollY, revision: doc.revision };
    node.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent) {
    const active = gesture, view = viewport(); if (!active || !view || event.pointerId !== active.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    const dx = (event.clientX - active.x) / view.zoom + view.scrollX - active.startScrollX;
    const dy = (event.clientY - active.y) / view.zoom + view.scrollY - active.startScrollY;
    const totalW = axisPosition(doc.cols, doc.colWidthPx), totalH = axisPosition(doc.rows, doc.rowHeightPx);
    active.next = active.resize ? { ...active.box, width: Math.max(1, Math.min(totalW - active.box.x, active.box.width + dx)),
      height: Math.max(1, Math.min(totalH - active.box.y, active.box.height + dy)) }
      : { ...active.box, x: Math.max(0, Math.min(totalW - active.box.width, active.box.x + dx)),
        y: Math.max(0, Math.min(totalH - active.box.height, active.box.y + dy)) };
    schedule();
  }
  function finish(event: PointerEvent) {
    const active = gesture; if (!active || active.pointerId !== event.pointerId) return;
    event.stopPropagation(); gesture = undefined;
    if (active.node.hasPointerCapture(event.pointerId)) active.node.releasePointerCapture(event.pointerId);
    if (event.type === 'pointerup' && active.revision === doc.revision && JSON.stringify(active.next) !== JSON.stringify(active.box))
      update(active.id, imageRect(active.next, doc));
    schedule();
  }
  function draw() {
    frame = 0; if (disposed || !doc) return;
    const view = viewport(); if (!view) return;
    // The asynchronous initial React workbench mount can replace container children.
    if (!layer.isConnected) container.appendChild(layer);
    layer.style.left = `${view.left}px`; layer.style.top = `${view.top}px`;
    const ids = new Set((doc.images ?? []).map(image => image.imageId));
    for (const [id, node] of nodes) if (!ids.has(id)) { node.remove(); nodes.delete(id); }
    for (const image of doc.images ?? []) {
      const resource = resources.find(item => item.resourceId === image.resourceId);
      if (!resource) continue;
      let node = nodes.get(image.imageId);
      if (!node) {
        node = document.createElement('div'); node.className = 'template-image'; node.dataset.imageId = image.imageId;
        node.tabIndex = 0; node.setAttribute('role', 'button'); node.setAttribute('aria-label', `图片 ${image.imageId}`);
        Object.assign(node.style, { position: 'absolute', pointerEvents: 'auto', touchAction: 'none', cursor: 'move', boxSizing: 'border-box' });
        const img = document.createElement('img'); img.alt = `模板图片 ${image.imageId}`; img.draggable = false;
        Object.assign(img.style, { width: '100%', height: '100%', display: 'block', pointerEvents: 'none' });
        node.appendChild(img); layer.appendChild(node); nodes.set(image.imageId, node);
        const handle = document.createElement('span'); handle.className = 'image-resize-handle'; handle.hidden = true;
        handle.setAttribute('role', 'button'); handle.setAttribute('aria-label', `缩放图片 ${image.imageId}`);
        Object.assign(handle.style, { position: 'absolute', right: '0', bottom: '0', width: '12px', height: '12px', background: '#2563eb', cursor: 'nwse-resize' });
        node.appendChild(handle);
        node.addEventListener('pointerdown', event => begin(event, image.imageId, node!));
        node.addEventListener('pointermove', move); node.addEventListener('pointerup', finish);
        node.addEventListener('pointercancel', finish); node.addEventListener('lostpointercapture', finish);
        node.addEventListener('focus', () => select(image.imageId));
        node.addEventListener('keydown', event => { if (event.key === 'Escape') { gesture = undefined; select(''); schedule(); } });
      }
      const img = node.querySelector('img')!;
      const src = `data:${resource.mediaType};base64,${resource.base64}`;
      if (img.getAttribute('src') !== src) img.src = src;
      const box = gesture?.id === image.imageId ? gesture.next : imagePixels(image.rect, doc);
      Object.assign(node.style, { left: `${(box.x - view.scrollX) * view.zoom}px`, top: `${(box.y - view.scrollY) * view.zoom}px`,
        width: `${box.width * view.zoom}px`, height: `${box.height * view.zoom}px` });
    }
    select(selected);
  }
  function schedule() { if (!disposed && !frame) frame = requestAnimationFrame(draw); }
  const resize = new ResizeObserver(schedule); resize.observe(container);
  return {
    render(document: TemplateDocument, nextResources: NonNullable<TemplatePackage['resources']>) {
      if (gesture && gesture.revision !== document.revision) gesture = undefined;
      doc = document; resources = nextResources; schedule();
    },
    schedule,
    dispose() { disposed = true; gesture = undefined; cancelAnimationFrame(frame); resize.disconnect(); nodes.clear(); layer.remove(); },
  };
}
