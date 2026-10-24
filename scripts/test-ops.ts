/**
 * Unit tests for the shared editor operations (src/spec/ops.ts).
 * Run: npx tsx scripts/test-ops.ts
 */
import assert from 'node:assert/strict';
import { applyOps, parseOps } from '../src/spec/ops';

const base = () => ({
  fps: 30,
  scenes: [
    {
      duration: 4,
      layers: [
        { type: 'text', id: 'a', text: 'Hello', keyframes: { x: [{ t: 0, v: 0 }, { t: '1s', v: 100 }, { t: 2, v: 50, ease: 'outBack' }] } },
        { type: 'shape', id: 'b', width: 100 },
        { type: 'group', id: 'g', children: [{ type: 'shape', id: 'c' }] },
      ],
    },
  ],
});

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

const L0 = ['scenes', 0, 'layers', 0];

test('set and delete a property', () => {
  let s = applyOps(base(), parseOps({ ops: [{ op: 'set', path: [...L0, 'color'], value: '#FF0000' }] }));
  assert.equal(s.scenes[0].layers[0].color, '#FF0000');
  s = applyOps(s, parseOps({ ops: [{ op: 'delete', path: [...L0, 'color'] }] }));
  assert.equal(s.scenes[0].layers[0].color, undefined);
});

test('input spec is not mutated', () => {
  const b = base();
  applyOps(b, [{ op: 'set', path: [...L0, 'text'], value: 'Changed' }]);
  assert.equal(b.scenes[0].layers[0].text, 'Hello');
});

test('key adds, replaces and sorts', () => {
  let s = applyOps(base(), [{ op: 'key', layer: L0, prop: 'x', t: 0.5, v: 20 }]);
  assert.deepEqual(s.scenes[0].layers[0].keyframes.x.map((k: any) => k.v), [0, 20, 100, 50]);
  s = applyOps(s, [{ op: 'key', layer: L0, prop: 'x', t: 1.01, v: 99 }]);
  assert.equal(s.scenes[0].layers[0].keyframes.x[2].v, 99, 'a key within half a frame is replaced');
});

test('unkey removes and cleans up empty tracks', () => {
  let s = applyOps(base(), [{ op: 'key', layer: ['scenes', 0, 'layers', 1], prop: 'width', t: 1, v: 10 }]);
  s = applyOps(s, [{ op: 'unkey', layer: ['scenes', 0, 'layers', 1], prop: 'width', t: 1 }]);
  assert.equal(s.scenes[0].layers[1].keyframes, undefined);
});

test('retime moves one property key and replaces a key at the destination', () => {
  const s = applyOps(base(), [{ op: 'retime', layer: L0, prop: 'x', t: 1, to: 2 }]);
  const ks = s.scenes[0].layers[0].keyframes.x;
  assert.deepEqual(ks.map((k: any) => [k.t, k.v]), [[0, 0], [2, 100]]);
});

test('retime without prop moves every key at that time', () => {
  let s = applyOps(base(), [{ op: 'key', layer: L0, prop: 'opacity', t: 1, v: 0.5 }]);
  s = applyOps(s, [{ op: 'retime', layer: L0, t: 1, to: 1.5 }]);
  assert.equal(s.scenes[0].layers[0].keyframes.x[1].t, 1.5);
  assert.equal(s.scenes[0].layers[0].keyframes.opacity[0].t, 1.5);
});

test('ease sets, replaces with a bezier and clears', () => {
  let s = applyOps(base(), [{ op: 'ease', layer: L0, prop: 'x', t: 1, ease: [0.2, 0, 0, 1] }]);
  assert.deepEqual(s.scenes[0].layers[0].keyframes.x[1].ease, [0.2, 0, 0, 1]);
  s = applyOps(s, [{ op: 'ease', layer: L0, prop: 'x', t: 2, ease: null }]);
  assert.equal(s.scenes[0].layers[0].keyframes.x[2].ease, undefined);
  assert.throws(() => applyOps(s, [{ op: 'ease', layer: L0, prop: 'x', t: 3, ease: 'linear' }]), /No x keyframe/);
});

test('insert, move and remove layers', () => {
  let s = applyOps(base(), parseOps({ ops: [{ op: 'insert', path: ['scenes', 0, 'layers'], value: { type: 'glow' } }] }));
  assert.equal(s.scenes[0].layers.length, 4);
  assert.equal(s.scenes[0].layers[3].type, 'glow');
  s = applyOps(s, [{ op: 'move', path: ['scenes', 0, 'layers', 3], to: 0 }]);
  assert.equal(s.scenes[0].layers[0].type, 'glow');
  s = applyOps(s, [{ op: 'remove', path: ['scenes', 0, 'layers', 0] }]);
  assert.equal(s.scenes[0].layers.length, 3);
  assert.equal(s.scenes[0].layers[0].id, 'a');
});

test('insert into children of a group', () => {
  const s = applyOps(base(), parseOps({ ops: [{ op: 'insert', path: ['scenes', 0, 'layers', 2, 'children'], index: 0, value: { type: 'glow' } }] }));
  assert.equal(s.scenes[0].layers[2].children[0].type, 'glow');
});

test('a valid spec cannot be made invalid', () => {
  assert.throws(() => applyOps(base(), [{ op: 'set', path: [...L0, 'align'], value: 'sideways' }]), /invalid/);
  assert.throws(() => applyOps(base(), [{ op: 'set', path: [...L0, 'nonsense'], value: 1 }]), /invalid/);
});

test('request validation rejects unsafe or malformed ops', () => {
  const bad = [
    { op: 'set', path: ['__proto__', 'x'], value: 1 },
    { op: 'set', path: ['theme', 'colors'], value: {} },
    { op: 'set', path: [...L0, 'constructor'], value: 1 },
    { op: 'set', path: [...L0, 'a-b'], value: 1 },
    { op: 'key', layer: L0, prop: '__proto__', t: 0, v: 1 },
    { op: 'retime', layer: [...L0, 'x'], t: 0, to: 1 },
    { op: 'insert', path: ['scenes', 0], value: { type: 'text' } },
    { op: 'insert', path: ['scenes', 0, 'layers'], value: 'text' },
    { op: 'move', path: L0, to: -1 },
    { op: 'ease', layer: L0, prop: 'x', t: 0, ease: [1, 2] },
    { op: 'nope' },
  ];
  for (const o of bad) assert.throws(() => parseOps({ ops: [o] }), Error, JSON.stringify(o));
});

test('prototype keys inside values are dropped', () => {
  const value = JSON.parse('{"type":"glow","__proto__":{"polluted":true}}');
  const s = applyOps(base(), parseOps({ ops: [{ op: 'insert', path: ['scenes', 0, 'layers'], value }] }));
  assert.equal(({} as any).polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(s.scenes[0].layers[3], '__proto__'), false);
});

console.log(`\n${passed} tests passed`);
