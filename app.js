import {parseMapYAML} from './yaml.js';
import {normalizeMap, searchEntities, vector, validBounds, mapGroup} from './model.js';

const $ = id => document.getElementById(id);
const fmt = n => n.toLocaleString();
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const layerColors = {wires:'#e8b362', pipes:'#86b6df', disposals:'#bb9dcf'};
const state = {catalog:null, frames:null, maps:[], atlases:[], map:null, source:null, grid:null, selected:null, matches:[], limit:80,
  zoom:8, x:0, y:0, width:0, height:0, dpr:1, layers:{wires:false,pipes:false,disposals:false}, gridLines:false, entities:true, loadId:0};
const canvas = $('map-canvas'), ctx = canvas.getContext('2d', {alpha:false});
const viewport = $('viewport'), mini = $('minimap'), miniCtx = mini.getContext('2d');
let queued = false, toastTimer, hoverTimer, mapCategory = 'stations', miniTransform, drag, pointers = new Map(), pinch, yamlRequest=0;
const tintCache = new Map();

async function fetchJSON(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn’t load ${url} (HTTP ${response.status}).`);
  return response.json();
}
function toast(text) {
  $('toast').textContent = text; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500);
}
function setLoading(title, detail) {
  $('loading-title').textContent = title; $('loading-detail').textContent = detail;
  $('loading').hidden = false; $('map-error').hidden = true;
  $('load-status').textContent = 'Loading map…';
}
function showError(error) {
  $('loading').hidden = true; $('map-error').hidden = false;
  $('error-detail').textContent = error.message ?? String(error);
  $('load-status').textContent = 'Map could not be loaded';
  console.error(error);
}
function currentBounds() {
  if (!state.map) return null;
  return state.grid == null ? state.map.bounds : state.map.gridById.get(state.grid)?.bounds;
}
function visibleGrid(g) { return state.grid == null || g === state.grid; }
function screen(x, y) { return [state.width / 2 + (x-state.x)*state.zoom, state.height / 2 - (y-state.y)*state.zoom]; }
function world(x, y) { return [state.x+(x-state.width/2)/state.zoom, state.y-(y-state.height/2)/state.zoom]; }
function resize() {
  const box = viewport.getBoundingClientRect();
  state.width = box.width; state.height = box.height; state.dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(box.width * state.dpr); canvas.height = Math.round(box.height * state.dpr);
  render();
}
function render() { if (!queued) { queued = true; requestAnimationFrame(draw); } }
function fitMap() {
  const b = currentBounds();
  if (!validBounds(b)) { state.x = state.y = 0; state.zoom = 16; render(); return; }
  state.x = (b.minX+b.maxX)/2; state.y = (b.minY+b.maxY)/2;
  state.zoom = Math.max(.12, Math.min(64, (state.width-100)/Math.max(4,b.maxX-b.minX), (state.height-100)/Math.max(4,b.maxY-b.minY)));
  render();
}
function zoomAt(factor, sx=state.width/2, sy=state.height/2) {
  const before = world(sx, sy);
  state.zoom = Math.max(.12, Math.min(128, state.zoom*factor));
  const after = world(sx, sy);
  state.x += before[0]-after[0]; state.y += before[1]-after[1]; render();
}
function atlasDraw(target, key, x, y, w, h) {
  const frame = state.frames[key];
  if (!frame) return false;
  const [page, sx, sy, sw, sh] = frame;
  if (!state.atlases[page]) return false;
  target.drawImage(state.atlases[page], sx, sy, sw, sh, x, y, w ?? sw, h ?? sh);
  return true;
}
function spriteDraw(target, entity, px, py, zoom) {
  let sprite = entity.sprite;
  if (!sprite) return;
  const offset = vector(sprite.offset), scale = vector(sprite.scale, [1,1]);
  const angle = entity.r * Math.PI/180;
  const ox = (offset[0]*Math.cos(angle)-offset[1]*Math.sin(angle))*zoom;
  const oy = -(offset[0]*Math.sin(angle)+offset[1]*Math.cos(angle))*zoom;
  const layers = entity.cableFrame ? [entity.cableFrame,entity.cableExtraFrame].filter(Boolean).map(key=>({key,dirs:1,offset:'0,0'})) : sprite.layers ?? [];
  for (const layer of layers) {
    let key = layer.key, rotation = sprite.noRot ? 0 : -angle;
    if (layer.dirs > 1) {
      const increment=layer.dirs===8?45:90;
      const direction = ((Math.round((entity.r+(layer.dirOffset??0))/increment) % (layer.dirs===8?8:4))+(layer.dirs===8?8:4))%(layer.dirs===8?8:4);
      const index = layer.dirs===8 ? [0,4,2,6,1,7,3,5][direction] : [0,2,1,3][direction];
      if (index && state.frames[key+`~${index}`]) key += `~${index}`;
      rotation = sprite.noRot ? 0 : -(entity.r-Math.round(entity.r/increment)*increment)*Math.PI/180;
    }
    const frame = state.frames[key];
    if (!frame) continue;
    const [lx, ly] = vector(layer.offset);
    const w = frame[3]*zoom/32*scale[0], h = frame[4]*zoom/32*scale[1];
    const layerX=(lx*Math.cos(angle)-ly*Math.sin(angle))*zoom,layerY=-(lx*Math.sin(angle)+ly*Math.cos(angle))*zoom;
    target.save(); target.translate(px+ox+layerX, py+oy+layerY); target.rotate(rotation);
    const tint=entity.c.AtmosPipeColor?.color;
    if(tint){
      const cacheKey=key+'|'+tint;
      if(!tintCache.has(cacheKey)){
        const colored=document.createElement('canvas');colored.width=frame[3];colored.height=frame[4];
        const paint=colored.getContext('2d');atlasDraw(paint,key,0,0);
        paint.globalCompositeOperation='multiply';paint.fillStyle=tint;paint.fillRect(0,0,colored.width,colored.height);
        paint.globalCompositeOperation='destination-in';atlasDraw(paint,key,0,0);
        if(tintCache.size>1024)tintCache.delete(tintCache.keys().next().value);
        tintCache.set(cacheKey,colored);
      }
      target.drawImage(tintCache.get(cacheKey),-w/2,-h/2,w,h);
    }else atlasDraw(target, key, -w/2, -h/2, w, h);
    target.restore();
  }
}
function draw() {
  queued = false;
  ctx.setTransform(state.dpr,0,0,state.dpr,0,0); ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#0d131b'; ctx.fillRect(0,0,state.width,state.height);
  drawBackdrop();
  const map = state.map;
  if (!map) return;
  const utilities = Object.values(state.layers).some(Boolean);
  const margin = state.zoom*3;
  const onScreen = (x,y) => x>-margin && x<state.width+margin && y>-margin && y<state.height+margin;
  ctx.globalAlpha = utilities ? .62 : 1;
  for (const tile of map.tiles) {
    if (!visibleGrid(tile.g)) continue;
    const [x,y] = screen(tile.wx,tile.wy);
    if (!onScreen(x,y)) continue;
    const frames = state.catalog.tiles[tile.type]?.frames;
    const gridAngle = map.gridById.get(tile.g).r;
    if (frames?.length) {
      const frame = frames[tile.variant % frames.length];
      ctx.save(); ctx.translate(x,y); ctx.rotate(-(gridAngle+(tile.rotation&3)*90)*Math.PI/180);
      if (tile.rotation&4) ctx.scale(-1,1);
      atlasDraw(ctx,frame,-state.zoom/2,-state.zoom/2,state.zoom+.03,state.zoom+.03);ctx.restore();
    } else {
      ctx.fillStyle = tileColor(tile.type);ctx.fillRect(x-state.zoom/2,y-state.zoom/2,state.zoom+.1,state.zoom+.1);
    }
  }
  ctx.globalAlpha = 1;
  if (state.entities) for (const e of map.drawable) {
    if (e.layer !== 'base' || !visibleGrid(e.g)) continue;
    const [x,y] = screen(e.x,e.y); if (!onScreen(x,y)) continue;
    if (e.sprite?.visible === false) continue;
    ctx.globalAlpha = utilities ? .35 : 1;
    spriteDraw(ctx,e,x,y,state.zoom);
  }
  ctx.globalAlpha = 1;
  if (state.entities) for (const e of map.drawable) {
    if (!state.layers[e.layer] || !visibleGrid(e.g)) continue;
    const [x,y] = screen(e.x,e.y); if (!onScreen(x,y)) continue;
    if (e.sprite?.layers?.length) spriteDraw(ctx,e,x,y,state.zoom);
    else { ctx.fillStyle=layerColors[e.layer];ctx.fillRect(x-state.zoom*.13,y-state.zoom*.4,state.zoom*.26,state.zoom*.8); }
  }
  if (state.gridLines && state.zoom>=7) drawGrid();
  if (state.matches.length && $('entity-search').value.trim()) {
    ctx.strokeStyle = '#edc77c';ctx.lineWidth=1.25;
    for (const e of state.matches.slice(0,3000)) if (e.located && visibleGrid(e.g)) {
      const [x,y]=screen(e.x,e.y);if (!onScreen(x,y)) continue;
      ctx.strokeRect(x-state.zoom*.52,y-state.zoom*.52,state.zoom*1.04,state.zoom*1.04);
    }
  }
  if (state.selected?.located && visibleGrid(state.selected.g)) drawSelection(state.selected);
  $('zoom-label').value = `${Math.round(state.zoom/32*100)}%`;
  drawMinimapViewport();
}
function drawBackdrop() {
  const step = 32*state.zoom;
  if (step<24) return;
  const [ox,oy] = screen(0,0);
  ctx.fillStyle='#29323e';
  for (let x=((ox%step)+step)%step;x<state.width;x+=step) for (let y=((oy%step)+step)%step;y<state.height;y+=step) ctx.fillRect(Math.round(x),Math.round(y),1,1);
}
function drawGrid() {
  const [left,top]=world(0,0), [right,bottom]=world(state.width,state.height);
  ctx.beginPath();ctx.strokeStyle='#bacde119';ctx.lineWidth=.5;
  // Align the grid to the selected SS14 grid's local origin, including rotation.
  const grid=state.map.gridById.get(state.grid);
  if (grid) {
    const b=grid.bounds;
    const a=grid.r*Math.PI/180, c=Math.cos(a), s=Math.sin(a);
    const points=[[left,top],[right,top],[left,bottom],[right,bottom]].map(([x,y])=>[(x-grid.x)*c+(y-grid.y)*s,-(x-grid.x)*s+(y-grid.y)*c]);
    const minX=Math.floor(Math.min(...points.map(p=>p[0]))), maxX=Math.ceil(Math.max(...points.map(p=>p[0])));
    const minY=Math.floor(Math.min(...points.map(p=>p[1]))), maxY=Math.ceil(Math.max(...points.map(p=>p[1])));
    const line=(x1,y1,x2,y2)=>{const p1=screen(grid.x+x1*c-y1*s,grid.y+x1*s+y1*c),p2=screen(grid.x+x2*c-y2*s,grid.y+x2*s+y2*c);ctx.moveTo(...p1);ctx.lineTo(...p2);};
    for(let x=minX;x<=maxX;x++)line(x,minY,x,maxY);
    for(let y=minY;y<=maxY;y++)line(minX,y,maxX,y);
  } else {
    for(let x=Math.floor(left);x<=right;x++){const p=screen(x,0);ctx.moveTo(p[0],0);ctx.lineTo(p[0],state.height);}
    for(let y=Math.floor(bottom);y<=top;y++){const p=screen(0,y);ctx.moveTo(0,p[1]);ctx.lineTo(state.width,p[1]);}
  }
  ctx.stroke();
}
function drawSelection(e) {
  const [x,y]=screen(e.x,e.y), r=Math.max(9,state.zoom*.66);
  ctx.strokeStyle='#f2c775';ctx.lineWidth=2;
  ctx.strokeRect(x-r,y-r,r*2,r*2);
  ctx.fillStyle='#f2c775';
  ctx.fillRect(x-2,y-2,4,4);
  ctx.strokeStyle='#f2c77580';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x-r-7,y);ctx.lineTo(x-r-2,y);ctx.moveTo(x+r+2,y);ctx.lineTo(x+r+7,y);ctx.moveTo(x,y-r-7);ctx.lineTo(x,y-r-2);ctx.moveTo(x,y+r+2);ctx.lineTo(x,y+r+7);ctx.stroke();
}
function tileColor(type) {
  if (/wood/i.test(type)) return '#695543';if (/grass|green/i.test(type)) return '#526950';
  if (/white|snow/i.test(type)) return '#a0a6ab';if (/dark|tech|plating/i.test(type)) return '#414b54';
  if (/blue|freezer/i.test(type)) return '#516c84';if (/red|carpet/i.test(type))return '#78504f';return '#707b85';
}
let miniBase = document.createElement('canvas');miniBase.width=196;miniBase.height=140;
function buildMinimap() {
  const b=currentBounds(), target=miniBase.getContext('2d');target.fillStyle='#111923';target.fillRect(0,0,196,140);
  if(!validBounds(b))return;
  const scale=Math.min(180/Math.max(1,b.maxX-b.minX),124/Math.max(1,b.maxY-b.minY));
  miniTransform={scale,x:(b.minX+b.maxX)/2,y:(b.minY+b.maxY)/2};
  for(const tile of state.map.tiles)if(visibleGrid(tile.g)){target.fillStyle=tileColor(tile.type);target.fillRect(98+(tile.wx-miniTransform.x)*scale,70-(tile.wy-miniTransform.y)*scale,Math.max(1,scale),Math.max(1,scale));}
  for(const e of state.map.drawable)if(visibleGrid(e.g)&&e.proto?.components?.includes('Wall')){target.fillStyle='#bbc8d3';target.fillRect(98+(e.x-miniTransform.x)*scale,70-(e.y-miniTransform.y)*scale,Math.max(1,scale),Math.max(1,scale));}
  drawMinimapViewport();
}
function drawMinimapViewport() {
  miniCtx.drawImage(miniBase,0,0);
  if(!miniTransform)return;
  const t=miniTransform,x=98+(state.x-t.x)*t.scale,y=70-(state.y-t.y)*t.scale,w=state.width/state.zoom*t.scale,h=state.height/state.zoom*t.scale;
  miniCtx.strokeStyle='#e4b567';miniCtx.lineWidth=1;miniCtx.fillStyle='#e4b56717';
  miniCtx.fillRect(x-w/2,y-h/2,w,h);miniCtx.strokeRect(x-w/2,y-h/2,w,h);
  if(state.selected?.located){const e=state.selected;miniCtx.fillStyle='#ffda8c';miniCtx.fillRect(96+(e.x-t.x)*t.scale,68-(e.y-t.y)*t.scale,4,4);}
}
async function openMap(source) {
  const loadId=++state.loadId;state.source=source;
  setLoading(`Opening ${source.name}`,source.path);
  try {
    const raw=source.raw??await fetchJSON(source.file);
    // Give the loading state a paint before decoding the tile chunks.
    await new Promise(requestAnimationFrame);
    const map=normalizeMap(raw,state.catalog,source.name,state.frames);
    map.source=source;
    if(loadId!==state.loadId)return;
    if(!map.grids.length)throw new Error('This file contains no map grids. Select a saved SS14 map with a MapGrid component.');
    state.map=map;state.selected=null;state.matches=[];
    state.grid=map.grids[0].id;
    $('chosen-map').textContent=source.name;$('chosen-path').textContent=source.path;
    $('map-title').textContent=source.name;$('map-category').textContent=source.imported?'IMPORTED YAML':({stations:'STATION MAP',wrecks:'WRECK',shuttles:'SHUTTLE',other:'OTHER'}[mapGroup(source)]);
    $('grid-select').replaceChildren(new Option(`All grids (${map.grids.length})`,'all'),...map.grids.map(g=>new Option(`${g.name} · ${fmt(g.tiles.length)} tiles`,String(g.id))));
    $('grid-select').value=String(state.grid);$('grid-select').disabled=false;
    for(const layer in state.layers)$(`${layer}-count`).textContent=fmt(map.counts[layer]);
    $('tile-count').textContent=`${fmt(map.tiles.length)} tiles`;$('entity-count').textContent=`${fmt(map.entities.length)} entities`;
    $('load-status').textContent=`Format ${map.meta.format??'?'} · ${source.imported?'Imported YAML':'Map loaded'}`;
    $('source-status').textContent=source.imported?'BROWSER-LOCAL YAML':'LOCAL RESOURCE INDEX';
    $('loading').hidden=true;updateGridLabel();clearSelection();updateSearch();fitMap();buildMinimap();
    $('sidebar').classList.remove('open');
    if(!source.imported){try{localStorage.setItem('ss14-map',source.path);}catch{} const url=new URL(location);url.hash=new URLSearchParams({map:source.path}).toString();history.replaceState(null,'',url);}
    if(map.missingPrototypes.length)toast(`${map.missingPrototypes.length} prototypes are not in this resource index. Their IDs remain searchable.`);
  }catch(error){if(loadId===state.loadId)showError(error);}
}
function updateGridLabel(){const g=state.map?.gridById.get(state.grid);$('view-label').textContent=g?g.name.toUpperCase():'ALL GRIDS';}
function updateLayers(){
  for(const layer in state.layers)state.layers[layer]=$(layer).checked;
  $('layer-legend').replaceChildren(...Object.keys(state.layers).filter(k=>state.layers[k]).map(layer=>{const el=document.createElement('span');el.className='layer-chip';el.style.color=layerColors[layer];el.textContent=layer.toUpperCase();return el;}));
  $('layer-legend').hidden=!Object.values(state.layers).some(Boolean);render();
}
function updateSearch(){
  state.limit=80;state.matches=state.map?searchEntities(state.map,$('entity-search').value,$('search-mode').value):[];
  $('clear-search').hidden=!$('entity-search').value;
  const q=$('entity-search').value.trim();$('result-count').textContent=q?`${fmt(state.matches.length)} found`:'Find an entity';
  showResults();render();
}
function showResults(){
  const list=$('search-results');list.replaceChildren();
  const query=$('entity-search').value.trim();
  if(!query){list.innerHTML='<div class="search-empty"><span aria-hidden="true">⌖</span><strong>Find your way around</strong><p>Search a name, prototype ID, or the entity’s numeric map ID.</p><small>Try “airlock”, “CableHV”, or “#42”</small></div>';return;}
  if(!state.matches.length){list.innerHTML='<div class="search-empty"><span aria-hidden="true">⌕</span><strong>No matching entities</strong><p>Try a shorter name, a prototype ID, or a numeric map ID with #.</p></div>';return;}
  for(const e of state.matches.slice(0,state.limit)){
    const button=document.createElement('button');button.className='result'+(state.selected?.id===e.id?' active':'');button.dataset.entityId=e.id;
    const color=layerColors[e.layer]??'#8d9fac';
    button.innerHTML=`<span class="result-name"><span class="result-dot" style="background:${color}"></span>${escapeHTML(e.name)}</span><span class="result-proto">${escapeHTML(e.prototype||'No prototype')}</span><span class="result-bottom"><span class="result-id">#${e.id}</span><span>${e.contained?'IN CONTAINER':e.located?`${e.x.toFixed(1)}, ${e.y.toFixed(1)}`:'NULLSPACE'}</span></span>`;
    button.addEventListener('click',()=>selectEntity(e,true));list.append(button);
  }
  if(state.matches.length>state.limit){const more=document.createElement('button');more.className='show-more';more.textContent=`Show more (${fmt(state.matches.length-state.limit)} remaining)`;more.onclick=()=>{const top=list.scrollTop;state.limit+=80;showResults();list.scrollTop=top;};list.append(more);}
}
function selectEntity(e,focus=false){
  state.selected=e;
  if(e.layer!=='base'&&!state.layers[e.layer]){$(e.layer).checked=true;updateLayers();}
  if(!state.entities){state.entities=true;$('entities-visible').checked=true;}
  if(focus&&e.located){
    if(state.grid!=null&&state.grid!==e.g){state.grid=e.g??null;$('grid-select').value=state.grid==null?'all':String(state.grid);updateGridLabel();buildMinimap();}
    state.x=e.x;state.y=e.y;state.zoom=Math.max(24,state.zoom);$('sidebar').classList.remove('open');
  }else if(focus&&!e.located)toast('This entity is in nullspace and has no position on the map.');
  renderInspector(e);showResults();render();
}
function renderInspector(e){
  const siblings=entitiesAt(e.x,e.y,true).filter(other=>other.id!==e.id).slice(0,8);
  $('inspector').classList.add('has-yaml');$('inspector').classList.remove('yaml-collapsed');
  $('inspector').innerHTML=`<div class="inspector-summary"><canvas id="entity-swatch" class="entity-swatch" width="64" height="64" aria-hidden="true"></canvas><div class="entity-summary"><h2>${escapeHTML(e.name)}</h2><code>${escapeHTML(e.prototype||'No prototype')}</code>${siblings.length?'<div class="tile-entities" id="tile-entities"></div>':''}</div><div class="entity-facts"><div class="entity-fact"><small>ENTITY ID</small><span style="color:var(--accent)">#${e.id}</span></div><div class="entity-fact"><small>POSITION · WORLD</small>${e.located?`${e.x.toFixed(2)}, ${e.y.toFixed(2)}`:'Nullspace'}</div><div class="entity-fact"><small>${e.contained?'CONTAINER':'GRID'}</small>${e.contained?`#${e.container??e.parent}`:e.g?`#${e.g}`:'—'}</div></div><div class="inspect-actions"><button id="copy-id" title="Copy prototype ID">Copy ID</button><button id="toggle-yaml" aria-expanded="true">Hide YAML</button><button id="close-inspector" aria-label="Clear selection">×</button></div></div><div id="yaml-pane" class="yaml-pane"><div class="yaml-heading"><span>MAP YAML <small>Saved entity configuration</small></span><button id="copy-yaml" disabled>Copy YAML</button></div><pre id="entity-yaml" class="entity-yaml" tabindex="0" aria-label="Selected entity YAML">Loading saved configuration…</pre></div>`;
  const target=$('entity-swatch').getContext('2d');target.imageSmoothingEnabled=false;spriteDraw(target,e,32,32,48);
  $('copy-id').onclick=async()=>{try{await navigator.clipboard.writeText(e.prototype||String(e.id));toast(`Copied ${e.prototype||e.id}`);}catch{toast('Clipboard unavailable in this browser. The ID is shown in the inspector.');}};
  $('close-inspector').onclick=clearSelection;
  $('toggle-yaml').onclick=()=>{const hidden=!$('yaml-pane').hidden;$('yaml-pane').hidden=hidden;$('inspector').classList.toggle('yaml-collapsed',hidden);$('toggle-yaml').textContent=hidden?'Show YAML':'Hide YAML';$('toggle-yaml').setAttribute('aria-expanded',String(!hidden));};
  for(const other of siblings){const button=document.createElement('button');button.textContent=`${other.name} #${other.id}`;button.onclick=()=>selectEntity(other);$('tile-entities').append(button);}
  showEntityYAML(e);
}
async function showEntityYAML(e){
  const request=++yamlRequest,source=state.map.source;
  try{
    if(!source.yamlById){
      if(!source.yamlPromise)source.yamlPromise=(async()=>{
        const response=await fetch(source.sourceFile);
        if(!response.ok)throw new Error(`Couldn’t load the map YAML (HTTP ${response.status}).`);
        const parsed=parseMapYAML(await response.text());source.yamlById=parsed.yamlById;return parsed.yamlById;
      })().catch(error=>{delete source.yamlPromise;throw error;});
      await source.yamlPromise;
    }
    if(request!==yamlRequest||state.selected!==e)return;
    const yaml=source.yamlById.get(e.id);
    $('entity-yaml').textContent=yaml??'No saved YAML block was found for this entity.';
    $('copy-yaml').disabled=!yaml;
    $('copy-yaml').onclick=async()=>{try{await navigator.clipboard.writeText(yaml);toast(`Copied YAML for entity #${e.id}`);}catch{toast('Clipboard unavailable. You can select and copy the YAML text.');}};
  }catch(error){if(request===yamlRequest&&state.selected===e)$('entity-yaml').textContent=error.message+' Select the entity again to retry.';}
}
function clearSelection(){state.selected=null;yamlRequest++;$('inspector').classList.remove('has-yaml');$('inspector').classList.remove('yaml-collapsed');$('inspector').innerHTML='<div class="inspector-placeholder"><span aria-hidden="true">⌖</span><div><strong>Explore the station</strong><p>Select an entity on the map or in search results to inspect it.</p></div></div>';showResults();render();}
function entitiesAt(x,y,includeHidden=false){
  if(!state.map)return[];
  return state.map.entities.filter(e=>e.located&&!e.contained&&visibleGrid(e.g)&&!e.c.MapGrid&&!e.c.Map&&(includeHidden||e.layer==='base'||state.layers[e.layer])&&Math.abs(e.x-x)<.55&&Math.abs(e.y-y)<.55)
    .sort((a,b)=>Number(!!state.layers[b.layer])-Number(!!state.layers[a.layer])||(b.sprite?.depth??0)-(a.sprite?.depth??0));
}
function inspectAt(sx,sy){const [x,y]=world(sx,sy);const matches=entitiesAt(x,y);if(matches.length){const current=matches.findIndex(e=>state.selected?.id===e.id);selectEntity(matches[(current+1)%matches.length]);}else{clearSelection();toast(`Tile at ${Math.floor(x)}, ${Math.floor(y)} · no visible entities`);}}
function showMapList(){
  const query=$('map-filter').value.trim().toLowerCase();
  const groupLabels={stations:'Station maps',wrecks:'Wrecks',shuttles:'Shuttles',other:'Other · test rooms & templates'};
  const maps=state.maps.filter(m=>(mapCategory==='all'||mapGroup(m)===mapCategory)&&(!query||`${m.name} ${m.path}`.toLowerCase().includes(query)));
  const groupOrder=['stations','wrecks','shuttles','other'];
  maps.sort((a,b)=>groupOrder.indexOf(mapGroup(a))-groupOrder.indexOf(mapGroup(b))||a.name.localeCompare(b.name)||a.path.localeCompare(b.path));
  $('map-list').replaceChildren();
  let previousGroup;
  for(const map of maps){const group=mapGroup(map);if(group!==previousGroup){const heading=document.createElement('h2');heading.className='map-group-heading';heading.textContent=`${groupLabels[group]} · ${maps.filter(m=>mapGroup(m)===group).length}`;$('map-list').append(heading);previousGroup=group;}const button=document.createElement('button');button.className='map-card'+(state.source?.path===map.path?' active':'');button.innerHTML=`<span class="map-card-arrow">↗</span><strong>${escapeHTML(map.name)}</strong><small>${escapeHTML(map.path)}</small><div class="map-card-count">${fmt(map.entities)} ENTITIES</div>`;button.onclick=()=>{$('map-dialog').close();openMap(map);};$('map-list').append(button);}
  if(!maps.length)$('map-list').innerHTML='<div class="search-empty"><strong>No maps found</strong><p>Try another path or choose “All maps”.</p></div>';
  $('map-list-count').textContent=`${maps.length} of ${state.maps.length} maps`;
}

