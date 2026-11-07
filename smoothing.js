// Ported from this checkout's Content.Client/IconSmoothing/Smoothings classes.
// Direction order follows Robust.Shared.Maths.Direction: S, SE, E, NE, N, NW, W, SW.
const DIRECTIONS = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
const wrap = (value, size) => ((value % size) + size) % size;
const tileKey = (grid,x,y) => `${grid}:${x}:${y}`;

export function cardinalCornerState(primary, alternate) {
  const cardinal = (primary&1) | ((primary&4)>>1);
  const combined = cardinal | (alternate&1) | ((alternate&4)>>1);
  if (combined < 3) return combined !== cardinal ? combined+2 : cardinal;
  if (combined === cardinal) return primary&2 ? 6 : alternate&2 ? 7 : 5;
  return (primary|alternate)&2 ? cardinal+11 : cardinal+8;
}

export function smoothingPieces(definition, adjacent) {
  const kind = definition.__yamlType ?? definition.kind;
  const mask = new Set(definition.mask ?? []), altMask = new Set(definition.altMask ?? []);
  const overlaps = (keys, set) => keys && [...keys].some(key=>set.has(key));
  const primary = adjacent.map(keys=>!!overlaps(keys,mask));
  const alternate = adjacent.map(keys=>!!overlaps(keys,altMask));
  const base = definition.base ?? '';
  if (kind==='DirectionSpriteSmoothing') {
    const value=[0,2,4,6].reduce((bits,dir,i)=>bits|(primary[dir]?1<<i:0),0);
    return [{state:base+value}];
  }
  if (kind==='EdgeSpriteSmoothing') {
    return [0,2,4,6].filter(dir=>!primary[dir]).map(dir=>({state:base+['south','east','north','west'][dir/2],offset:DIRECTIONS[dir]}));
  }
  if (kind==='DiagonalSpriteSmoothing' || kind==='AltDiagonalSpriteSmoothing') {
    const matches=primary.slice(0,3).every(Boolean), altMatches=alternate.slice(0,3).every(Boolean);
    return [{state:base+(matches?1:kind==='AltDiagonalSpriteSmoothing'&&altMatches?2:0)}];
  }
  if (kind!=='CornerSpriteSmoothing' && kind!=='CardinalCornerSpriteSmoothing') return [];
  return [0,2,4,6].map((offset,corner)=>{
    const bits = values=>[0,1,2].reduce((result,i)=>result|(values[(offset+i)%8]?1<<i:0),0);
    const p=bits(primary), a=bits(alternate);
    return {state:base+(kind==='CardinalCornerSpriteSmoothing'?cardinalCornerState(p,a):p),dirOffset:[0,90,180,-90][corner]};
  });
}

export function applySmoothing(entities, gridById, frames) {
  const keysByTile = new Map();
  for (const e of entities) {
    if (!e.smooth?.key || e.smooth.enabled===false || !e.anchored || e.contained || !e.located || !gridById.has(e.g)) continue;
    const key=tileKey(e.g,Math.floor(e.gx),Math.floor(e.gy));
    if (!keysByTile.has(key)) keysByTile.set(key,new Set());
    keysByTile.get(key).add(e.smooth.key);
  }
  for (const e of entities) {
    if (!e.smooth?.states?.length || !e.sprite) continue;
    const layers=[...(e.sprite.layers ?? [])];
    const active=e.anchored && e.smooth.enabled!==false && e.located && !e.contained && gridById.has(e.g);
    const rotation=wrap(Math.round(e.localR/90),4)*2;
    const x=Math.floor(e.gx),y=Math.floor(e.gy);
    const adjacent=DIRECTIONS.map((_,i)=>{
      if (!active) return null;
      const [dx,dy]=DIRECTIONS[(i+rotation)%8];
      return keysByTile.get(tileKey(e.g,x+dx,y+dy)) ?? null;
    });
    const rsi=(e.c.Sprite?.sprite ?? e.sprite.source?.sprite)?.replace(/^\/Textures\//,'').replace(/^\//,'');
    const color=e.c.Sprite?.color ?? e.sprite.source?.color;
    for (const definition of e.smooth.states) {
      const generated=[];
      for (const piece of smoothingPieces(definition,adjacent)) {
        let key=`${rsi}/${piece.state}`;
        if (color && frames?.[key+'@'+color]) key+='@'+color;
        if (frames && !frames[key]) continue;
        const dirs=frames?.[key+'~7']?8:frames?.[key+'~3']?4:1;
        generated.push({key,dirs,dirOffset:piece.dirOffset??0,offset:piece.offset??[0,0]});
      }
      if (definition.index!=null) {
        for (const layer of generated) layers.splice(Math.max(0,definition.index),0,layer);
      } else layers.push(...generated);
    }
    e.sprite={...e.sprite,layers};
  }
}
