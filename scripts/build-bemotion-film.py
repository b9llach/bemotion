"""Bemotion, a design-language film: eight short chapters (the point, motion, letterforms, the field, depth,
color, time, the wordmark) told with construction drawings, running heads and exact cuts.

Writes projects/bemotion-film/ad.json and its media. Run from the repo root:
  python scripts/build-bemotion-film.py --assets   # once: fonts and the film-strip tiles
  python scripts/build-bemotion-film.py
"""

import json
import math
import shutil
import subprocess
import sys
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
from genlib import write_spec  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DIR = ROOT / "projects" / "bemotion-film"
MEDIA = DIR / "media"
FONT_SRC = ROOT / "examples" / "media" / "refreshed" / "fonts"
FPS = 30

BLACK = "#000000"
INK = "#1A1A1A"
WHITE = "#FFFFFF"
GRAY = "#9A9A9A"
LINE = "#8A8A8A"
BLUE = "#2A5FE4"
PALETTE = [("Ink", "#0B0B0F"), ("Signal", "#2A5FE4"), ("Sky", "#8FB3FF"), ("Violet", "#7C5CFF"), ("Coral", "#FF7A59"), ("Paper", "#F2F1EC")]
FONT = "Bemotion Sans"
WEIGHTS = [300, 400, 500, 600, 700]

# The mark: a rounded square with a play triangle cut out.
LOGO = "M22 0 H78 A22 22 0 0 1 100 22 V78 A22 22 0 0 1 78 100 H22 A22 22 0 0 1 0 78 V22 A22 22 0 0 1 22 0 Z M39 28 L39 72 L75 50 Z"


def F(f):
    """Frame to seconds (scene-local frames)."""
    return round(f / FPS, 4)


# ---------------------------------------------------------------- fonts and glyphs

_fonts = {}


def font(w):
    if w not in _fonts:
        _fonts[w] = TTFont(str(FONT_SRC / f"Inter-{w}.ttf"))
    return _fonts[w]


def text_width(s, size, w=500, spacing=-0.02):
    f = font(w)
    upm = f["head"].unitsPerEm
    cmap = f.getBestCmap()
    hm = f["hmtx"]
    return sum(hm[cmap[ord(c)]][0] / upm * size + spacing * size for c in s if ord(c) in cmap)


def glyph_path(s, w=600):
    """SVG path data (y down, font units) of a string, and its ink box [x0, y0, x1, y1]."""
    f = font(w)
    gs = f.getGlyphSet()
    cmap = f.getBestCmap()
    hm = f["hmtx"]
    asc = f["hhea"].ascent
    parts, x = [], 0
    box = [1e9, 1e9, -1e9, -1e9]
    for ch in s:
        g = cmap.get(ord(ch))
        if g is None:
            continue
        pen = SVGPathPen(gs)
        gs[g].draw(TransformPen(pen, (1, 0, 0, -1, x, asc)))
        parts.append(pen.getCommands())
        bp = BoundsPen(gs)
        gs[g].draw(bp)
        if bp.bounds:
            x0, y0, x1, y1 = bp.bounds
            box = [min(box[0], x + x0), min(box[1], asc - y1), max(box[2], x + x1), max(box[3], asc - y0)]
        x += hm[g][0]
    return " ".join(parts), box


def glyph_points(ch, w=600):
    """On-curve nodes and off-curve handles of a glyph (font units, y down), with the handle lines."""
    f = font(w)
    gs = f.getGlyphSet()
    rp = RecordingPen()
    gs[f.getBestCmap()[ord(ch)]].draw(rp)
    asc = f["hhea"].ascent
    on, off, links = [], [], []
    last = None
    for op, args in rp.value:
        pts = [(x, asc - y) for x, y in args]
        if op == "moveTo":
            last = pts[0]
            on.append(last)
        elif op == "lineTo":
            last = pts[0]
            on.append(last)
        elif op in ("qCurveTo", "curveTo"):
            ctrl, end = pts[:-1], pts[-1]
            off += ctrl
            if ctrl:
                links.append([last, ctrl[0]])
                links.append([ctrl[-1], end])
            last = end
            on.append(end)
    return on, off, links


def mapper(box, cx, cy, height):
    k = height / (box[3] - box[1])
    mx, my = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    return (lambda x, y: (round(cx + (x - mx) * k, 1), round(cy - (y - my) * k, 1))), k


# ---------------------------------------------------------------- layer helpers


def kf(*pairs, ease=None):
    out = []
    for p in pairs:
        k = {"t": round(p[0], 4), "v": p[1]}
        e = p[2] if len(p) > 2 else ease
        if e:
            k["ease"] = e
        out.append(k)
    return out


