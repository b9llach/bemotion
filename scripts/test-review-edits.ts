/**
 * Edits a reviewer sends instead of a whole spec: paths as findings write them, set / delete /
 * insert / remove applied in order to a copy, errors that name the edit, guarded keys, what a reply
 * carries, and the layer outline that gives the reviewer its paths.
 * Run: npx tsx scripts/test-review-edits.ts
 */
import { applyReviewEdits, parsePath, readReply } from '../src/cli/review-edits';
import { layerOutline } from '../src/cli/generate';
import { validateVideo } from '../src/spec/schema';

let failed = 0;
let n = 0;
function check(name: string, fn: () => void): void {
  n++;
  try {
    fn();
    console.log(`ok  ${n}. ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${n}. ${name}\n     ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function throws(fn: () => unknown, re: RegExp): void {
  try {
    fn();
  } catch (e) {
    assert(re.test((e as Error).message), (e as Error).message);
    return;
  }
  throw new Error('expected an error');
}

const spec = (): any => ({
  scenes: [
    { id: 'a', duration: 3, layers: [{ type: 'text', text: 'One', x: 0 }, { type: 'group', children: [{ type: 'text', text: 'Two' }] }] },
    { id: 'b', duration: 2, layers: [{ type: 'text', text: 'Three', out: { preset: 'fade' } }] },
  ],
});

check('paths read the way findings write them', () => {
  assert(JSON.stringify(parsePath('scenes[0].layers[1].children[0].text')) === '["scenes",0,"layers",1,"children",0,"text"]', 'path');
  throws(() => parsePath('scenes[0].__proto__'), /Invalid path key/);
  throws(() => parsePath('scenes[0]..x'), /Invalid path/);
  throws(() => parsePath(''), /Invalid path/);
});

check('set, delete, insert and remove apply in order to a copy', () => {
  const s = spec();
  const out = applyReviewEdits(s, [
    { set: 'scenes[0].layers[0].x', value: 120 },
    { set: 'scenes[1].duration', value: 2.6 },
    { delete: 'scenes[1].layers[0].out' },
    { insert: 'scenes[0].layers[1].children', value: { type: 'text', text: 'Four' } },
    { insert: 'scenes[1].layers', index: 0, value: { type: 'background', color: '#fff' } },
    { remove: 'scenes[0].layers[1].children[0]' },
  ]);
  assert(out.scenes[0].layers[0].x === 120 && out.scenes[1].duration === 2.6, 'set');
  assert(out.scenes[1].layers[1].out === undefined && out.scenes[1].layers[0].type === 'background', 'delete and insert at 0');
  assert(out.scenes[0].layers[1].children.length === 1 && out.scenes[0].layers[1].children[0].text === 'Four', 'insert at end, then remove');
  assert(s.scenes[0].layers[0].x === 0, 'the original is untouched');
  assert(validateVideo(out).ok, 'still valid');
});

check('an edit that does not fit names itself', () => {
  throws(() => applyReviewEdits(spec(), [{ set: 'scenes[0].x', value: 1 }, { set: 'scenes[5].duration', value: 1 }]), /edit 2: nothing at scenes\[5\]/);
  throws(() => applyReviewEdits(spec(), [{ insert: 'scenes[0].layers', index: 9, value: {} }]), /index 9 is outside/);
  throws(() => applyReviewEdits(spec(), [{ remove: 'scenes[0].layers[4]' }]), /nothing at scenes\[0\]\.layers\[4\]/);
  throws(() => applyReviewEdits(spec(), [{ move: 'x' }]), /expected "set"/);
});

check('a reply carries edits, a whole spec, or neither', () => {
  assert(readReply('{"edits":[{"set":"scenes[0].duration","value":2}]}').edits?.length === 1, 'edits');
  assert(readReply('[{"remove":"scenes[0].layers[0]"}]').edits?.length === 1, 'bare list');
  assert(readReply(JSON.stringify(spec())).spec !== undefined, 'spec');
  assert(/syntax/.test(readReply('{nope').error ?? ''), 'syntax');
  assert(readReply(null).edits === undefined && readReply(null).spec === undefined, 'nothing');
});

check('the outline lists every layer with its path', () => {
  const v = validateVideo(spec());
  const lines = layerOutline(v.video!);
  assert(lines[0] === 'scenes[0] #a (3s)', lines[0]);
  assert(lines.includes('  scenes[0].layers[0] text "One"') && lines.includes('    scenes[0].layers[1].children[0] text "Two"'), lines.join('\n'));
  assert(lines.some((l) => l.startsWith('scenes[1] #b (2s')), 'second scene');
});

console.log(failed ? `\n${failed} of ${n} review-edit checks failed.` : `\nAll ${n} review-edit checks passed.`);
process.exit(failed ? 1 : 0);
