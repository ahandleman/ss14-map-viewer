// SS14 data handling is DOM-independent so the same decoder is used for bundled
// maps and user-selected YAML. Engine reference: MapChunkSerializer.cs.
import {applySmoothing} from './smoothing.js';
export function vector(value, fallback = [0, 0]) {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value !== 'string') return [...fallback];
  const parts = value.split(',').map(Number);
  return parts.length === 2 && parts.every(Number.isFinite) ? parts : [...fallback];
}

export function mapGroup(source) {
  const path = source.path.replaceAll('\\', '/');
  if (/^Shuttles\//i.test(path)) return 'shuttles';
  if (/^(Salvage|Ruins|Wrecks)\//i.test(path) || /(^|\/)wreck[^/]*[/.]/i.test(path)) return 'wrecks';
  if (!path.includes('/')) return 'stations';
  return 'other';
}

export function angle(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return 0;
  const number = parseFloat(value);
  if (!Number.isFinite(number)) return 0;
  return /rad/i.test(value) ? number * 180 / Math.PI : number;
}

export function decodeChunk(chunk, tilemap) {
  const version = Number(chunk.version ?? 1);
  const stride = version >= 7 ? 7 : version >= 6 ? 6 : 4;
  const size = Number(chunk.size ?? 16);
  if (!Number.isInteger(size) || size < 1 || size > 256) throw new Error('Invalid map chunk size.');
  const binary = atob(chunk.tiles);
  if (binary.length !== size * size * stride) throw new Error(`Invalid v${version} tile chunk: expected ${size * size * stride} bytes, got ${binary.length}.`);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const [cx, cy] = vector(chunk.ind);
  const result = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const offset = (y * size + x) * stride;
    const id = version >= 6 ? view.getInt32(offset, true) : view.getUint16(offset, true);
    const type = tilemap[id];
    if (id === 0 || type === 'Space') continue;
    if (!type) throw new Error(`Tile ID ${id} is missing from the map's tilemap.`);
    const variant = bytes[offset + (version >= 6 ? 5 : 3)];
    const rotation = version >= 7 ? bytes[offset + 6] : 0;
    result.push({x: cx * size + x, y: cy * size + y, type, variant, rotation});
  }
  return result;
}

export function emptyBounds() { return {minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity}; }
export function extend(bounds, x, y, pad = 0) {
  bounds.minX = Math.min(bounds.minX, x - pad); bounds.maxX = Math.max(bounds.maxX, x + pad);
  bounds.minY = Math.min(bounds.minY, y - pad); bounds.maxY = Math.max(bounds.maxY, y + pad);
}
export function validBounds(bounds) { return bounds && Number.isFinite(bounds.minX) && bounds.maxX >= bounds.minX; }
export function project(x, y, transform) {
  const a = transform.r * Math.PI / 180;
  return [transform.x + x * Math.cos(a) - y * Math.sin(a), transform.y + x * Math.sin(a) + y * Math.cos(a)];
}

function spriteOverride(override, proto, frames) {
  if (!override || !proto || override.viewer) return override?.viewer ?? proto;
  const source = {...proto.source, ...override};
  const rsi = source.sprite?.replace(/^\/Textures\//, '').replace(/^\//, '');
  const definitions = source.layers ?? (source.state ? [{state:source.state}] : []);
  const layers = definitions.filter(layer=>layer.visible!==false).map(layer=>{
    const path = (layer.sprite ?? rsi)?.replace(/^\/Textures\//, '').replace(/^\//, '');
    let key = `${path}/${layer.state}`;
    const color = layer.color ?? source.color;
    if (color && frames?.[key+'@'+color]) key += '@'+color;
    if (frames && !frames[key]) return null;
    const dirs = frames?.[key+'~7'] ? 8 : frames?.[key+'~3'] ? 4 : 1;
    return {key,dirs,offset:layer.offset??'0,0'};
  }).filter(Boolean);
  return {...proto,layers:layers.length?layers:proto.layers,offset:source.offset??proto.offset,scale:source.scale??proto.scale,noRot:source.noRot??proto.noRot,visible:source.visible??proto.visible};
}

export function normalizeMap(raw, catalog, name = 'Imported map', frames = null) {
  if (!raw || !Array.isArray(raw.entities)) throw new Error('Expected an SS14 map YAML with an entities list.');
  if (raw.meta?.format && (raw.meta.format < 3 || raw.meta.format > 7)) throw new Error(`Map format ${raw.meta.format} is not supported. This viewer supports formats 3–7.`);
  const entities = [], byId = new Map(), grids = [], gridById = new Map(), containers = new Map();
  for (const group of raw.entities) {
    const members = Array.isArray(group.entities) ? group.entities : [group];
    for (const item of members) {
      const c = Object.fromEntries((item.components ?? []).map(value => [value.type, value]));
      const prototype = group.proto ?? group.type ?? item.proto ?? '';
      const proto = catalog.entities[prototype];
      const e = {id: Number(item.uid), prototype, c, proto, name: c.MetaData?.name ?? proto?.name ?? prototype ?? 'Unnamed entity', parent: Number(c.Transform?.parent ?? 0), contained: false, located: false};
      if (!Number.isFinite(e.id) || byId.has(e.id)) throw new Error('Map contains a missing or duplicate entity ID.');
      if (!e.name) e.name = c.MapGrid ? 'Map grid' : c.Map ? 'Map' : 'Unnamed entity';
      e.layer = proto?.layer ?? (/^Cable(HV|MV|Apc)/.test(prototype) ? 'wires' : /^GasPipe/.test(prototype) ? 'pipes' : /^DisposalPipe/.test(prototype) ? 'disposals' : 'base');
      e.sprite = spriteOverride(c.Sprite, proto, frames);
      e.anchored = c.Transform?.anchored ?? proto?.anchored ?? true;
      e.smooth = c.IconSmooth ? {...proto?.smooth,...c.IconSmooth} : proto?.smooth;
      e.nodes = {...proto?.nodes,...c.NodeContainer?.nodes};
      e.terminal = proto?.terminal || Object.values(e.nodes).some(node=>node?.__yamlType==='CableTerminalNode');
      if (e.terminal) e.layer='wires';
      entities.push(e); byId.set(e.id, e);
      for (const container of Object.values(c.ContainerContainer?.containers ?? {})) {
        for (const id of container?.ents ?? []) containers.set(Number(id), e.id);
      }
    }
  }
  const resolving = new Set();
  function locate(e) {
    if (e.resolved) return;
    if (resolving.has(e.id)) throw new Error('Map contains a cyclic entity transform.');
    resolving.add(e.id);
    const container = containers.get(e.id);
    const parent = byId.get(container ?? e.parent);
    if (parent) locate(parent);
    const [x, y] = vector(e.c.Transform?.pos);
    const rotation = angle(e.c.Transform?.rot);
    if (container != null && parent) {
      e.x = parent.x; e.y = parent.y; e.r = parent.r; e.g = parent.g; e.contained = true; e.container = container; e.located = parent.located;
    } else {
      const pos = project(x, y, parent ?? {x: 0, y: 0, r: 0});
      [e.x, e.y] = pos; e.r = (parent?.r ?? 0) + rotation;
      e.g = e.c.MapGrid ? e.id : parent?.g;
      e.located = !!(e.c.Map || e.c.MapGrid || parent?.located);
      e.contained = parent?.contained ?? false;
    }
    e.resolved = true; resolving.delete(e.id);
  }
  entities.forEach(locate);
  for (const e of entities) if (e.c.MapGrid) {
    const grid = {id: e.id, name: e.c.MetaData?.name ?? e.c.BecomesStation?.id ?? `Grid #${e.id}`, x: e.x, y: e.y, r: e.r, bounds: emptyBounds(), tiles: [], entityCount: 0};
    for (const [key, data] of Object.entries(e.c.MapGrid.chunks ?? {})) {
      const tiles = decodeChunk({...data, ind: data.ind ?? key}, raw.tilemap ?? {});
      for (const tile of tiles) {
        const p = project(tile.x + .5, tile.y + .5, grid);
        tile.wx = p[0]; tile.wy = p[1]; tile.g = grid.id;
        extend(grid.bounds, p[0], p[1], .71);
        grid.tiles.push(tile);
      }
    }
    grids.push(grid); gridById.set(grid.id, grid);
  }
  const bounds = emptyBounds(), counts = {wires: 0, pipes: 0, disposals: 0};
  const drawable = [];
  const cablePositions = new Set();
  const terminalDirections = new Map();
  for (const e of entities) {
    const grid=gridById.get(e.g);
    const rotation=-(grid?.r ?? 0)*Math.PI/180;
    const dx=e.x-(grid?.x ?? 0),dy=e.y-(grid?.y ?? 0);
    e.gx=dx*Math.cos(rotation)-dy*Math.sin(rotation);e.gy=dx*Math.sin(rotation)+dy*Math.cos(rotation);
    e.localR=e.r-(grid?.r ?? 0);
    if (e.terminal && e.anchored && e.located && !e.contained) {
      const direction=((Math.round(e.localR/90)%4)+4)%4;
      const key=`${e.g}:${Math.floor(e.gx)}:${Math.floor(e.gy)}`;
      terminalDirections.set(key,(terminalDirections.get(key)??0)|(1<<direction));
    }
  }
  applySmoothing(entities,gridById,frames);
  for (const e of entities) {
    const grid = gridById.get(e.g);
    if (grid) grid.entityCount++;
    if (e.layer in counts) counts[e.layer]++;
    e.searchName = String(e.name).toLowerCase(); e.searchProto = (e.prototype + ' ' + (e.proto?.migratedTo ?? '')).trim().toLowerCase();
    if (!e.located || e.c.MapGrid || e.c.Map || e.contained) continue;
    extend(bounds, e.x, e.y, .5);
    if (grid) extend(grid.bounds, e.x, e.y, .5);
    e.render = !!e.sprite?.layers?.length || e.layer !== 'base';
    if (e.render) drawable.push(e);
    if (e.proto?.cable && e.anchored) {
      cablePositions.add(`${e.g}:${e.proto?.cableGroup??e.prototype}:${Math.floor(e.gx)}:${Math.floor(e.gy)}`);
    }
  }
  for (const e of drawable) if (e.proto?.cable) {
    let mask = 0;
    const x=Math.floor(e.gx),y=Math.floor(e.gy);
    const ownTerminal=terminalDirections.get(`${e.g}:${x}:${y}`)??0;
    // CableVisSystem uses N=1, S=2, E=4, W=8.
    for (const [dx, dy, bit, direction] of [[0, 1, 1,2], [0, -1, 2,0], [1, 0, 4,1], [-1, 0, 8,3]]) {
      const otherTerminal=terminalDirections.get(`${e.g}:${x+dx}:${y+dy}`)??0;
      const blocked=(ownTerminal&(1<<direction)) || (otherTerminal&(1<<((direction+2)%4)));
      if (e.anchored && !blocked && cablePositions.has(`${e.g}:${e.proto?.cableGroup??e.prototype}:${x+dx}:${y+dy}`)) mask |= bit;
    }
    e.cableMask=mask;
    if (e.proto.cable[mask]) e.cableFrame = e.proto.cable[mask];
    if (e.proto.cableExtra?.[mask]) e.cableExtraFrame=e.proto.cableExtra[mask];
  }
  for (const grid of grids) if (validBounds(grid.bounds)) {
    extend(bounds, grid.bounds.minX, grid.bounds.minY); extend(bounds, grid.bounds.maxX, grid.bounds.maxY);
  }
  grids.sort((a, b) => b.tiles.length - a.tiles.length);
  drawable.sort((a, b) => (a.sprite?.depth ?? 16) - (b.sprite?.depth ?? 16) || b.y - a.y || a.id - b.id);
  return {name, meta: raw.meta ?? {}, entities, byId, grids, gridById, bounds, counts, drawable,
    tiles: grids.flatMap(g => g.tiles), missingPrototypes: [...new Set(entities.filter(e => e.prototype && !e.proto).map(e => e.prototype))]};
}

export function searchEntities(map, query, mode = 'all') {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  if (q.startsWith('#') || mode === 'id') {
    const value = q.replace(/^#/, '');
    if (!/^\d+$/.test(value)) return [];
    const e = map.byId.get(Number(value));
    return e ? [e] : [];
  }
  const exactId = /^\d+$/.test(q) ? Number(q) : null;
  return map.entities.filter(e => mode === 'name' ? e.searchName.includes(q) : mode === 'prototype' ? e.searchProto.includes(q) : e.id === exactId || e.searchName.includes(q) || e.searchProto.includes(q))
    .sort((a, b) => Number(b.id === exactId) - Number(a.id === exactId) || Number(b.searchProto === q) - Number(a.searchProto === q) || Number(b.searchName === q) - Number(a.searchName === q) || a.id - b.id);
}