def text(s, x=0, y=0, size=48, w=500, color=BLACK, align="center", **kw):
    layer = {"type": "text", "text": s, "font": FONT, "weight": w, "size": size, "color": color, "x": x, "y": y, "letterSpacing": -0.02}
    if align != "center":
        layer["align"] = align
        layer["anchor"] = align
    layer.update(kw)
    return layer


def dot(x, y, d, color=BLACK, **kw):
    layer = {"type": "shape", "shape": "circle", "x": x, "y": y, "width": d, "height": d, "fill": color}
    layer.update(kw)
    return layer


def ring(x, y, d, color=LINE, sw=1.3, **kw):
    layer = {"type": "shape", "shape": "ring", "x": x, "y": y, "width": d, "height": d, "fill": color, "strokeWidth": sw}
    layer.update(kw)
    return layer


def line(points, color=LINE, width=1.3, **kw):
    layer = {"type": "path", "points": [[round(a, 1), round(b, 1)] for a, b in points], "color": color, "width": width, "smooth": False}
    layer.update(kw)
    return layer


def draw_on(layer, at, dur, ease="inOutCubic"):
    layer.setdefault("keyframes", {})["progress"] = kf((at, 0), (at + dur, 1, ease))
    return layer


def win(layer, a=None, b=None):
    if a is not None:
        layer["start"] = round(a, 4)
    if b is not None:
        layer["end"] = round(b, 4)
    return layer


SCRAMBLE = {"preset": "scramble", "duration": 0.2, "stagger": 0.006, "chars": "lower"}


def captions(num, title, items, end):
    """Running heads: chapter number and title on top, a letter and a caption at the bottom, decoding as they change."""
    out = [text(str(num), -882, 456, 11, 700, align="left", end=end), text(title, 0, 456, 11, 700, end=end, animate=SCRAMBLE)]
    for i, (t, letter, cap) in enumerate(items):
        t1 = items[i + 1][0] if i + 1 < len(items) else end
        out.append(text(letter, -882, -457, 11, 700, align="left", start=t, end=t1, animate=SCRAMBLE))
        out.append(text(cap, 0, -457, 11, 700, start=t, end=t1, animate=SCRAMBLE))
    return out


def scene(sid, dur, layers, bg=WHITE, **kw):
    s = {"id": sid, "duration": round(dur, 4), "background": bg, "layers": layers}
    s.update(kw)
    return s


# ---------------------------------------------------------------- 1. the point

