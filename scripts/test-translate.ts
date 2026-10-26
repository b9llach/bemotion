/**
 * Translation, offline: strings taken out of a spec and put back by path, names and numbers kept (with
 * a fix round when the model drops one), right-to-left languages refused, voice tracks per language,
 * and a German translation measured in the rendered video, with one round of shorter wording and then
 * a smaller type size for lines that no longer fit. A Japanese translation renders with the bundled
 * CJK font. The model is a mock that only ever sees lists of strings.
 * Run: npx tsx scripts/test-translate.ts   (KEEP=1 keeps out/dev/translate-test)
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Backend, Part } from '../src/cli/backends';
import { extractStrings, insertStrings, missingProtected, protectedNames, translate } from '../src/cli/translate';
import { ffmpegPath } from '../src/cli/ffmpeg';
import { still } from '../src/cli/render';
import { validateVideo } from '../src/spec/schema';

let failed = 0;
let n = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  n++;
  try {
    await fn();
    console.log(`ok  ${n}. ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${n}. ${name}\n     ${(e as Error).stack?.split('\n').slice(0, 3).join('\n     ')}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const DIR = 'out/dev/translate-test';
await rm(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
await mkdir(DIR, { recursive: true });

const spec = {
  title: 'Lumen launch',
  fps: 30, motionBlur: false, sfx: false,
  post: { bloom: false, grain: 0, vignette: 0 },
  scenes: [
    {
      id: 'hook', duration: 2, background: '#FFFFFF',
      layers: [
        { type: 'text', text: 'Meet Lumen.', size: 110, y: 260, color: '#111111', highlight: [{ text: 'Lumen', color: '#4F46E5' }] },
        { type: 'text', text: '150 devices, one dashboard', size: 56, y: 120, color: '#111111', highlight: [{ text: 'one dashboard', color: '#4F46E5' }] },
        { type: 'button', label: 'Get started', y: -40 },
        { type: 'counter', from: 0, to: 4.9, decimals: 1, suffix: ' stars on GitHub', size: 48, y: -160, color: '#111111' },
        { type: 'text', text: 'lumen.app', size: 32, y: -300, color: '#666666' },
      ],
    },
    {
      id: 'promise', duration: 2, background: '#FFFFFF',
      layers: [
        { type: 'text', text: 'Ship faster', size: 150, y: 150, color: '#111111' },
        { type: 'text', text: 'Plan less, do more', size: 130, y: -100, color: '#111111' },
        { type: 'toast', title: 'Report ready', body: 'Your weekly summary is here', y: -320 },
      ],
    },
  ],
};

const GERMAN: Record<string, string> = {
  'Meet Lumen.': 'Das ist Lumen.',
  Lumen: 'Lumen',
  '150 devices, one dashboard': '150 Geräte, ein einziges Dashboard',
  'one dashboard': 'ein einziges Dashboard',
  'Get started': 'Jetzt kostenlos loslegen',
  ' stars on GitHub': ' Sterne auf GitHub',
  'Ship faster': 'Schneller ausliefern als je zuvor möglich',
  'Plan less, do more': 'Weniger planen, viel mehr erledigen und erreichen',
  'Report ready': 'Bericht ist fertig',
  'Your weekly summary is here': 'Deine wöchentliche Zusammenfassung ist da',
  'Hello, this is Lumen.': 'Hallo, das ist Lumen.',
};
const SHORTER: Record<string, string> = {
  // Fits.
  'Ship faster': 'Schneller liefern',
  // Still a little too long at 130 px: the type gets smaller.
  'Plan less, do more': 'Weniger planen, viel mehr schaffen',
  'Your weekly summary is here': 'Dein Wochenbericht ist da',
};
const JAPANESE: Record<string, string> = {
  'Meet Lumen.': 'Lumenの登場。',
  Lumen: 'Lumen',
  '150 devices, one dashboard': '150台のデバイスを、ひとつの画面で',
  'one dashboard': 'ひとつの画面で',
  'Get started': '今すぐ始める',
  ' stars on GitHub': ' GitHubの星',
  'Ship faster': 'もっと速く届ける',
  'Plan less, do more': '計画は少なく、成果は多く',
  'Report ready': 'レポート完成',
  'Your weekly summary is here': '今週のまとめが届きました',
};

/** A conversation that answers from a dictionary; `drop` loses a kept name the first time. */
class MockBackend implements Backend {
  readonly name = 'mock';
  sent: string[] = [];
  constructor(private dict: Record<string, string>, private opts: { drop?: boolean } = {}) {}
  async send(parts: Part[]): Promise<string> {
    const text = parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
    this.sent.push(text);
    if (/^Fix these/.test(text)) {
      const ids = [...text.matchAll(/id (\d+)/g)].map((m) => Number(m[1]));
      return JSON.stringify(ids.map((id) => ({ id, text: this.dict[this.items.find((i) => i.id === id)!.text] })));
    }
    if (text.includes('\n\n[')) {
      // Shortening round: [{ id, original, current, maxChars }].
      const list = JSON.parse(text.slice(text.indexOf('\n\n[')));
      return JSON.stringify(list.map((x: { id: number; original: string; current: string }) => ({ id: x.id, text: SHORTER[x.original] ?? x.current })));
    }
    const json = JSON.parse(text.slice(text.indexOf('{')));
    this.items = json.strings;
    return 'Here you go:\n' + JSON.stringify(json.strings.map((s: { id: number; text: string }) => {
      let t = this.dict[s.text] ?? `[${json.language}] ${s.text}`;
      if (this.opts.drop && s.text === 'Meet Lumen.') t = 'Das ist Lumen-App.'.replace('Lumen', 'Lumin');
      return { id: s.id, text: t };
    }));
  }
  private items: { id: number; text: string }[] = [];
  summary(): string {
    return `${this.sent.length} turns`;
  }
}

