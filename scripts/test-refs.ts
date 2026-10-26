/**
 * The technique library: every sample is a valid spec with notes, search finds techniques by name,
 * alias and tag, and prompts that name a technique pick it up.
 * Run: npx tsx scripts/test-refs.ts
 */
import { validateVideo } from '../src/spec/schema';
import { loadRefs, namedInPrompt, pickRefs, refContext, searchRefs } from '../src/cli/refs';

let failed = 0;
let n = 0;
function check(name: string, fn: () => void): void {
  n++;
  try {
    fn();
    console.log(`ok  ${n}. ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${n}. ${name}\n     ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const lib = await loadRefs();

check('at least a dozen techniques, each with notes and a valid sample spec', () => {
  assert(lib.length >= 12, `${lib.length} techniques`);
  for (const t of lib) {
    assert(t.key && t.name && t.summary && t.how.length >= 2 && t.aliases.length >= 2, `${t.key} is missing notes`);
    assert(['flow', 'minimal', 'hype', 'any'].includes(t.style), `${t.key} style ${t.style}`);
    const v = validateVideo(t.spec);
    assert(v.ok, `${t.key}: ${v.errors.slice(0, 3).join('; ')}`);
  }
  assert(new Set(lib.map((t) => t.key)).size === lib.length, 'duplicate keys');
});

check('search ranks by name, alias and tag', () => {
  assert(searchRefs(lib, 'langease')[0]?.key === 'langease-morph', 'alias');
  assert(searchRefs(lib, 'apple reveal')[0]?.key === 'apple-product-reveal', 'name words');
  assert(searchRefs(lib, 'rack focus')[0]?.key === 'scatter-cloud-dof', 'alias phrase');
  assert(searchRefs(lib, 'typewriter')[0]?.key === 'typed-prompt-follow', 'tag');
  assert(searchRefs(lib, 'zzzz').length === 0, 'no match');
});

check('prompts that name a technique pick it up, others do not', () => {
  const hits = namedInPrompt(lib, 'A launch film for Lumen with the LangEase morph into the logo and an Apple product reveal.').map((t) => t.key);
  assert(hits.includes('langease-morph') && hits.includes('apple-product-reveal'), hits.join(', '));
  assert(namedInPrompt(lib, 'A calm ad for a focus timer app.').length === 0, 'no technique named');
});

check('picking by key or words, and the prompt text carries notes and the sample', () => {
  const ts = pickRefs(lib, ['hype-slam', 'number mask']);
  assert(ts[0].key === 'hype-slam' && ts[1].key === 'mask-number-dive', ts.map((t) => t.key).join(', '));
  const text = refContext(ts);
  assert(text.includes('<technique name="Hype slam and whip"') && text.includes('"type":"counter"'), 'context');
  let threw = false;
  try {
    pickRefs(lib, ['qqqq']);
  } catch {
    threw = true;
  }
  assert(threw, 'unknown technique throws');
});

console.log(failed ? `\n${failed} of ${n} library checks failed.` : `\nAll ${n} library checks passed.`);
process.exit(failed ? 1 : 0);
