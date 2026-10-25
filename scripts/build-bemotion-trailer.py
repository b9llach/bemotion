"""Bemotion launch trailer: Hype style, near-black with a hot amber-to-pink accent, cut to the music.

Writes projects/bemotion-trailer/ad.json. Run from the repo root:
  python scripts/build-bemotion-trailer.py [--force]

The music (FreePD "Fireworks", CC0, trimmed from 0:43.17) runs at 117 bpm and has a 1.3 s silence
before its drop at 8.2 s. Every scene boundary below is placed on a beat of that track, and the
spec plays with "sync": true, so the engine nudges anything slightly off onto the beat.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from genlib import write_spec  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DIR = ROOT / "projects" / "bemotion-trailer"
FONT = ROOT / "node_modules" / "@fontsource" / "bricolage-grotesque" / "files" / "bricolage-grotesque-latin-800-normal.woff"
FPS = 30
B = 60 / 117  # one beat of the track

BG = "#08070B"
TEXT = "#F6F2EE"
MUTED = "#8E8794"
AMBER = "#FFB020"
ORANGE = "#FF6A2B"
PINK = "#FF2E7E"
HOT = {"colors": [AMBER, ORANGE, PINK], "angle": 90}

DISPLAY_LS = -0.03


# ---------------------------------------------------------------- helpers

def kf(*pairs, ease=None):
    out = []
    for p in pairs:
        k = {"t": round(p[0], 4), "v": p[1]}
        e = p[2] if len(p) > 2 else ease
        if e:
            k["ease"] = e
        out.append(k)
    return out


def text(s, size=150, weight=800, color=TEXT, **kw):
    layer = {"type": "text", "text": s, "size": size, "weight": weight, "color": color, "letterSpacing": DISPLAY_LS}
    layer.update(kw)
    return layer


def mono(s, size=36, color=MUTED, **kw):
    layer = {"type": "text", "text": s, "font": "mono", "size": size, "weight": 500, "color": color, "letterSpacing": 0}
    layer.update(kw)
    return layer


_font = None


def font():
    global _font
    if _font is None:
        from fontTools.ttLib import TTFont
        _font = TTFont(str(FONT))
    return _font


def measure(s, size, ls=DISPLAY_LS):
    """Width in px of a line of Bricolage Grotesque 800 (advances plus tracking)."""
    f = font()
    upm = f["head"].unitsPerEm
    cmap = f.getBestCmap()
    hmtx = f["hmtx"]
    w = sum(hmtx[cmap[ord(c)]][0] for c in s) / upm * size
    return w + ls * size * (len(s) - 1)


def word_path(s, ls=DISPLAY_LS):
    """A line of Bricolage Grotesque 800 as SVG path data (y down) and its viewBox, for extruded 3D type."""
    from fontTools.pens.boundsPen import BoundsPen
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.transformPen import TransformPen
    f = font()
    gs = f.getGlyphSet()
    cmap = f.getBestCmap()
    upm = f["head"].unitsPerEm
    pen = SVGPathPen(gs, ntos=lambda v: f"{v:.1f}")
    bounds = BoundsPen(gs)
    x = 0.0
    for c in s:
        name = cmap[ord(c)]
        if c != " ":
            gs[name].draw(TransformPen(pen, (1, 0, 0, -1, x, 0)))
            gs[name].draw(TransformPen(bounds, (1, 0, 0, -1, x, 0)))
        x += f["hmtx"][name][0] + ls * upm
    x0, y0, x1, y1 = bounds.bounds
    pad = 4
    return pen.getCommands(), [round(x0 - pad, 1), round(y0 - pad, 1), round(x1 - x0 + 2 * pad, 1), round(y1 - y0 + 2 * pad, 1)]


def rnd(seed):
    """Small deterministic generator for layout jitter."""
    state = [seed * 2654435761 % 2147483647 or 1]

    def nxt():
        state[0] = (state[0] * 48271) % 2147483647
        return state[0] / 2147483647
    return nxt


def glow(color=PINK, size=1400, intensity=0.2, **kw):
    layer = {"type": "glow", "color": color, "size": size, "intensity": intensity}
    layer.update(kw)
    return layer


# ---------------------------------------------------------------- timing
# Boundaries in beats; each transition is centred on its boundary.

PLAN = [
    ("hook", 0, None),
    ("describe", 4, {"type": "glitch", "duration": 0.3}),
    ("prompt", 8, {"type": "zoom", "duration": 0.45}),
    ("drop", 16, None),
    ("real3d", 22, {"type": "whip", "duration": 0.35, "direction": "left"}),
    ("blur", 24, None),
    ("kinetic", 26, {"type": "glitch", "duration": 0.25}),
    ("shaders", 28, {"type": "pixelate", "duration": 0.35}),
    ("beat", 30, {"type": "whip", "duration": 0.35, "direction": "right"}),
    ("format", 32, {"type": "split", "duration": 0.4}),
    ("stats", 34, {"type": "flash", "duration": 0.3, "color": AMBER}),
    ("ship", 40, {"type": "zoomOut", "duration": 0.4}),
    ("brand", 46, {"type": "zoom", "duration": 0.5}),
]
END_BEAT = 56


def timeline():
    """Per scene: start (global), duration, and the local time of its boundary beat."""
    rows = []
    for i, (sid, beat, tr) in enumerate(PLAN):
        d = tr["duration"] if tr else 0
        start = beat * B - d / 2
        rows.append({"id": sid, "start": start, "boundary": beat * B, "tr": tr})
    for i, r in enumerate(rows):
        if i + 1 < len(rows):
            nxt = rows[i + 1]
            nd = nxt["tr"]["duration"] if nxt["tr"] else 0
            r["duration"] = nxt["start"] + nd - r["start"]
        else:
            r["duration"] = END_BEAT * B - r["start"]
        r["b0"] = r["boundary"] - r["start"]
    return {r["id"]: r for r in rows}


TL = timeline()


def scene(sid, layers, **kw):
    r = TL[sid]
    s = {"id": sid, "duration": round(r["duration"], 4)}
    if r["tr"]:
        s["transition"] = r["tr"]
    s.update(kw)
    s["layers"] = layers
    return s


def beat(sid, k=0):
    """Local time of beat k after the scene's boundary."""
    return round(TL[sid]["b0"] + k * B, 4)


