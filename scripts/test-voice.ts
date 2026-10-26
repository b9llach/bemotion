/**
 * Tests for voiceover timing: aligning a script to speech, matching lines of type to spoken words,
 * caption phrases, and a render that follows the voice. On Windows it also checks the aligner
 * against a voice synthesized with known word times (scripts/make-voiceover.ps1), and, when Whisper
 * is installed, speech recognition: word times, a script aligned to them, and captions from a voice
 * track without a script. The Whisper checks are skipped when it is not installed.
 * Run: npx tsx scripts/test-voice.ts
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { alignScript, alignVoice } from '../src/cli/voice';
import { ffmpegPath, runFfmpeg } from '../src/cli/ffmpeg';
import { still } from '../src/cli/render';
import { lineTargets, phrases } from '../src/engine/voice';
import { alignTranscript, looksEnglish, numberWords, spokenTokens, transcriptText, whisperAvailable } from '../src/cli/transcribe';
import { layoutScenes, toSeconds } from '../src/spec/time';
import type { Video } from '../src/spec/schema';

let n = 0;
let skipped = 0;
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

  await test('numbers are matched as they are spoken', () => {
    assert.deepEqual(numberWords(150), ['one', 'hundred', 'fifty']);
    assert.deepEqual(numberWords(2045), ['two', 'thousand', 'forty', 'five']);
    assert.deepEqual(spokenTokens('50.'), ['fifty']);
    assert.deepEqual(spokenTokens('40%'), ['forty', 'percent']);
    assert.deepEqual(spokenTokens('1,200'), ['one', 'thousand', 'two', 'hundred']);
    assert.ok(looksEnglish('When you work at a small business, IT can be a big deal.'));
    assert.ok(!looksEnglish('Wenn Sie in einem kleinen Unternehmen arbeiten, ist IT wichtig.'));
  });

  await test('a script takes its times from recognized words (numbers, missed and extra words)', () => {
    const heard = [
      { w: 'That', start: 10.5, end: 10.8, p: 1 }, { w: 'could', start: 10.8, end: 11, p: 1 }, { w: 'mean', start: 11, end: 11.2, p: 1 },
      { w: '150', start: 11.2, end: 12, p: 1 }, { w: 'devices', start: 12, end: 12.6, p: 1 }, { w: 'uh', start: 12.6, end: 12.8, p: 0.4 },
      { w: 'manage.', start: 13, end: 13.3, p: 1 },
    ];
    const { words, matched } = alignTranscript('That could mean one hundred fifty devices to manage.', heard);
    const at = (w: string) => words.find((x) => x.text.replace(/\W/g, '') === w)!;
    assert.equal(words.length, 9);
    assert.ok(matched > 0.8, `matched ${matched}`);
    assert.equal(at('mean').start, 11);
    assert.equal(at('one').start, 11.2, '"one hundred fifty" shares the time of "150"');
    assert.ok(at('fifty').end <= 12.001 && at('hundred').start > 11.2);
    assert.equal(at('devices').start, 12);
    assert.ok(at('to').start >= 12.6 && at('to').end <= 13, 'a word not recognized sits in the gap before the next one');
    assert.equal(at('manage').start, 13);
    assert.ok(words.every((w, i) => i === 0 || w.start >= words[i - 1].start));
    assert.equal(transcriptText(heard), 'That could mean 150 devices uh manage.');
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
      const got = await alignVoice(`${DIR}/tts.wav`, script, { method: 'loudness' });
      assert.equal(got.length, truth.length);
      const err = got.map((w, i) => Math.abs(w.start - truth[i].start));
      const mean = err.reduce((a, b) => a + b, 0) / err.length;
      assert.ok(mean < 0.12 && Math.max(...err) < 0.35, `mean ${mean.toFixed(3)} s, worst ${Math.max(...err).toFixed(3)} s`);
    });
  }

  if (process.platform === 'win32' && (await whisperAvailable())) {
    const script = 'When you work at a small business, IT can be a big deal. At first, it was just a few of you. Then one day, there were fifty. That could mean one hundred fifty devices to manage.';
    const truth = async () => (JSON.parse((await readFile(`${DIR}/tts.wav.words.json`, 'utf8')).replace(/^﻿/, '')) as { text: string; start: number }[]).sort((a, b) => a.start - b.start);

    await test('speech recognition: a script aligned to recognized words is within 0.15 s of the true times', async () => {
      const t = await truth();
      const got = await alignVoice(`${DIR}/tts.wav`, script, { cacheDir: `${DIR}/cache` });
      assert.equal(got.length, t.length);
      const err = got.map((w, i) => Math.abs(w.start - t[i].start));
      const mean = err.reduce((a, b) => a + b, 0) / err.length;
      const within = err.filter((e) => e <= 0.15).length / err.length;
      assert.ok(mean < 0.08 && within >= 0.9 && Math.max(...err) < 0.25, `mean ${mean.toFixed(3)} s, ${Math.round(within * 100)}% within 0.15 s, worst ${Math.max(...err).toFixed(3)} s`);
      console.log(`    mean error ${mean.toFixed(3)} s, worst ${Math.max(...err).toFixed(3)} s`);
    });

    await test('speech recognition: without a script the transcript is the words, and caption phrases follow the speech', async () => {
      const t = await truth();
      const got = await alignVoice(`${DIR}/tts.wav`, undefined, { cacheDir: `${DIR}/cache` });
      assert.ok(got.length >= t.length - 3, `${got.length} words heard`);
      assert.match(got.map((w) => w.text).join(' '), /small business, IT can be a big deal\./);
      // Each caption phrase starts within 0.15 s of the true start of its first word.
      for (const p of phrases(got, 6)) {
        const first = p.text.split(' ')[0].replace(/\W/g, '').toLowerCase();
        const near = t.filter((w) => w.text.toLowerCase() === first).sort((a, b) => Math.abs(a.start - p.start) - Math.abs(b.start - p.start))[0];
        if (!near) continue;
        assert.ok(Math.abs(near.start - p.start) < 0.15, `"${p.text}" at ${p.start}, said at ${near.start}`);
      }
    });

    await test('speech recognition: a render with captions from a voice track without a script', async () => {
      const spec = {
        title: 'Transcribed captions', fps: 30, motionBlur: false, sfx: false,
        post: { bloom: false, grain: 0, vignette: 0, tonemap: 'none' },
        audio: [{ src: 'tts.wav', role: 'voice' }],
        captions: { color: '#FFFFFF', size: 60 },
        scenes: [{ id: 'a', duration: 14, background: '#000000', layers: [] }],
      };
      await writeFile(`${DIR}/captions.json`, JSON.stringify(spec));
      // "deal." ends at about 3.6 s, its caption leaves 0.6 s later, "At first," is said at about 4.56 s.
      const files = await still(`${DIR}/captions.json`, [1.2, 4.35, 5.0], `${DIR}/c_{t}.png`);
      const bottom = (file: string) => new Promise<number>((resolve, reject) => {
        const p = spawn(ffmpegPath(), ['-loglevel', 'error', '-i', file, '-vf', 'crop=iw:ih*0.25:0:ih*0.75,scale=64:16', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
        const c: Buffer[] = [];
        p.stdout.on('data', (d) => c.push(d));
        p.on('close', (code) => (code === 0 ? resolve(Math.max(...Buffer.concat(c))) : reject(new Error(`ffmpeg ${code}`))));
      });
      const [during, gap, next] = await Promise.all(files.map(bottom));
      assert.ok(during > 80, `a caption shows while the first phrase is said (brightest ${during})`);
      assert.ok(gap < 20, `no caption in the pause after "deal." (brightest ${gap})`);
      assert.ok(next > 80, `the next caption shows as "At first" is said (brightest ${next})`);
    });
  } else {
    skipped++;
    console.log('skip  speech recognition checks (Whisper is not installed, or not on Windows)');
  }

  console.log(`\nAll ${n} voice checks passed${skipped ? ' (speech recognition skipped)' : ''}.`);
} finally {
  if (!process.env.KEEP) await rm(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
