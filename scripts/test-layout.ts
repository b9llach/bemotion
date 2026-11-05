/**
 * Automatic layout and the product UI components: line wrap and ellipsis estimates, stack placement
 * (columns, rows, alignment, `between`, padding, wrapping in a fixed width, staggered entrances),
 * every UI component validating and sizing itself with its text inside its box, and a real `check`
 * run where a line inside a stack is still reported at its own path in the JSON.
 * Run: npx tsx scripts/test-layout.ts
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { layoutStack, measure, truncate, wrapLines, lineWidth } from '../src/engine/components/layout';
import { COMPONENTS } from '../src/engine/components/index';
import { validateVideo } from '../src/spec/schema';
import { check as runCheck } from '../src/cli/check';
import type { EngineContext } from '../src/engine/context';

let failed = 0;
let n = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
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
const near = (a: number, b: number, eps = 0.5) => Math.abs(a - b) <= eps;

// Enough of the engine context for expanding components outside a browser.
const ctx = {
  width: 1920, height: 1080, fps: 30,
  time: (v: unknown, d = 0) => (typeof v === 'number' ? v : d),
  color: () => ({ r: 0.5, g: 0.5, b: 0.5, a: 1 }),
  event: () => {},
} as unknown as EngineContext;

await check('wrapLines breaks at maxWidth and keeps explicit line breaks; truncate ends in an ellipsis', () => {
  const lines = wrapLines('one two three four five six seven eight', 40, 300);
  assert(lines.length > 1 && lines.every((l) => lineWidth(l, 40) <= 300 || !l.includes(' ')), lines.join('|'));
  assert(wrapLines('a\nb', 40).length === 2, 'line breaks');
  const t = truncate('Globex Industries International', 20, 160);
  assert(t.endsWith('…') && lineWidth(t, 20, 0) <= 160 + 1, t);
  assert(truncate('Short', 20, 400) === 'Short', 'short text untouched');
});

await check('a column stacks children top down with the gap, left edges aligned, sized to fit', () => {
  const s = { type: 'stack', gap: 20, children: [
    { type: 'shape', width: 200, height: 100 },
    { type: 'shape', width: 400, height: 50 },
  ] };
  const l = layoutStack(s, ctx);
  assert(near(l.size[0], 400) && near(l.size[1], 170), `size ${l.size}`);
  const [a, b] = l.children as any[];
  // Top child: its top at +85, left edge at -200.
  assert(near(a.y, 85 - 50) && near(a.x, -200 + 100), `first at ${a.x},${a.y}`);
  assert(near(b.y, 85 - 100 - 20 - 25) && near(b.x, 0), `second at ${b.x},${b.y}`);
});

await check('a row centers children vertically; justify between spreads them over a fixed width; padding adds room', () => {
  const s = { type: 'stack', direction: 'row', gap: 10, width: 600, justify: 'between', padding: [10, 20], fill: '$surface', children: [
    { type: 'shape', width: 100, height: 40 },
    { type: 'shape', width: 100, height: 80 },
  ] };
  const l = layoutStack(s, ctx);
  assert(near(l.size[0], 600) && near(l.size[1], 100), `size ${l.size}`);
  const [panel, a, b] = l.children as any[];
  assert(panel.type === 'shape' && panel.width === 600 && panel.height === 100, 'panel behind');
  assert(near(a.x, -300 + 20 + 50) && near(b.x, 300 - 20 - 50), `ends at ${a.x} and ${b.x}`);
  assert(near(a.y, 0) && near(b.y, 0), 'centered across');
});

await check('text in a stack takes the edge it is aligned to, and a fixed-width column wraps it', () => {
  const s = { type: 'stack', width: 300, children: [{ type: 'text', text: 'A long line of copy that has to wrap inside the column', size: 30 }] };
  const l = layoutStack(s, ctx);
  const g = (l.children as any[])[0];
  const t = g.children[0];
  assert(t.align === 'left' && t.maxWidth === 300, `align ${t.align}, maxWidth ${t.maxWidth}`);
  assert(near(g.x, -150), `left edge at ${g.x}`);
  const box = measure(t, ctx);
  assert(box.h > 60, `wrapped to ${box.h} px`);
  assert((s.children[0] as Record<string, unknown>).align === undefined, 'the spec itself is not changed');
});

await check('stagger moves each child entrance later, or gives it one', () => {
  const s = { type: 'stack', stagger: 0.2, at: 1, children: [
    { type: 'shape', width: 10, height: 10 },
    { type: 'shape', width: 10, height: 10, in: { preset: 'fade', at: 0.5 } },
  ] };
  const [a, b] = (layoutStack(s, ctx).children as any[]).map((g) => g.children[0]);
  assert(a.in.preset === 'riseIn' && near(a.in.at, 1, 1e-9), JSON.stringify(a.in));
  assert(b.in.preset === 'fade' && near(b.in.at, 1.7, 1e-9), JSON.stringify(b.in));
});

const samples: Record<string, any> = {
  list: { type: 'list', title: 'Leads', select: { row: 1, at: 1 }, rows: [
    { title: 'Maya Chen', subtitle: 'Re: pricing for 12 seats and a much longer subject line that must be cut', avatar: 'MC', meta: '3d', badge: 'Hot' },
    { title: 'Jordan Pike', icon: 'mail', meta: '$1,200' }] },
  table: { type: 'table', columns: [{ label: 'Name' }, { label: 'Status' }, { label: 'Amount', align: 'right' }], rows: [['Acme', { badge: 'Paid', color: '$success' }, 4800], ['Globex', null, '$9,320']] },
  board: { type: 'board', move: { card: 'B', to: 1, at: 1 }, columns: [{ title: 'Todo', cards: [{ title: 'A' }, { title: 'B', tag: 'Bug' }] }, { title: 'Done', cards: [] }] },
  thread: { type: 'thread', typing: true, messages: [{ from: 'Maya', text: 'Hi, I was charged twice for March.' }, { from: 'Support', text: 'Refunded just now.' }] },
  email: { type: 'thread', style: 'email', subject: 'Pricing', messages: [{ from: 'Maya Chen', email: 'maya@x.io', time: '9:41 AM', text: 'Could you send pricing for 12 seats?' }] },
  form: { type: 'form', title: 'Sign up', submit: 'Create', press: 3, fields: [{ label: 'Email', value: 'dana@acme.dev' }, { label: 'Plan', value: 'Team', kind: 'select' }, { label: 'Updates', kind: 'toggle', at: 2 }, { label: 'Terms', kind: 'check' }] },
  calendar: { type: 'calendar', now: 13.5, events: [{ day: 0, from: 9, to: 11, title: 'Deep work', solid: true }, { day: 2, from: 14, to: 14.5, title: 'A very long meeting title that cannot fit' }] },
  sidebar: { type: 'sidebar', brand: 'Acme', active: 0, select: { item: 2, at: 1 }, items: [{ label: 'Inbox', icon: 'inbox', badge: 3 }, { section: 'Teams' }, { label: 'Design', icon: 'pen-tool' }] },
  notifications: { type: 'notifications', max: 2, items: [{ title: 'Deploy finished', body: 'checkout is live', app: 'Vercel', time: 'now' }, { title: 'Paid', body: '$4,800' }, { title: 'Merged', body: '#482' }] },
};

await check('every UI component validates, reports its size, and keeps its text inside its box', () => {
  for (const [key, spec] of Object.entries(samples)) {
    const v = validateVideo({ scenes: [{ id: 's', duration: 4, layers: [spec] }] });
    assert(v.ok, `${key}: ${v.errors?.join('; ')}`);
    const g = COMPONENTS[spec.type](spec, ctx) as any;
    assert(g.width > 100 && g.height > 50, `${key}: size ${g.width}x${g.height}`);
    // Every text, measured where it is drawn, stays within the component (a little slack for estimates).
    const walk = (l: any, ox: number, oy: number) => {
      const x = ox + (l.x ?? 0);
      const y = oy + (l.y ?? 0);
      if (l.type === 'text') {
        const b = measure(l, ctx);
        const cx = x + b.cx;
        assert(cx - b.w / 2 >= -g.width / 2 - 4 && cx + b.w / 2 <= g.width / 2 + 4, `${key}: "${l.text}" runs out sideways`);
        assert(y + b.h / 2 <= g.height / 2 + 4 && y - b.h / 2 >= -g.height / 2 - 4, `${key}: "${l.text}" runs out vertically`);
      }
      for (const c of l.children ?? []) walk(c, x, y);
    };
    for (const c of g.children) walk(c, 0, 0);
  }
});

await check('a stack measures nested components and stacks, so they can be laid out in turn', () => {
  const s = { type: 'stack', direction: 'row', gap: 24, children: [samples.list, { type: 'stack', children: [samples.form, samples.notifications] }] };
  const l = layoutStack(s, ctx);
  const list = COMPONENTS.list(samples.list, ctx) as any;
  const form = COMPONENTS.form(samples.form, ctx) as any;
  assert(l.size[0] >= list.width + form.width + 24 - 1, `row width ${l.size[0]}`);
});

await check('check: a line inside a stack is reported at its own path, and stacks pass the readability checks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bemotion-layout-'));
  try {
    const spec = {
      fps: 30,
      scenes: [{ id: 'one', duration: 2.5, layers: [
        { type: 'background', style: 'solid', color: '#0B0B10' },
        { type: 'stack', gap: 24, children: [
          { type: 'text', text: 'Covered headline', size: 80 },
          { type: 'text', text: 'Second line of copy', size: 40 },
        ] },
        { type: 'shape', width: 900, height: 120, y: 30, fill: '#7C5CFF' },
      ] }],
    };
    const path = join(dir, 'ad.json');
    await writeFile(path, JSON.stringify(spec));
    const r = await runCheck(path, { read: 4 });
    const hit = r.collisions.find((c: any) => /Covered headline/.test(JSON.stringify(c)));
    assert(hit, `collision found: ${JSON.stringify(r.collisions).slice(0, 300)}`);
    assert(JSON.stringify(hit).includes('scenes[0].layers[1].children[0]'), `named by its path: ${JSON.stringify(hit)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

console.log(failed ? `\n${failed} of ${n} layout checks failed.` : `\nAll ${n} layout checks passed.`);
process.exit(failed ? 1 : 0);
