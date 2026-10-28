/**
 * The numbers listed for the review: strings with digits from text, morphs and component fields,
 * counters at their end value with prefix and suffix, chart data left out, grouped by scene.
 * Run: npx tsx scripts/test-numbers.ts
 */
import { numberLines } from '../src/cli/generate';
import { validateVideo } from '../src/spec/schema';

const v = validateVideo({
  scenes: [
    { id: 'hook', duration: 3, layers: [{ type: 'text', text: '28 pages.', morph: [{ text: 'One bad clause.', at: 1 }] }, { type: 'text', text: 'No digits here' }] },
    { id: 'product', duration: 3, layers: [
      { type: 'browser', url: 'app.clause.ai', children: [{ type: 'text', text: 'Page 14 of 18' }, { type: 'chart', kind: 'bar', data: [3, 7, 9] }] },
      { type: 'counter', from: 0, to: 4800, prefix: '$', suffix: ' saved' },
      { type: 'counter', from: 0, to: 2.4, decimals: 1, suffix: 'x' },
    ] },
    { id: 'end', duration: 3, layers: [{ type: 'text', text: 'Clause' }] },
  ],
});
if (!v.ok) throw new Error(v.errors.join('; '));
const lines = numberLines(v.video!);
const expect = ['hook: "28 pages."', 'product: "Page 14 of 18", "$4,800 saved (counter)", "2.4x (counter)"'];
const ok = lines.length === 2 && lines[0] === expect[0] && lines[1] === expect[1];
console.log(ok ? 'All 1 number checks passed.' : `FAIL\n${lines.join('\n')}`);
process.exit(ok ? 0 : 1);
