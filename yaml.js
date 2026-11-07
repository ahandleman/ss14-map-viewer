import {load, Type, DEFAULT_SCHEMA} from './vendor/js-yaml.mjs';

// Keep SS14 type names for IconSmooth and node configurations. Inspector text
// comes from the original file rather than a re-serialization of these values.
export const schema=DEFAULT_SCHEMA.extend(['mapping','sequence','scalar'].map(kind=>new Type('!type:',{
  kind,multi:true,construct:(data,tag)=>{
    if (data && typeof data==='object') Object.defineProperty(data,'__yamlType',{value:tag.replace(/^!type:/,''),enumerable:false});
    return data;
  }
})));

export function parseMapYAML(text) {
  const stack=[], locations=new Map();
  const raw=load(text,{schema,listener:(event,state)=>{
    if (event==='open') { stack.push(state.position);return; }
    const start=stack.pop();
    if (state.kind==='mapping' && Number.isFinite(state.result?.uid)) locations.set(Number(state.result.uid),{start,end:state.position});
  }});
  const yamlById=new Map();
  for (const group of raw?.entities ?? []) {
    for (const entity of group.entities ?? [group]) {
      const location=locations.get(Number(entity.uid));
      if (!location) continue;
      const lineStart=text.lastIndexOf('\n',location.start-1)+1;
      const firstLine=text.slice(lineStart,location.start);
      const indent=firstLine.match(/^\s*/)?.[0].length ?? 0;
      const source=text.slice(lineStart,location.end).trimEnd();
      // The mapping starts after the sequence's dash. Preserve everything in
      // the entity block, including comments, custom tags, and block scalars.
      const lines=source.split('\n').map(line=>'  '+line.slice(indent));
      const prototype=group.proto ?? group.type ?? entity.proto ?? '';
      yamlById.set(Number(entity.uid),`- proto: ${JSON.stringify(prototype)}\n  entities:\n${lines.join('\n')}\n`);
    }
  }
  return {raw,yamlById};
}
