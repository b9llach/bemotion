/**
 * End-to-end test of the preview's Sound panel in headless Chrome: dropping audio files, roles,
 * volume, the effects kit, removing tracks, playback and mute. Uses examples/dev/sound-test.json and
 * restores it (and deletes the uploaded files) at the end. Run: npx tsx scripts/test-sound.ts
 */
import puppeteer, { type Page } from 'puppeteer';
import assert from 'node:assert/strict';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { startServer } from '../src/cli/server';

const SPEC = 'examples/dev/sound-test.json';
const BASE = {
  title: 'Sound test',
  fps: 30,
  theme: { fonts: { display: 'Inter', body: 'Inter', mono: 'JetBrains Mono' } },
  post: { bloom: false, grain: 0, vignette: 0 },
  scenes: [{
    id: 'a', duration: 4, background: '#000000',
    layers: [{ type: 'text', text: 'Listen to this', size: 90, color: '#FFFFFF', animate: { preset: 'lift', by: 'word', glide: true, at: 0.2 } }],
  }],
};
await writeFile(SPEC, JSON.stringify(BASE, null, 2) + '\n');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const spec = async (): Promise<any> => {
  for (let i = 0; ; i++) {
    try {
      return JSON.parse(await readFile(SPEC, 'utf8'));
    } catch (e) {
      if (i > 20) throw e;
      await wait(25);
    }
  }
};
async function until<T>(get: () => Promise<T>, pred: (v: T) => boolean, what: string, ms = 6000): Promise<T> {
  const end = Date.now() + ms;
  let v = await get();
  while (!pred(v)) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await wait(80);
    v = await get();
  }
  return v;
}

