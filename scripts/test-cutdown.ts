/**
 * Cutdowns: which scenes stay and why, the length, validation (also at 9:16), readable text, times
 * scaled together, shared elements and mask transitions cleaned up, sounds, score and audio, --keep,
 * the files written, and a still rendered from a cut.
 * Run: npx tsx scripts/test-cutdown.ts
 */
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cutdown, cutdownFiles, minScale, rankScenes, scaleLayer, textSpans, cleanShares } from '../src/cli/cutdown';
import { validateVideo } from '../src/spec/schema';
import { applyFormat } from '../src/spec/formats';
import { layoutScenes } from '../src/spec/time';
import { still } from '../src/cli/render';
import { check as runCheck, findingLines } from '../src/cli/check';

let failed = 0;
let n = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
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
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;
const sec = (v: unknown) => Number(v);

const bg = { type: 'background', color: '#0E0E14' };
/** A 26 s ad: hook, problem, product (names it), stats (a number), a dull interlude, end card. */
function ad(): any {
  return {
    title: 'Ledgerly launch',
    fps: 30,
    score: { style: 'warm', energy: { stats: 0.9, '2': 0.7, '4': 0.3 } },
    audio: [
      { src: 'media/music.mp3', sync: true },
      { src: 'media/vo.wav', role: 'voice', script: 'Books that close themselves.' },
    ],
    captions: true,
    sounds: [
      { sound: 'whoosh', at: 0.5, scene: 'stats' },
      { sound: 'pop', at: 1, scene: 'product' },
      { sound: 'chime', at: 22.5 },
    ],
    scenes: [
      { id: 'hook', duration: 4, layers: [bg, { type: 'text', text: 'Month end again?', size: 110, animate: { preset: 'build', at: 0.2 } }] },
      { id: 'problem', duration: 4.5, transition: { type: 'fade', duration: 0.4 }, layers: [bg, { type: 'text', text: 'Receipts everywhere.', size: 96 }] },
      {
        id: 'product', duration: 6, transition: { type: 'blur', duration: 0.4 },
        camera: { moves: [{ preset: 'pushIn', duration: 5 }, { preset: 'moveTo', at: 5.2, duration: 0.6, y: 20 }] },
        layers: [
          bg,
          { type: 'text', id: 'name', text: 'Ledgerly books it for you.', size: 96, y: 200, in: { preset: 'fade', at: 0.3, duration: 0.5 } },
          { type: 'card', id: 'card', share: 'card', width: 600, height: 300, y: -150, start: 1, end: 5, in: { preset: 'scaleIn', duration: 2 }, keyframes: { y: [{ t: 1, v: -150 }, { t: 3, v: -120 }] } },
          { type: 'group', delay: 1, children: [{ type: 'text', text: 'Ten words of detail a viewer must read before it goes', size: 40, y: -400, start: 0.5 }] },
        ],
      },
      { id: 'stats', duration: 4, transition: { type: 'fade', duration: 0.4 }, layers: [bg, { type: 'text', text: '3x faster close', size: 120, share: 'stat' }] },
      { id: 'interlude', duration: 4, transition: { type: 'push', duration: 0.5 }, layers: [bg, { type: 'shape', width: 200, height: 200, share: 'stat' }] },
      {
        id: 'end', duration: 5, transition: { type: 'fade', duration: 0.5 },
        layers: [bg, { type: 'text', text: 'Ledgerly', size: 140 }, { type: 'text', text: 'Books that close themselves.', size: 48, y: -120 }, { type: 'card', share: 'card', width: 300, height: 150, y: 250 }],
      },
    ],
  };
}

await check('ranking: hook and end card first, then the product, then proof; the dull interlude last', () => {
  const r = rankScenes(ad());
  assert(r[0].score === 100 && r[5].score === 100, 'first and last');
  assert(r[2].score > r[3].score && r[3].score > r[4].score && r[1].score < r[2].score, r.map((x) => x.score).join(','));
  assert(r[2].reasons.some((x) => x.includes('names the product (Ledgerly)')), r[2].reasons.join('; '));
  assert(r[3].reasons.some((x) => x.includes('number')), r[3].reasons.join('; '));
});

await check('a 13 s cut keeps hook, product and end; length on target; reasons given', () => {
  const r = cutdown(ad(), { length: 13 });
  const kept = r.choices.filter((c) => c.kept).map((c) => c.id);
  assert(kept.join(',') === 'hook,product,end', kept.join(','));
  assert(Math.abs(r.length - 13) <= 0.5, `length ${r.length}`);
  assert(r.choices.every((c) => c.why.length > 0), 'a choice without a reason');
  assert(r.choices.find((c) => c.id === 'stats')!.why.includes('does not fit'), r.choices.find((c) => c.id === 'stats')!.why);
});

