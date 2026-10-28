/**
 * Automatic retiming of rushed text: time inserted into a scene moves every later moment (layers,
 * children of delayed groups, keyframes, camera moves, sounds), the time is paid back from other
 * scenes when the brief sets a length, large shortfalls and passing text are left alone, and a real
 * video measured, retimed and measured again loses its rush. Also the rush model's treatment of UI.
 * Run: npx tsx scripts/test-retime.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { shiftLayer, shiftScene, retimeRushes, retimeHelped } from '../src/cli/retime';
import { check, findRushes, type Probe, type Rush } from '../src/cli/check';
import { layoutScenes } from '../src/spec/time';
import type { InspectItem } from '../src/engine/engine';

let failed = 0;
let n = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  n++;
  try {
    await fn();
    console.log(`ok  ${n}. ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${n}. ${name}\n     ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const sec = (v: unknown) => Number(v);
const lengthOf = (spec: any) => layoutScenes(spec.scenes, { fps: 30 }).duration;

await test('moments at or after the point move later; earlier ones and durations stay', () => {
  const l = shiftLayer({ type: 'text', text: 'Hi', start: 0.2, end: 3, animate: { preset: 'lift', at: 0.5, duration: 0.8 }, animateOut: { preset: 'fade', at: 2, duration: 0.4 }, keyframes: { x: [{ t: 0.5, v: 0 }, { t: 2.5, v: 10 }] } }, 1.5, 1, sec);
  assert(l.start === 0.2 && l.end === 4, `start/end ${l.start} ${l.end}`);
  assert(l.animate.at === 0.5 && l.animate.duration === 0.8, 'entrance kept');
  assert(l.animateOut.at === 3 && l.animateOut.duration === 0.4, 'exit moved');
  assert(l.keyframes.x[0].t === 0.5 && l.keyframes.x[1].t === 3.5, 'keyframes');
});

await test('children of a delayed group move by their time in the scene', () => {
  const g = shiftLayer({ type: 'group', delay: 1, children: [{ type: 'text', text: 'a', in: { preset: 'fade', at: 0.2 } }, { type: 'text', text: 'b', in: { preset: 'fade', at: 1 } }] }, 1.5, 0.5, sec);
  // Child a at scene 1.2 stays, child b at scene 2.0 moves to 2.5 (local 1.5).
  assert(g.delay === 1 && g.children[0].in.at === 0.2 && g.children[1].in.at === 1.5, JSON.stringify(g));
  const late = shiftLayer({ type: 'group', delay: 2, children: [{ type: 'text', text: 'c', in: { preset: 'fade', at: 0.3 } }] }, 1.5, 0.5, sec);
  assert(late.delay === 2.5 && late.children[0].in.at === 0.3, JSON.stringify(late));
});

await test('camera moves across the point stretch; later ones move', () => {
  const s = shiftScene({ duration: 4, layers: [], camera: { moves: [{ preset: 'pushIn', duration: 4 }, { preset: 'moveTo', at: 3, duration: 1 }] } }, 2, 0.6, sec);
  assert(s.duration === 4.6 && s.camera.moves[0].duration === 4.6 && s.camera.moves[1].at === 3.6, JSON.stringify(s.camera));
});

const spec = () => ({
  width: 1920, height: 1080, fps: 30,
  scenes: [
    { id: 'hook', duration: 3, layers: [{ type: 'text', text: 'Short hook line here', size: 100, animateOut: { preset: 'fade', at: 1.2, duration: 0.3 } }] },
    { id: 'middle', duration: 5, transition: { type: 'fade', duration: 0.4 }, layers: [{ type: 'text', text: 'Calm', size: 100 }] },
    { id: 'end', duration: 3, transition: { type: 'fade', duration: 0.4 }, layers: [{ type: 'text', text: 'Brand', size: 100 }] },
  ],
  sounds: [{ sound: 'whoosh', at: 2 }, { sound: 'pop', scene: 'hook', at: 1.3 }],
});
const rush = (scene: string, from: number, to: number, need: number, texts: string[]): Rush => ({ scene, from, to, need, words: 4, texts });

await test('a rush gets its time and the length is paid back from a scene with slack', () => {
  const raw = spec();
  const r = retimeRushes(raw, [rush('hook', 0.1, 1.3, 1.9, ['Short hook line here'])], { asked: lengthOf(raw) });
  assert(r.changes.length === 2 && r.changes[0].includes('[hook] held'), r.changes.join('\n'));
  assert(r.spec.scenes[0].layers[0].animateOut.at > 1.8, `exit at ${r.spec.scenes[0].layers[0].animateOut.at}`);
  assert(r.spec.scenes[0].duration > 3 && r.spec.scenes[1].duration < 5 && r.spec.scenes[2].duration === 3, JSON.stringify(r.spec.scenes.map((s: any) => s.duration)));
  assert(Math.abs(r.length - r.original) <= 0.25, `${r.length} vs ${r.original}`);
  assert(r.spec.sounds[1].at > 1.3 && r.spec.sounds[0].at !== 2, JSON.stringify(r.spec.sounds));
});

await test('large shortfalls, passing text and voiceovers are left alone', () => {
  const raw = spec();
  assert(retimeRushes(raw, [rush('hook', 0.1, 1.3, 4, ['Short hook line here'])]).changes.length === 0, 'large');
  assert(retimeRushes(raw, [rush('hook', 1.0, 1.2, 1.5, ['Short hook line here'])]).skipped[0].includes('passes through'), 'passing');
  const voiced = { ...raw, audio: [{ src: 'vo.wav', role: 'voice' }] };
  assert(retimeRushes(voiced, [rush('hook', 0.1, 1.3, 1.9, ['Short hook line here'])]).skipped[0].includes('voiceover'), 'voice');
});

await test('with no room to pay back, the hold is skipped', () => {
  const raw = spec();
  raw.scenes[1].duration = 1.2;
  raw.scenes[1].layers[0].text = 'A few more words to read here';
  const r = retimeRushes(raw, [rush('hook', 0.1, 1.3, 2.6, ['Short hook line here'])], { asked: lengthOf(raw) });
  assert(r.changes.length === 0 && r.skipped.some((s) => s.includes('no time to pay back')), JSON.stringify(r));
});

await test('only fewer rushes with nothing else worse counts as helped', () => {
  const base = { duration: 20, collisions: [], holds: [], unsafe: [], small: [], empty: [], stale: [], cropped: [], probes: [] } as any;
  const one = { ...base, rushes: [{}] };
  const none = { ...base, rushes: [] };
  assert(retimeHelped(one, none, 20), 'fewer');
  assert(!retimeHelped(one, { ...none, empty: [{}] }, 20), 'empty frame added');
  assert(!retimeHelped(one, { ...none, duration: 21.2 }, 20), 'length');
  assert(!retimeHelped(one, one, 20), 'same');
});

await test('the rush model reads three lines of a UI and the copy around it', () => {
  let uid = 0;
  const item = (text: string, px: number, component?: number): InspectItem => ({ uid: uid++, anc: [], type: 'text', order: 0, opacity: 1, box: { x0: 0, y0: 0, x1: 300, y1: px }, text, px, component });
  const ui = Array.from({ length: 12 }, (_, i) => item(`Row label ${i}`, i < 2 ? 40 : 22, 7));
  const copy = item('Ship faster', 100);
  const probes: Probe[] = [];
  for (let t = 0; t < 4; t += 0.1) probes.push({ t, info: { scene: 'a', transition: false, items: t < 3 ? [...ui, copy] : [] }, thumb: [] });
  probes.push(...[4, 4.1, 4.2].map((t) => ({ t, info: { scene: 'b', transition: false, items: [item('End', 100)] }, thumb: [] })));
  // 3 of the UI's lines (2.5 words each) plus 2 words of copy: 9.5 words in 3 s, readable.
  assert(findRushes(probes, 4.3).length === 0, JSON.stringify(findRushes(probes, 4.3)));
  // Small lines outside any component count as one screen too.
  const loose = ui.map((it) => ({ ...it, component: undefined, px: 22 }));
  const p2 = probes.map((p) => (p.info.scene === 'a' && p.t < 3 ? { ...p, info: { ...p.info, items: [...loose, copy] } } : p));
  assert(findRushes(p2, 4.3).length === 0, 'plain-group UI');
});

await test('a real video: measured, retimed and measured again, the rush is gone and the length kept', async () => {
  const dir = 'out/dev/retime-test';
  await mkdir(dir, { recursive: true });
  const raw = {
    width: 640, height: 360, fps: 30,
    scenes: [
      { id: 'hook', duration: 2.4, layers: [{ type: 'background', color: '#111' }, { type: 'text', text: 'Every pull request gets its own live preview', size: 40, color: '#fff', maxWidth: 560, animate: { preset: 'fade', duration: 0.2 }, animateOut: { preset: 'fade', at: 1.2, duration: 0.2 } }] },
      { id: 'slack', duration: 5, transition: { type: 'fade', duration: 0.3 }, layers: [{ type: 'background', color: '#111' }, { type: 'text', text: 'Calm', size: 60, color: '#fff', animate: { preset: 'fade', duration: 0.3 } }], camera: { moves: [{ preset: 'pushIn', duration: 5, amount: 80 }] } },
      { id: 'end', duration: 2.5, transition: { type: 'fade', duration: 0.3 }, layers: [{ type: 'background', color: '#111' }, { type: 'text', text: 'Brand', size: 60, color: '#fff' }] },
    ],
  };
  const path = `${dir}/ad.json`;
  await writeFile(path, JSON.stringify(raw));
  const a = await check(path);
  assert(a.rushes.length === 1 && a.rushes[0].scene === 'hook', JSON.stringify(a.rushes));
  const r = retimeRushes(raw, a.rushes, { asked: 9.3 });
  await writeFile(path, JSON.stringify(r.spec));
  const b = await check(path);
  assert(b.rushes.length === 0, JSON.stringify(b.rushes));
  assert(Math.abs(b.duration - 9.3) <= 0.3, `length ${b.duration}`);
  assert(retimeHelped(a, b, 9.3), 'helped');
});

console.log(failed ? `\n${failed} of ${n} retime checks failed.` : `\nAll ${n} retime checks passed.`);
process.exit(failed ? 1 : 0);
