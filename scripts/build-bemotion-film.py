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
    R = 180
    # Construction states. Each one grows out of the last: nothing pops.
    b, c, d, z = F(147), F(165), F(183), F(214)
    fade = lambda s: {"preset": "fade", "duration": s}
    # The point swells into a disc, then hollows into the construction circle.
    L.append(dot(0, 0, dd, start=0.2, end=b + 0.3, in_={"preset": "popIn", "duration": 0.35},
                 keyframes={"x": kf(*dk), "width": kf((grow, dd), (grow + 0.45, 2 * R, "inOutCubic")),
                            "height": kf((grow, dd), (grow + 0.45, 2 * R, "inOutCubic")),
                            "opacity": kf((b - 0.1, 1), (b + 0.3, 0, "inOutSine"))}))
    big = win(ring(0, 0, 2 * R, BLACK, 1.2), b - 0.1, z)
    L.append(big)
    cons = []
    for x, y in ((0, R), (R, 0), (0, -R), (-R, 0)):
        cons.append(ring(x, y, 16, BLACK, 1.2, in_={"preset": "popIn", "at": b + 0.05, "duration": 0.3}))
    for i, v in enumerate((-R * 0.52, R * 0.52)):
        cons.append(draw_on(line([(v, R), (v, -R)], BLACK, 1.1, dash=[7, 5]), b + 0.05 * i, 0.35, "outCubic"))
        cons.append(draw_on(line([(-R, v), (R, v)], BLACK, 1.1, dash=[7, 5]), b + 0.1 + 0.05 * i, 0.35, "outCubic"))
    cons.append(draw_on(line([(-R, R), (R, -R)], BLACK, 1.1, dash=[7, 5]), b + 0.15, 0.4, "outCubic"))
    cons.append(draw_on(line([(-R, -R), (R, R)], BLACK, 1.1, dash=[7, 5]), b + 0.2, 0.4, "outCubic"))
    L.append(win({"type": "group", "children": cons, "out": {"preset": "scaleIn", "from": 0.7, "duration": 0.3}}, b, c + 0.15))
    # Concentric rings open out of the center as the guides fold away.
    for k in range(10):
        r = 16 + k * 17
        at = c - 0.1 + k * 0.025
        L.append(win(ring(0, 0, 2 * r, BLACK, 1.1, keyframes={"width": kf((at, 0), (at + 0.45, 2 * r, "outCubic")),
                                                             "height": kf((at, 0), (at + 0.45, 2 * r, "outCubic"))},
                          out={"preset": "fade", "duration": 0.3}), at, d + 0.25))
    # A keyframe dial: 30 frame ticks drawn round the circle, the sweep of one second. It condenses into the first frame.
    dial = []
    for k in range(30):
        ang = math.radians(k * 12)
        r0, r1 = (R - 16, R) if k % 5 else (R - 28, R)
        tk = d + k * 0.012
        dial.append(line([(r1 * math.sin(ang), r1 * math.cos(ang)), (r0 * math.sin(ang), r0 * math.cos(ang))], BLACK, 1.1,
                         keyframes={"progress": kf((tk, 0), (tk + 0.18, 1, "outCubic"))}))
        if k % 5 == 0:
            dial.append(text(f"{k}f", (R + 26) * math.sin(ang), (R + 26) * math.cos(ang) - 4, 11, 600, in_={**fade(0.25), "at": tk}))
    dial.append(ring(0, 0, 2 * (R - 52), BLUE, 3, keyframes={"progress": kf((d, 0), (z - 0.1, 1, "inOutCubic"))}))
    dial.append(dot(0, 0, 6))
    dial.append({"type": "counter", "from": 0, "to": 30, "at": d, "duration": z - 0.1 - d, "ease": "inOutCubic", "suffix": "f", "font": FONT,
                 "weight": 600, "size": 40, "color": BLACK, "y": -6, "letterSpacing": -0.02})
    sk = kf((z - 0.05, 1), (z + 0.4, 0.06, "inOutCubic"))
    L.append(win({"type": "group", "children": dial, "keyframes": {"scale": sk, "opacity": kf((z + 0.1, 1), (z + 0.35, 0))}}, d, z + 0.4))
    big["end"] = z + 0.4
    big["keyframes"] = {"scale": sk, "opacity": kf((z + 0.1, 1), (z + 0.35, 0))}
    # The first frame: a solid point that settles, then drifts off toward the next chapter.
    pk = kf((z - 0.05, 2 * R), (z + 0.4, 22, "inOutCubic"))
    end = z + 1.0
    L.append(win(dot(0, 0, 2 * R, keyframes={"width": pk, "height": pk, "opacity": kf((z, 0), (z + 0.25, 1)),
                                              "x": kf((z + 0.5, 0), (end, -40, "inOutSine"))}, share="point"), z, end))
    L += captions(1, "The Point", [(b, "A", "Origin"), (c, "B", "Keyframes"), (d, "C", "Time"), (z, "D", "The First Frame")], end)
    sounds = [{"sound": "tick", "at": x} for x in (b, c, d, z)]
    return scene("point", end, L), sounds


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


