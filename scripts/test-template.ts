/**
 * Templates and batch: placeholders filled from values or slot defaults, numbers kept as numbers, file
 * paths rewritten for the output folder, CSV parsing, and one valid spec per CSV row.
 * Run: npx tsx scripts/test-template.ts
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { batch, fillTemplate, parseCsv, slotNames } from '../src/cli/template';
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
    console.log(`FAIL ${n}. ${name}\n     ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const template = {
  title: '{{company}} launch',
  slots: { company: { label: 'Company' }, headline: { default: 'Ship faster.' }, size: { default: 110 }, accent: { default: '#4F46E5' }, logo: { default: 'media/logo.png' } },
  theme: { colors: { primary: '{{accent}}' } },
  fonts: { Brand: 'media/brand.woff' },
  scenes: [{
    id: 'hook', duration: 3,
    layers: [
      { type: 'text', text: '{{headline}}', size: '{{size}}' },
      { type: 'text', text: 'Made for {{company}}, by {{company}}.', y: -150 },
      { type: 'image', src: '{{logo}}', width: 200, y: 200 },
    ],
  }],
};

const root = await mkdtemp(join(tmpdir(), 'bemotion-template-'));
try {
  const tdir = join(root, 'templates');
  const ddir = join(root, 'data');
  const out = join(root, 'out');
  await mkdir(join(tdir, 'media'), { recursive: true });
  await mkdir(join(ddir, 'logos'), { recursive: true });
  await writeFile(join(tdir, 'media', 'logo.png'), 'x');
  await writeFile(join(ddir, 'logos', 'acme.png'), 'x');

  await check('slot names in order of first use', () => {
    assert(slotNames(template).join(',') === 'company,accent,headline,size,logo', slotNames(template).join(','));
  });

  await check('values fill placeholders; defaults fill the rest; a lone number stays a number', () => {
    const s = fillTemplate(template, { company: 'Acme' }, { templateDir: tdir, outDir: out }) as any;
    assert(s.title === 'Acme launch', s.title);
    assert(s.scenes[0].layers[0].text === 'Ship faster.' && s.scenes[0].layers[0].size === 110, JSON.stringify(s.scenes[0].layers[0]));
    assert(s.scenes[0].layers[1].text === 'Made for Acme, by Acme.', 'inline placeholders');
    assert(s.theme.colors.primary === '#4F46E5', 'color default');
    assert(s.slots === undefined, 'slots are dropped from the filled spec');
    assert(validateVideo(s).ok, validateVideo(s).errors.join('; '));
  });

  await check('paths are rewritten for the output folder: template files and value files', () => {
    const a = fillTemplate(template, { company: 'Acme' }, { templateDir: tdir, valuesDir: ddir, outDir: out }) as any;
    assert(a.scenes[0].layers[2].src === '../templates/media/logo.png', a.scenes[0].layers[2].src);
    assert(a.fonts.Brand === '../templates/media/brand.woff', a.fonts.Brand);
    const b = fillTemplate(template, { company: 'Acme', logo: 'logos/acme.png' }, { templateDir: tdir, valuesDir: ddir, outDir: out }) as any;
    assert(b.scenes[0].layers[2].src === '../data/logos/acme.png', b.scenes[0].layers[2].src);
  });

  await check('a placeholder with no value and no default is an error naming it', () => {
    let msg = '';
    try {
      fillTemplate(template, {}, { templateDir: tdir, outDir: out });
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(/\{\{company\}\}/.test(msg), msg);
  });

  await check('CSV: quotes, commas and line breaks inside quotes, blank lines', () => {
    const rows = parseCsv('name,headline,size\r\nacme,"Ship faster, sleep better.",120\n\nglobex,"Two\nlines",\n"quote ""co""",x,90\n');
    assert(rows.length === 3, `${rows.length} rows`);
    assert(rows[0].headline === 'Ship faster, sleep better.' && rows[0].size === '120', JSON.stringify(rows[0]));
    assert(rows[1].headline === 'Two\nlines' && rows[1].size === '', JSON.stringify(rows[1]));
    assert(rows[2].name === 'quote "co"', rows[2].name);
  });

  await check('batch: one valid spec per row, named by the name column; bad rows are reported', async () => {
    await writeFile(join(tdir, 'launch.json'), JSON.stringify(template));
    await writeFile(join(ddir, 'rows.csv'), 'name,company,logo\nAcme Corp,Acme,logos/acme.png\nGlobex,Globex,\nNo Company,,\n');
    const items = await batch(join(tdir, 'launch.json'), join(ddir, 'rows.csv'), out);
    assert(items.length === 3, `${items.length} items`);
    assert(items[0].name === 'acme-corp' && !items[0].error, JSON.stringify(items[0]));
    const spec = JSON.parse(await readFile(items[0].spec, 'utf8'));
    assert(spec.title === 'Acme launch' && validateVideo(spec).ok, 'first spec');
    assert(spec.scenes[0].layers[2].src === '../data/logos/acme.png', spec.scenes[0].layers[2].src);
    assert(items[2].error && /company/.test(items[2].error), JSON.stringify(items[2]));
  });
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} of ${n} template checks failed.` : `\nAll ${n} template checks passed.`);
process.exit(failed ? 1 : 0);
