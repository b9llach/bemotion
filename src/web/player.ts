import '@fontsource/manrope/400.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './player.css';
import { Engine } from '../engine/engine';
import { Editor, type Json } from './editor';
import { applyOps, type EditOp } from '../spec/ops';
import { PreviewAudio } from './audio';
import { SoundPanel } from './sound-panel';
import { CommentsPanel } from './comments-panel';
import { attachSafeOverlay } from './safe-overlay';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const params = new URLSearchParams(location.search);
/** Aspect ratio to preview in (?format=9:16), or the design's own. */
const FORMAT = params.get('format') || (params.get('safe') ? '9:16' : undefined);
/** Platform whose interface areas to draw over the canvas (?safe=tiktok, reels or shorts). */
const SAFE = params.get('safe') || undefined;
const SPEC_URL = params.get('spec') ?? '/__bemotion/spec';
const BASE_URL = params.get('base') ?? (params.get('spec') ? new URL('.', new URL(SPEC_URL, location.href)).href : '/__bemotion/assets/');

const store = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem(`bemotion:${k}`);
      return v === null ? d : (JSON.parse(v) as T);
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(`bemotion:${k}`, JSON.stringify(v));
    } catch {
      /* storage unavailable */
    }
  },
};

const state = {
  engine: null as Engine | null,
  /** The spec the preview shows: the file plus edits that are still being saved. */
  spec: null as Json | null,
  /** Edit requests in flight; file-change notifications are ignored until they settle. */
  saving: 0,
  time: store.get('time', 0),
  playing: false,
  rendering: false,
  dirty: true,
  scale: store.get('scale', 0.5),
  mbOnPause: store.get('mb', true),
  loop: store.get('loop', true),
  lastTick: 0,
  building: 0,
  mbTimer: 0 as number | ReturnType<typeof setTimeout>,
  muted: store.get('muted', false),
  /** Set when playback should restart the soundtrack at the current time (a seek, a loop, new audio). */
  resyncAudio: false,
  audioKey: '',
};

const audio = new PreviewAudio(BASE_URL);
// Exposed for scripts/test-sound.ts.
(window as any).__bemotionAudio = audio;
audio.setMuted(state.muted);
audio.onReady = () => {
  state.resyncAudio = true;
  sound?.render();
};

/** Points the soundtrack at the current spec and engine; restarts playback if the tracks changed. */
function syncSound(engine: Engine) {
  if (!state.spec) return;
  const clips = engine.clipSounds();
  audio.update(state.spec, engine.events(), engine.duration, clips, engine.scorePlan());
  const key = JSON.stringify([state.spec.audio ?? null, clips]);
  if (key !== state.audioKey) {
    state.audioKey = key;
    state.resyncAudio = true;
  }
  sound?.render();
}

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function setStatus(kind: 'ok' | 'err' | 'busy', text: string) {
  const el = $('status');
  el.className = `status ${kind}`;
  $('status-text').textContent = text;
}

function showError(msg: string | null) {
  $('error').classList.toggle('hidden', !msg);
  if (msg) $('error-text').textContent = msg;
}

async function fetchSpec(): Promise<Json> {
  const res = await fetch(SPEC_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load spec (${res.status})`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON syntax error: ${(e as Error).message}`);
  }
}

/** Builds a new engine (and canvas) from scratch. */
async function load(given?: Json) {
  const id = ++state.building;
  setStatus('busy', 'Building');
  $('loading').classList.remove('hidden');
  try {
    const spec = given ?? (await fetchSpec());
    state.spec = spec;
    // A fresh canvas per build: a WebGL context cannot be shared between renderers.
    const canvas = document.createElement('canvas');
    const engine = await Engine.create(canvas, spec, { baseUrl: BASE_URL, preview: true, scale: state.scale, format: FORMAT });
    if (id !== state.building) {
      engine.dispose();
      return;
    }
    state.engine?.dispose();
    state.engine = engine;
    editor.attach(engine, canvas);
    const frame = $('frame');
    frame.replaceChildren(canvas);
    if (SAFE) attachSafeOverlay(frame, canvas, SAFE);
    frame.style.setProperty('--aspect', `${engine.width} / ${engine.height}`);
    canvas.style.setProperty('--aspect', `${engine.width} / ${engine.height}`);
    canvas.style.setProperty('--ar', String(engine.width / engine.height));
    state.time = Math.min(state.time, engine.duration);
    buildChrome(engine);
    showError(null);
    setStatus('ok', 'Live');
    state.dirty = true;
  } catch (e) {
    if (id !== state.building) return;
    showError((e as Error).message);
    setStatus('err', 'Error');
    console.error(e);
  } finally {
    if (id === state.building) $('loading').classList.add('hidden');
  }
}