def sliver_d(pts, ox=0, oy=0):
    """A curve traced out and back as a hairline-thin closed loop: strokes like the open curve, and morphs into any
    closed outline without a closing edge."""
    back = [(x + 0.4, y - 0.4) for x, y in reversed(pts)]
    return poly_d(pts + back, ox, oy) + " Z"


def glyph_frame_d(s, w, cx, cy, height, ref=None):
    """A string's outline as SVG path data in frame coordinates (viewBox FRAME_VB, y down), centered on (cx, cy).
    With ref (another weight), it is placed and scaled exactly as that weight would be, so weights line up."""
    _, box = glyph_path(s, ref or w)
    f = font(w)
    gs = f.getGlyphSet()
    cmap = f.getBestCmap()
    hm = f["hmtx"]
    asc = f["hhea"].ascent
    k = height / (box[3] - box[1])
    mx, my = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    parts, x = [], 0
    for ch in s:
        g = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        gs[g].draw(TransformPen(pen, (k, 0, 0, -k, cx + (x - mx) * k, (asc - my) * k - cy)))
        parts.append(pen.getCommands())
        x += hm[g][0]
    return " ".join(parts)


FRAME_VB = [-960, -540, 1920, 1080]
B_CX, B_H = -220, 640


def ch_motion():
    L = []
    W = H = 520
    gx = -260
    seg = 2.3
    t0 = 0.6
    end = t0 + 3 * seg + 0.9
    leave = end - 1.0
    gone = {"preset": "fade", "duration": 0.45}
    # The point arrives from the first chapter and becomes the curve's first dot.
    L.append(win(dot(gx - W / 2, -H / 2, 14, share="point"), 0, t0 + 0.5))
    # Frame: a hairline square with axis labels.
    L.append(win(draw_on(line([(gx - W / 2, H / 2), (gx - W / 2, -H / 2), (gx + W / 2, -H / 2)], BLACK, 1.2), 0.1, 0.5), None, leave, ) | {"out": gone})
    L.append(win(draw_on(line([(gx - W / 2, H / 2), (gx + W / 2, H / 2), (gx + W / 2, -H / 2)], LINE, 1, dash=[4, 6]), 0.3, 0.6), 0.3, leave) | {"out": gone})
    L.append(win(text("time", gx + W / 2 - 18, -H / 2 - 22, 11, 600, in_={"preset": "fade", "duration": 0.3}), 0.5, leave) | {"out": gone})
    L.append(win(text("value", gx - W / 2 - 40, H / 2 - 6, 11, 600, in_={"preset": "fade", "duration": 0.3}), 0.5, leave) | {"out": gone})
    curves = [("outExpo", ease_out_expo, "outExpo"), ("inOutCubic", ease_in_out_cubic, "inOutCubic"), ("spring", spring, "springBouncy")]
    ds = [sliver_d(curve_points(fn), gx, 0) for _, fn, _ in curves]
    # One stroke that morphs from curve to curve (same point count, so the blend is exact), and at the end folds itself
    # into the outline of the b that opens the next chapter, exactly where that chapter draws it.
    b_d = glyph_frame_d("b", 600, B_CX, 0, B_H)
    for i in range(len(curves)):
        s0 = t0 + i * seg
        last = i + 1 == len(curves)
        lay = {"type": "svg", "d": ds[i], "morphTo": ds[i + 1] if not last else b_d, "fill": "none", "stroke": BLACK, "strokeWidth": 3,
               "viewBox": FRAME_VB, "width": 1920, "start": s0, "end": s0 + seg if not last else end,
               "keyframes": {"morph": kf((s0 + seg - 0.55, 0), (s0 + seg, 1, "inOutCubic"))}}
        if last:
            lay["keyframes"] = {"morph": kf((leave - 0.1, 0), (end - 0.05, 1, "inOutCubic")),
                                "strokeWidth": kf((leave, 3), (end - 0.05, 1.4, "inOutCubic"))}
        if i == 0:
            lay["keyframes"]["progress"] = kf((s0, 0), (s0 + 1.4, 1, "linear"))
        L.append(lay)
    # The motion each curve describes: a dot travelling the curve, and a dot riding a track beside it that eases back
    # down for the next curve.
    tx = 260
    L.append(win(draw_on(line([(tx, -H / 2), (tx, H / 2)], LINE, 1), 0.4, 0.5), 0.4, leave) | {"out": gone})
    for y in (-H / 2, H / 2):
        L.append(win(line([(tx - 10, y), (tx + 10, y)], LINE, 1, in_={"preset": "growX", "duration": 0.3}), 0.6, leave) | {"out": gone})
    ty = [(0, -H / 2)]
    for i, (name, fn, ease) in enumerate(curves):
        s0 = t0 + i * seg + 0.55
        L.append(dot(gx - W / 2, -H / 2, 14, start=s0 - 0.05 if i else t0 + 0.5, end=s0 + 1.55,
                     motionPath={"points": [[round(x + gx, 1), round(y, 1)] for x, y in curve_points(fn)],
                                 "at": s0, "duration": 1.2, "ease": "linear", "smooth": True},
                     **({"in": {"preset": "scaleIn", "from": 0, "duration": 0.3, "ease": "outBack"}} if i else {}),
                     out={"preset": "scaleIn", "from": 0, "duration": 0.3}))
        ty += [(s0, -H / 2), (s0 + 1.2, H / 2, ease)]
        if i + 1 < len(curves):
            ty += [(s0 + 1.55, H / 2), (s0 + seg - 0.1, -H / 2, "inOutCubic")]
        L.append(text(name, 600, 0, 64, 600, align="left", start=t0 + i * seg, end=t0 + (i + 1) * seg if i < 2 else leave + 0.4, animate=SCRAMBLE,
                      **({"animateOut": {"preset": "riseOut", "duration": 0.4}} if i == 2 else {})))
        L.append(text(f"{['01', '02', '03'][i]}", 600, 60, 11, 700, align="left", start=t0 + i * seg, end=t0 + (i + 1) * seg if i < 2 else leave,
                      animate=SCRAMBLE))
    L.append(win(dot(tx, -H / 2, 28, keyframes={"y": kf(*ty)}, in_={"preset": "popIn", "at": 0.6, "duration": 0.4},
                     out={"preset": "scaleIn", "from": 0, "duration": 0.35}), 0.6, leave + 0.2))
    L += captions(2, "Motion", [(0, "A", "Ease Out"), (t0 + seg, "B", "Ease In Out"), (t0 + 2 * seg, "C", "Spring")], end)
    return scene("motion", end, L, transition={"type": "fade", "duration": 0.8}), [{"sound": "tick", "at": t0 + i * seg} for i in range(3)]


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
    H = B_H
    cx = B_CX
    # 3a. The b under construction: outline (already there, folded from the last curve), its nodes and handles, metric lines.
    d, box = glyph_path("b", 600)
    m, k = mapper(box, cx, 0, H)
    on, off, links = glyph_points("b", 600)
    a0, a1 = 0.0, 1.8
    s0, s1 = 3.6, 6.2
    f = font(600)
    asc = f["hhea"].ascent
    for i, (name, v) in enumerate((("ascender", f["hhea"].ascent), ("x-height", f["OS/2"].sxHeight), ("baseline", 0))):
        _, y = m(0, asc - v)
        L.append(win(draw_on(line([(-860, y), (860, y)], LINE, 1), 0.05 + i * 0.08, 0.7, "outCubic"), a0, s0) | {"out": {"preset": "fade", "duration": 0.4}})
        L.append(win(text(name, 860, y + 12, 11, 600, align="right", in_={"preset": "fade", "duration": 0.3}), 0.4 + i * 0.08, s0) | {"out": {"preset": "fade", "duration": 0.3}})
    L.append(win({"type": "svg", "d": glyph_frame_d("b", 600, cx, 0, H), "viewBox": FRAME_VB, "width": 1920, "fill": "none", "stroke": BLACK,
                  "strokeWidth": 1.4, "out": {"preset": "fade", "duration": 0.4}}, a0, a1 + 0.2))
    for j, ((x0, y0), (x1, y1)) in enumerate(links):
        p, q = m(x0, y0), m(x1, y1)
        L.append(win(draw_on(line([p, q], LINE, 1), 0.5 + j * 0.02, 0.25, "outCubic"), 0.5, a1) | {"out": {"preset": "fade", "duration": 0.3}})
    for j, (x, y) in enumerate(off):
        px, py = m(x, y)
        L.append(win(ring(px, py, 12, BLACK, 1.1, in_={"preset": "popIn", "from": 0, "duration": 0.35, "at": 0.6 + j * 0.02},
                          out={"preset": "scaleIn", "from": 0, "duration": 0.3}), 0.6, a1))
    for j, (x, y) in enumerate(on):
        px, py = m(x, y)
        L.append(win(dot(px, py, 12, in_={"preset": "popIn", "from": 0, "duration": 0.35, "at": 0.45 + j * 0.02},
                         out={"preset": "scaleIn", "from": 0, "duration": 0.3}), 0.45, a1))
    # Filled (the ink floods into the outline as it lets go), then sweeping from light to bold.
    # All weights share the Semibold outline's placement, so the fill lands exactly inside it (Semibold sits at 0.75
    # between Light and Bold), thins to Light, then sweeps up to Bold.
    dl = glyph_frame_d("b", 300, cx, 0, H, ref=600)
    db = glyph_frame_d("b", 700, cx, 0, H, ref=600)
    semi = (600 - 300) / (700 - 300)
    t_go, t_end = a1 + 0.35, s0 - 0.2
    t_mid = t_go + (t_end - t_go) * 0.4
    lb = {"type": "svg", "d": dl, "morphTo": db, "viewBox": FRAME_VB, "width": 1920, "fill": BLACK,
          "keyframes": {"morph": kf((t_go, semi), (t_mid, 0, "inOutCubic"), (t_end, 1, "inOutCubic"))}, "in": {"preset": "fade", "duration": 0.45},
          "out": {"preset": "slideLeft", "distance": 260, "duration": 0.55, "ease": "inCubic"}}
    L.append(win(lb, a1 - 0.1, s0 + 0.1))
    num = {"type": "counter", "ease": "inOutCubic", "separator": False, "font": FONT, "weight": 600, "size": 120, "color": BLACK, "x": 520, "y": 0}
    L.append(win({**num, "from": 600, "to": 300, "at": t_go, "duration": t_mid - t_go, "in": {"preset": "blurIn", "duration": 0.45}}, a1, t_mid))
    L.append(win({**num, "from": 300, "to": 700, "at": t_mid, "duration": t_end - t_mid, "out": {"preset": "blurIn", "duration": 0.35}}, t_mid, s0 - 0.05))
    L.append(win(text("weight", 520, -90, 11, 700, in_={"preset": "fade", "duration": 0.3}, out={"preset": "fade", "duration": 0.3}), a1 + 0.1, s0))
    # 3b. Specimen: the wordmark in five weights, rows drifting in from the right as the b leaves left.
    names = {300: "Light", 400: "Regular", 500: "Medium", 600: "Semibold", 700: "Bold"}
    for i, w in enumerate(WEIGHTS):
        y = 300 - i * 150
        st = s0 - 0.15 + i * 0.07
        ox = 140
        L.append(win(text("Bemotion", -870, y, 150, w, align="left", letterSpacing=-0.035,
                          keyframes={"x": kf((st, -870 + ox), (st + 0.8, -870, "outCubic"), (s1, -870 - 30 - i * 6, "linear"))},
                          in_={"preset": "blurIn", "duration": 0.5, "blur": 16},
                          out={"preset": "blurIn", "duration": 0.4, "blur": 16}), st, s1 + i * 0.05))
        L.append(win(text(names[w], 870, y, 150, w, align="right", letterSpacing=-0.035,
                          keyframes={"x": kf((st, 870 + ox), (st + 0.8, 870, "outCubic"), (s1, 870 + 30 + i * 6, "linear"))},
                          in_={"preset": "blurIn", "duration": 0.5, "blur": 16},
                          out={"preset": "blurIn", "duration": 0.4, "blur": 16}), st + 0.05, s1 + i * 0.05))
    # 3c. Line styles, each named in its own motion, then each leaving its own way.
    s2 = s1 + 0.1
    end = s2 + 3.4
    styles = [("push", -460, 210), ("plop", 460, 210), ("depth", -460, 0), ("ripple", 460, 0), ("tipUp", -460, -210), ("focusPull", 460, -210)]
    for i, (st, x, y) in enumerate(styles):
        L.append(win(text(st, x, y, 110, 600, letterSpacing=-0.03, animate={"preset": st, "at": s2 + 0.15 + i * 0.3},
                          animateOut={"preset": "auto"}), s2, end - 0.5 + i * 0.07))
    L += captions(3, "Letterforms", [(0, "A", "Construction"), (a1, "B", "Weight"), (s0, "C", "Specimen"), (s2, "D", "Line Styles")], end)
    return scene("letterforms", end, L), [{"sound": "tick", "at": t} for t in (a1, s0, s2)]