def ch_point():
    L = []
    q = "Describe a video."
    size, gap, dd = 46, 14, 30
    t0 = 0.9
    # Typing in bursts.
    times, t = [], t0
    for i, c in enumerate(q):
        if c == " ":
            t += 0.16
            continue
        times.append(round(t, 3))
        t += 0.055 + (0.05 if i % 4 == 3 else 0)
    vis = [i for i, c in enumerate(q) if c != " "]
    adv = [text_width(q[:k], size) for k in range(len(q) + 1)]
    left = lambda k: -(adv[k] + gap + dd) / 2
    dot_x = lambda k: (adv[k] + gap) / 2
    gk, dk = [(0, left(0))], [(0, dot_x(0))]
    for j, i in enumerate(vis):
        tk = times[j]
        gk += [(tk, gk[-1][1]), (tk + 0.07, left(i + 1), "outCubic")]
        dk += [(tk, dk[-1][1]), (tk + 0.07, dot_x(i + 1), "outCubic")]
    erase = 3.5
    dk += [(erase + 0.36, dot_x(len(q))), (erase + 0.7, 0, "inOutCubic")]
    L.append({"type": "group", "end": erase + 0.6, "keyframes": {"x": kf(*gk)}, "children": [
        text(q, 0, 0, size, 500, align="left", animate={"preset": "typewriter", "at": t0, "times": [round(x - t0, 3) for x in times]},
             animateOut={"preset": "typewriter", "at": erase, "stagger": 0.02, "from": "start"})]})
    grow = 4.25
    L.append(dot(0, 0, dd, start=0.2, end=F(147), in_={"preset": "popIn", "duration": 0.35},
                 keyframes={"x": kf(*dk), "width": kf((grow, dd), (grow + 0.25, 360, "outCubic")),
                            "height": kf((grow, dd), (grow + 0.25, 360, "outCubic"))}))
    R = 180
    # Construction states, each held for nine frames.
    a, b, c, d, e = F(136), F(147), F(156), F(165), F(174)
    st = lambda l, s0, s1: win(l, s0, s1)
    for s0 in (b,):
        L.append(st(ring(0, 0, 2 * R, BLACK, 1.2), s0, c))
        for x, y in ((0, R), (R, 0), (0, -R), (-R, 0)):
            L.append(st(ring(x, y, 16, BLACK, 1.2), s0, c))
        for v in (-R * 0.52, R * 0.52):
            L.append(st(line([(v, R), (v, -R)], BLACK, 1.1, dash=[7, 5]), s0, c))
            L.append(st(line([(-R, v), (R, v)], BLACK, 1.1, dash=[7, 5]), s0, c))
        L.append(st(line([(-R, R), (R, -R)], BLACK, 1.1, dash=[7, 5]), s0, c))
        L.append(st(line([(-R, -R), (R, R)], BLACK, 1.1, dash=[7, 5]), s0, c))
    # Concentric rings opening out.
    for k in range(10):
        r = 16 + k * 17
        L.append(st(ring(0, 0, 2 * r, BLACK, 1.1, keyframes={"width": kf((c, 2 * r * 0.7), (d, 2 * r, "outCubic")),
                                                            "height": kf((c, 2 * r * 0.7), (d, 2 * r, "outCubic"))}), c, d))
    # A keyframe dial: 30 frame ticks, numbered every five, and the sweep of one second.
    L.append(st(ring(0, 0, 2 * R, BLACK, 1.2), d, F(190)))
    for k in range(30):
        ang = math.radians(k * 12)
        r0, r1 = (R - 16, R) if k % 5 else (R - 28, R)
        L.append(st(line([(r0 * math.sin(ang), r0 * math.cos(ang)), (r1 * math.sin(ang), r1 * math.cos(ang))], BLACK, 1.1), d, F(190)))
        if k % 5 == 0:
            L.append(st(text(f"{k}f", (R + 26) * math.sin(ang), (R + 26) * math.cos(ang) - 4, 11, 600), d, F(190)))
    L.append(st(ring(0, 0, 2 * (R - 52), BLUE, 3, keyframes={"progress": kf((d, 0), (F(188), 1, "inOutCubic"))}), d, F(190)))
    L.append(st(dot(0, 0, 6), d, F(190)))
    L.append(st({"type": "counter", "from": 0, "to": 30, "at": d, "duration": F(188) - d, "ease": "inOutCubic", "suffix": "f", "font": FONT,
                 "weight": 600, "size": 40, "color": BLACK, "y": -6, "letterSpacing": -0.02}, d, F(190)))
    # The first frame: the dial collapses into a point that settles and drifts.
    pk = kf((F(190), 260), (F(198), 22, "inOutCubic"))
    L.append(st(dot(0, 0, 260, keyframes={"width": pk, "height": pk, "x": kf((F(202), 0), (F(216), -40, "inCubic"))}), F(190), F(216)))
    L += captions(1, "The Point", [(b, "A", "Origin"), (c, "B", "Keyframes"), (d, "C", "Time"), (F(190), "D", "The First Frame")], F(216))
    sounds = [{"sound": "tick", "at": x} for x in (b, c, d, F(190))]
    return scene("point", F(216), L), sounds


# ---------------------------------------------------------------- 2. motion

def curve_points(fn, n=48, w=520, h=520):
    pts = []
    for i in range(n + 1):
        u = i / n
        pts.append((-w / 2 + u * w, -h / 2 + fn(u) * h))
    return pts


def ease_out_expo(u):
    return 1 if u >= 1 else 1 - 2 ** (-10 * u)


def ease_in_out_cubic(u):
    return 4 * u ** 3 if u < 0.5 else 1 - (-2 * u + 2) ** 3 / 2


def spring(u):
    return 1 - math.exp(-6.5 * u) * math.cos(14 * u)


def poly_d(pts, ox=0, oy=0):
    # svg path data is y-down: flip y.
    return "M" + " L".join(f"{x + ox:.1f} {-(y + oy):.1f}" for x, y in pts)