function buildChrome(engine: Engine) {
  syncSound(engine);
  const v = engine.video;
  $('title').textContent = v.title ?? 'Untitled';
  $('meta').innerHTML = `<span><b>${engine.pixelWidth}x${engine.pixelHeight}</b>${FORMAT ? ` ${FORMAT}` : ''}</span><span><b>${engine.fps}</b> fps</span><span><b>${engine.duration.toFixed(2)}</b> s</span><span><b>${v.scenes.length}</b> scenes</span>`;
  $('dur').textContent = fmt(engine.duration);

  const list = $('scene-list');
  list.replaceChildren(
    ...engine.timings.map((tm, i) => {
      const s = v.scenes[i];
      const li = document.createElement('li');
      li.dataset.index = String(i);
      li.innerHTML = `<span class="idx">${String(i + 1).padStart(2, '0')}</span><span class="name"></span><span class="dur">${tm.duration.toFixed(1)}s</span>`;
      li.querySelector('.name')!.textContent = s.id ?? `Scene ${i + 1}`;
      if (s.transition && i > 0 && s.transition.type !== 'cut') {
        const tr = document.createElement('span');
        tr.className = 'tr';
        tr.textContent = `in: ${s.transition.type}${s.transition.direction ? ` ${s.transition.direction}` : ''}, ${tm.transitionIn.toFixed(2)}s`;
        li.appendChild(tr);
      }
      li.onclick = () => seek(tm.start + (tm.transitionIn || 0));
      return li;
    }),
  );

  const tracks = $('tracks');
  const d = engine.duration;
  const pct = (t: number) => `${(t / d) * 100}%`;
  const nodes: HTMLElement[] = [];
  engine.timings.forEach((tm, i) => {
    const clip = document.createElement('div');
    clip.className = 'clip';
    clip.dataset.index = String(i);
    clip.style.left = pct(tm.start);
    const next = engine.timings[i + 1];
    clip.style.width = `calc(${pct((next ? next.start : tm.end) - tm.start)} - 3px)`;
    const name = document.createElement('div');
    name.className = 'clip-name';
    name.textContent = v.scenes[i].id ?? `Scene ${i + 1}`;
    const sub = document.createElement('div');
    sub.className = 'clip-sub';
    sub.textContent = `${tm.start.toFixed(2)}s, ${v.scenes[i].layers.length} layers`;
    clip.append(name, sub);
    nodes.push(clip);
    if (tm.transitionIn > 0) {
      const x = document.createElement('div');
      x.className = 'xfade';
      x.style.left = pct(tm.start);
      x.style.width = pct(tm.transitionIn);
      nodes.push(x);
    }
  });
  tracks.replaceChildren(...nodes);

  const ruler = $('ruler');
  const step = d > 60 ? 10 : d > 20 ? 5 : d > 8 ? 2 : 1;
  const ticks: HTMLElement[] = [];
  for (let t = 0; t <= d + 1e-6; t += step / 2) {
    const s = document.createElement('span');
    s.style.left = pct(t);
    const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    if (major) s.textContent = `${Math.round(t)}s`;
    else s.className = 'minor';
    ticks.push(s);
  }
  ruler.replaceChildren(...ticks);
  comments.render();
}

function updateChrome() {
  const e = state.engine;
  if (!e) return;
  $('tc').textContent = fmt(state.time);
  $('frame-no').textContent = `f ${Math.round(state.time * e.fps)}`;
  $('playhead').style.left = `${(state.time / e.duration) * 100}%`;
  editor.refreshInspector();
  const idx = e.sceneIndexAt(state.time);
  document.querySelectorAll<HTMLElement>('#scene-list li, #tracks .clip').forEach((el) => el.classList.toggle('active', Number(el.dataset.index) === idx));
  document.querySelector('.app')!.classList.toggle('playing', state.playing);
}