# ---------------------------------------------------------------- 4. the field

def glyph_targets(ch, w, height, pitch):
    """Grid points (frame px, centered, y up) that fall inside a glyph drawn `height` px tall."""
    from PIL import Image, ImageDraw, ImageFont
    f = ImageFont.truetype(str(FONT_SRC / f"Inter-{w}.ttf"), 1000)
    x0, y0, x1, y1 = f.getbbox(ch)
    im = Image.new("L", (x1 - x0 + 4, y1 - y0 + 4), 0)
    ImageDraw.Draw(im).text((2 - x0, 2 - y0), ch, font=f, fill=255)
    k = height / (y1 - y0)
    gw, gh = (x1 - x0) * k, height
    out = []
    ny, nx = int(gh // pitch), int(gw // pitch)
    for j in range(ny + 1):
        for i in range(nx + 1):
            x = (i - nx / 2) * pitch
            y = (ny / 2 - j) * pitch
            px, py = (x + gw / 2) / k + 2, (gh / 2 - y) / k + 2
            if 0 <= px < im.width and 0 <= py < im.height and im.getpixel((int(px), int(py))) > 128:
                out.append((round(x, 1), round(y, 1)))
    return out


def field_tracks():
    """Dots: a grid breathing in a wave, gathering into a bold b, then flowing away to the right."""
    cols, rows, pitch = 32, 18, 54
    grid = [((c - (cols - 1) / 2) * pitch, ((rows - 1) / 2 - r) * pitch) for r in range(rows) for c in range(cols)]
    # Targets inside a bold b, 520 px tall, centered.
    targets = glyph_targets("b", 700, 520, 19)
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
            # The grid ripples out of the center as the chapter opens.
            reveal = min(1, max(0, (t * 1500 - dist) / 260))
            size *= reveal * reveal * (3 - 2 * reveal)
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
            if size < 0.3 and t > 1.6:
                continue
            keys.append([f, round(x, 1), round(y, 1), round(size, 2)])
        if keys:
            tracks.append({"keys": keys})
    return tracks


def ch_field():
    (MEDIA / "field.json").write_text(json.dumps(field_tracks()))
    L = [{"type": "dots", "src": "media/field.json", "fps": FPS, "color": BLACK, "fade": 1, "end": 6.0}]
    # Halftone light on a sphere.
    sphere = {"type": "group", "start": 5.8, "raster": {"width": 760, "height": 760}, "children": [
        {"type": "shape", "shape": "circle", "width": 740, "height": 740,
         "fill": {"type": "radial", "from": "#FFFFFF", "to": "#000000", "center": [-0.22, 0.24]},
         "keyframes": {"centerX": kf((6.0, -0.3), (9.0, 0.25, "inOutSine")), "centerY": kf((6.0, 0.3), (9.0, -0.1, "inOutSine"))}}],
        "halftone": {"columns": 46, "color": BLACK, "levels": [0.05, 0.95], "invert": True, "size": 1.0},
        "in": [{"preset": "scaleIn", "from": 0.8, "at": 5.8, "duration": 0.9, "ease": "outCubic"}, {"preset": "fade", "at": 5.8, "duration": 0.5}]}
    L.append(sphere)
    L += captions(4, "The Field", [(0, "A", "Grid"), (1.6, "B", "Formation"), (4.0, "C", "Flow"), (6.0, "D", "Halftone")], 9.0)
    return scene("field", 9.0, L), [{"sound": "tick", "at": t} for t in (1.6, 6.0)] + [{"sound": "whoosh", "at": 4.1, "gain": 0.7}]


# ---------------------------------------------------------------- 5. depth

def ch_depth():
    bd, bbox = glyph_path("b", 700)
    bh = 520
    bw = round((bbox[2] - bbox[0]) / (bbox[3] - bbox[1]) * bh, 1)
    mark = {"type": "mesh", "geometry": "svg", "d": bd, "viewBox": [bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]], "width": bw,
            "depth": 96, "bevel": 9,
            "material": "glossy", "color": "#111114", "sideColor": "#C9CCD3", "sideMaterial": "metal",
            "keyframes": {"rotateY": kf((0, -38), (3.6, 32, "inOutSine")), "rotateX": kf((0, 14), (3.6, -8, "inOutSine"))}, "end": 3.9,
            "out": {"preset": "pushIn", "distance": 1400, "duration": 0.7, "ease": "inCubic"}}
    L = [mark]
    # Construction hairlines over the solid.
    for v in (-bw / 2, bw / 2):
        L.append(win(draw_on(line([(v, 360), (v, -360)], LINE, 1), 0.3, 0.6), 0, 3.5) | {"out": {"preset": "fade", "duration": 0.4}})
    for v in (-bh / 2, bh / 2):
        L.append(win(draw_on(line([(360, v), (-360, v)], LINE, 1), 0.4, 0.6), 0, 3.5) | {"out": {"preset": "fade", "duration": 0.4}})
    L.append(win(text("96", bw / 2 + 26, bh / 2 + 20, 11, 600, in_={"preset": "fade", "duration": 0.3}, out={"preset": "fade", "duration": 0.3}), 0.9, 3.5))
    # A lens over a character set.
    rows = ["ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz", "0123456789!?&@#%*+=<>/", "Bemotion Bemotion Bemotion"]
    for i, r in enumerate(rows):
        L.append(win(text(r, 0, 250 - i * 166, 96, 500, justify="all", maxWidth=1720, letterSpacing=0,
                          in_={"preset": "focusIn", "from": 1.06, "blur": 20, "duration": 0.7},
                          out={"preset": "blurIn", "blur": 20, "duration": 0.45}), 3.45 + i * 0.09, 7.0 + i * 0.06))
    L.append({"type": "shape", "shape": "circle", "width": 380, "height": 380, "fill": WHITE, "start": 3.6,
              "glass": {"blur": 0, "refract": 90, "profile": "lens", "dispersion": 7, "tint": WHITE, "tintAmount": 0.04, "rim": 0.3},
              "shadow": {"color": BLACK, "blur": 60, "y": -24, "opacity": 0.12},
              "keyframes": {"x": kf((3.6, -1250), (5.4, 0, "outSine"), (7.3, 1250, "inSine")), "y": kf((3.6, 120), (5.4, -80, "inOutSine"), (7.3, 60, "inOutSine"))}})
    L += captions(5, "Depth", [(0, "A", "Extrusion"), (1.8, "B", "Light"), (3.6, "C", "Refraction")], 7.3)
    return scene("depth", 7.3, L, transition={"type": "blur", "duration": 0.6}, lighting={"shadows": True, "ground": -330, "shadowOpacity": 0.12, "softness": 18},
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
                     "in": {"preset": "growY", "at": i * F(3), "duration": 0.6, "ease": "outExpo"}})
        fg = BLACK if name in ("Sky", "Paper", "Coral") else WHITE
        L.append(win(text(name, x - w / 2 + 24, -400, 22, 600, fg, align="left", animate=SCRAMBLE,
                          out={"preset": "fade", "duration": 0.25}), 0.5 + i * F(3), 2.6))
        L.append(win(text(hexv, x - w / 2 + 24, -436, 14, 500, fg, align="left", font="JetBrains Mono", letterSpacing=0, animate=SCRAMBLE,
                          out={"preset": "fade", "duration": 0.25}), 0.55 + i * F(3), 2.6))
    L.insert(0, win({"type": "group", "children": bars, "keyframes": {"scale": kf((0.5, 1), (2.6, 1.06, "inOutSine"))}}, 0, 3.2))
    # Full-bleed fields. Signal opens out of its own bar; each next color sweeps in over the last from a new side,
    # and its value decodes as it lands.
    t = 2.6
    fields = PALETTE[1:5] + PALETTE[:1]
    hold = 0.62
    sides = ["left", "bottom", "right", "top"]
    for j, (name, hexv) in enumerate(fields):
        fg = BLACK if name in ("Sky", "Paper", "Coral") else WHITE
        t1 = t + hold + 0.5
        if j == 0:
            bx = -960 + w * 1.5
            shape = {"type": "shape", "width": w + 1, "height": 1084, "fill": hexv, "x": bx,
                     "keyframes": {"width": kf((t, w * 1.06), (t + 0.55, 1924, "inOutCubic")), "x": kf((t, bx * 1.06), (t + 0.55, 0, "inOutCubic"))}}
        else:
            side = sides[(j - 1) % 4]
            axis = "growX" if side in ("left", "right") else "growY"
            shape = {"type": "shape", "width": 1924, "height": 1084, "fill": hexv, "origin": side,
                     "in": {"preset": axis, "duration": 0.5, "ease": "inOutQuart"}}
        if j == len(fields) - 1:
            # Ink lifts away to the paper underneath.
            shape["origin"] = "top"
            shape["out"] = {"preset": "growY", "duration": 0.55, "ease": "inOutQuart"}
            t1 = t + hold + 0.55
        L.append(win(shape, t, t1))
        L.append(win(text(hexv.upper(), 0, 0, 260, 600, fg, font="JetBrains Mono", letterSpacing=-0.02,
                          animate={"preset": "scramble", "at": t + (0.15 if j == 0 else 0.4), "duration": 0.35, "stagger": 0.03, "chars": "0123456789ABCDEF"}),
                     t + (0.1 if j == 0 else 0.38), t1 - (0.35 if j == len(fields) - 1 else 0)))
        t += hold
    t += 0.45
    # Paper: the palette as confetti.
    L.append(win({"type": "confetti", "at": t + 0.1, "count": 160, "colors": [h for _, h in PALETTE[:5]], "power": 1300, "y": -420}, t, t + 3.0))
    L.append(win(text("Color", 0, 0, 220, 600, BLACK, letterSpacing=-0.04, animate={"preset": "lift", "by": "char", "at": t + 0.25},
                      animateOut={"preset": "riseOut"}), t, t + 2.9))
    end = t + 3.0
    L += captions(6, "Color", [(0, "A", "Palette"), (2.6, "B", "Fields"), (t, "C", "Celebration")], end)
    return scene("color", end, L), [{"sound": "tick", "at": 2.6 + i * hold} for i in range(5)]