await check('a 16 s cut also keeps the proof scene; a 6 s cut only hook and end', () => {
  const twenty = cutdown(ad(), { length: 16 }).choices.filter((c) => c.kept).map((c) => c.id);
  assert(twenty.includes('stats') && !twenty.includes('interlude'), twenty.join(','));
  const six = cutdown(ad(), { length: 6 });
  assert(six.choices.filter((c) => c.kept).map((c) => c.id).join(',') === 'hook,end', 'six');
  const { scenes, duration } = layoutScenes(six.spec.scenes, { fps: 30 });
  assert(near(duration, six.length) && scenes.length === 2, `layout ${duration} vs ${six.length}`);
});

await check('cuts validate, also at 9:16', () => {
  for (const len of [15, 6]) {
    const r = cutdown(ad(), { length: len });
    assert(validateVideo(r.spec).ok, `${len}: ${validateVideo(r.spec).errors.join('; ')}`);
    const v = validateVideo(applyFormat(r.spec, '9:16').spec);
    assert(v.ok, `${len} at 9:16: ${v.errors.join('; ')}`);
  }
});

await check('text stays readable: no scene goes below the time its lines need', () => {
  // Very short target: everything is squeezed as far as reading allows.
  const r = cutdown(ad(), { length: 4, keep: ['hook', 'product', 'end'] });
  for (const s of r.spec.scenes) {
    const d = Number(s.duration);
    // At its new length, every page of the scene reads in time (minScale 1 or less means it fits as is).
    assert(minScale(s.layers, d, sec) <= 1.001, `${s.id}`);
    for (const t of textSpans(s.layers, d, sec)) assert(t.to - t.from >= 0.4 + t.words / 4 - 0.01 || t.words > 10, `${s.id}: "${t.text}" ${t.to - t.from}`);
  }
  const product = r.choices.find((c) => c.id === 'product')!;
  // The ten-word line (from 1.5 s to the end) needs about 3.2 s before the next transition starts.
  assert(product.newDuration! >= 4.6, `product ${product.newDuration}`);
  assert(r.length > 4, 'reported over the target');
});

await check('layer times scale together: start, end, keyframes, in, delay, camera; short entrances keep their speed', () => {
  const r = cutdown(ad(), { length: 15 });
  const c = r.choices.find((x) => x.id === 'product')!;
  const s = c.scale!;
  assert(s < 1 && s > 0.4, `scale ${s}`);
  const scene = r.spec.scenes[1];
  const card = scene.layers[2];
  assert(near(card.start, 1 * s) && near(card.end, 5 * s), `card ${card.start} ${card.end}`);
  assert(near(card.keyframes.y[1].t, 3 * s), 'keyframe');
  assert(near(card.in.duration, Math.max(0.8, 2 * s)), `long entrance ${card.in.duration}`);
  const name = scene.layers[1];
  assert(near(name.in.at, 0.3 * s) && name.in.duration === 0.5, `short entrance ${JSON.stringify(name.in)}`);
  const group = scene.layers[3];
  assert(near(group.delay, 1 * s) && near(group.children[0].start, 0.5 * s), 'delay');
  assert(near(scene.camera.moves[0].duration, 5 * s) && near(scene.camera.moves[1].at, 5.2 * s) && scene.camera.moves[1].duration === 0.6, JSON.stringify(scene.camera.moves));
  assert(near(Number(scene.duration), 6 * s), 'scene duration');
});

await check('scaling leaves timeline axis positions alone and scales format overrides', () => {
  const l = scaleLayer({ type: 'timeline', items: [{ at: 3, label: 'a', time: 2 }], formats: { '9:16': { start: 2 }, '1:1': false } }, 0.5, sec);
  assert(l.items[0].at === 3 && l.items[0].time === 1, JSON.stringify(l.items));
  assert(l.formats['9:16'].start === 1 && l.formats['1:1'] === false, JSON.stringify(l.formats));
});

await check('shared elements: a pair that is still adjacent stays, one whose partner was cut loses share', () => {
  const r = cutdown(ad(), { length: 13 });
  const product = r.spec.scenes[1];
  const end = r.spec.scenes[2];
  assert(product.layers[2].share === 'card' && end.layers[3].share === 'card', 'card pair kept');
  const r2 = cutdown(ad(), { length: 16 });
  const stats = r2.spec.scenes.find((s: any) => s.id === 'stats');
  assert(stats && stats.layers[1].share === undefined, 'stat share kept without its partner');
  assert(r2.notes.some((x) => x.includes('"stat" is no longer shared')), r2.notes.join('; '));
  // Across a cut nothing flies, so a name with only a cut between is not a pair.
  const v = { scenes: [{ layers: [{ share: 'x' }] }, { transition: { type: 'cut' }, layers: [{ share: 'x' }] }] };
  cleanShares(v);
  assert(v.scenes[0].layers[0].share === undefined && v.scenes[1].layers[0].share === undefined, 'cut pair');
});