def ch_motion():
    L = []
    W = H = 520
    gx = -260
    # Frame: a hairline square with axis labels.
    L.append(draw_on(line([(gx - W / 2, H / 2), (gx - W / 2, -H / 2), (gx + W / 2, -H / 2)], BLACK, 1.2), 0.1, 0.5))
    L.append(line([(gx - W / 2, H / 2), (gx + W / 2, H / 2), (gx + W / 2, -H / 2)], LINE, 1, dash=[4, 6], start=0.4))
    L.append(text("time", gx + W / 2 - 18, -H / 2 - 22, 11, 600, start=0.5))
    L.append(text("value", gx - W / 2 - 40, H / 2 - 6, 11, 600, start=0.5))
    curves = [("outExpo", ease_out_expo, "outExpo"), ("inOutCubic", ease_in_out_cubic, "inOutCubic"), ("spring", spring, "springBouncy")]
    seg = 2.3
    t0 = 0.6
    ds = [poly_d(curve_points(fn), gx, 0) for _, fn, _ in curves]
    # One stroke that morphs from curve to curve (same point count, so the blend is exact).
    for i in range(len(curves)):
        s0 = t0 + i * seg
        nxt = ds[i + 1] if i + 1 < len(curves) else ds[i]
        lay = {"type": "svg", "d": ds[i], "morphTo": nxt, "fill": "none", "stroke": BLACK, "strokeWidth": 3,
               "viewBox": [-960, -540, 1920, 1080], "width": 1920, "start": s0, "end": s0 + seg,
               "keyframes": {"morph": kf((s0 + seg - 0.45, 0), (s0 + seg, 1, "inOutCubic"))}}
        if i == 0:
            lay["keyframes"]["progress"] = kf((s0, 0), (s0 + 0.7, 1, "inOutCubic"))
        L.append(lay)
    # The motion each curve describes: a dot travelling the curve, and a dot rising on a track beside it.
    tx = 260
    L.append(line([(tx, -H / 2), (tx, H / 2)], LINE, 1, start=0.4))
    for y in (-H / 2, H / 2):
        L.append(line([(tx - 10, y), (tx + 10, y)], LINE, 1, start=0.4))
    for i, (name, fn, ease) in enumerate(curves):
        s0 = t0 + i * seg + 0.55
        L.append(dot(gx - W / 2, -H / 2, 14, start=s0 - 0.05, end=t0 + (i + 1) * seg,
                     motionPath={"points": [[round(x + gx, 1), round(y, 1)] for x, y in curve_points(fn)],
                                 "at": s0, "duration": 1.2, "ease": "linear", "smooth": True}))
        L.append(dot(tx, -H / 2, 28, start=s0 - 0.05, end=t0 + (i + 1) * seg,
                     keyframes={"y": kf((s0, -H / 2), (s0 + 1.2, H / 2, ease))}))
        L.append(text(name, 600, 0, 64, 600, align="left", start=t0 + i * seg, end=t0 + (i + 1) * seg, animate=SCRAMBLE))
        L.append(text(f"{['01', '02', '03'][i]}", 600, 60, 11, 700, align="left", start=t0 + i * seg, end=t0 + (i + 1) * seg))
    end = t0 + 3 * seg
    L += captions(2, "Motion", [(0, "A", "Ease Out"), (t0 + seg, "B", "Ease In Out"), (t0 + 2 * seg, "C", "Spring")], end)
    return scene("motion", end, L), [{"sound": "tick", "at": t0 + i * seg} for i in range(3)]


# ---------------------------------------------------------------- 3. letterforms

def glyph_svg(s, cx, cy, height, w=600, fill=BLACK, stroke=None, sw=1.3, **kw):
    d, box = glyph_path(s, w)
    vb = [box[0], box[1], box[2] - box[0], box[3] - box[1]]
    layer = {"type": "svg", "d": d, "viewBox": vb, "width": round(vb[2] / vb[3] * height, 1), "x": cx, "y": cy, "fill": fill}
    if stroke:
        layer["stroke"] = stroke
        layer["strokeWidth"] = sw
    layer.update(kw)
    return layer


