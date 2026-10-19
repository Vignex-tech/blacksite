// Prints skins, joints, (optionally) the node tree, animations, materials and primitives of a glb. Data only, nothing is executed.
// Usage: node Art/scripts/inspect_rig.mjs <file.glb> [tree]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
const root = doc.getRoot();
for (const s of root.listSkins()) {
  console.log('skin', s.getName(), s.listJoints().length, 'skeleton', s.getSkeleton()?.getName());
  console.log(s.listJoints().map(j=>j.getName()).join(' '));
}
function walk(n, d){ console.log(' '.repeat(d)+n.getName(), n.getMesh()?'[mesh]':'', n.getSkin()?'[skin]':'', JSON.stringify(n.getTranslation().map(x=>+x.toFixed(3))), JSON.stringify(n.getScale())); n.listChildren().forEach(c=>walk(c,d+1)); }
if (process.argv[3]) root.listScenes()[0].listChildren().forEach(c=>walk(c,0));
console.log('anims', root.listAnimations().map(a=>a.getName()+':'+a.listChannels().length+(a.listChannels()[0]?'/'+(a.listChannels()[0].getSampler().getInput().getCount()):'')).join(' '));
console.log('mats', root.listMaterials().map(m=>m.getName()+JSON.stringify(m.getBaseColorFactor())+(m.getBaseColorTexture()?'T':'')).join(' '));
for (const m of root.listMeshes()) for (const p of m.listPrimitives()) console.log('prim', m.getName(), p.getAttribute('POSITION').getCount(), p.getIndices()?.getCount()/3, p.listSemantics().join(','), p.getMaterial()?.getName());