# ---------------------------------------------------------------- 1. hook: stop keyframing

def diamond_row(y, direction, fall_to, at):
    """A strip of keyframe diamonds scrolling like a timeline, dropping out of frame when the line is struck."""
    rows = {"type": "repeat", "count": 30, "layout": "line", "spacing": 74,
            "children": [{"type": "shape", "width": 20, "height": 20, "radius": 3, "rotate": 45, "fill": "#FFFFFF38"},
                         {"type": "shape", "width": 20, "height": 20, "radius": 3, "rotate": 45, "fill": f"{AMBER}90"},
                         {"type": "shape", "width": 20, "height": 20, "radius": 3, "rotate": 45, "fill": "#FFFFFF38"},
                         {"type": "shape", "width": 20, "height": 20, "radius": 3, "rotate": 45, "fill": "#FFFFFF20"}]}
    line = {"type": "shape", "width": 2400, "height": 2, "fill": "#FFFFFF1A"}
    return {"type": "group", "y": y, "children": [line, rows],
            "in": {"preset": "fade", "duration": 0.3},
            "keyframes": {"x": kf((0, -120 * direction), (2.2, 160 * direction, "linear")),
                          "y": kf((at, y), (at + 0.55, fall_to, "inCubic")),
                          "rotate": kf((at, 0), (at + 0.55, -9 * direction, "inCubic"))}}


def scene_hook():
    size = 170
    line = "Stop keyframing."
    full = measure(line, size)
    word = measure("keyframing.", size)
    strike_at = beat("hook", 2.4)
    # The strike runs across "keyframing." only (the line is centred, so its left edge is at -full/2).
    x_left = -full / 2 + (full - word)
    return scene("hook", [
        {"type": "background", "style": "radial", "colors": ["#1E0A12", BG], "center": [0, 0], "intensity": 1.1},
        {"type": "particles", "count": 700, "motion": "warp", "colors": [AMBER, PINK, "#FFFFFF"], "size": [1.5, 4], "speed": 1.4},
        glow(PINK, 1500, 0.22),
        diamond_row(-330, 1, -900, strike_at),
        diamond_row(330, -1, 900, strike_at),
        text(line, size, animate={"preset": "slam", "by": "word", "at": 0.05, "stagger": B}),
        {"type": "shape", "x": x_left + word / 2, "y": -8, "width": word + 40, "height": 18, "radius": 9, "origin": "left",
         "fill": {"type": "linear", "from": AMBER, "to": PINK, "angle": 90}, "intensity": 1.6,
         "glow": {"color": PINK, "size": 24, "intensity": 0.7},
         "start": strike_at, "in": {"preset": "growX", "at": strike_at, "duration": 0.22, "ease": "outExpo"}},
    ], camera={"moves": [{"preset": "punch", "at": 0.05, "amount": 5},
                         {"preset": "punch", "at": beat("hook", 1), "amount": 6},
                         {"preset": "shake", "at": strike_at, "amount": 16},
                         {"preset": "pushIn", "amount": 140, "duration": TL["hook"]["duration"], "ease": "outCubic"},
                         {"preset": "drift", "amount": 10}]})


