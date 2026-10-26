/**
 * Spring motion: the spring table gives the same values whatever order times are asked in, `bouncy`
 * overshoots and every spring settles on its target; in a render, frames sought in random order match
 * frames played in order, a sprung layer overshoots where the plain one does not, and a group with
 * `lag` makes its children trail. Run: npx tsx scripts/test-spring.ts
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { SPRING_PRESETS, SpringTable, springParams } from '../src/engine/anim/spring';
import { validateVideo } from '../src/spec/schema';
import { startServer } from '../src/cli/server';
import { BROWSER_ARGS, openPage } from '../src/cli/render';
import type { InspectInfo } from '../src/engine/engine';

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

/** A target that jumps at 0.2 s and eases back at 1.2 s, on two channels. */
const target = (t: number, out: number[]) => {
  out[0] = t < 0.2 ? 0 : t < 1.2 ? 100 : 100 - 60 * Math.min(1, (t - 1.2) / 0.3);
  out[1] = t < 0.5 ? 1 : 2;
};

/** Deterministic shuffle (no Math.random in tests that compare runs). */
function shuffle<T>(xs: T[], seed = 7): T[] {
  const a = xs.slice();
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

await check('presets and forms resolve to spring parameters', () => {
  assert(springParams(undefined) === null && springParams(false) === null, 'off');
  assert(springParams(true) === SPRING_PRESETS.default, 'true is the default spring');
  assert(springParams('bouncy') === SPRING_PRESETS.bouncy, 'a preset name');
  const p = springParams({ preset: 'heavy', damping: 5 })!;
  assert(p.mass === SPRING_PRESETS.heavy.mass && p.damping === 5, 'an object overrides a preset');
  for (const v of [true, 'gentle', { stiffness: 300, damping: 20, mass: 1, props: ['x', 'scale'] }, { preset: 'bouncy', lag: 0.04 }]) {
    const r = validateVideo({ scenes: [{ duration: 1, layers: [{ type: 'shape', shape: 'rect', spring: v }] }] });
    assert(r.ok, `valid: ${JSON.stringify(v)} ${r.errors.join('; ')}`);
  }
  const bad = validateVideo({ scenes: [{ duration: 1, layers: [{ type: 'shape', shape: 'rect', spring: 'wobbly' }] }] });
  assert(!bad.ok, 'an unknown preset is an error');
});

await check('seeking in random order gives bit-identical values to seeking in order', () => {
  const times = Array.from({ length: 400 }, (_, i) => -0.1 + i * 0.0071);
  const a = new SpringTable(SPRING_PRESETS.bouncy, 2, 0, target);
  const inOrder = times.map((t) => a.at(t, [0, 0]).slice());
  const b = new SpringTable(SPRING_PRESETS.bouncy, 2, 0, target);
  const got = new Map<number, number[]>();
  for (const t of shuffle(times)) got.set(t, b.at(t, [0, 0]).slice());
  times.forEach((t, i) => {
    const x = got.get(t)!;
    assert(x[0] === inOrder[i][0] && x[1] === inOrder[i][1], `t=${t}: ${x} vs ${inOrder[i]}`);
  });
  // Far first, then near: the table extends in order whatever is asked first.
  const c = new SpringTable(SPRING_PRESETS.bouncy, 2, 0, target);
  const far = c.at(2.5, [0, 0])[0];
  assert(far === a.at(2.5, [0, 0])[0], 'a far seek first');
});

await check('bouncy overshoots a step, then settles on the target', () => {
  const s = new SpringTable(SPRING_PRESETS.bouncy, 2, 0, target);
  let peak = 0;
  for (let t = 0.2; t < 1.2; t += 0.005) peak = Math.max(peak, s.at(t, [0, 0])[0]);
  assert(peak > 130, `overshoot past 100 (peak ${peak.toFixed(1)})`);
  const end = s.at(4, [0, 0]);
  assert(Math.abs(end[0] - 40) < 1e-3 && Math.abs(end[1] - 2) < 1e-3, `settled at the target (${end})`);
  assert(s.at(0, [0, 0])[0] === 0 && s.at(-1, [0, 0])[0] === 0, 'rests at the start target before the start');
  const g = new SpringTable(SPRING_PRESETS.gentle, 2, 0, target);
  let gp = 0;
  for (let t = 0.2; t < 1.2; t += 0.005) gp = Math.max(gp, g.at(t, [0, 0])[0]);
  assert(gp < 103, `gentle barely overshoots (peak ${gp.toFixed(1)})`);
});

await check('channels left out of the spring are written by the caller only', () => {
  const s = new SpringTable(SPRING_PRESETS.bouncy, 2, 0, target, [true, false]);
  const out = [0, 42];
  s.at(0.3, out);
  assert(out[1] === 42, 'unsprung channel untouched');
});

// A render: a plain and a sprung square sliding in, and a group whose children trail.
const DIR = 'out/dev/spring-test';
await rm(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
await mkdir(DIR, { recursive: true });
const slide = { x: [{ t: 0.3, v: -700 }, { t: 0.7, v: 0, ease: 'outCubic' }] };
const spec = {
  title: 'Spring test', fps: 30, motionBlur: false, sfx: false,
  post: { bloom: false, grain: 0, vignette: 0, tonemap: 'none' },
  scenes: [{ id: 'a', duration: 3, background: '#101018', layers: [
    { type: 'shape', shape: 'rect', id: 'plain', y: 300, width: 160, height: 160, fill: '#9A9AB0', keyframes: slide },
    { type: 'shape', shape: 'rect', id: 'bouncy', y: 80, width: 160, height: 160, fill: '#7C5CFF', spring: 'bouncy', keyframes: slide },
    { type: 'shape', shape: 'rect', id: 'scaled', x: 500, y: 300, width: 100, height: 100, fill: '#F472B6', spring: { preset: 'bouncy', props: ['scale'] }, in: { preset: 'scaleIn', at: 0.3, duration: 0.3 } },
    { type: 'group', id: 'row', y: -260, spring: { preset: 'bouncy', lag: 0.03 }, keyframes: slide, children: [
      { type: 'shape', shape: 'rect', id: 'c0', x: -200, width: 100, height: 100, fill: '#22D3EE' },
      { type: 'shape', shape: 'rect', id: 'c1', x: 0, width: 100, height: 100, fill: '#22D3EE' },
      { type: 'shape', shape: 'rect', id: 'c2', x: 200, width: 100, height: 100, fill: '#22D3EE' },
    ] },
  ] }],
};
await writeFile(`${DIR}/spec.json`, JSON.stringify(spec));
const { server, url } = await startServer(`${DIR}/spec.json`, { hmr: false });
const browser = await puppeteer.launch({ headless: true, args: BROWSER_ARGS, protocolTimeout: 600000 });
try {
  const boxes = async (order: number[]) => {
    const { page } = await openPage(browser, url, spec);
    const out = new Map<number, Record<string, { cx: number; w: number }>>();
    for (const f of order) {
      const r = (await page.evaluate((i) => (window as any).bemotion.probe(i), f)) as { info: InspectInfo };
      const m: Record<string, { cx: number; w: number }> = {};
      for (const it of r.info.items) if (it.id) m[it.id] = { cx: (it.box.x0 + it.box.x1) / 2 - 960, w: it.box.x1 - it.box.x0 };
      out.set(f, m);
    }
    await page.close();
    return out;
  };
  const frames = Array.from({ length: 90 }, (_, i) => i);
  const inOrder = await boxes(frames);
  const random = await boxes(shuffle(frames, 3));

  await check('a render sought in random order matches the render played in order', () => {
    for (const f of frames) assert(JSON.stringify(inOrder.get(f)) === JSON.stringify(random.get(f)), `frame ${f} differs`);
  });

  await check('the sprung square overshoots its target, the plain one does not', () => {
    const peak = Math.max(...frames.map((f) => inOrder.get(f)!.bouncy?.cx ?? -1e9));
    const plainPeak = Math.max(...frames.map((f) => inOrder.get(f)!.plain?.cx ?? -1e9));
    assert(peak > 40, `sprung peak ${peak.toFixed(1)} px past the target`);
    assert(plainPeak < 1, `plain peak ${plainPeak.toFixed(1)}`);
    const end = inOrder.get(89)!;
    assert(Math.abs(end.bouncy.cx) < 1 && Math.abs(end.plain.cx) < 1, `settled (${end.bouncy.cx.toFixed(2)})`);
  });

  await check('a spring on scale only overshoots the size', () => {
    const big = Math.max(...frames.map((f) => inOrder.get(f)!.scaled?.w ?? 0));
    assert(big > 106, `peak width ${big.toFixed(1)} (target 100)`);
    assert(Math.abs(inOrder.get(89)!.scaled.w - 100) < 1, 'settles at its size');
  });

  await check('children of a group with lag trail each other, then line up', () => {
    // Mid-move the later children are further behind (left) than their place relative to the first.
    const f = 15;
    const b = inOrder.get(f)!;
    const g1 = b.c1.cx - b.c0.cx;
    const g2 = b.c2.cx - b.c1.cx;
    assert(g1 < 195 && g2 < 195, `gaps shrink while moving right (${g1.toFixed(0)}, ${g2.toFixed(0)})`);
    const e = inOrder.get(89)!;
    assert(Math.abs(e.c1.cx - e.c0.cx - 200) < 1 && Math.abs(e.c2.cx - e.c1.cx - 200) < 1, 'evenly spaced once settled');
  });
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
  await rm(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

console.log(failed ? `\n${failed} of ${n} spring checks failed.` : `\nAll ${n} spring checks passed.`);
process.exit(failed ? 1 : 0);