def ch_letterforms():
    L = []
    H = 640
    cx = -220
    # 3a. The b under construction: outline, its nodes and handles, metric lines.
    d, box = glyph_path("b", 600)
    m, k = mapper(box, cx, 0, H)
    on, off, links = glyph_points("b", 600)
    a0, a1 = 0.0, 1.6
    f = font(600)
    asc = f["hhea"].ascent
    for name, v in (("ascender", f["hhea"].ascent), ("x-height", f["OS/2"].sxHeight), ("baseline", 0)):
        _, y = m(0, asc - v)
        L.append(win(draw_on(line([(-860, y), (860, y)], LINE, 1), 0.05, 0.6, "outCubic"), a0, 3.4))
        L.append(win(text(name, 860, y + 12, 11, 600, align="right"), 0.3, 3.4))
    L.append(win(glyph_svg("b", cx, 0, H, 600, fill="none", stroke=BLACK, sw=1.4, keyframes={"progress": kf((0.1, 0), (0.9, 1, "inOutCubic"))}), a0, a1))
    for (x0, y0), (x1, y1) in links:
        p, q = m(x0, y0), m(x1, y1)
        L.append(win(line([p, q], LINE, 1), 0.6, a1))
    for x, y in off:
        px, py = m(x, y)
        L.append(win(ring(px, py, 12, BLACK, 1.1, in_={"preset": "scaleIn", "from": 0.2, "duration": 0.2, "at": 0.65}), 0.6, a1))
    for x, y in on:
        px, py = m(x, y)
        L.append(win(dot(px, py, 12, in_={"preset": "scaleIn", "from": 0.2, "duration": 0.2, "at": 0.55}), 0.5, a1))
    # Filled, then sweeping from light to bold.
    dl, bl = glyph_path("b", 300)
    db, bb = glyph_path("b", 700)
    vb = [min(bl[0], bb[0]) - 20, min(bl[1], bb[1]), max(bl[2], bb[2]) - min(bl[0], bb[0]) + 40, max(bl[3], bb[3]) - min(bl[1], bb[1])]
    width = round(vb[2] / vb[3] * H, 1)
    L.append(win({"type": "svg", "d": dl, "morphTo": db, "viewBox": vb, "width": width, "x": cx, "y": 0, "fill": BLACK,
                  "keyframes": {"morph": kf((a1 + 0.2, 0), (3.2, 1, "inOutCubic"))}}, a1, 3.4))
    L.append(win({"type": "counter", "from": 300, "to": 700, "at": a1 + 0.2, "duration": 3.2 - a1 - 0.2, "ease": "inOutCubic", "separator": False,
                  "font": FONT, "weight": 600, "size": 120, "color": BLACK, "x": 520, "y": 0}, a1, 3.4))
    L.append(win(text("weight", 520, -90, 11, 700), a1, 3.4))
    # 3b. Specimen: the wordmark in five weights.
    s0, s1 = 3.4, 6.0
    names = {300: "Light", 400: "Regular", 500: "Medium", 600: "Semibold", 700: "Bold"}
    for i, w in enumerate(WEIGHTS):
        y = 300 - i * 150
        drift = {"x": kf((s0, -870), (s1, -870 - 24 - i * 6, "linear"))}
        L.append(win(text("Bemotion", -870, y, 150, w, align="left", letterSpacing=-0.035, keyframes=drift), s0 + i * F(3), s1))
        L.append(win(text(names[w], 870, y, 150, w, align="right", letterSpacing=-0.035,
                          keyframes={"x": kf((s0, 870), (s1, 870 + 24 + i * 6, "linear"))}), s0 + i * F(3) + F(2), s1))
    # 3c. Line styles, each named in its own motion.
    s2 = 6.0
    styles = [("push", -460, 210), ("plop", 460, 210), ("depth", -460, 0), ("ripple", 460, 0), ("tipUp", -460, -210), ("focusPull", 460, -210)]
    for i, (st, x, y) in enumerate(styles):
        L.append(win(text(st, x, y, 110, 600, letterSpacing=-0.03, animate={"preset": st, "at": s2 + 0.15 + i * 0.32}), s2, 9.2))
    end = 9.2
    L += captions(3, "Letterforms", [(0, "A", "Construction"), (a1, "B", "Weight"), (s0, "C", "Specimen"), (s2, "D", "Line Styles")], end)
    return scene("letterforms", end, L), [{"sound": "tick", "at": t} for t in (a1, s0, s2)]


# ---------------------------------------------------------------- 4. the field

def logo_inside(x, y):
    """Is (x, y) (logo units 0-100, y down) inside the mark (rounded square minus the triangle)?"""
    r = 22
    cx = min(max(x, r), 100 - r)
    cy = min(max(y, r), 100 - r)
    if (x - cx) ** 2 + (y - cy) ** 2 > r * r or not (0 <= x <= 100 and 0 <= y <= 100):
        return False
    # Triangle (39,28) (39,72) (75,50).
    inside_tri = x >= 39 and abs(y - 50) <= (75 - x) * 22 / 36
    return not inside_tri


def field_tracks():
    """Dots: a grid breathing in a wave, gathering into the mark, then flowing away to the right."""
    cols, rows, pitch = 32, 18, 54
    grid = [((c - (cols - 1) / 2) * pitch, ((rows - 1) / 2 - r) * pitch) for r in range(rows) for c in range(cols)]
    # Targets inside the mark (440 px wide, centered).
    targets = []
    step = 100 / 22
    for j in range(23):
        for i in range(23):
            x, y = i * step, j * step
            if logo_inside(x, y):
                targets.append(((x - 50) * 4.4, (50 - y) * 4.4))
    tracks = []
    seed = 5
    for n, (gx, gy) in enumerate(grid):
        seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
        r = (seed % 1000) / 1000
        keys = []
        tgt = targets[n % len(targets)] if n < len(targets) * 2 else None
        for f in range(0, 241, 2):
            t = f / FPS
            # 0-1.6 s: the grid breathes in a wave from the center.
            dist = math.hypot(gx, gy)
            size = 8 + 10 * (0.5 + 0.5 * math.sin(t * 5 - dist / 120))
            x, y = gx, gy
            if t > 1.6 and tgt is not None:
                u = min(1, max(0, (t - 1.6 - r * 0.4) / 1.0))
                e = u * u * (3 - 2 * u)
                x, y = gx + (tgt[0] - gx) * e, gy + (tgt[1] - gy) * e
                size = size + (13 - size) * e
            elif t > 1.6:
                u = min(1, max(0, (t - 1.6 - r * 0.3) / 0.6))
                size *= 1 - u
            if t > 4.0 and tgt is not None:
                s = (t - 4.0 - (1 - (tgt[0] + 220) / 440) * 0.5 - r * 0.15) * FPS
                if s > 0:
                    x = x + 4 * s + 0.35 * s * s
                    y = y * max(0.15, 1 - s / 30) + 26 * math.sin(s / 7 + r * 6) * min(1, s / 20)
            if size < 0.3:
                continue
            keys.append([f, round(x, 1), round(y, 1), round(size, 2)])
        if keys:
            tracks.append({"keys": keys})
    return tracks