# ---------------------------------------------------------------- 2. start describing

def scene_describe():
    at = beat("describe", 0) + 0.02
    return scene("describe", [
        {"type": "background", "style": "rays", "colors": [BG, "#3C1606"], "center": [0, 620], "intensity": 0.8},
        {"type": "particles", "count": 220, "motion": "rise", "colors": [AMBER, ORANGE], "size": [1.5, 3.5], "speed": 0.8},
        glow(AMBER, 1300, 0.16, y=-60),
        text("Start describing.", 150, highlight=[{"text": "describing.", "gradient": HOT}],
             animate={"preset": "scramble", "at": at, "stagger": 0.028, "chars": "lower"}),
        {"type": "shape", "shape": "pill", "x": measure("Start ", 150) / 2, "y": -110,
         "width": measure("describing.", 150), "height": 6, "fill": {"type": "linear", "from": AMBER, "to": PINK, "angle": 90},
         "intensity": 1.4, "start": beat("describe", 2), "in": {"preset": "growX", "at": beat("describe", 2), "duration": 0.35, "ease": "outExpo"}},
    ], camera={"moves": [{"preset": "punch", "at": at, "amount": 4},
                         {"preset": "pushIn", "amount": 240, "duration": TL["describe"]["duration"], "ease": "outCubic"},
                         {"preset": "roll", "angle": -2, "duration": TL["describe"]["duration"]},
                         {"preset": "drift", "amount": 10}]})


# ---------------------------------------------------------------- 3. one prompt (the music drops out)

PROMPT = "A launch trailer. Loud. 25 seconds."


def typing_times(s):
    """A person typing quickly: bursts inside words, short pauses at spaces and stops (deterministic)."""
    times, t = [], 0.0
    r = rnd(11)
    for ch in s:
        if ch == " ":
            t += 0.03 + 0.05 * r()
            continue
        times.append(round(t, 3))
        t += 0.026 + 0.022 * r() + (0.09 if ch == "." else 0)
    return times, t


def scene_prompt():
    sid = "prompt"
    dur = TL[sid]["duration"]
    silence = 6.68 - TL[sid]["start"]  # the track goes quiet here
    press = beat(sid, 7)
    type_at = beat(sid, 1) + 0.1
    times, total = typing_times(PROMPT)
    size = 40
    cw = 0.6 * size  # JetBrains Mono advance
    x0 = -560
    # caret follows the typed characters
    caret_keys = [(type_at - 0.01, x0 + 6)]
    j = 0
    for idx, ch in enumerate(PROMPT):
        if ch == " ":
            continue
        caret_keys.append((type_at + times[j], x0 + (idx + 1) * cw + 6, "outQuad"))
        j += 1
    bar_y = -40
    return scene(sid, [
        {"type": "background", "style": "radial", "colors": ["#160A16", BG], "center": [0, -100], "intensity": 1.0},
        {"type": "grid", "color": f"{PINK}2E", "speed": 70,
         "keyframes": {"opacity": kf((0, 1), (silence - 0.05, 1), (silence + 0.25, 0.15, "outCubic"))}},
        glow(PINK, 1500, 0.2, y=bar_y,
             keyframes={"intensity": kf((0, 0.2), (silence, 0.2), (silence + 0.3, 0.07, "outCubic"), (press, 0.07), (press + 0.25, 0.4, "outExpo"))}),
        text("One prompt.", 120, y=200, animate={"preset": "auto"}, start=beat(sid, 0) + 0.05, end=silence + 0.05, animateOut={"preset": "auto"}),
        {"type": "group", "y": bar_y, "id": "bar",
         "in": {"preset": "growX", "at": beat(sid, 0), "duration": 0.45, "ease": "outExpo"},
         "children": [
             {"type": "shape", "width": 1240, "height": 124, "radius": 62, "fill": "#131017", "stroke": f"{PINK}70", "strokeWidth": 2,
              "glow": {"color": PINK, "size": 30, "intensity": 0.35}},
             mono(PROMPT, size, TEXT, x=x0, align="left", anchor="left",
                  animate={"preset": "typewriter", "at": type_at, "times": times}),
             {"type": "shape", "width": 3, "height": 46, "fill": PINK, "y": 0,
              "keyframes": {"x": kf(*caret_keys)}, "loop": {"preset": "blink", "period": 0.55, "at": type_at + total}},
             {"type": "button", "label": "Render", "icon": "arrow-right", "x": 468, "size": 24, "fill": PINK, "color": "#FFFFFF",
              "press": press, "in": {"preset": "popIn", "at": type_at + total + 0.05}},
         ]},
    ], camera={"moves": [{"preset": "pushIn", "amount": 90, "duration": silence, "ease": "outCubic"},
                         {"preset": "moveTo", "x": 468, "y": bar_y, "zoom": 3.2, "at": press + 0.04, "duration": dur - press - 0.04,
                          "ease": "inExpo"},
                         {"preset": "drift", "amount": 6}]})