# ---------------------------------------------------------------- 7. time

DIVE = 11
TILE_TIMES = [0.6, 2.4, 4.6, 5.4, 6.6, 9.0, 12.0, 16.5, 18.5, 20.2, 23.6, 27.0, 30.0, 35.0, 38.0, 43.5]


def ch_time():
    L = []
    # A film strip of the film's own frames scrolling under a playhead.
    n = len(TILE_TIMES)
    tw, th, gap = 384, 216, 18
    strip = []
    for i in range(n):
        strip.append({"type": "image", "src": f"media/tiles/t{i:02d}.png", "x": i * (tw + gap), "width": tw, "height": th, "radius": 6,
                      "stroke": "#00000014", "strokeWidth": 1, **({"id": "dive"} if i == DIVE else {})})
    L.append({"type": "group", "y": 60, "children": strip, "keyframes": {"x": kf((0, 1500), (5.6, 300 - (n - 4) * (tw + gap), "inOutSine"))}})
    # Ruler and timecode.
    for k in range(97):
        x = -960 + k * 20
        h = 22 if k % 5 == 0 else 10
        tk = 0.1 + k * 0.006
        L.append(line([(x, -150), (x, -150 - h)], BLACK if k % 5 == 0 else LINE, 1, keyframes={"progress": kf((tk, 0), (tk + 0.25, 1, "outCubic"))}))
    L.append(draw_on(line([(0, -200), (0, 200)], BLUE, 2), 0.3, 0.6, "outCubic"))
    L.append(dot(0, 200, 14, BLUE, in_={"preset": "popIn", "at": 0.8, "duration": 0.4}))
    L.append({"type": "counter", "from": 0, "to": 1680, "at": 0.2, "duration": 5.4, "ease": "inOutSine", "separator": False, "suffix": " f",
              "font": "JetBrains Mono", "size": 30, "weight": 500, "color": BLACK, "y": -250, "in": {"preset": "blurIn", "duration": 0.5}})
    L.append(text("Every frame, rendered.", 0, 330, 64, 600, BLACK, letterSpacing=-0.03, animate={"preset": "auto"}, start=0.5))
    L += captions(7, "Time", [(0, "A", "Timeline"), (1.8, "B", "Frames"), (3.6, "C", "Render")], 5.8)
    # The camera dives into the frame under the playhead, which opens into the last chapter.
    cam = {"moves": [{"preset": "moveTo", "target": "dive", "zoom": 5.2, "at": 4.4, "duration": 1.4, "ease": "inOutCubic"}]}
    return scene("time", 5.8, L, transition={"type": "blur", "duration": 0.5}, camera=cam), []


