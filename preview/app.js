// Optional dependency-free UI. The model/ops/blocks/demo variables are the exact
// transpiled modules from src/domain, injected by build-offline-preview.mjs.
const $ = id => document.getElementById(id);
const { BLOCKS, gridStyle } = blocks;
let doc = demo.createDemoDocument();
let selection = { r: 0, c: 0, rows: 1, cols: 4 };
let selectionOrigin = { r: 0, c: 0 };
const past = [], future = [];
let dragging, lastHover = '', idCounter = 0;
const MIME = 'application/x-report-designer';
function uid() { return globalThis.crypto?.randomUUID?.() ?? `preview-${Date.now()}-${++idCounter}`; }
function selectedCell() {
  const [r,c] = ops.anchor(doc, selection.r, selection.c);
  return doc.cells[model.keyOf(r,c)];
}
function selectedBlock() { return doc.blocks.find(b => ops.inside(b.rect, selection.r, selection.c)); }
function address(rect = selection) {
  const first = ops.a1(rect.r, rect.c);
  return rect.rows * rect.cols > 1 ? `${first}:${ops.a1(rect.r+rect.rows-1, rect.c+rect.cols-1)}` : first;
}
function status(text, error = false) {
  $('status').textContent = text;
  $('status').style.color = error ? '#b55f59' : '';
  $('status-dot').style.background = error ? '#c07870' : '';
}
function safely(action) {
  try { action(); } catch(error) { status(error instanceof Error ? error.message : String(error), true); }
}
function commit(change, message = '已更新模板。') {
  const next = ops.transaction(doc, change);
  past.push(model.copy(doc)); if (past.length > 100) past.shift();
  future.length = 0; doc = next;
  render(); status(message);
}
function changeDocument(next, message) {
  commit(draft => {
    const revision = draft.revision;
    Object.assign(draft, model.copy(next), { revision });
  }, message);
}
function choose(rect, setOrigin = true) {
  ops.checkBounds(rect, doc.rows, doc.cols); selection = model.copy(rect);
  if (setOrigin) selectionOrigin = { r: rect.r, c: rect.c };
  paintSelection(); renderProperties();
}
function paintSelection() {
  for (const td of $('grid').querySelectorAll('td')) {
    const r = Number(td.dataset.r), c = Number(td.dataset.c);
    const rect = { r, c, rows: td.rowSpan, cols: td.colSpan };
    td.classList.toggle('selection-area', ops.intersects(rect, selection));
    td.classList.toggle('selected', r === selection.r && c === selection.c);
  }
}
function textElement(tag, text, className) {
  const el = document.createElement(tag); el.textContent = text;
  if (className) el.className = className;
  return el;
}
const icons = ['▤', '▦', '☷', '✓'];
for (let i=0; i<BLOCKS.length; i++) {
  const b = BLOCKS[i];
  const card = document.createElement('div'); card.className='material'; card.draggable=true;
  card.dataset.kind='block';card.dataset.id=b.id;card.tabIndex=0;
  const compactName = b.name.replace(/（.*?）/g,'');
  card.append(textElement('span',icons[i],'material-icon'));
  const body=document.createElement('div');body.append(textElement('strong',compactName), textElement('small',`${b.rows} 行 × ${b.cols} 列${b.repeat ? ' · 可扩展' : ''}`));
  card.append(body,textElement('span','⠿','grip'));$('materials').append(card);
  card.addEventListener('dblclick',()=>safely(()=>dropPayload({version:1,kind:'block',id:b.id}, selection.r,selection.c)));
  card.addEventListener('keydown',e=>{if(e.key==='Enter')safely(()=>dropPayload({version:1,kind:'block',id:b.id},selection.r,selection.c));});
}
$('binding').append(new Option('静态文本 / 无绑定', ''));
for (const f of model.FIELDS) {
  const tag=document.createElement('div');tag.className='field';tag.draggable=true;
  tag.dataset.kind='field';tag.dataset.id=f.path;
  tag.append(textElement('i','{ }'));
  const body=document.createElement('div');body.append(textElement('strong',f.label),textElement('small',f.path));
  tag.append(body);$('fields').append(tag);
  $('binding').append(new Option(`${f.label} · ${f.path}`, f.path));
}
$('search').addEventListener('input', e => {
  const query=e.target.value.trim().toLowerCase();
  for(const el of document.querySelectorAll('.material,.field')) el.hidden=!el.textContent.toLowerCase().includes(query);
});
function renderGrid() {
  const table=$('grid'), fragment=document.createDocumentFragment();
  const colgroup=document.createElement('colgroup');
  const numberCol=document.createElement('col');numberCol.style.width='39px';colgroup.append(numberCol);
  for (const width of doc.colWidthPx) {const col=document.createElement('col');col.style.width=`${width}px`;colgroup.append(col);}
  fragment.append(colgroup);
  const thead=document.createElement('thead'), tr=document.createElement('tr');
  tr.append(textElement('th','◢','corner'));
  for(let c=0;c<doc.cols;c++)tr.append(textElement('th',ops.a1(0,c).replace(/\d+$/,'')));
  thead.append(tr);fragment.append(thead);
  const tbody=document.createElement('tbody');
  for(let r=0;r<doc.rows;r++) {
    const row=document.createElement('tr'); row.style.height=`${doc.rowHeightPx[r]}px`;
    row.append(textElement('th',String(r+1),'row-head'));
    for(let c=0;c<doc.cols;c++) {
      const [ar,ac]=ops.anchor(doc,r,c);if(ar!==r||ac!==c)continue;
      const td=document.createElement('td');td.dataset.r=String(r);td.dataset.c=String(c);
      const cell=doc.cells[model.keyOf(r,c)], s=cell?.style??{};
      const merge=doc.merges.find(m=>m.r===r&&m.c===c);
      if(merge){td.rowSpan=merge.rows;td.colSpan=merge.cols;}
      // CSS uses a single merged TD; its style comes from the same domain master cell.
      td.style.height=`${doc.rowHeightPx.slice(r,r+(merge?.rows??1)).reduce((a,b)=>a+b,0)}px`;
      if(s.background)td.style.backgroundColor=s.background;
      td.style.textAlign=s.horizontal??'left';td.style.verticalAlign=s.vertical??'middle';
      if(s.color)td.style.color=s.color;if(s.bold)td.style.fontWeight='700';
      td.style.fontSize=`${s.fontSizePt??11}pt`;
      if(s.fontFamily)td.style.fontFamily=s.fontFamily;
      for(const [side,edge] of Object.entries(s.borders??{})) {
        td.style[`border${side[0].toUpperCase()+side.slice(1)}`]=`${edge.style==='medium'?2:1}px ${edge.style==='dashed'?'dashed':'solid'} ${edge.color}`;
      }
      const content=textElement('div',cell?model.displayText(cell,doc.syntax):'','cell-content');
      if(s.wrap===false)content.style.whiteSpace='nowrap';
      td.append(content);td.classList.toggle('has-binding',!!cell?.binding);
      td.title=`${ops.a1(r,c)}${cell?' · '+model.displayText(cell,doc.syntax):''}`;
      row.append(td);
    }
    tbody.append(row);
  }
  fragment.append(tbody);
  table.style.width=`${39+doc.colWidthPx.reduce((a,b)=>a+b,0)}px`;
  table.replaceChildren(fragment);paintSelection();
}
function renderProperties() {
  const cell=selectedCell(), s=cell?.style??{}, b=selectedBlock();
  const a=address();$('address').textContent=a;$('selection-chip').textContent=a;
  $('selection-size').textContent=`${selection.rows} 行 × ${selection.cols} 列${b?' · 业务积木':' · 独立区域'}`;
  $('formula-value').textContent=cell?model.displayText(cell,doc.syntax):'选择单元格，设置内容或业务字段';
  $('formula-type').textContent=cell?.binding?'业务占位符':cell?.text?'静态文本':'';
  $('binding').value=cell?.binding?.path??'';$('cell-text').value=cell?.text??'';
  $('format').value=cell?.binding?.format??'text';$('format').disabled=!cell?.binding;
  $('align').value=s.horizontal??'left';$('background').value=s.background??'#ffffff';
  $('font-size').value=s.fontSizePt??11;$('row-height').value=doc.rowHeightPx[selection.r];
  $('col-width').value=doc.colWidthPx[selection.c];
  $('block-properties').hidden=!b;
  if(b){
    $('block-name').textContent=BLOCKS.find(x=>x.id===b.definitionId)?.name??b.definitionId;
    $('move-handle').dataset.kind='move';$('move-handle').dataset.id=b.id;
    $('repeat-source').value=b.repeat?.source??'';$('repeat-offset').value=b.repeat?.rowOffset??0;
    $('repeat-count').value=b.repeat?.rowCount??1;$('repeat-empty').value=b.repeat?.empty??'remove';
    $('repeat-offset').max=b.rect.rows-1;$('repeat-count').max=b.rect.rows;
  }
}
function render(){
  renderGrid();renderProperties();$('doc-name').textContent=doc.name;
  $('dimensions').textContent=`${doc.rows} 行 × ${doc.cols} 列`;
  $('counts').textContent=`${doc.blocks.length} 个积木 · ${Object.values(doc.cells).filter(c=>c.binding).length} 个绑定`;
  $('revision').textContent=`rev ${doc.revision}`;$('undo').disabled=!past.length;$('redo').disabled=!future.length;
}
$('grid').addEventListener('click',e=>{
  const td=e.target.closest('td');if(!td)return;
  const r=Number(td.dataset.r),c=Number(td.dataset.c);
  if(e.shiftKey){
    choose({r:Math.min(r,selectionOrigin.r),c:Math.min(c,selectionOrigin.c),rows:Math.abs(r-selectionOrigin.r)+1,cols:Math.abs(c-selectionOrigin.c)+1},false);
  }else choose({r,c,rows:td.rowSpan,cols:td.colSpan});
});
$('grid').addEventListener('dblclick',e=>{if(e.target.closest('td')){$('cell-text').focus();$('cell-text').select();}});
function payloadFromText(text){
  if(!text||text.length>512)throw new Error('非法拖放数据');
  const p=JSON.parse(text);
  if(!p||p.version!==1||typeof p.id!=='string'||!['block','field','move'].includes(p.kind))throw new Error('不支持的拖放数据');
  if(p.kind==='block'&&!BLOCKS.some(b=>b.id===p.id))throw new Error('未知积木');
  if(p.kind==='field'&&!model.FIELDS.some(f=>f.path===p.id))throw new Error('未知业务字段');
  if(p.kind==='move'&&!doc.blocks.some(b=>b.id===p.id))throw new Error('积木已不存在');
  return p;
}
function targetRect(p,r,c){
  if(p.kind==='block'){const b=BLOCKS.find(b=>b.id===p.id);return{r,c,rows:b.rows,cols:b.cols};}
  if(p.kind==='move'){const b=doc.blocks.find(b=>b.id===p.id);return{...b.rect,r,c};}
  return doc.merges.find(m=>ops.inside(m,r,c))??{r,c,rows:1,cols:1};
}
function applyPayload(draft,p,r,c,id){
  if(p.kind==='block')ops.placeBlock(draft,BLOCKS.find(b=>b.id===p.id),r,c,id);
  else if(p.kind==='field')ops.bindField(draft,r,c,p.id);
  else ops.moveBlock(draft,p.id,r,c);
}
function dropPayload(p,r,c){
  const rect=targetRect(p,r,c);
  commit(draft=>applyPayload(draft,p,r,c,uid()),`已放置到 ${ops.a1(r,c)}。`);
  choose(rect);clearHover();
}
function clearHover(){
  for(const td of $('grid').querySelectorAll('.hover-good,.hover-bad'))td.classList.remove('hover-good','hover-bad');
  lastHover='';
}
document.addEventListener('dragstart',e=>{
  const source=e.target.closest('[draggable=true][data-kind]');if(!source||!e.dataTransfer)return;
  dragging={version:1,kind:source.dataset.kind,id:source.dataset.id};
  e.dataTransfer.setData(MIME,JSON.stringify(dragging));e.dataTransfer.effectAllowed=dragging.kind==='move'?'move':'copy';
});
document.addEventListener('dragend',()=>{dragging=undefined;clearHover();});
$('grid').addEventListener('dragover',e=>{
  if(!dragging||!e.dataTransfer)return;
  const td=e.target.closest('td');if(!td)return;e.preventDefault();
  const r=Number(td.dataset.r),c=Number(td.dataset.c),key=`${doc.revision}:${r}:${c}:${dragging.kind}:${dragging.id}`;
  // Keep drop deliverable even on an invalid target so that the user gets the exact error.
  e.dataTransfer.dropEffect=dragging.kind==='move'?'move':'copy';
  if(key===lastHover)return;clearHover();lastHover=key;
  let error='';try{ops.transaction(doc,d=>applyPayload(d,dragging,r,c,'__offline_hover__'));}catch(err){error=err.message;}
  const target=targetRect(dragging,r,c);
  for(const cell of $('grid').querySelectorAll('td')){
    const rect={r:Number(cell.dataset.r),c:Number(cell.dataset.c),rows:cell.rowSpan,cols:cell.colSpan};
    if(ops.intersects(rect,target))cell.classList.add(error?'hover-bad':'hover-good');
  }
  status(error||`释放到 ${ops.a1(r,c)}`,!!error);
});
$('grid').addEventListener('drop',e=>{
  if(!e.dataTransfer?.types.includes(MIME))return;e.preventDefault();
  const td=e.target.closest('td');if(!td)return;
  safely(()=>dropPayload(payloadFromText(e.dataTransfer.getData(MIME)),Number(td.dataset.r),Number(td.dataset.c)));
  dragging=undefined;clearHover();
});
function on(id,action){$(id).addEventListener('click',()=>safely(action));}
on('undo',()=>{if(!past.length)return;future.push(model.copy(doc));const prev=past.pop();prev.revision=doc.revision+1;doc=prev;render();status('已撤销上一步。');});
on('redo',()=>{if(!future.length)return;past.push(model.copy(doc));const next=future.pop();next.revision=doc.revision+1;doc=next;render();status('已重做。');});
on('load-demo',()=>{choose({r:0,c:0,rows:1,cols:4});changeDocument(demo.createDemoDocument(),'已载入示例；可通过撤销恢复之前的设计。');});
on('new-doc',()=>{if(!confirm('新建空白模板？当前内容可通过“撤销”恢复，或先导出 JSON。'))return;choose({r:0,c:0,rows:1,cols:1});changeDocument(model.newDocument(),'空白画布就绪：从左侧拖入一个积木。');});
on('apply-binding',()=>{const path=$('binding').value;commit(d=>path?ops.bindField(d,selection.r,selection.c,path,true):ops.setText(d,selection.r,selection.c,$('cell-text').value),'已更新字段绑定。');});
on('apply-text',()=>{const text=$('cell-text').value;commit(d=>ops.setText(d,selection.r,selection.c,text),'已应用静态文本。');});
$('format').addEventListener('change',()=>safely(()=>{const value=$('format').value;commit(d=>{const[r,c]=ops.anchor(d,selection.r,selection.c);const cell=d.cells[model.keyOf(r,c)];ops.assert(cell?.binding,'请先绑定字段');cell.binding.format=value;});}));
$('align').addEventListener('change',()=>safely(()=>{const value=$('align').value;commit(d=>ops.styleRange(d,selection,{horizontal:value}));}));
on('apply-style',()=>{const style={background:$('background').value,fontSizePt:Number($('font-size').value)};commit(d=>ops.styleRange(d,selection,style));});
on('toggle-bold',()=>{const bold=!selectedCell()?.style?.bold;commit(d=>ops.styleRange(d,selection,{bold}));});
on('set-border',()=>commit(d=>ops.styleRange(d,selection,{borders:gridStyle.borders})));
on('clear-border',()=>commit(d=>ops.styleRange(d,selection,{borders:{}})));
on('apply-size',()=>{const height=Number($('row-height').value),width=Number($('col-width').value);commit(d=>{ops.eachCell(selection,(r,c)=>{d.rowHeightPx[r]=height;d.colWidthPx[c]=width;});},'已更新行高与列宽。');});
on('merge',()=>commit(d=>ops.mergeRange(d,selection),'已合并选区。'));
on('unmerge',()=>commit(d=>ops.unmergeRange(d,selection),'已取消合并。'));
on('clear-range',()=>commit(d=>ops.clearRange(d,selection),'已清除独立区域。'));
on('delete-block',()=>{const b=selectedBlock();ops.assert(b,'请先选中积木');commit(d=>ops.removeBlock(d,b.id),'已删除整个积木。');});
on('apply-repeat',()=>{
  const b=selectedBlock();ops.assert(b,'请先选中积木');
  const source=$('repeat-source').value,repeat=source?{source,rowOffset:Number($('repeat-offset').value),rowCount:Number($('repeat-count').value),mode:'insert',empty:$('repeat-empty').value}:undefined;
  commit(d=>{const block=d.blocks.find(x=>x.id===b.id);if(repeat)block.repeat=repeat;else delete block.repeat;},'已更新明细扩展规则；实际扩行由后端执行。');
});
on('export-json',()=>{
  const snapshot=model.copy(doc);ops.validateDocument(snapshot);
  const bytes=JSON.stringify({document:snapshot,metadata:ops.metadata(snapshot)},null,2);
  const url=URL.createObjectURL(new Blob([bytes],{type:'application/json;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=`${snapshot.name}.json`;document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),30000);status('已发起模型 JSON 下载。');
});
on('about',()=>$('info-dialog').showModal());on('close-dialog',()=>$('info-dialog').close());
$('info-dialog').addEventListener('click',e=>{if(e.target===$('info-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
render();