# ---------------------------------------------------------------- 4. the drop: every frame, in extruded 3D

def scene_drop():
    sid = "drop"
    dur = TL[sid]["duration"]
    d, vb = word_path("Every frame.")
    return scene(sid, [
        {"type": "background", "style": "rays", "colors": [BG, "#4A0E2C"], "center": [0, 60], "intensity": 1.0},
        {"type": "grid", "color": f"{PINK}40", "speed": 420},
        {"type": "particles", "count": 360, "motion": "burst", "shape": "spark", "colors": [AMBER, PINK, "#FFFFFF"], "size": [2, 5], "speed": 1.6},
        {"type": "particles", "count": 400, "motion": "warp", "colors": [AMBER, "#FFFFFF"], "size": [1.5, 3], "speed": 1.8},
        glow(PINK, 1700, 0.3, y=40),
        {"type": "mesh", "geometry": "svg", "d": d, "viewBox": vb, "width": 1300, "depth": 150, "bevel": 6,
         "material": "glossy", "color": "#FFF1E8", "sideColor": PINK, "sideMaterial": "metal", "y": 0,
         "keyframes": {"z": kf((0, -3200), (0.38, 0, "outExpo")),
                       "rotateX": kf((0, 38), (0.55, 10, "outCubic"), (dur, 4, "inOutSine")),
                       "rotateY": kf((0, -26), (0.55, -10, "outCubic"), (dur, 12, "inOutSine"))}},
        text("Rendered, not keyframed.", 46, 600, MUTED, y=-330, letterSpacing=-0.01, animate={"preset": "auto"}, start=beat(sid, 2)),
        {"type": "flash", "at": 0, "duration": 0.4, "color": "#FFE2C2", "intensity": 1},
    ], camera={"moves": [{"preset": "punch", "at": 0.02, "amount": 8},
                         {"preset": "shake", "at": 0.02, "amount": 22},
                         {"preset": "punch", "at": beat(sid, 2), "amount": 4},
                         {"preset": "punch", "at": beat(sid, 4), "amount": 4},
                         {"preset": "orbit", "angle": 6, "duration": dur, "ease": "inOutSine"},
                         {"preset": "pushIn", "amount": 110, "duration": dur, "ease": "outCubic"},
                         {"preset": "drift", "amount": 10}]},
        post={"bloom": {"strength": 0.7, "threshold": 1.0}})


# ---------------------------------------------------------------- 5. the montage, one feature per two beats

def scene_real3d():
    sid = "real3d"
    t0 = beat(sid)
    return scene(sid, [
        {"type": "background", "style": "radial", "colors": ["#1A0D08", BG], "center": [0.25, 0], "intensity": 1.2},
        {"type": "mesh", "geometry": "torusKnot", "material": "metal", "color": ORANGE, "roughness": 0.3, "size": 470, "x": 430, "z": -320,
         "spin": [30, 80, 0], "in": {"preset": "zoomIn", "at": 0, "duration": 0.5}},
        {"type": "particles", "count": 160, "motion": "drift", "colors": [AMBER], "size": [1.5, 3]},
        text("Real 3D.", 190, x=-820, align="left", anchor="left", highlight=[{"text": "3D.", "gradient": HOT}],
             animate={"preset": "slam", "by": "word", "at": t0, "stagger": 0.14}),
    ], camera={"moves": [{"preset": "orbit", "angle": 16, "duration": TL[sid]["duration"], "ease": "outCubic"},
                         {"preset": "punch", "at": t0, "amount": 5}, {"preset": "drift", "amount": 8}]})