function seek(t: number) {
  const e = state.engine;
  if (!e) return;
  state.time = Math.min(Math.max(0, t), e.duration);
  state.dirty = true;
  state.resyncAudio = true;
  store.set('time', state.time);
}

function togglePlay(force?: boolean) {
  const e = state.engine;
  if (!e) return;
  state.playing = force ?? !state.playing;
  if (state.playing && state.time >= e.duration - 1e-3) state.time = 0;
  state.lastTick = performance.now();
  state.dirty = true;
}

// Spec changes are applied one at a time; when several arrive during a rebuild only the latest is shown.
let wanted: Json | null = null;
let applying = false;

function show(spec: Json) {
  wanted = spec;
  if (!applying) void drain();
}

async function drain() {
  applying = true;
  try {
    while (wanted) {
      const next = wanted;
      wanted = null;
      await applySpec(next);
    }
  } finally {
    applying = false;
  }
}

/** Updates the running engine in place (only changed scenes rebuild); falls back to a full load. */
async function applySpec(spec: Json) {
  const e = state.engine;
  if (!e) return load(spec);
  try {
    const t0 = performance.now();
    const result = await e.patch(spec);
    if (result === 'reload') return load(spec);
    // Visible in the browser's performance panel (and used by the editor test).
    performance.measure(`bemotion:${result}`, { start: t0 });
    if (state.engine !== e) return;
    buildChrome(e);
    editor.onSpecChanged();
    showError(null);
    state.dirty = true;
  } catch (err) {
    showError((err as Error).message);
    setStatus('err', 'Error');
  }
}

const firstLine = (m: string) => m.split('\n').slice(0, 2).join(' ');

