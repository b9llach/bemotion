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
  `Fixed.\n\n\`\`\`json\n${JSON.stringify(good, null, 2)}\n\`\`\``,
  'APPROVED',
];

const requests: { headers: IncomingMessage['headers']; body: any }[] = [];

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
    const text = replies[requests.length - 1] ?? 'APPROVED';
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
} finally {
  server.close();
}