def scene_blur():
    sid = "blur"
    t0 = beat(sid)
    return scene(sid, [
        {"type": "background", "style": "linear", "colors": ["#0C0710", BG, "#140808"], "angle": 90},
        {"type": "particles", "count": 500, "motion": "warp", "shape": "streak", "colors": [PINK, AMBER, "#FFFFFF"], "size": [1.5, 3.5], "speed": 3},
        glow(PINK, 1300, 0.18),
        text("Motion blur.", 190, highlight=[{"text": "blur.", "gradient": HOT}],
             keyframes={"x": kf((t0, 2100), (t0 + 0.24, -30, "outExpo"), (TL[sid]["duration"], 30, "linear")),
                        "scaleX": kf((t0, 1.35), (t0 + 0.3, 1, "outCubic"))}),
    ], camera={"moves": [{"preset": "punch", "at": t0 + 0.2, "amount": 5},
                         {"preset": "pushIn", "amount": 120, "duration": TL[sid]["duration"]}, {"preset": "drift", "amount": 8}]})


def scene_kinetic():
    sid = "kinetic"
    t0 = beat(sid)
    dur = TL[sid]["duration"]
    rows = []
    for i, y in enumerate([390, 195, -195, -390]):
        sgn = 1 if i % 2 else -1
        rows.append(text("TYPE  KINETIC  TYPE  KINETIC  TYPE", 150, color="#00000000", y=y, letterSpacing=0.02,
                         stroke={"color": f"{PINK}48", "width": 2}, dof=False,
                         keyframes={"x": kf((0, -260 * sgn), (dur, 260 * sgn, "linear"))}))
    return scene(sid, [
        {"type": "background", "style": "solid", "colors": [BG]},
        *rows,
        glow(ORANGE, 1200, 0.18),
        text("Kinetic type.", 190, highlight=[{"text": "type.", "gradient": HOT}],
             animate={"preset": "cascade", "at": t0, "stagger": 0.028}),
    ], camera={"moves": [{"preset": "roll", "angle": 4, "duration": dur, "ease": "outCubic"},
                         {"preset": "punch", "at": t0, "amount": 4},
                         {"preset": "pushIn", "amount": 160, "duration": dur}]})


def scene_shaders():
    sid = "shaders"
    t0 = beat(sid)
    dur = TL[sid]["duration"]
    bands = []
    r = rnd(5)
    for i in range(9):
        y = -480 + i * 120
        if abs(y) < 130:
            continue
        sgn = 1 if i % 2 else -1
        bands.append({"type": "shape", "y": y, "width": 2600, "height": 56 + 40 * r(),
                      "fill": (AMBER if i % 3 == 0 else PINK if i % 3 == 1 else ORANGE) + "1A",
                      "keyframes": {"x": kf((0, 900 * sgn), (0.45, 0, "outExpo"), (dur, -80 * sgn, "linear"))}})
    return scene(sid, [
        {"type": "background", "style": "solid", "colors": [BG]},
        *bands,
        text("Shader transitions.", 150, highlight=[{"text": "transitions.", "gradient": HOT}],
             animate={"preset": "glitch", "at": t0, "stagger": 0.012, "duration": 0.25}),
    ], camera={"moves": [{"preset": "punch", "at": t0, "amount": 5},
                         {"preset": "pushIn", "amount": 140, "duration": dur}, {"preset": "drift", "amount": 8}]})