/** Applies editor ops: preview first, then save. Returns false (and restores the file state) on failure. */
async function edit(ops: EditOp[]): Promise<boolean> {
  if (!state.spec) return false;
  let next: Json;
  try {
    next = applyOps(state.spec, ops);
  } catch (err) {
    setStatus('err', firstLine((err as Error).message));
    show(state.spec);
    return false;
  }
  state.spec = next;
  show(next);
  state.saving++;
  setStatus('busy', 'Saving');
  try {
    const res = await fetch('/__bemotion/edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ops }) });
    const j = (await res.json()) as { ok: boolean; error?: string; spec?: string };
    if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
    state.saving--;
    setStatus('ok', 'Saved');
    if (state.saving === 0 && j.spec) adopt(j.spec);
    return true;
  } catch (err) {
    state.saving--;
    setStatus('err', firstLine((err as Error).message));
    await resync();
    return false;
  }
}

/** Shows `ops` on top of the saved spec without saving them. */
function preview(ops: EditOp[] | null) {
  if (!state.spec) return;
  if (!ops) return show(state.spec);
  try {
    show(applyOps(state.spec, ops));
  } catch {
    /* an invalid intermediate value is simply not previewed */
  }
}

/** Switches to the file's content when it differs from what the preview shows. */
function adopt(text: string) {
  let spec: Json;
  try {
    spec = JSON.parse(text);
  } catch (err) {
    showError(`JSON syntax error: ${(err as Error).message}`);
    setStatus('err', 'Error');
    return;
  }
  if (state.spec && JSON.stringify(spec) === JSON.stringify(state.spec)) return;
  state.spec = spec;
  show(spec);
}

async function resync() {
  try {
    const res = await fetch(SPEC_URL, { cache: 'no-store' });
    adopt(await res.text());
  } catch (err) {
    setStatus('err', (err as Error).message);
  }
}

async function history(kind: 'undo' | 'redo') {
  setStatus('busy', kind === 'undo' ? 'Undoing' : 'Redoing');
  try {
    const res = await fetch(`/__bemotion/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const j = (await res.json()) as { ok: boolean; spec?: string | null; error?: string };
    if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
    if (j.spec) {
      adopt(j.spec);
      setStatus('ok', kind === 'undo' ? 'Undone' : 'Redone');
    } else setStatus('ok', kind === 'undo' ? 'Nothing to undo' : 'Nothing to redo');
  } catch (err) {
    setStatus('err', firstLine((err as Error).message));
  }
}

async function renderNow(motionBlur = false) {
  const e = state.engine;
  if (!e || state.rendering) return;
  state.rendering = true;
  try {
    await e.renderFrame(state.time, { motionBlur });
  } catch (err) {
    showError((err as Error).message);
    state.playing = false;
  } finally {
    state.rendering = false;
  }
}

function tick(now: number) {
  requestAnimationFrame(tick);
  const e = state.engine;
  if (!e) return;
  if (state.playing) {
    const dt = Math.min(0.1, (now - state.lastTick) / 1000);
    state.lastTick = now;
    // The audio clock leads while sound plays, so picture and sound never drift apart.
    const heard = audio.now();
    state.time = heard !== null && !state.resyncAudio ? heard : state.time + dt;
    if (state.time >= e.duration) {
      if (state.loop) {
        state.time = 0;
        state.resyncAudio = true;
      } else {
        state.time = e.duration;
        state.playing = false;
      }
    }
    if (!audio.playing || state.resyncAudio) {
      state.resyncAudio = false;
      audio.start(state.time);
    }
    state.dirty = true;
  } else if (audio.playing) {
    audio.stop();
  }
  if (state.dirty && !state.rendering) {
    state.dirty = false;
    clearTimeout(state.mbTimer);
    void renderNow(false).then(() => {
      // When paused, refine the frame with motion blur so stills match the final render.
      if (!state.playing && state.mbOnPause && !editor.enabled) {
        state.mbTimer = setTimeout(() => {
          if (!state.playing && !state.dirty) void renderNow(true);
        }, 180);
      }
    });
  }
  updateChrome();
}

function bindTimeline() {
  const tl = $('timeline');
  const toTime = (ev: PointerEvent) => {
    const r = tl.getBoundingClientRect();
    return ((ev.clientX - r.left) / r.width) * (state.engine?.duration ?? 0);
  };
  let dragging = false;
  let wasPlaying = false;
  tl.addEventListener('pointerdown', (ev) => {
    dragging = true;
    wasPlaying = state.playing;
    state.playing = false;
    tl.setPointerCapture(ev.pointerId);
    seek(toTime(ev));
  });
  tl.addEventListener('pointermove', (ev) => dragging && seek(toTime(ev)));
  tl.addEventListener('pointerup', () => {
    dragging = false;
    if (wasPlaying) togglePlay(true);
  });
}

function jumpScene(dir: number) {
  const e = state.engine;
  if (!e) return;
  const idx = e.sceneIndexAt(state.time);
  const target = e.timings[Math.min(e.timings.length - 1, Math.max(0, idx + dir))];
  seek(target.start + target.transitionIn);
}

function bindControls() {
  $('play').onclick = () => togglePlay();
  const syncMute = () => {
    $('mute').classList.toggle('off', state.muted);
    $('mute').title = state.muted ? 'Unmute (M)' : 'Mute (M)';
  };
  $('mute').onclick = () => {
    state.muted = !state.muted;
    store.set('muted', state.muted);
    audio.setMuted(state.muted);
    syncMute();
  };
  syncMute();
  $('prev').onclick = () => jumpScene(-1);
  $('next').onclick = () => jumpScene(1);
  // Formats reload the preview with ?format= (the same spec, framed for that aspect ratio).
  document.querySelectorAll<HTMLButtonElement>('#format button').forEach((b) => {
    b.classList.toggle('on', (b.dataset.format ?? '') === (FORMAT ?? ''));
    b.onclick = () => {
      const u = new URL(location.href);
      if (b.dataset.format) u.searchParams.set('format', b.dataset.format);
      else u.searchParams.delete('format');
      // Safe zones are for vertical video: leaving 9:16 hides them.
      if (b.dataset.format !== '9:16') u.searchParams.delete('safe');
      if (u.href !== location.href) location.href = u.href;
    };
  });
  const scaleBtns = document.querySelectorAll<HTMLButtonElement>('#scale button');
  const syncScale = () => scaleBtns.forEach((b) => b.classList.toggle('on', Number(b.dataset.scale) === state.scale));
  scaleBtns.forEach((b) => {
    b.onclick = () => {
      state.scale = Number(b.dataset.scale);
      store.set('scale', state.scale);
      state.engine?.setScale(state.scale);
      state.dirty = true;
      syncScale();
    };
  });
  syncScale();
  const mb = $<HTMLInputElement>('mb');
  mb.checked = state.mbOnPause;
  mb.onchange = () => {
    state.mbOnPause = mb.checked;
    store.set('mb', mb.checked);
    state.dirty = true;
  };
  const loop = $<HTMLInputElement>('loop');
  loop.checked = state.loop;
  loop.onchange = () => {
    state.loop = loop.checked;
    store.set('loop', loop.checked);
  };
  window.addEventListener('keydown', (ev) => {
    const tag = (ev.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (editor.handleKey(ev)) {
      ev.preventDefault();
      return;
    }
    const e = state.engine;
    if (!e) return;
    const frame = 1 / e.fps;
    switch (ev.key) {
      case ' ':
        ev.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        ev.preventDefault();
        state.playing = false;
        seek(state.time - (ev.shiftKey ? 1 : frame));
        break;
      case 'ArrowRight':
        ev.preventDefault();
        state.playing = false;
        seek(state.time + (ev.shiftKey ? 1 : frame));
        break;
      case 'ArrowUp':
        ev.preventDefault();
        jumpScene(-1);
        break;
      case 'ArrowDown':
        ev.preventDefault();
        jumpScene(1);
        break;
      case 'Home':
        seek(0);
        break;
      case 'End':
        seek(e.duration);
        break;
      case 'm':
      case 'M':
        $('mute').click();
        break;
      case 'c':
      case 'C':
        if (ev.ctrlKey || ev.metaKey) break;
        ev.preventDefault();
        state.playing = false;
        comments.focus();
        break;
    }
  });
}

const editor = new Editor({
  engine: () => state.engine,
  canvas: () => document.querySelector('#frame canvas'),
  spec: () => state.spec,
  edit,
  preview,
  undo: () => void history('undo'),
  redo: () => void history('redo'),
  time: () => state.time,
  seek: (t) => {
    state.playing = false;
    seek(t);
  },
  requestRender: () => {
    state.dirty = true;
  },
  setStatus,
});
const comments = new CommentsPanel({
  time: () => state.time,
  duration: () => state.engine?.duration ?? null,
  seek: (t) => {
    state.playing = false;
    seek(t);
  },
  where: (t) => {
    const e = state.engine;
    if (!e || !state.spec) return null;
    const i = e.sceneIndexAt(t);
    const tm = e.timings[i];
    if (!tm) return null;
    return { scene: (state.spec as any).scenes?.[i]?.id ?? `scene ${i + 1}`, sceneTime: Math.max(0, t - tm.start) };
  },
  selection: () => {
    const path = editor.selectedPath;
    if (!path) return null;
    const raw = editor.raw(path) as Record<string, unknown> | undefined;
    const name = raw ? String(raw.id ?? (typeof raw.text === 'string' ? `${raw.type} "${String(raw.text).slice(0, 30)}"` : raw.type)) : 'layer';
    return { path: path as (string | number)[], name };
  },
  toast: setStatus,
});
const sound: SoundPanel = new SoundPanel({ spec: () => state.spec, edit, audio, toast: setStatus, addLayer: (v) => editor.addLayer(v) });
$('edit-toggle').onclick = () => editor.setEnabled(!editor.enabled);
$('autokey').onclick = () => editor.setAutoKey(!editor.autoKey);
document.querySelectorAll<HTMLButtonElement>('#edit-mode button').forEach((b) => {
  b.onclick = () => editor.setMode(b.dataset.mode as 'translate' | 'rotate' | 'scale');
});

bindControls();
bindTimeline();
requestAnimationFrame(tick);
void load();

if (import.meta.hot) {
  // The file changed on disk (an editor save, an undo, or the user's own editor): update in place.
  import.meta.hot.on('bemotion:spec-changed', (data: { asset?: boolean }) => {
    if (data?.asset) return void load();
    if (state.saving > 0) return;
    void resync();
  });
}