await check('a mask transition over a layer of a cut scene starts at the center instead', () => {
  const spec = ad();
  spec.scenes[4].transition = { type: 'mask', text: '3x', from: 'big' };
  spec.scenes[3].layers[1].id = 'big';
  const r = cutdown(spec, { length: 12, keep: ['hook', 'interlude', 'end'] });
  const tr = r.spec.scenes[1].transition;
  assert(tr.type === 'mask' && tr.from === undefined && tr.text === '3x', JSON.stringify(tr));
  const kept = cutdown(spec, { length: 20, keep: ['hook', 'stats', 'interlude', 'end'] });
  assert(kept.spec.scenes[2].transition.from === 'big', 'kept when the layer is still there');
  assert(r.spec.scenes[0].transition === undefined, 'first scene transition');
});

await check('sounds follow their scenes, score energy is renumbered, voice and captions left out, music kept', () => {
  const r = cutdown(ad(), { length: 16 });
  const ids = r.spec.scenes.map((s: any) => s.id);
  assert(ids.join(',') === 'hook,product,stats,end', ids.join(','));
  const sounds = r.spec.sounds;
  assert(sounds.length === 3, JSON.stringify(sounds));
  const scaleOf = (id: string) => r.choices.find((c) => c.id === id)!.scale!;
  const pop = sounds.find((s: any) => s.sound === 'pop');
  assert(pop.scene === 'product' && near(pop.at, scaleOf('product')), JSON.stringify(pop));
  // 22.5 s on the full timeline is 2.2 s into the end card (it starts at 20.3, after the transitions' overlaps).
  const chime = sounds.find((s: any) => s.sound === 'chime');
  assert(chime.scene === 'end' && near(chime.at, 2.2 * scaleOf('end')), JSON.stringify(chime));
  assert(JSON.stringify(r.spec.score.energy) === JSON.stringify({ stats: 0.9, '1': 0.7 }), JSON.stringify(r.spec.score.energy));
  assert(r.spec.audio.length === 1 && r.spec.audio[0].sync === true, JSON.stringify(r.spec.audio));
  assert(r.spec.captions === undefined, 'captions');
  const six = cutdown(ad(), { length: 6 });
  assert(six.spec.sounds.length === 1 && six.spec.sounds[0].sound === 'chime', JSON.stringify(six.spec.sounds));
  assert(six.spec.score.energy === undefined, 'energy of cut scenes');
});

await check('--keep picks the scenes (in story order) and refuses unknown ones', () => {
  const r = cutdown(ad(), { length: 12, keep: ['end', 'stats', '0'] });
  assert(r.spec.scenes.map((s: any) => s.id).join(',') === 'hook,stats,end', r.spec.scenes.map((s: any) => s.id).join(','));
  let threw = false;
  try { cutdown(ad(), { length: 12, keep: ['nope'] }); } catch { threw = true; }
  assert(threw, 'unknown scene accepted');
});

const root = await mkdtemp(join(tmpdir(), 'bemotion-cutdown-'));
try {
  await mkdir(join(root, 'media'), { recursive: true });
  await writeFile(join(root, 'media', 'logo.png'), 'x');
  const src = join(root, 'ad.json');
  const spec = ad();
  spec.audio = undefined;
  delete spec.captions;
  spec.scenes[5].layers.push({ type: 'image', src: 'media/logo.png', width: 100, y: 350 });
  await writeFile(src, JSON.stringify(spec, null, 2));

  await check('files: <name>.cut15.json next to the source; another folder rewrites asset paths', async () => {
    const files = await cutdownFiles(src, [15, 6], { formats: ['9:16'] });
    assert(files.map((f) => f.path).join('|') === [join(root, 'ad.cut15.json'), join(root, 'ad.cut6.json')].join('|'), files.map((f) => f.path).join('|'));
    const written = JSON.parse(await readFile(files[0].path, 'utf8'));
    assert(validateVideo(written).ok, 'written spec invalid');
    assert(written.scenes.at(-1).layers.at(-1).src === 'media/logo.png', 'path next to source');
    const other = await cutdownFiles(src, [15], { outDir: join(root, 'cuts') });
    const moved = JSON.parse(await readFile(other[0].path, 'utf8'));
    assert(moved.scenes.at(-1).layers.at(-1).src === '../media/logo.png', moved.scenes.at(-1).layers.at(-1).src);
  });

  await check('a still renders from the 6 s cut', async () => {
    const out = join(root, 'still_{t}.png');
    const plain = join(root, 'plain.json');
    const plainSpec = ad();
    delete plainSpec.audio;
    await writeFile(plain, JSON.stringify(plainSpec));
    await cutdownFiles(plain, [6]);
    const files = await still(join(root, 'plain.cut6.json'), ['1', '5'], out);
    assert(files.length === 2 && files.every((f) => existsSync(f)), files.join(','));
    for (const f of files) assert((await stat(f)).size > 2000, `${f} is nearly empty`);
  });

  await check('check plays the 13 s cut and finds no text leaving before it is read', async () => {
    await cutdownFiles(join(root, 'plain.json'), [13]);
    const r = await runCheck(join(root, 'plain.cut13.json'), { rate: 10 });
    assert(r.rushes.length === 0, findingLines(r).join('; '));
  });
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} of ${n} failed` : `\nall ${n} passed`);
process.exit(failed ? 1 : 0);
