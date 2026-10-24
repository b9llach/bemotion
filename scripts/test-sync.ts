/**
 * Tests for cutting to the music: beat tracking on generated music, the time warp, and a render where
 * a cut moves onto the beat. Run: npx tsx scripts/test-sync.ts
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { analyzeBeats } from '../src/cli/beats';
import { ffmpegPath, runFfmpeg } from '../src/cli/ffmpeg';
import { still } from '../src/cli/render';
import { buildWarp, toDesign, toOutput } from '../src/spec/beatsync';

let n = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  n++;
  console.log(`ok  ${n}. ${name}`);
}

const DIR = 'out/dev/sync-e2e';
await rm(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
await mkdir(DIR, { recursive: true });

/** Kick on every beat, snare on 2 and 4, hats on eighths. */
function groove(file: string, bpm: number, first: number, seconds: number): Promise<void> {
  const B = (60 / bpm).toFixed(5);
  const expr = `0.9*sin(2*PI*55*t)*exp(-20*mod(t-${first},${B}))*gte(t,${first})`
    + `+0.35*sin(2*PI*1800*t+sin(2*PI*7000*t)*3)*exp(-25*mod(t-${first}-${B},2*${B}))*gte(t,${first}+${B})`
    + `+0.12*sin(2*PI*8000*t+sin(2*PI*11000*t)*5)*exp(-70*mod(t-${first},${B}/2))*gte(t,${first})`;
  return runFfmpeg(['-f', 'lavfi', '-i', `aevalsrc='${expr}':s=44100:d=${seconds}`, file]);
}

try {
  await test('beat tracking finds the tempo and the beats of a groove', async () => {
    await groove(`${DIR}/g112.wav`, 112, 0.2, 20);
    const info = await analyzeBeats(`${DIR}/g112.wav`);
    assert.ok(Math.abs(info.bpm - 112) < 1, `bpm ${info.bpm}`);
    const period = 60 / 112;
    const worst = Math.max(...info.beats.slice(1, -1).map((b) => Math.abs(((b - 0.2 + period / 2) % period) - period / 2)));
    assert.ok(worst < 0.02, `every beat within 20 ms of the kick (worst ${worst.toFixed(3)} s)`);
    assert.ok(info.bars.length >= Math.floor(info.beats.length / 4), 'a bar every four beats');
    for (let i = 1; i < info.bars.length; i++) assert.ok(Math.abs(info.bars[i] - info.bars[i - 1] - 4 * period) < 0.03, 'bars are four beats apart');
    assert.ok(info.bars.every((b) => info.beats.includes(b)), 'bars start on beats');
  });

  await test('the warp lands moments on beats, within the speed limits, and inverts', () => {
    const beats = Array.from({ length: 40 }, (_, i) => 0.3 + i * 0.5);
    const w = buildWarp([1.9, 3.1, 3.2, 6.05], beats, 8);
    assert.deepEqual(w.map((p) => p[0]), [0, 1.9, 3.1, 6.05, 8], '3.2 is too close to 3.1 and is skipped');
    for (const [d, o] of w.slice(1, -1)) assert.ok(beats.some((b) => Math.abs(b - o) < 1e-9), `moment ${d} lands on a beat (${o})`);
    for (let i = 1; i < w.length; i++) {
      const rate = (w[i][0] - w[i - 1][0]) / (w[i][1] - w[i - 1][1]);
      assert.ok(rate >= 0.82 && rate <= 1.22, `rate ${rate}`);
    }
    for (const t of [0, 0.7, 2.5, 5, 7.9]) assert.ok(Math.abs(toDesign(w, toOutput(w, t)) - t) < 1e-9);
    assert.deepEqual(buildWarp([1, 2], [], 5), [[0, 0], [5, 5]], 'no beats, no change');
  });

  await test('a render with a synced track cuts on the beat', async () => {
    // Beats at 0.3 + 0.5k; the cut at 1.9 s moves to the beat at 1.8 s.
    await groove(`${DIR}/g120.wav`, 120, 0.3, 6);
    const spec = {
      title: 'Sync e2e', fps: 30, motionBlur: false, sfx: false,
      post: { bloom: false, grain: 0, vignette: 0, tonemap: 'none' },
      audio: [{ src: 'g120.wav', sync: true }],
      scenes: [
        { id: 'a', duration: 1.9, background: '#000000', layers: [] },
        { id: 'b', duration: 2, background: '#FFFFFF', transition: { type: 'cut' }, layers: [] },
      ],
    };
    await writeFile(`${DIR}/spec.json`, JSON.stringify(spec));
    const files = await still(`${DIR}/spec.json`, [1.7, 1.84], `${DIR}/s_{t}.png`);
    const luma = (file: string) => new Promise<number>((resolve, reject) => {
      const p = spawn(ffmpegPath(), ['-loglevel', 'error', '-i', file, '-vf', 'scale=4:4', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
      const c: Buffer[] = [];
      p.stdout.on('data', (d) => c.push(d));
      p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(c).reduce((a, b) => a + b, 0) / 16) : reject(new Error(`ffmpeg ${code}`))));
    });
    assert.ok((await luma(files[0])) < 20, 'still the first scene just before the beat');
    assert.ok((await luma(files[1])) > 235, 'the second scene from the beat on (1.8 s, not 1.9 s)');
  });

  console.log(`\nAll ${n} sync checks passed.`);
} finally {
  await rm(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
