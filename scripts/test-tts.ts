/**
 * Generated voiceover: a voice track with `tts` is spoken from its script before the video plays,
 * kept while the script stays the same, spoken again when it changes, and aligned like a recording.
 * Uses the computer's own voice (Windows speech, macOS say, Linux espeak-ng); skips where there is none.
 * Run: npx tsx scripts/test-tts.ts
 */
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readSpec } from '../src/cli/server';
import { systemVoices } from '../src/cli/tts';
import { alignVoiceCached } from '../src/cli/voice';
import { validateVideo } from '../src/spec/schema';

let failed = 0;
let n = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
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

const voices = await systemVoices().catch(() => [] as string[]);
if (!voices.length) {
  console.log('No system voice on this computer; skipping the generated voiceover test.');
  process.exit(0);
}

const DIR = resolve('out/dev/tts-test');
const SPEC = join(DIR, 'ad.json');
const spec = (script: string) => ({
  title: 'TTS test',
  audio: [{ src: 'vo.wav', role: 'voice', script, tts: { voice: voices[0] }, align: true }],
  captions: true,
  scenes: [{ duration: 6, layers: [{ type: 'text', text: 'Meet Lumen.' }, { type: 'text', text: 'Notes in one place.', y: -120, start: 2 }] }],
});
await rm(DIR, { recursive: true, force: true });
await mkdir(DIR, { recursive: true });
const first = 'Meet Lumen. Your notes, finally in one place.';

try {
  await check('the schema takes tts (true or provider settings)', async () => {
    assert(validateVideo(spec(first)).ok, 'settings');
    assert(validateVideo({ ...spec(first), audio: [{ src: 'v.wav', role: 'voice', script: 'Hi.', tts: true }] }).ok, 'true');
    assert(!validateVideo({ ...spec(first), audio: [{ src: 'v.wav', role: 'voice', script: 'Hi.', tts: { provider: 'robot' } }] }).ok, 'unknown provider');
  });

  let mtime = 0;
  await check('reading the spec speaks the script into the file', async () => {
    await writeFile(SPEC, JSON.stringify(spec(first)));
    await readSpec(SPEC);
    const st = await stat(join(DIR, 'vo.wav'));
    assert(st.size > 40000, `file size ${st.size}`);
    mtime = st.mtimeMs;
  });

  await check('the same script keeps the file', async () => {
    await new Promise((r) => setTimeout(r, 50));
    await readSpec(SPEC);
    assert((await stat(join(DIR, 'vo.wav'))).mtimeMs === mtime, 'file was spoken again');
  });

  await check('a changed script speaks it again', async () => {
    await writeFile(SPEC, JSON.stringify(spec('Meet Lumen. Every note you take, found again in a second.')));
    await readSpec(SPEC);
    assert((await stat(join(DIR, 'vo.wav'))).mtimeMs !== mtime, 'file was not updated');
  });

  await check('the spoken file aligns to its script, word by word in order', async () => {
    const script = 'Meet Lumen. Every note you take, found again in a second.';
    const words = await alignVoiceCached(join(DIR, 'vo.wav'), script, DIR);
    assert(words.length === script.split(/\s+/).length, `${words.length} words`);
    for (let i = 1; i < words.length; i++) assert(words[i].start >= words[i - 1].start, 'words out of order');
    assert(words[0].start < 1 && words[words.length - 1].end > 2, `span ${words[0].start}-${words[words.length - 1].end}`);
  });
} finally {
  await rm(DIR, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} of ${n} voiceover checks failed.` : `\nAll ${n} voiceover checks passed.`);
process.exit(failed ? 1 : 0);