async function importYAML(file){
  if(!file)return;
  if(file.size>100*1024*1024){toast('Please choose a YAML file smaller than 100 MB.');return;}
  setLoading('Reading local YAML',file.name);
  try{const {raw,yamlById}=parseMapYAML(await file.text());await openMap({raw,yamlById,name:file.name.replace(/\.ya?ml$/i,''),path:file.name,imported:true});}catch(error){showError(error);}
}

$('map-picker').onclick=()=>{showMapList();$('map-dialog').showModal();$('map-filter').focus();};
$('close-map-dialog').onclick=()=>$('map-dialog').close();$('map-filter').addEventListener('input',showMapList);
document.querySelectorAll('[data-category]').forEach(button=>button.onclick=()=>{mapCategory=button.dataset.category;document.querySelectorAll('[data-category]').forEach(b=>b.classList.toggle('active',b===button));showMapList();});
$('help-button').onclick=()=>$('help-dialog').showModal();$('close-help-dialog').onclick=()=>$('help-dialog').close();
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',event=>{if(event.target===dialog){const b=dialog.getBoundingClientRect();if(event.clientX<b.left||event.clientX>b.right||event.clientY<b.top||event.clientY>b.bottom)dialog.close();}});
$('sidebar-toggle').onclick=()=>$('sidebar').classList.toggle('open');
$('import-button').onclick=()=>$('file-input').click();$('file-input').onchange=event=>{importYAML(event.target.files[0]);event.target.value='';};
$('grid-select').onchange=()=>{state.grid=$('grid-select').value==='all'?null:Number($('grid-select').value);updateGridLabel();fitMap();buildMinimap();};
for(const layer in state.layers)$(layer).onchange=updateLayers;
$('tile-grid').onchange=()=>{state.gridLines=$('tile-grid').checked;render();};
$('entities-visible').onchange=()=>{state.entities=$('entities-visible').checked;render();};
$('entity-search').addEventListener('input',updateSearch);$('search-mode').onchange=updateSearch;
$('entity-search').addEventListener('keydown',event=>{if(event.key==='Enter'&&state.matches.length){selectEntity(state.matches[0],true);event.preventDefault();}});
$('clear-search').onclick=()=>{$('entity-search').value='';updateSearch();$('entity-search').focus();};
$('fit-button').onclick=$('minimap-fit').onclick=fitMap;
$('reset-button').onclick=()=>{state.zoom=32;render();};$('zoom-in').onclick=()=>zoomAt(1.3);$('zoom-out').onclick=()=>zoomAt(1/1.3);
$('retry-button').onclick=()=>state.source?openMap(state.source):location.reload();
mini.addEventListener('pointerdown',event=>{if(!miniTransform)return;const b=mini.getBoundingClientRect(),t=miniTransform;state.x=t.x+((event.clientX-b.left)*196/b.width-98)/t.scale;state.y=t.y-((event.clientY-b.top)*140/b.height-70)/t.scale;render();});
viewport.addEventListener('wheel',event=>{event.preventDefault();const b=viewport.getBoundingClientRect();zoomAt(Math.exp(-Math.max(-200,Math.min(200,event.deltaY))*.002),event.clientX-b.left,event.clientY-b.top);},{passive:false});
viewport.addEventListener('pointerdown',event=>{
  if(event.target!==canvas||event.button!==0)return;
  viewport.focus({preventScroll:true});viewport.setPointerCapture(event.pointerId);pointers.set(event.pointerId,[event.clientX,event.clientY]);
  $('hover-label').hidden=true;
  if(pointers.size===1)drag={sx:event.clientX,sy:event.clientY,x:state.x,y:state.y,moved:false};
  if(pointers.size===2){const p=[...pointers.values()];pinch={distance:Math.hypot(p[0][0]-p[1][0],p[0][1]-p[1][1])};if(drag)drag.moved=true;}
  viewport.classList.add('dragging');
});
viewport.addEventListener('pointermove',event=>{
  const box=viewport.getBoundingClientRect(),sx=event.clientX-box.left,sy=event.clientY-box.top;
  const [x,y]=world(sx,sy);$('coordinates').innerHTML=`X ${x.toFixed(1)} &nbsp; Y ${y.toFixed(1)}`;
  if(pointers.has(event.pointerId)){
    pointers.set(event.pointerId,[event.clientX,event.clientY]);
    if(pointers.size===2&&pinch){const p=[...pointers.values()],distance=Math.hypot(p[0][0]-p[1][0],p[0][1]-p[1][1]);zoomAt(distance/Math.max(1,pinch.distance),(p[0][0]+p[1][0])/2-box.left,(p[0][1]+p[1][1])/2-box.top);pinch.distance=distance;}
    else if(drag&&!pinch){const dx=event.clientX-drag.sx,dy=event.clientY-drag.sy;state.x=drag.x-dx/state.zoom;state.y=drag.y+dy/state.zoom;if(Math.abs(dx)+Math.abs(dy)>4)drag.moved=true;render();}
    return;
  }
  clearTimeout(hoverTimer);$('hover-label').hidden=true;
  hoverTimer=setTimeout(()=>{const matches=entitiesAt(x,y);if(!matches.length)return;const label=$('hover-label');label.textContent=`${matches[0].name} · #${matches[0].id}${matches.length>1?` (+${matches.length-1})`:''}`;label.style.left=`${Math.min(state.width-240,Math.max(8,sx+13))}px`;label.style.top=`${Math.min(state.height-35,sy+15)}px`;label.hidden=false;},180);
});
function pointerEnd(event){
  const moved=drag?.moved||!!pinch;
  pointers.delete(event.pointerId);
  if(!pointers.size){if(drag&&!moved&&event.type!=='pointercancel'){const b=viewport.getBoundingClientRect();inspectAt(event.clientX-b.left,event.clientY-b.top);}drag=null;pinch=null;viewport.classList.remove('dragging');}
  else if(pointers.size===1){const p=[...pointers.values()][0];drag={sx:p[0],sy:p[1],x:state.x,y:state.y,moved:true};pinch=null;}
}
viewport.addEventListener('pointerup',pointerEnd);viewport.addEventListener('pointercancel',pointerEnd);
viewport.addEventListener('pointerleave',()=>{clearTimeout(hoverTimer);$('hover-label').hidden=true;});
viewport.addEventListener('dragover',event=>{event.preventDefault();});viewport.addEventListener('drop',event=>{event.preventDefault();importYAML(event.dataTransfer.files[0]);});
document.addEventListener('keydown',event=>{
  if(document.querySelector('dialog[open]'))return;
  if(event.key==='Escape'){if(document.activeElement?.tagName==='INPUT'){document.activeElement.blur();}else clearSelection();return;}
  if(/INPUT|SELECT|TEXTAREA/.test(event.target.tagName)||event.ctrlKey||event.metaKey||event.altKey)return;
  const actions={'/':()=>{$('sidebar').classList.add('open');$('entity-search').focus();},'f':fitMap,'F':fitMap,'+':()=>zoomAt(1.3),'=':()=>zoomAt(1.3),'-':()=>zoomAt(1/1.3),'ArrowLeft':()=>{state.x-=80/state.zoom;render();},'ArrowRight':()=>{state.x+=80/state.zoom;render();},'ArrowUp':()=>{state.y+=80/state.zoom;render();},'ArrowDown':()=>{state.y-=80/state.zoom;render();}};
  if(actions[event.key]){event.preventDefault();actions[event.key]();}
});
new ResizeObserver(resize).observe(viewport);

async function start(){
  try{
    [state.catalog,state.frames,state.maps]=await Promise.all([fetchJSON('data/catalog.json'),fetchJSON('assets/frames.json'),fetchJSON('data/maps.json')]);
    const pages=1+Math.max(...Object.values(state.frames).map(f=>f[0]));
    $('loading-detail').textContent=`Loading ${pages} sprite atlases · ${state.maps.length} maps available`;
    state.atlases=await Promise.all(Array.from({length:pages},(_,i)=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error(`Couldn’t load sprite atlas ${i}. Rebuild the viewer and retry.`));image.src=`assets/atlas-${i}.png`;})));
    $('map-total').textContent=`${state.maps.length} MAPS`;
    let saved;try{saved=localStorage.getItem('ss14-map');}catch{}
    const hash=new URLSearchParams(location.hash.slice(1)).get('map');
    const source=state.maps.find(m=>m.path===(hash??saved))??state.maps.find(m=>m.path==='box.yml')??state.maps[0];
    if(!source)throw new Error('No maps have been exported. Run python build.py.');
    await openMap(source);
  }catch(error){showError(error);}
}
start();