def scene_beat():
    sid = "beat"
    t0 = beat(sid)
    dur = TL[sid]["duration"]
    r = rnd(23)
    bars = []
    n = 38
    pitch = 46
    for i in range(n):
        x = (i - (n - 1) / 2) * pitch
        center = 1 - abs(i - (n - 1) / 2) / ((n - 1) / 2)
        keys = [(0, 0.08)]
        k = 0
        t = t0
        while t < dur + 0.01:
            amp = 0.25 + 0.75 * (0.35 + 0.65 * center) * (0.55 + 0.45 * r())
            keys.append((t, amp, "outExpo"))
            keys.append((min(t + B * 0.9, dur + 0.5), amp * 0.35, "outQuad"))
            k += 1
            t = t0 + k * B / 2
        bars.append({"type": "shape", "x": x, "y": -270, "width": 28, "height": 340, "radius": 6, "origin": "bottom",
                     "fill": {"type": "linear", "from": PINK, "to": AMBER, "angle": 0}, "intensity": 1.15,
                     "keyframes": {"scaleY": kf(*keys)}})
    return scene(sid, [
        {"type": "background", "style": "radial", "colors": ["#1C0712", BG], "center": [0, -0.6], "intensity": 1.3},
        *bars,
        text("On the beat.", 190, y=230, highlight=[{"text": "beat.", "gradient": HOT}],
             animate={"preset": "drop", "by": "word", "at": t0, "stagger": 0.09}),
    ], camera={"moves": [{"preset": "punch", "at": t0, "amount": 5}, {"preset": "punch", "at": t0 + B, "amount": 3},
                         {"preset": "craneUp", "amount": 60, "duration": dur}, {"preset": "drift", "amount": 8}]})


def scene_format():
    sid = "format"
    t0 = beat(sid)
    dur = TL[sid]["duration"]
    a, b2 = t0 + 0.32, t0 + 0.62
    fy = -110
    frame = {"type": "shape", "y": fy, "radius": 22, "fill": "#FFFFFF06", "stroke": AMBER, "strokeWidth": 6,
             "width": 620, "height": 349,
             "keyframes": {"width": kf((0, 620), (a, 620), (a + 0.2, 252, "inOutQuart"), (b2, 252), (b2 + 0.2, 400, "inOutQuart")),
                           "height": kf((0, 349), (a, 349), (a + 0.2, 448, "inOutQuart"), (b2, 448), (b2 + 0.2, 400, "inOutQuart"))}}
    labels = [("16:9", 0, a + 0.05), ("9:16", a + 0.05, b2 + 0.05), ("1:1", b2 + 0.05, dur)]
    return scene(sid, [
        {"type": "background", "style": "radial", "colors": ["#170A10", BG], "center": [0, -0.2], "intensity": 1.1},
        glow(AMBER, 1000, 0.14, y=fy),
        frame,
        *[mono(s, 44, AMBER, y=fy, start=st, end=en) for s, st, en in labels],
        text("Every format.", 150, y=300, highlight=[{"text": "format.", "gradient": HOT}],
             animate={"preset": "tracking", "at": t0, "duration": 0.5}),
    ], camera={"moves": [{"preset": "punch", "at": a + 0.2, "amount": 3}, {"preset": "punch", "at": b2 + 0.2, "amount": 3},
                         {"preset": "pushIn", "amount": 120, "duration": dur}, {"preset": "drift", "amount": 8}]})


# ---------------------------------------------------------------- 6. stats

def scene_stats():
    sid = "stats"
    dur = TL[sid]["duration"]
    w = [beat(sid, 0), beat(sid, 2), beat(sid, 4), dur]
    stats = [(0, 16, "SHADER TRANSITIONS"), (0, 4, "VIDEO FORMATS"), (2400, 0, "KEYFRAMES BY HAND")]
    layers = [
        {"type": "background", "style": "rays", "colors": [BG, "#3A0F22"], "center": [0, 0], "intensity": 0.9},
        {"type": "particles", "count": 240, "motion": "drift", "colors": [AMBER, PINK], "size": [1.5, 3.5]},
        glow(PINK, 1500, 0.22, y=40),
    ]
    moves = [{"preset": "drift", "amount": 10}, {"preset": "pushIn", "amount": 200, "duration": dur, "ease": "outCubic"}]
    for i, (a, b2, label) in enumerate(stats):
        st, en = (0 if i == 0 else w[i]), (w[i + 1] if i < 2 else dur)
        at = w[i]
        layers.append({"type": "counter", "from": a, "to": b2, "at": at, "duration": 0.55 if i < 2 else 0.8, "ease": "outExpo",
                       "size": 360, "weight": 800, "letterSpacing": -0.04, "color": [AMBER, ORANGE, PINK][i], "glow": {"color": PINK, "size": 40, "intensity": 0.45}, "y": 60, "intensity": 1.05,
                       "start": st, "end": en, "in": {"preset": "slam", "at": at, "duration": 0.3}})
        layers.append(mono(label, 40, TEXT, y=-200, letterSpacing=0.28, start=st, end=en,
                           animate={"preset": "scramble", "at": at + 0.06, "stagger": 0.012, "duration": 0.18}))
        moves.append({"preset": "punch", "at": at + 0.05, "amount": 6})
    return scene(sid, layers, camera={"moves": moves})