# ---------------------------------------------------------------- 8. the wordmark

def ch_wordmark():
    L = []
    H = 150
    d, box = glyph_path("Bemotion", 600)
    vb = [box[0], box[1], box[2] - box[0], box[3] - box[1]]
    width = round(vb[2] / vb[3] * H, 1)
    cx, cy = 0, 0
    common = {"type": "svg", "d": d, "viewBox": vb, "width": width, "x": cx, "y": cy}
    L.append(win({**common, "fill": "none", "stroke": BLACK, "strokeWidth": 1.3, "keyframes": {"progress": kf((0.1, 0), (1.0, 1, "inOutCubic"))},
                  "out": {"preset": "fade", "duration": 0.4}}, 0, 1.6))
    # The ink floods in.
    L.append(win({**common, "fill": BLACK, "in": {"preset": "fade", "duration": 0.45}}, 1.2, 6.0))
    L.append(win(text("Prompt to motion.", 0, -170, 34, 500, GRAY, animate={"preset": "lift", "by": "word", "at": 2.0}), 1.9, 6.0))
    L.append(win(text("github.com/b9llach/bemotion", 0, -400, 18, 500, BLACK, font="JetBrains Mono", letterSpacing=0,
                      animate={"preset": "typewriter", "at": 2.8, "stagger": 0.025}), 2.7, 6.0))
    # Metric lines while it is drawn.
    for y in (H / 2, -H / 2):
        L.append(win(draw_on(line([(-860, y), (860, y)], LINE, 1), 0.05, 0.6, "outCubic"), 0, 1.7) | {"out": {"preset": "fade", "duration": 0.5}})
    L += captions(8, "Bemotion", [(0, "A", "Wordmark"), (1.4, "B", "Prompt to Motion")], 6.0)
    return scene("wordmark", 6.0, L, transition={"type": "blur", "duration": 0.6}, camera={"moves": [{"preset": "pushIn", "amount": 70, "at": 1.4, "duration": 4.6, "ease": "inOutSine"}]}), [{"sound": "tick", "at": 1.4}, {"sound": "chime", "at": 1.45, "gain": 0.5}]


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
        # A CC0 laid-back lo-fi bed (FreePD, Study and Relax); the chapter cuts snap to its beats, the effects sit under it.
        "audio": [{"src": "media/music/study-and-relax.mp3", "sync": True, "volume": 1.0, "fadeOut": 2.5}],
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
