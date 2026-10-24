/**
 * Tests for voiceover timing: aligning a script to speech, matching lines of type to spoken words,
 * caption phrases, and a render that follows the voice. On Windows it also checks the aligner
 * against a voice synthesized with known word times (scripts/make-voiceover.ps1).
 * Run: npx tsx scripts/test-voice.ts
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { alignScript, alignVoice } from '../src/cli/voice';
import { ffmpegPath, runFfmpeg } from '../src/cli/ffmpeg';
import { still } from '../src/cli/render';
import { lineTargets, phrases } from '../src/engine/voice';
import { layoutScenes, toSeconds } from '../src/spec/time';
import type { Video } from '../src/spec/schema';

let n = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  n++;
  console.log(`ok  ${n}. ${name}`);
}

const DIR = 'out/dev/voice-e2e';
await rm(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
await mkdir(DIR, { recursive: true });

try {
  await test('the script is shared out over stretches of speech, breaking at punctuation', () => {
    const words = alignScript('Hello there, my friend. Fast. We are here now.', [[0.5, 1.4], [1.6, 2.1], [3.0, 3.4], [4.0, 5.0]]);
    const at = (w: string) => words.find((x) => x.text.replace(/\W/g, '') === w)!.start;
    assert.equal(words.length, 9);
    assert.equal(at('Hello'), 0.5);
    assert.equal(at('my'), 1.6, '"my friend." is the second stretch (after the comma)');
    assert.equal(at('Fast'), 3.0);
    assert.equal(at('We'), 4.0);
    assert.ok(words.every((w, i) => i === 0 || w.start >= words[i - 1].start));
  });

  await test('lines match their spoken words in order; numbers and morph steps are handled', () => {
    const video = {
      fps: 30,
      scenes: [
        { duration: 3, layers: [{ type: 'text', text: 'One small step', start: 0.2 }, { type: 'text', text: 'could mean 150 devices', start: 1.5 }] },
        { duration: 3, layers: [{ type: 'text', text: 'IT', morph: [{ text: 'IT demands.', at: 1 }] }, { type: 'text', text: 'one more', start: 2 }] },
      ],
    } as unknown as Video;
    const spoken = 'one small step could mean one hundred fifty devices IT demands one more'.split(' ').map((t, i) => ({ text: t, start: i, end: i + 0.8 }));
    const { scenes } = layoutScenes(video.scenes, { fps: 30 });
    const pairs = lineTargets(video, scenes, spoken, (v) => toSeconds(v as never, { fps: 30 }, 0));
    assert.deepEqual(pairs.map((p) => p[1] + 0.12).map((x) => Math.round(x)), [0, 3, 9, 10, 11], JSON.stringify(pairs));
  });

  await test('captions break at pauses, sentence ends and commas, without orphan words', () => {
    const w = (text: string, start: number) => ({ text, start, end: start + 0.25 });
    const list = phrases([w('When', 0), w('you', 0.3), w('work', 0.6), w('at', 0.9), w('a', 1.2), w('small', 1.5), w('business,', 1.8), w('IT', 2.4), w('matters.', 2.7), w('Later', 4)], 6);
    assert.deepEqual(list.map((p) => p.text), ['When you work at a small business,', 'IT matters.', 'Later']);
  });

  await test('a render follows the voice: the next line arrives as it is said', async () => {
    // "Speech" bursts at 0.5-1.4 s and 3.0-3.8 s; the second line is designed at 1.5 s and said at 3.0 s.
    await runFfmpeg(['-f', 'lavfi', '-i', "anoisesrc=d=4.5:c=pink:a=0.4,volume='between(t,0.5,1.4)+between(t,3.0,3.8)':eval=frame", '-ar', '16000', `${DIR}/vo.wav`]);
    const spec = {
      title: 'Voice e2e', fps: 30, motionBlur: false, sfx: false,
      post: { bloom: false, grain: 0, vignette: 0, tonemap: 'none' },
      audio: [{ src: 'vo.wav', role: 'voice', script: 'Hello there friend. Fast forward now.', align: true }],
      scenes: [
        { id: 'a', duration: 1.5, background: '#000000', layers: [{ type: 'text', text: 'Hello there friend.' }] },
        { id: 'b', duration: 2, background: '#FFFFFF', transition: { type: 'cut' }, layers: [{ type: 'text', text: 'Fast forward now.', color: '#000000' }] },
      ],
    };
    await writeFile(`${DIR}/spec.json`, JSON.stringify(spec));
    const files = await still(`${DIR}/spec.json`, [2.7, 2.95], `${DIR}/s_{t}.png`);
    const luma = (file: string) => new Promise<number>((resolve, reject) => {
      const p = spawn(ffmpegPath(), ['-loglevel', 'error', '-i', file, '-vf', 'crop=200:200:0:0,scale=4:4', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
      const c: Buffer[] = [];
      p.stdout.on('data', (d) => c.push(d));
      p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(c).reduce((a, b) => a + b, 0) / 16) : reject(new Error(`ffmpeg ${code}`))));
    });
    assert.ok((await luma(files[0])) < 20, 'the first scene holds until the second line is said');
    assert.ok((await luma(files[1])) > 235, 'the second scene arrives just before its words (3.0 s - 0.12 s lead)');
  });

  if (process.platform === 'win32') {
    await test('alignment matches a synthesized voice within a fraction of a second', async () => {
      const script = 'When you work at a small business, IT can be a big deal. At first, it was just a few of you. Then one day, there were fifty. That could mean one hundred fifty devices to manage.';
      const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/make-voiceover.ps1', '-Out', `${DIR}/tts.wav`, '-Text', script], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      const truth = (JSON.parse((await readFile(`${DIR}/tts.wav.words.json`, 'utf8')).replace(/^﻿/, '')) as { start: number }[]).sort((a, b) => a.start - b.start);
      const got = await alignVoice(`${DIR}/tts.wav`, script);
      assert.equal(got.length, truth.length);
      const err = got.map((w, i) => Math.abs(w.start - truth[i].start));
      const mean = err.reduce((a, b) => a + b, 0) / err.length;
      assert.ok(mean < 0.12 && Math.max(...err) < 0.35, `mean ${mean.toFixed(3)} s, worst ${Math.max(...err).toFixed(3)} s`);
    });
  }

  console.log(`\nAll ${n} voice checks passed.`);
} finally {
  await rm(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