# ---------------------------------------------------------------- 7. type it, ship it

def scene_ship():
    sid = "ship"
    t0 = beat(sid)
    m = beat(sid, 3)
    dur = TL[sid]["duration"]
    return scene(sid, [
        {"type": "background", "style": "rays", "colors": [BG, "#3D1A05"], "center": [0, 0], "intensity": 0.9},
        {"type": "particles", "count": 300, "motion": "rise", "colors": [AMBER, PINK, "#FFFFFF"], "size": [1.5, 4], "speed": 1.2},
        glow(AMBER, 1500, 0.2,
             keyframes={"intensity": kf((0, 0.15), (m, 0.15), (m + 0.3, 0.32, "outExpo"))}),
        text("Type it.", 220, animate={"preset": "pop", "at": t0, "stagger": 0.04},
             morph=[{"text": "Ship it.", "at": m, "duration": 0.5, "size": 260, "gradient": HOT, "ease": "inOutQuart"}]),
    ], camera={"moves": [{"preset": "punch", "at": t0, "amount": 4},
                         {"preset": "punch", "at": m + 0.3, "amount": 7},
                         {"preset": "shake", "at": m + 0.3, "amount": 12},
                         {"preset": "pushIn", "amount": 260, "duration": dur, "ease": "inQuad"},
                         {"preset": "drift", "amount": 8}]})


# ---------------------------------------------------------------- 8. brand

def scene_brand():
    sid = "brand"
    t0 = beat(sid)
    return scene(sid, [
        {"type": "background", "style": "radial", "colors": ["#1A0A12", BG], "center": [0, 0.1], "intensity": 1.2},
        {"type": "particles", "count": 140, "motion": "drift", "colors": [AMBER, PINK], "size": [1.2, 3]},
        glow(PINK, 1600, 0.16, y=60),
        text("Bemotion", 230, y=80, letterSpacing=-0.045, gradient=HOT, intensity=1.02,
             animate={"preset": "tracking", "at": t0, "duration": 1.0}),
        text("Prompt to motion.", 60, 600, TEXT, y=-80, letterSpacing=-0.02, animate={"preset": "auto"}, start=t0 + 0.9),
        mono("github.com/b9llach/bemotion", 32, AMBER, y=-300,
             animate={"preset": "typewriter", "at": t0 + 1.7, "stagger": 0.022}),
    ], camera={"moves": [{"preset": "punch", "at": t0 + 0.1, "amount": 3},
                         {"preset": "pushIn", "amount": 90, "duration": TL[sid]["duration"], "ease": "outCubic"},
                         {"preset": "drift", "amount": 5}]})


# ---------------------------------------------------------------- assembly

SCENES = [scene_hook, scene_describe, scene_prompt, scene_drop, scene_real3d, scene_blur, scene_kinetic,
          scene_shaders, scene_beat, scene_format, scene_stats, scene_ship, scene_brand]


def video():
    return {
        "title": "Bemotion: trailer",
        "fps": FPS, "width": 1920, "height": 1080,
        "theme": {"colors": {"bg": BG, "text": TEXT, "muted": MUTED, "primary": PINK, "secondary": AMBER, "accent": ORANGE},
                  "fonts": {"display": "Bricolage Grotesque", "body": "Inter", "mono": "JetBrains Mono"}},
        "background": BG,
        "environment": "studio",
        "post": {"bloom": {"strength": 0.85, "threshold": 0.95}, "grain": 0.04, "vignette": 0.35, "chromatic": 1.4},
        "motionBlur": {"samples": 10, "shutter": 0.6},
        "audio": [{"src": "media/music/fireworks.mp3", "sync": True, "volume": 0.55, "fadeOut": 1.5}],
        "sfx": {"kit": "classic", "volume": 0.7},
        "sounds": [{"sound": "impact", "at": round(16 * B, 3), "gain": 0.9}],
        "scenes": [fn() for fn in SCENES],
    }


if __name__ == "__main__":
    write_spec(DIR / "ad.json", video())