def ch_field():
    (MEDIA / "field.json").write_text(json.dumps(field_tracks()))
    L = [{"type": "dots", "src": "media/field.json", "fps": FPS, "color": BLACK, "fade": 1, "end": 6.0}]
    # Halftone light on a sphere.
    sphere = {"type": "group", "start": 6.0, "raster": {"width": 760, "height": 760}, "children": [
        {"type": "shape", "shape": "circle", "width": 740, "height": 740,
         "fill": {"type": "radial", "from": "#FFFFFF", "to": "#000000", "center": [-0.22, 0.24]},
         "keyframes": {"centerX": kf((6.0, -0.3), (9.0, 0.25, "inOutSine")), "centerY": kf((6.0, 0.3), (9.0, -0.1, "inOutSine"))}}],
        "halftone": {"columns": 46, "color": BLACK, "levels": [0.05, 0.95], "invert": True, "size": 1.0},
        "in": {"preset": "fade", "at": 6.0, "duration": 0.2}}
    L.append(sphere)
    L += captions(4, "The Field", [(0, "A", "Grid"), (1.6, "B", "Formation"), (4.0, "C", "Flow"), (6.0, "D", "Halftone")], 9.0)
    return scene("field", 9.0, L), [{"sound": "tick", "at": t} for t in (1.6, 6.0)] + [{"sound": "whoosh", "at": 4.1, "gain": 0.7}]


# ---------------------------------------------------------------- 5. depth

def ch_depth():
    mark = {"type": "mesh", "geometry": "svg", "d": LOGO, "viewBox": [0, 0, 100, 100], "width": 420, "depth": 96, "bevel": 9,
            "material": "glossy", "color": "#111114", "sideColor": "#C9CCD3", "sideMaterial": "metal",
            "keyframes": {"rotateY": kf((0, -38), (3.6, 32, "inOutSine")), "rotateX": kf((0, 14), (3.6, -8, "inOutSine"))}, "end": 3.6}
    L = [mark]
    # Construction hairlines over the solid.
    for v in (-210, 210):
        L.append(win(draw_on(line([(v, 330), (v, -330)], LINE, 1), 0.3, 0.6), 0, 3.6))
        L.append(win(draw_on(line([(330, v), (-330, v)], LINE, 1), 0.4, 0.6), 0, 3.6))
    L.append(win(text("96", 236, 230, 11, 600), 0.9, 3.6))
    # A lens over a character set.
    rows = ["ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz", "0123456789!?&@#%*+=<>/", "Bemotion Bemotion Bemotion"]
    for i, r in enumerate(rows):
        L.append(win(text(r, 0, 250 - i * 166, 96, 500, justify="all", maxWidth=1720, letterSpacing=0), 3.6, 7.2))
    L.append({"type": "shape", "shape": "circle", "width": 380, "height": 380, "fill": WHITE, "start": 3.6,
              "glass": {"blur": 0, "refract": 90, "profile": "lens", "dispersion": 7, "tint": WHITE, "tintAmount": 0.04, "rim": 0.3},
              "shadow": {"color": BLACK, "blur": 60, "y": -24, "opacity": 0.12},
              "keyframes": {"x": kf((3.6, -620), (7.2, 620, "inOutSine")), "y": kf((3.6, 120), (5.4, -80, "inOutSine"), (7.2, 60, "inOutSine"))}})
    L += captions(5, "Depth", [(0, "A", "Extrusion"), (1.8, "B", "Light"), (3.6, "C", "Refraction")], 7.2)
    return scene("depth", 7.2, L, lighting={"shadows": True, "ground": -330, "shadowOpacity": 0.12, "softness": 18},
                 camera={"moves": [{"preset": "orbit", "angle": 8, "duration": 3.6, "ease": "inOutSine"}]}), [{"sound": "tick", "at": 3.6}]


# ---------------------------------------------------------------- 6. color