const { server, url } = await startServer(SPEC, { port: 0 });
const browser = await puppeteer.launch({ headless: true, args: ['--ignore-gpu-blocklist', '--use-angle=default', '--autoplay-policy=no-user-gesture-required'] });
const page: Page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));
let step = 0;
async function check(name: string, fn: () => Promise<void>) {
  step++;
  await fn();
  console.log(`ok  ${step}. ${name}`);
}
const setInput = (selector: string, value: string, index = 0) =>
  page.evaluate(
    (sel, v, i) => {
      const el = document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(sel)[i];
      if (!el) throw new Error(`missing ${sel}`);
      el.value = v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    selector,
    value,
    index,
  );

try {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('#frame canvas');

  await check('empty soundtrack shows a hint', async () => {
    const text = await page.$eval('#audio-list', (e) => e.textContent ?? '');
    assert.match(text, /No music/);
  });

  await check('dropping files uploads them and adds music and voice tracks', async () => {
    // Passed as a string: tsx would otherwise inject a __name helper the page does not have.
    await page.evaluate(`(() => {
      // A short stereo sine WAV, built in the page so the drop carries a real file.
      const wav = (seconds, freq) => {
        const sr = 48000;
        const n = Math.floor(seconds * sr);
        const buf = new ArrayBuffer(44 + n * 4);
        const v = new DataView(buf);
        const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
        str(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); str(8, 'WAVE'); str(12, 'fmt ');
        v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, sr, true);
        v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 4, true);
        for (let i = 0; i < n; i++) {
          const s = Math.round(Math.sin((2 * Math.PI * freq * i) / sr) * 8000);
          v.setInt16(44 + i * 4, s, true);
          v.setInt16(46 + i * 4, s, true);
        }
        return buf;
      };
      const dt = new DataTransfer();
      dt.items.add(new File([wav(2, 220)], 'theme song.wav', { type: 'audio/wav' }));
      dt.items.add(new File([wav(1, 440)], 'voiceover.wav', { type: 'audio/wav' }));
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, cancelable: true }));
    })()`);
    const s = await until(spec, (s) => (s.audio ?? []).length === 2, 'two tracks');
    assert.deepEqual(s.audio.map((a: any) => a.role), ['music', 'voice']);
    assert.equal(s.audio[0].src, 'audio/theme-song.wav');
    await stat('examples/dev/audio/theme-song.wav');
    await stat('examples/dev/audio/voiceover.wav');
    const hidden = await page.$eval('#drop-audio', (e) => e.classList.contains('hidden'));
    assert.ok(hidden, 'drop overlay hides after the drop');
  });

  await check('the panel lists both tracks with their lengths', async () => {
    await page.waitForFunction(() => document.querySelectorAll('#audio-list .audio-row').length === 2);
    await page.waitForFunction(() => [...document.querySelectorAll('.audio-len')].every((e) => /s$/.test(e.textContent ?? '')));
    const names = await page.$$eval('.audio-name', (es) => es.map((e) => e.textContent));
    assert.deepEqual(names, ['theme-song.wav', 'voiceover.wav']);
  });

  await check('volume and start time edits save to the spec', async () => {
    await setInput('.audio-vol', '0.5', 0);
    await until(spec, (s) => s.audio[0].volume === 0.5, 'music volume');
    await setInput('.audio-at', '1.25', 1);
    await until(spec, (s) => s.audio[1].at === 1.25, 'voice start');
  });

  await check('role can be changed', async () => {
    await setInput('.audio-role', 'sfx', 1);
    await until(spec, (s) => s.audio[1].role === 'sfx', 'role sfx');
    await setInput('.audio-role', 'voice', 1);
    await until(spec, (s) => s.audio[1].role === 'voice', 'role voice');
  });

  await check('playing runs the soundtrack on the audio clock', async () => {
    await page.click('#play');
    await page.waitForFunction(() => (window as any).__bemotionAudio?.playing === true, { timeout: 4000 });
    const a = await page.evaluate(() => (window as any).__bemotionAudio.now());
    await wait(400);
    const b = await page.evaluate(() => (window as any).__bemotionAudio.now());
    assert.ok(b > a + 0.2, `audio clock advances (${a} -> ${b})`);
    await page.click('#play');
    await page.waitForFunction(() => (window as any).__bemotionAudio?.playing === false, { timeout: 4000 });
  });

  await check('M mutes and unmutes', async () => {
    await page.keyboard.press('m');
    assert.ok(await page.$eval('#mute', (e) => e.classList.contains('off')));
    await page.keyboard.press('m');
    assert.ok(!(await page.$eval('#mute', (e) => e.classList.contains('off'))));
  });

  await check('effects kit and off switch', async () => {
    await setInput('#sfx-kit', 'tactile');
    await until(spec, (s) => s.sfx?.kit === 'tactile', 'tactile kit');
    await setInput('#sfx-kit', 'off');
    await until(spec, (s) => s.sfx === false, 'effects off');
    await setInput('#sfx-kit', 'soft');
    await until(spec, (s) => s.sfx?.kit === 'soft', 'soft kit');
  });

  await check('generated score: style, mode, a new take, and removing it', async () => {
    assert.ok(await page.$eval('#score-more', (e) => (e as HTMLElement).hidden), 'take controls hidden without a score');
    await setInput('#score-style', 'piano');
    await until(spec, (s) => s.score?.style === 'piano', 'piano score');
    await page.waitForFunction(() => !(document.getElementById('score-more') as HTMLElement).hidden, { timeout: 5000 });
    await setInput('#score-mode', 'minor');
    await until(spec, (s) => s.score?.mode === 'minor' && s.score?.style === 'piano', 'minor piano');
    await page.click('#score-take');
    await until(spec, (s) => s.score?.seed === 1, 'seed 1');
    await page.click('#score-take');
    await until(spec, (s) => s.score?.seed === 2, 'seed 2');
    await setInput('#score-style', 'none');
    await until(spec, (s) => s.score === undefined, 'score removed');
  });

  await check('removing tracks', async () => {
    await page.evaluate(() => document.querySelectorAll<HTMLButtonElement>('.audio-row .danger')[0].click());
    let s = await until(spec, (s) => (s.audio ?? []).length === 1, 'one track left');
    assert.equal(s.audio[0].role, 'voice');
    await page.evaluate(() => document.querySelectorAll<HTMLButtonElement>('.audio-row .danger')[0].click());
    s = await until(spec, (s) => s.audio === undefined, 'no audio key');
  });

  await check('non-audio drops are refused', async () => {
    // Record every status message: a later "Saved" can replace the error before a poll would see it.
    await page.evaluate(() => {
      const seen: string[] = ((window as any).__statuses = []);
      const el = document.getElementById('status-text')!;
      new MutationObserver(() => seen.push(el.textContent ?? '')).observe(el, { childList: true, characterData: true, subtree: true });
      const dt = new DataTransfer();
      dt.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, cancelable: true }));
    });
    await page.waitForFunction(() => ((window as any).__statuses as string[]).some((t) => /Drop an audio file/.test(t)), { timeout: 5000 });
    const s = await spec();
    assert.equal(s.audio, undefined);
  });

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`\nAll ${step} sound checks passed.`);
} finally {
  await browser.close();
  await server.close();
  await rm('examples/dev/audio', { recursive: true, force: true });
  await writeFile(SPEC, JSON.stringify(BASE, null, 2) + '\n');
}
