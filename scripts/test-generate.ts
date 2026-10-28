/**
 * Offline end-to-end test of `generate` on the API backend. A local server stands in for the
 * Messages API (streaming), so the real SDK request path, the validate-and-fix loop and the
 * render-and-review loop all run without a key or network.
 * Run: npx tsx scripts/test-generate.ts
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { readFile, rm } from 'node:fs/promises';

const good = JSON.parse(await readFile('examples/tempo-apple.json', 'utf8'));
const bad = structuredClone(good);
bad.scenes[0].layers[0].sparkle = true; // unknown field: must be caught and fixed

const replies = [
  `Concept: a calm, minimal launch film.\n\n\`\`\`json\n${JSON.stringify(bad)}\n\`\`\``,
  // The fix comes back as an edit to the spec that parsed, not a whole spec.
  `Fixed.\n\n\`\`\`json\n${JSON.stringify({ edits: [{ delete: 'scenes[0].layers[0].sparkle' }] })}\n\`\`\``,
  'APPROVED',
];

const requests: { headers: IncomingMessage['headers']; body: any }[] = [];
let byContent = false;

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const body = JSON.parse(raw);
    requests.push({ headers: req.headers, body });
    const last = JSON.stringify(body.messages.at(-1).content);
    const text = byContent
      ? last.includes('<direction>')
        ? `Take.

\`\`\`json
${JSON.stringify({ ...good, title: /Minimal style/.test(last) ? 'minimal take' : 'other take' })}
\`\`\``
        : 'APPROVED'
      : replies[requests.length - 1] ?? 'APPROVED';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const usage = { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: requests.length > 1 ? 1000 : 0, cache_creation_input_tokens: 0 };
    res.write(sse('message_start', { type: 'message_start', message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }));
    res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    for (let i = 0; i < text.length; i += 4000) {
      res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 4000) } }));
    }
    res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
    res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: Math.ceil(text.length / 4) } }));
    res.write(sse('message_stop', { type: 'message_stop' }));
    res.end();
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;

process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
process.env.ANTHROPIC_API_KEY = 'test-key';
const { generate } = await import('../src/cli/generate');

const out = 'out/dev/generate-test/ad.json';
try {
  await rm('out/dev/generate-test', { recursive: true, force: true });
  const path = await generate('A calm launch film for a focus timer app', { out, review: 1, backend: 'api' });
  const written = JSON.parse(await readFile(path, 'utf8'));

  assert.equal(requests.length, 3, 'write, fix, review');
  const [first, fix, review] = requests.map((r) => r.body);
  assert.equal(first.model, 'claude-opus-5-5');
  assert.deepEqual(first.thinking, { type: 'adaptive' });
  assert.equal(first.stream, true);
  assert.equal(first.system[1].cache_control.type, 'ephemeral', 'reference block is cached');
  assert.match(first.system[1].text, /<reference>/);
  assert.match(String(requests[0].headers['anthropic-beta']), /server-side-fallback/);
  assert.match(first.messages[0].content.at(-1).text, /focus timer/);

  assert.equal(fix.messages.length, 3, 'fix turn carries the conversation');
  assert.match(fix.messages[2].content[0].text, /sparkle/, 'validation error is fed back');

  const images = review.messages.at(-1).content.filter((c: any) => c.type === 'image');
  assert.ok(images.length >= 2, 'review sends rendered frames');
  assert.equal(images[0].source.media_type, 'image/jpeg');
  assert.ok(Buffer.from(images[0].source.data, 'base64').length > 5000, 'frames are real renders');

  assert.equal(written.scenes.length, good.scenes.length);
  assert.equal(written.scenes[0].layers[0].sparkle, undefined, 'the fixed spec was written');
  console.log(`\nok  generate (API backend, mocked): ${requests.length} requests, ${images.length} review frames, spec written to ${out}`);

  // review(): two lines of copy on top of each other are measured, reported in the prompt, and the
  // corrected spec from the reply replaces the file.
  const { review: reviewSpec } = await import('../src/cli/generate');
  const clash = structuredClone(good);
  const s0 = clash.scenes[0];
  s0.layers.push(
    { type: 'text', text: 'Focus that lasts all day', size: 90, x: 0, y: 0, start: 0.2 },
    { type: 'text', text: 'Quiet hours, finally', size: 90, x: 20, y: 10, start: 0.2 },
  );
  const reviewPath = 'out/dev/generate-test/review.json';
  await (await import('node:fs/promises')).writeFile(reviewPath, JSON.stringify(clash, null, 2));
  replies.push(`The two lines collide; fixed.\n\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``);
  const { applyComment, readComments } = await import('../src/cli/comments');
  await rm('out/dev/generate-test/review.comments.json', { force: true });
  await applyComment(reviewPath, { op: 'add', t: 1.2, scene: 'hook', sceneTime: 1.2, text: 'The two lines are on top of each other' });
  const before = requests.length;
  const r = await reviewSpec(reviewPath, { rounds: 1, backend: 'api', comments: true });
  assert.equal(requests.length, before + 1, 'one review turn');
  const ask = requests.at(-1)!.body.messages.at(-1).content;
  assert.match(ask[0].text, /spec under review/, 'the spec is in the first review message');
  assert.match(ask[0].text, /left these comments[\s\S]*The two lines are on top of each other/, 'preview comments reach the review');
  assert.equal((await readComments(reviewPath))[0].resolved, true, 'the comment is resolved after the revision');
  const prompt = ask.at(-1).text as string;
  assert.match(prompt, /measured these problems/, 'measured problems reach the prompt');
  assert.match(prompt, /collision: .*Focus that lasts|collision: .*Quiet hours/, `the collision is named:\n${prompt}`);
  const labels = ask.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
  if (good.scenes.some((sc: any, i: number) => i > 0 && (sc.transition?.duration ?? 0) > 0.2)) assert.match(labels, /halfway/, 'transition frames are reviewed');
  const revised = JSON.parse(await readFile(reviewPath, 'utf8'));
  assert.equal(revised.scenes[0].layers.length, good.scenes[0].layers.length, 'the corrected spec replaced the file');
  assert.equal(r.approved, false, 'a revision is not approved until it is looked at');
  console.log(`ok  review (mocked): measured problems in the prompt, ${r.findings.length} left after the revision`);

  // Variants: parallel conversations, each with its own direction, spec and contact sheet.
  byContent = true;
  const { generateVariants } = await import('../src/cli/generate');
  const start = requests.length;
  const vs = await generateVariants('A calm launch film for a focus timer app', { out: 'out/dev/generate-test/v.json', variants: 2, review: 0, backend: 'api', refs: ['keynote-type'] });
  assert.equal(vs.length, 2);
  assert.deepEqual(vs.map((v) => v.key), ['flow', 'minimal']);
  const writes = requests.slice(start).map((q) => JSON.stringify(q.body.messages[0].content));
  assert.equal(writes.length, 2, 'one conversation per variant');
  assert.ok(writes.some((w) => w.includes('Flow style')) && writes.some((w) => w.includes('Minimal style')), 'each variant gets its direction');
  assert.ok(writes.every((w) => w.includes('technique name=\\"Keynote type film\\"')), 'the asked-for technique is in every brief');
  const minimal = JSON.parse(await readFile(vs[1].path, 'utf8'));
  assert.equal(minimal.title, 'minimal take', 'each variant writes its own spec');
  for (const v of vs) {
    assert.ok(v.sheet && (await readFile(v.sheet)).length > 20000, `contact sheet for ${v.key}`);
  }
  console.log(`ok  variants (mocked): ${vs.map((v) => v.path.split(/[\\/]/).pop()).join(', ')} with contact sheets`);

  // A vertical brief: the format is read from the prompt, explained in the brief, and the review
  // sees 9:16 frames with the platform's safe zones measured.
  const { briefTarget } = await import('../src/cli/generate');
  assert.deepEqual(briefTarget('A 15 second vertical-friendly ad'), { format: '9:16', platforms: [] });
  assert.deepEqual(briefTarget('An ad for TikTok and Reels'), { format: '9:16', platforms: ['tiktok', 'reels'] });
  assert.deepEqual(briefTarget('A square 1:1 post'), { format: '1:1', platforms: [] });
  assert.deepEqual(briefTarget('A 4:5 feed ad'), { format: '4:5', platforms: [] });
  assert.deepEqual(briefTarget('A launch film for a focus timer'), { format: undefined, platforms: [] });
  byContent = false;
  const vStart = requests.length;
  replies[vStart] = `Vertical.\n\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``;
  await generate('A 20 second vertical ad for a focus timer, for TikTok', { out: 'out/dev/generate-test/vertical.json', review: 1, backend: 'api' });
  const vWrite = JSON.stringify(requests[vStart].body.messages[0].content);
  assert.ok(vWrite.includes('<format>') && vWrite.includes('9:16') && vWrite.includes('tiktok'), 'the brief explains the format and platform');
  const vReview = requests[vStart + 1].body.messages.at(-1).content;
  const jpeg = Buffer.from(vReview.find((c: any) => c.type === 'image').source.data, 'base64');
  // Width and height from the JPEG's start-of-frame marker.
  let size = '';
  for (let i = 2; i < jpeg.length - 9; ) {
    if (jpeg[i] !== 0xff) break;
    const marker = jpeg[i + 1];
    if (marker >= 0xc0 && marker <= 0xc2) {
      size = `${jpeg.readUInt16BE(i + 7)}x${jpeg.readUInt16BE(i + 5)}`;
      break;
    }
    i += 2 + jpeg.readUInt16BE(i + 2);
  }
  assert.equal(size, '1080x1920', 'review frames are vertical');
  console.log('ok  vertical brief (mocked): format in the brief, 9:16 review frames');
} finally {
  server.close();
}