try {
  await writeFile(join(DIR, 'ad.json'), JSON.stringify(spec, null, 2));

  await check('copy is extracted by path: text, highlights, button, counter suffix, toast; URLs and numbers are not copy', () => {
    const s = extractStrings(spec);
    const paths = s.map((x) => x.path.join('.'));
    assert(paths.includes('scenes.0.layers.0.text') && paths.includes('scenes.0.layers.0.highlight.0.text'), paths.join(' '));
    assert(paths.includes('scenes.0.layers.2.label') && paths.includes('scenes.0.layers.3.suffix'), 'button label and counter suffix');
    assert(paths.includes('scenes.1.layers.2.title') && paths.includes('scenes.1.layers.2.body'), 'toast');
    assert(!paths.includes('scenes.0.layers.4.text'), 'a domain alone is not translated');
    const hl = s.find((x) => x.path.join('.') === 'scenes.0.layers.1.highlight.0.text')!;
    assert(hl.partOf !== undefined && s[hl.partOf].text === '150 devices, one dashboard', 'a highlight belongs to its line');
  });

  await check('strings go back by path; a highlight not found in its translated line is dropped', () => {
    const s = extractStrings(spec);
    const texts = s.map((x) => GERMAN[x.text] ?? x.text);
    texts[s.findIndex((x) => x.text === 'one dashboard')] = 'ein Dashboard';
    const { spec: out, dropped } = insertStrings(spec, s, texts);
    const l = (out.scenes as any)[0].layers;
    assert(l[1].text === '150 Geräte, ein einziges Dashboard' && l[2].label === 'Jetzt kostenlos loslegen', 'inserted');
    assert(l[1].highlight === undefined || l[1].highlight.length === 0, 'the highlight that no longer matches is gone');
    assert(l[0].highlight[0].text === 'Lumen' && dropped.length === 1, dropped.join('; '));
    assert((spec.scenes[0].layers[1] as any).text === '150 devices, one dashboard', 'the source is untouched');
    assert(validateVideo(out).ok, 'still a valid spec');
  });

  await check('brand names, inner capitals and domains are kept; numbers must survive', () => {
    const keep = protectedNames(spec, [...extractStrings(spec), { path: [], text: 'Try it free at lumen.app or @lumenhq', kind: '' }]);
    assert(keep.includes('Lumen') && keep.includes('GitHub') && keep.includes('lumen.app') && keep.includes('@lumenhq'), keep.join(', '));
    assert(!keep.includes('Ship'), 'ordinary words are translated');
    assert(missingProtected('150 devices on GitHub', '150 Geräte auf Github', keep).join() === 'GitHub', 'a changed name is caught');
    assert(missingProtected('4.9 stars', '4,9 Sterne', keep).join() === '4.9', 'a reformatted number is caught');
  });

  await check('right-to-left languages are refused with a clear message, nothing written', async () => {
    let msg = '';
    try {
      await translate(join(DIR, 'ad.json'), { to: ['de', 'he', 'ar'], fit: false, makeBackend: () => new MockBackend(GERMAN) });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/Right-to-left languages are not supported: he, ar/.test(msg), msg);
    assert(!(await readdir(DIR)).some((f) => f.startsWith('ad.de')), 'no German file either');
  });

  await check('a dropped brand name gets one fix round; the model only ever sees strings', async () => {
    const mock = new MockBackend(GERMAN, { drop: true });
    const [r] = await translate(join(DIR, 'ad.json'), { to: ['de'], outDir: join(DIR, 'nofit'), fit: false, makeBackend: () => mock, voicesFor: async () => [] });
    assert(mock.sent.length === 2 && /^Fix these/.test(mock.sent[1]) && /"Lumen"/.test(mock.sent[1]), mock.sent[1] ?? 'no fix round');
    const out = JSON.parse(await readFile(r.file, 'utf8'));
    assert(out.scenes[0].layers[0].text === 'Das ist Lumen.', out.scenes[0].layers[0].text);
    assert(!mock.sent.some((t) => t.includes('"scenes"') || t.includes('"layers"')), 'no spec JSON in the prompts');
  });

  await check('German: lines that run off the frame are shortened, then set smaller; the rest fit', async () => {
    const mock = new MockBackend(GERMAN);
    const [r] = await translate(join(DIR, 'ad.json'), { to: ['de'], makeBackend: () => mock, voicesFor: async () => [] });
    const out = JSON.parse(await readFile(r.file, 'utf8'));
    const l = out.scenes[1].layers;
    assert(r.shortened.some((c) => c.path === 'scenes[1].layers[0].text' && c.to === 'Schneller liefern'), JSON.stringify(r.shortened));
    assert(l[0].text === 'Schneller liefern' && l[0].size === 150, 'the shorter wording fits at full size');
    assert(r.resized.some((c) => c.path === 'scenes[1].layers[1].size'), JSON.stringify(r.resized));
    assert(l[1].text === 'Weniger planen, viel mehr schaffen' && l[1].size < 130 && l[1].size >= 130 * 0.75, `size ${l[1].size}`);
    assert(r.overflows.length === 0, JSON.stringify(r.overflows));
    assert(validateVideo(out).ok, 'valid');
    console.log(`     shortened ${r.shortened.length}, resized ${r.resized.map((c) => `${c.from} -> ${c.to}`).join(', ')}`);
  });

  await check('Japanese: the copy uses the bundled Noto Sans JP and renders offline', async () => {
    const [r] = await translate(join(DIR, 'ad.json'), { to: ['ja'], fit: false, makeBackend: () => new MockBackend(JAPANESE), voicesFor: async () => [] });
    assert(r.font === 'Noto Sans JP', `font ${r.font}`);
    const [png] = await still(r.file, [1.5], join(DIR, 'ja.png'));
    // Dark letters in the headline band: the kana and kanji were drawn.
    const dark = await new Promise<number>((resolve, reject) => {
      const p = spawn(ffmpegPath(), ['-loglevel', 'error', '-i', png, '-vf', 'crop=iw:200:0:180,format=gray', '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
      const c: Buffer[] = [];
      p.stdout.on('data', (d) => c.push(d));
      p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(c).filter((v) => v < 80).length) : reject(new Error(`ffmpeg ${code}`))));
    });
    assert(dark > 5000, `${dark} dark pixels in the headline`);
  });

  await check('voice: a spoken track gets its own file per language and a voice for it, or a warning', async () => {
    const withVoice = { ...spec, audio: [{ src: 'audio/vo.wav', role: 'voice', tts: true, script: 'Hello, this is Lumen.' }] };
    await writeFile(join(DIR, 'vo.json'), JSON.stringify(withVoice));
    const [a] = await translate(join(DIR, 'vo.json'), { to: ['de'], outDir: join(DIR, 'voice'), fit: false, makeBackend: () => new MockBackend(GERMAN), voicesFor: async () => [] });
    const outA = JSON.parse(await readFile(a.file, 'utf8'));
    assert(outA.audio[0].src === 'audio/vo.de.wav' && outA.audio[0].script === 'Hallo, das ist Lumen.', JSON.stringify(outA.audio[0]));
    assert(a.warnings.some((w) => /no system voice for German/.test(w)), a.warnings.join('; '));
    const [b] = await translate(join(DIR, 'vo.json'), { to: ['de'], outDir: join(DIR, 'voice2'), fit: false, makeBackend: () => new MockBackend(GERMAN), voicesFor: async () => ['Microsoft Hedda Desktop'] });
    const outB = JSON.parse(await readFile(b.file, 'utf8'));
    assert(outB.audio[0].tts.voice === 'Microsoft Hedda Desktop' && !b.warnings.some((w) => /system voice/.test(w)), JSON.stringify(outB.audio[0]));
  });

  console.log(failed ? `\n${failed} of ${n} translate checks failed.` : `\nAll ${n} translate checks passed.`);
} finally {
  if (!process.env.KEEP) await rm(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
process.exit(failed ? 1 : 0);
