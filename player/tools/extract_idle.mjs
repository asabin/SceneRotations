// One-time: strip Xbot.glb down to skeleton + the 'idle' clip only, so the
// player can retarget the idle onto Michelle without shipping Xbot's mesh.
import { NodeIO } from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';

const io = new NodeIO();
const doc = await io.read('public/models/person.glb');
const root = doc.getRoot();

for (const anim of root.listAnimations()) {
  if (anim.getName() !== 'idle') anim.dispose();
}
for (const node of root.listNodes()) {
  if (node.getMesh()) node.setMesh(null);
}
for (const skin of root.listSkins()) skin.dispose();
for (const mesh of root.listMeshes()) mesh.dispose();
for (const mat of root.listMaterials()) mat.dispose();
for (const tex of root.listTextures()) tex.dispose();

await doc.transform(prune());
await io.write('public/models/idle.glb', doc);
console.log('wrote public/models/idle.glb');