def ch_color():
    L = []
    n = len(PALETTE)
    w = 1920 / n
    bars = []
    for i, (name, hexv) in enumerate(PALETTE):
        x = -960 + w * (i + 0.5)
        bars.append({"type": "shape", "x": x, "width": w + 1, "height": 1080, "fill": hexv, "origin": "bottom",
                     "in": {"preset": "growY", "at": i * F(3), "duration": 0.5, "ease": "outExpo"}})
        fg = BLACK if name in ("Sky", "Paper", "Coral") else WHITE
        L.append(win(text(name, x - w / 2 + 24, -400, 22, 600, fg, align="left"), 0.5 + i * F(3), 2.6))
        L.append(win(text(hexv, x - w / 2 + 24, -436, 14, 500, fg, align="left", font="JetBrains Mono", letterSpacing=0), 0.55 + i * F(3), 2.6))
    L.insert(0, win({"type": "group", "children": bars, "keyframes": {"scale": kf((0.5, 1), (2.6, 1.06, "inOutSine"))}}, 0, 2.6))
    # Full-bleed fields, cut every six frames, each with its value.
    t = 2.6
    for name, hexv in PALETTE[1:5] + PALETTE[:1]:
        fg = BLACK if name in ("Sky", "Paper", "Coral") else WHITE
        L.append(win({"type": "shape", "width": 1924, "height": 1084, "fill": hexv}, t, t + F(7)))
        L.append(win(text(hexv.upper(), 0, 0, 260, 600, fg, font="JetBrains Mono", letterSpacing=-0.02), t, t + F(7)))
        t += F(7)
    # Paper: the palette as confetti.
    L.append(win({"type": "confetti", "at": t + 0.1, "count": 160, "colors": [h for _, h in PALETTE[:5]], "power": 1300, "y": -420}, t, t + 3.0))
    L.append(win(text("Color", 0, 0, 220, 600, BLACK, letterSpacing=-0.04, animate={"preset": "lift", "by": "char", "at": t + 0.25}), t, t + 3.0))
    end = t + 3.0
    L += captions(6, "Color", [(0, "A", "Palette"), (2.6, "B", "Fields"), (t, "C", "Celebration")], end)
    return scene("color", end, L), [{"sound": "tick", "at": 2.6 + i * F(7)} for i in range(5)]


# ---------------------------------------------------------------- 7. time

TILE_TIMES = [0.6, 2.4, 6.8, 9.2, 11.6, 14.8, 17.0, 20.4, 22.6, 25.2, 29.0, 31.5, 34.2, 37.0, 40.4, 44.6]


def ch_time():
    L = []
    # A film strip of the film's own frames scrolling under a playhead.
    n = len(TILE_TIMES)
    tw, th, gap = 384, 216, 18
    strip = []
    for i in range(n):
        strip.append({"type": "image", "src": f"media/tiles/t{i:02d}.png", "x": i * (tw + gap), "width": tw, "height": th, "radius": 6,
                      "stroke": "#00000014", "strokeWidth": 1})
    L.append({"type": "group", "y": 60, "children": strip, "keyframes": {"x": kf((0, 300), (5.4, 300 - (n - 4) * (tw + gap), "inOutSine"))}})
    # Ruler and timecode.
    for k in range(97):
        x = -960 + k * 20
        h = 22 if k % 5 == 0 else 10
        L.append(line([(x, -150), (x, -150 - h)], BLACK if k % 5 == 0 else LINE, 1))
    L.append(line([(0, 200), (0, -200)], BLUE, 2))
    L.append(dot(0, 200, 14, BLUE))
    L.append({"type": "counter", "from": 0, "to": 1680, "at": 0, "duration": 5.4, "ease": "inOutSine", "separator": False, "suffix": " f",
              "font": "JetBrains Mono", "size": 30, "weight": 500, "color": BLACK, "y": -250})
    L.append(text("Every frame, rendered.", 0, 330, 64, 600, BLACK, letterSpacing=-0.03, animate={"preset": "auto"}, start=0.5))
    L += captions(7, "Time", [(0, "A", "Timeline"), (1.8, "B", "Frames"), (3.6, "C", "Render")], 5.4)
    return scene("time", 5.4, L), []


# ---------------------------------------------------------------- 8. the wordmark

