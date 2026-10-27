/**
 * Offline test of `bench`: a local server stands in for the Messages API, so two prompts are
 * generated, checked, put on contact sheets and judged without a key or network. Also covers the
 * score, the asked length and the comparison against a baseline.
 * Run: npx tsx scripts/test-bench.ts
 */
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

let failed = 0;
let n = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
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

const good = JSON.parse(await readFile('examples/tempo-apple.json', 'utf8'));
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
let judged = 0;
/** When set, the mock judge alternates 6 and 8 overall, to stand in for a judge that varies. */
let varying = false;
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw);
    const last = JSON.stringify(body.messages.at(-1).content);
    const system = JSON.stringify(body.system);
    let text: string;
    if (system.includes('strict creative director judging')) {
      judged++;
      const overall = varying ? (judged % 2 ? 6 : 8) : 7;
      text = '```json\n{"hook": 7, "clarity": 8, "motion": 6, "craft": 7, "overall": ' + overall + ', "note": "Clear, but the middle drags."}\n```';
    } else if (last.includes('<brief>')) text = `Concept.\n\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``;
    else text = 'APPROVED';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    res.write(sse('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }));
    res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }));
    res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
    res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }));
    res.write(sse('message_stop', { type: 'message_stop' }));
    res.end();
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env.ANTHROPIC_API_KEY = 'test-key';

const { bench, benchScore, askedLength, benchReport, judgeNoise } = await import('../src/cli/bench');
const dir = 'out/dev/bench-test';
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
await writeFile(`${dir}/prompts.json`, JSON.stringify([
  { id: 'one', prompt: 'A 20 second ad for a focus timer.' },
  { id: 'two', prompt: 'A 30s ad for an invoicing API.' },
  { id: 'three', prompt: 'Not run.' },
]));

try {
  await check('the asked length is read from the prompt', () => {
    assert(askedLength('A 20 second ad') === 20, 'a 20 second');
    assert(askedLength('a 15-second vertical ad') === 15, '15-second');
    assert(askedLength('about 30s long') === 30, '30s');
    assert(askedLength('An ad for this product') === undefined, 'none');
  });

  await check('generate reports a missed length as a finding for the review', async () => {
    const { lengthFinding } = await import('../src/cli/generate');
    assert(lengthFinding(20.4, 20) === undefined, 'within half a second');
    assert(lengthFinding(31, 30) === undefined, 'within 4 percent of a long ad');
    assert(lengthFinding(22.1, undefined) === undefined, 'no asked length');
    const f = lengthFinding(22.1, 20) ?? '';
    assert(f.includes('runs 22.1s') && f.includes('asks for 20s') && f.includes('+2.1s'), f);
    assert((lengthFinding(17.2, 20) ?? '').includes('-2.8s'), 'short');
  });

  await check('the score takes points off for measured problems and missed length', () => {
    assert(benchScore({ ok: false }) === 0, 'failed runs score 0');
    assert(benchScore({ ok: true }) === 100, 'clean run without a judge');
    assert(benchScore({ ok: true, collisions: 1, rushes: 1, holds: 1 }) === 88, String(benchScore({ ok: true, collisions: 1, rushes: 1, holds: 1 })));
    assert(benchScore({ ok: true, judge: { hook: 8, clarity: 8, motion: 8, craft: 8, overall: 8, note: '' } }) === 80, 'judge base');
    assert(benchScore({ ok: true, asked: 20, duration: 22 }) === 100, 'within 15 percent');
    assert(benchScore({ ok: true, asked: 20, duration: 30 }) < 100, '50 percent long');
  });

  let first: Awaited<ReturnType<typeof bench>> | undefined;
  await check('a run generates, measures, sheets and judges the chosen prompts', async () => {
    first = await bench({ prompts: `${dir}/prompts.json`, only: ['one', 'two'], out: `${dir}/run1`, review: 1, backend: 'api', judge: true, jobs: 2 });
    assert(first.results.length === 2, `${first.results.length} results`);
    for (const r of first.results) {
      assert(r.ok, `${r.id}: ${r.error}`);
      assert(r.sheet && existsSync(r.sheet), `${r.id}: no sheet`);
      assert(r.judge?.overall === 7, `${r.id}: judge ${JSON.stringify(r.judge)}`);
      assert(typeof r.duration === 'number' && r.scenes! > 0 && r.layerTypes! > 0, JSON.stringify(r));
    }
    assert(judged === 2, `${judged} judge calls`);
    assert(existsSync(`${dir}/run1/results.json`) && existsSync(`${dir}/run1/report.md`), 'files');
  });

  await check('remeasure scores the earlier specs again without generating, and compares to a baseline', async () => {
    const r = await bench({ prompts: `${dir}/prompts.json`, only: ['one'], out: `${dir}/run1`, remeasure: true, baseline: `${dir}/run1`, backend: 'api' });
    assert(r.results[0].ok, String(r.results[0].error));
    assert(r.results[0].judge?.overall === 7, 'the earlier judge scores are kept');
    assert(/\| one \| \d+ \| (0|[+-]\d+) \|/.test(r.report), r.report);
  });

  await check('judge-only judges the earlier sheets again, several times, and reports the noise', async () => {
    varying = true;
    const before = judged;
    try {
      const r = await bench({ prompts: `${dir}/prompts.json`, only: ['one', 'two'], out: `${dir}/run1`, judgeOnly: true, judgeRuns: 4, backend: 'api', jobs: 1 });
      assert(judged - before === 8, `${judged - before} judge calls`);
      for (const x of r.results) {
        assert(x.ok && x.judgeRuns?.length === 4, `${x.id}: ${JSON.stringify(x.judgeRuns)}`);
        assert(x.judge?.overall === 7 && x.score === benchScore(x), `${x.id}: mean ${x.judge?.overall}`);
        assert(typeof x.duration === 'number' && x.findings !== undefined, 'measurements kept');
      }
      assert(r.report.includes('## Judge noise') && r.report.includes('judged 4 times'), r.report);
    } finally {
      varying = false;
    }
  });

  await check('judge noise: pooled deviation and the smallest change that stands out', () => {
    const j = (overall: number) => ({ hook: 5, clarity: 5, motion: 5, craft: 5, overall, note: '' });
    const res = [
      { id: 'a', ok: true, seconds: 0, score: 0, judgeRuns: [j(6), j(8)] },
      { id: 'b', ok: true, seconds: 0, score: 0, judgeRuns: [j(5), j(5)] },
    ];
    const z = judgeNoise(res)!;
    // Squares 2 + 0 over 2 degrees of freedom: sd 1.
    assert(Math.abs(z.sd - 1) < 1e-9 && z.dims.hook === 0, JSON.stringify(z));
    assert(z.widest.id === 'a' && z.widest.spread === 2, JSON.stringify(z.widest));
    // 2 x 10 x 1 x sqrt(2 / 2) = 20 once; averaged over 2 judgings, 20 / sqrt(2).
    assert(Math.abs(z.once - 20) < 1e-9 && Math.abs(z.averaged - 20 / Math.SQRT2) < 1e-9, JSON.stringify(z));
    assert(judgeNoise([{ id: 'c', ok: true, seconds: 0, score: 0 }]) === undefined, 'single judgings');
  });

  await check('the report lists failures with their reason', () => {
    const rep = benchReport([{ id: 'x', ok: false, error: 'invalid spec: nope', seconds: 3, score: 0 }]);
    assert(rep.includes('0 of 1 prompts') && rep.includes('failed: invalid spec: nope'), rep);
  });

  await check('unknown ids are refused with the list of ids', async () => {
    let msg = '';
    try {
      await bench({ prompts: `${dir}/prompts.json`, only: ['nope'], out: `${dir}/run2` });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/one, two, three/.test(msg), msg);
  });
} finally {
  server.close();
}

console.log(failed ? `\n${failed} of ${n} bench checks failed.` : `\nAll ${n} bench checks passed.`);
process.exit(failed ? 1 : 0);