def ch_wordmark():
    L = []
    H = 150
    d, box = glyph_path("Bemotion", 600)
    vb = [box[0], box[1], box[2] - box[0], box[3] - box[1]]
    width = round(vb[2] / vb[3] * H, 1)
    cx, cy = 90, 0
    common = {"type": "svg", "d": d, "viewBox": vb, "width": width, "x": cx, "y": cy}
    L.append(win({**common, "fill": "none", "stroke": BLACK, "strokeWidth": 1.3, "keyframes": {"progress": kf((0.1, 0), (0.9, 1, "inOutCubic"))}}, 0, 1.4))
    # Nodes along the outline.
    L.append(win({**common, "fill": BLACK}, 1.4, 6.0))
    L.append(win({"type": "svg", "d": LOGO, "viewBox": [0, 0, 100, 100], "width": 132, "x": cx - width / 2 - 110, "y": 0, "fill": BLACK,
                  "in": {"preset": "scaleIn", "from": 0.6, "at": 1.4, "duration": 0.5}}, 1.4, 6.0))
    L.append(win(text("Prompt to motion.", 0, -170, 34, 500, GRAY, animate={"preset": "lift", "by": "word", "at": 2.0}), 1.9, 6.0))
    L.append(win(text("github.com/b9llach/bemotion", 0, -400, 18, 500, BLACK, font="JetBrains Mono", letterSpacing=0,
                      animate={"preset": "typewriter", "at": 2.8, "stagger": 0.025}), 2.7, 6.0))
    # Metric lines while it is drawn.
    for y in (H / 2, -H / 2):
        L.append(win(draw_on(line([(-860, y), (860, y)], LINE, 1), 0.05, 0.6, "outCubic"), 0, 1.4))
    L += captions(8, "Bemotion", [(0, "A", "Wordmark"), (1.4, "B", "Prompt to Motion")], 6.0)
    return scene("wordmark", 6.0, L, camera={"moves": [{"preset": "pushIn", "amount": 70, "at": 1.4, "duration": 4.6, "ease": "inOutSine"}]}), [{"sound": "tick", "at": 1.4}, {"sound": "chime", "at": 1.45, "gain": 0.5}]


# ---------------------------------------------------------------- assembly

CHAPTERS = [ch_point, ch_motion, ch_letterforms, ch_field, ch_depth, ch_color, ch_time, ch_wordmark]


def fix(o):
    if isinstance(o, dict):
        return {("in" if k == "in_" else k): fix(v) for k, v in o.items()}
    if isinstance(o, list):
        return [fix(v) for v in o]
    return o


def build(chapters=CHAPTERS):
    scenes, sounds, t = [], [], 0.0
    for fn in chapters:
        s, snd = fn()
        scenes.append(s)
        sounds += [{**x, "at": round(x["at"] + t, 3)} for x in snd]
        t += s["duration"]
    return fix({
        "title": "Bemotion",
        "fps": FPS, "width": 1920, "height": 1080,
        "theme": {"fonts": {"display": FONT, "body": FONT, "mono": "JetBrains Mono"}},
        "fonts": {FONT: {str(w): f"media/fonts/Inter-{w}.ttf" for w in WEIGHTS}},
        "environment": "softbox",
        "post": {"bloom": False, "grain": 0, "vignette": 0, "chromatic": 0, "tonemap": "none"},
        # A CC0 ambient electronic bed (FreePD); the chapter cuts snap to its beats, the effects sit under it.
        "audio": [{"src": "media/music/ambient-c-motion.mp3", "sync": True, "volume": 0.85, "fadeOut": 2.5}],
        "sfx": {"kit": "studio", "volume": 0.5},
        "sounds": sounds,
        "scenes": scenes,
    })


def assets():
    from PIL import Image
    (MEDIA / "fonts").mkdir(parents=True, exist_ok=True)
    for w in WEIGHTS:
        shutil.copy(FONT_SRC / f"Inter-{w}.ttf", MEDIA / "fonts" / f"Inter-{w}.ttf")
    # Inter is under the SIL Open Font License: its license travels with the files.
    shutil.copy(ROOT / "node_modules" / "@fontsource" / "inter" / "LICENSE", MEDIA / "fonts" / "OFL.txt")
    (MEDIA / "tiles").mkdir(exist_ok=True)
    for i in range(len(TILE_TIMES)):
        Image.new("RGB", (16, 9), "white").save(MEDIA / "tiles" / f"t{i:02d}.png")
    tmp = DIR / "_tiles.json"
    tmp.write_text(json.dumps(build(CHAPTERS[:6])))
    subprocess.run(["node", "bin/bemotion.mjs", "still", str(tmp), "-t", *map(str, TILE_TIMES), "-o", str(DIR / "_t_{t}.png")], cwd=ROOT, check=True)
    for i, t in enumerate(TILE_TIMES):
        p = DIR / f"_t_{t:.2f}.png"
        Image.open(p).convert("RGB").resize((768, 432), Image.LANCZOS).save(MEDIA / "tiles" / f"t{i:02d}.png")
        p.unlink()
    tmp.unlink()
    print("assets ready")


if __name__ == "__main__":
    MEDIA.mkdir(parents=True, exist_ok=True)
    if "--assets" in sys.argv:
        assets()
    write_spec(DIR / "ad.json", build())
