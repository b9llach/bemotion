"""Bemotion's own introduction film: a prompt becomes a spec, and the spec becomes everything the engine does.

Writes projects/bemotion-intro/ad.json (and media/ next to it). Run from the repo root:
  python scripts/build-bemotion-intro.py            # the spec (needs media/card-lum.json and media/tiles/*.png)
  python scripts/build-bemotion-intro.py --assets   # first: renders the halftone card and the frame tiles it reads
"""

import json
import math
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from genlib import write_spec  # noqa: E402
from devices import laptop  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DIR = ROOT / "projects" / "bemotion-intro"
MEDIA = DIR / "media"
FPS = 30

INK = "#111318"
MUTED = "#8A8F9C"
HAIR = "#E3E6EE"
BLUE = "#2A5FE4"
SKY = "#7C9BFF"
VIOLET = "#7C5CFF"
PINK = "#F472B6"
WHITE = "#FFFFFF"

SQUARE = "M14 14 H86 V86 H14 Z"
RING = "M50 4 A46 46 0 1 1 49.99 4 Z M50 30 A20 20 0 1 0 50.01 30 Z"


def glyph_d(ch, weight=700):
    """A glyph of Inter as SVG path data in a 100 x 100 box (y down), 100 tall and centered across."""
    from fontTools.pens.boundsPen import BoundsPen
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.transformPen import TransformPen
    from fontTools.ttLib import TTFont
    f = TTFont(str(ROOT / "examples" / "media" / "refreshed" / "fonts" / f"Inter-{weight}.ttf"))
    gs = f.getGlyphSet()
    g = gs[f.getBestCmap()[ord(ch)]]
    bp = BoundsPen(gs)
    g.draw(bp)
    x0, y0, x1, y1 = bp.bounds
    k = 100 / (y1 - y0)
    pen = SVGPathPen(gs, ntos=lambda v: f"{v:.2f}")
    g.draw(TransformPen(pen, (k, 0, 0, -k, 50 - (x0 + x1) / 2 * k, y1 * k)))
    return pen.getCommands()


# A bold lowercase b: the letter the shapes become and the solid that turns in 3D.
B = glyph_d("b")


def kf(*pairs, ease=None):
    out = []
    for p in pairs:
        k = {"t": round(p[0], 4), "v": p[1]}
        e = p[2] if len(p) > 2 else ease
        if e:
            k["ease"] = e
        out.append(k)
    return out


def text(s, size=72, weight=500, color=INK, **kw):
    layer = {"type": "text", "text": s, "size": size, "weight": weight, "color": color, "letterSpacing": -0.025}
    layer.update(kw)
    return layer


AUTO = {"preset": "auto"}


# ---------------------------------------------------------------- 1. the prompt

PROMPT = "A launch film for my app. Clean, bright, 30 seconds."


def typing_times(s, at=0.0):
    """A person typing: quick bursts inside words, a pause after spaces and commas (deterministic)."""
    times, t = [], at
    seed = 7
    for ch in s:
        seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
        jitter = (seed % 1000) / 1000
        if ch == " ":
            t += 0.05 + 0.08 * jitter
            continue
        times.append(round(t, 3))
        t += 0.032 + 0.03 * jitter + (0.16 if ch in ",." else 0)
    return times


def blobs():
    """Soft color blobs drifting behind the bar; drawn as halftone dots by the rastered group around them."""
    spec = [(-560, 210, 760, BLUE, 1.0), (560, -150, 820, VIOLET, 1.0), (120, 360, 560, PINK, 1.0), (-200, -330, 640, SKY, 1.0), (640, 380, 420, BLUE, 1.0)]
    out = []
    for i, (x, y, d, c, o) in enumerate(spec):
        out.append({"type": "shape", "shape": "circle", "x": x, "y": y, "width": d, "height": d, "opacity": o,
                    "fill": {"type": "radial", "from": c, "to": c + "00"},
                    "keyframes": {"x": kf((0, x), (5.2, x + (60 if i % 2 else -70), "inOutSine")),
                                  "y": kf((0, y), (5.2, y + (-40 if i % 3 else 50), "inOutSine"))}})
    return out


def scene_prompt():
    bar_w, bar_h = 1120, 116
    typed_at = 1.45
    times = typing_times(PROMPT)
    done = typed_at + times[-1]
    field = {"type": "group", "raster": {"width": 1920, "height": 1080}, "children": blobs(),
             "halftone": {"columns": 96, "color": BLUE, "levels": [0.0, 0.42], "invert": True, "size": 0.92},
             "keyframes": {"opacity": kf((0.5, 0), (1.3, 1, "outCubic")), "scale": kf((0.5, 1.08), (5.2, 1.0, "outCubic"))}}
    dot = {"type": "shape", "shape": "circle", "width": 28, "height": 28, "fill": INK,
           "in": {"preset": "popIn", "at": 0.15, "duration": 0.5},
           "keyframes": {"scale": kf((0.75, 1), (1.0, 0.4, "inCubic")), "opacity": kf((0.85, 1), (1.0, 0))}}
    bar = {"type": "shape", "shape": "rect", "width": bar_w, "height": bar_h, "radius": bar_h / 2, "fill": WHITE,
           "glass": {"blur": 10, "refract": 46, "edge": 60, "tint": "#F4F7FF", "tintAmount": 0.55, "rim": 0.12},
           "shadow": {"color": BLUE, "blur": 70, "y": -24, "opacity": 0.14}, "start": 0.78,
           "keyframes": {"width": kf((0.78, 28), (1.35, bar_w, "outExpo")), "height": kf((0.78, 28), (1.1, bar_h, "outCubic")),
                         "radius": kf((0.78, 14), (1.1, bar_h / 2, "outCubic"))}}
    icon = {"type": "icon", "name": "sparkles", "size": 40, "strokeWidth": 2.2, "color": BLUE, "x": -bar_w / 2 + 62,
            "in": {"preset": "popIn", "at": 1.2, "duration": 0.45}}
    prompt = text(PROMPT, 34, 500, INK, x=-bar_w / 2 + 108, align="left", anchor="left", letterSpacing=-0.01, share="prompt",
                  animate={"preset": "typewriter", "at": typed_at, "times": times})
    send = {"type": "group", "x": bar_w / 2 - 62, "in": {"preset": "popIn", "at": done + 0.15, "duration": 0.45},
            "keyframes": {"scale": kf((done + 0.7, 1), (done + 0.82, 0.86, "outQuad"), (done + 1.05, 1, "outBack"))},
            "children": [{"type": "shape", "shape": "circle", "width": 64, "height": 64, "fill": INK},
                         {"type": "icon", "name": "arrow-up", "size": 30, "strokeWidth": 2.6, "color": WHITE}]}
    return {"id": "prompt", "duration": 5.3, "background": WHITE,
            "camera": {"moves": [{"preset": "pushIn", "amount": 70, "duration": 5.3, "ease": "inOutSine"}]},
            "layers": [field, dot, bar, icon, prompt, send]}


# ---------------------------------------------------------------- 2. the spec

SPEC_CODE = """{
  "scenes": [{
    "duration": 3,
    "layers": [{
      "type": "text",
      "text": "Hello, motion.",
      "animate": { "preset": "auto" }
    }]
  }]
}"""


def scene_spec():
    return {"id": "spec", "duration": 4.8, "background": WHITE, "transition": {"type": "fade", "duration": 0.8},
            "camera": {"moves": [{"preset": "pushIn", "amount": 60, "duration": 3.4, "ease": "inOutSine"},
                                 {"preset": "moveTo", "x": 330, "y": -40, "zoom": 1.7, "at": 3.5, "duration": 1.3, "ease": "inOutQuart"}]},
            "layers": [
                text(PROMPT, 24, 500, MUTED, x=0, y=420, letterSpacing=-0.01, share="prompt"),
                text("One prompt.", 84, 600, INK, x=-840, y=90, align="left", anchor="left", animate=AUTO, start=0.5),
                text("One JSON file.", 84, 600, MUTED, x=-840, y=-20, align="left", anchor="left", animate=AUTO, start=1.1),
                {"type": "code", "code": SPEC_CODE, "language": "json", "title": "intro.json", "size": 25, "x": 330, "y": -40,
                 "at": 1.0, "speed": 120, "in": {"preset": "focusIn", "at": 0.7, "duration": 0.7}},
            ]}


# ---------------------------------------------------------------- 3. type

def scene_type():
    wave = [[-980, -330], [-560, -250], [-160, -360], [240, -250], [640, -350], [980, -280]]
    return {"id": "type", "duration": 5.2, "background": WHITE, "transition": {"type": "blur", "duration": 0.45},
            "camera": {"moves": [{"preset": "pushIn", "amount": 90, "duration": 5.2, "ease": "inOutSine"}]},
            "layers": [
                text("Hello, motion.", 128, 600, INK, y=60, animate={"preset": "build", "at": 0.15},
                     morph=[{"text": "Type that moves.", "at": 1.5, "duration": 0.75},
                            {"text": "Typography.", "at": 2.8, "duration": 0.8, "size": 210,
                             "gradient": {"colors": [BLUE, VIOLET, PINK], "angle": 95}}]),
                {"type": "path", "points": wave, "smooth": True, "width": 2, "color": HAIR,
                 "keyframes": {"progress": kf((1.7, 0), (2.6, 1, "inOutCubic"))}},
                text("along any curve you draw, letter by letter", 38, 500, MUTED,
                     path={"points": [[x, y + 26] for x, y in wave], "align": "center"},
                     animate={"preset": "fade", "by": "char", "at": 2.1, "stagger": 0.018},
                     keyframes={"pathOffset": kf((2.1, -260), (5.2, 260, "linear"))}),
            ]}


# ---------------------------------------------------------------- 4. shapes and 3D

def scene_shapes():
    common = {"type": "svg", "x": -330, "y": 10, "width": 330, "viewBox": [0, 0, 100, 100], "fill": BLUE}
    return {"id": "shapes", "duration": 3.1, "background": WHITE, "transition": {"type": "blur", "duration": 0.45},
            "camera": {"moves": [{"preset": "pushIn", "amount": 60, "duration": 3.1, "ease": "inOutSine"}]},
            "layers": [
                {**common, "d": SQUARE, "morphTo": RING, "end": 1.35, "in": {"preset": "scaleIn", "from": 0.6, "at": 0.1},
                 "keyframes": {"morph": kf((0.45, 0), (1.3, 1, "inOutCubic"))}},
                {**common, "d": RING, "morphTo": B, "start": 1.35, "share": "b",
                 "keyframes": {"morph": kf((1.35, 0), (2.25, 1, "inOutCubic")), "fill": kf((1.35, BLUE), (2.25, INK))}},
                text("Any shape,", 88, 600, INK, x=-40, y=60, align="left", anchor="left", animate=AUTO, start=0.3),
                text("into any other.", 88, 600, MUTED, x=-40, y=-50, align="left", anchor="left", animate=AUTO, start=1.4),
            ]}


def b_mesh(width, **kw):
    layer = {"type": "mesh", "geometry": "svg", "d": B, "viewBox": [0, 0, 100, 100], "width": width, "depth": width * 0.22,
             "bevel": width * 0.025, "material": "glossy", "color": BLUE, "sideColor": "#D9DDE6", "sideMaterial": "metal"}
    layer.update(kw)
    return layer


def scene_3d():
    return {"id": "real-3d", "duration": 4.2, "background": WHITE, "transition": {"type": "fade", "duration": 0.9},
            "lighting": {"shadows": True, "ground": -250, "shadowOpacity": 0.14, "softness": 18},
            "camera": {"moves": [{"preset": "orbit", "angle": 10, "duration": 4.2, "ease": "inOutSine"},
                                 {"preset": "pushIn", "amount": 80, "duration": 4.2, "ease": "inOutSine"}]},
            "layers": [
                b_mesh(330, x=-330, y=10, share="b",
                          keyframes={"rotateY": kf((0, 0), (1.6, -32, "inOutCubic"), (4.2, 18, "inOutSine")),
                                     "rotateX": kf((0, 0), (1.6, 12, "inOutCubic"), (4.2, -6, "inOutSine")),
                                     "x": kf((0, -330), (1.6, 0, "inOutCubic")), "y": kf((0, 10), (1.6, 60, "inOutCubic"))}),
                text("Real 3D, from any SVG.", 58, 600, INK, y=-360, animate=AUTO, start=1.3),
            ]}


# ---------------------------------------------------------------- 5. halftone into dots

CARD_W, CARD_H = 520, 600
RAST_W, RAST_H = 560, 640
COLS = 34
CARD_X = -380
COLLAPSE = 3.05  # scene seconds: the card hands over to the dots


def card_children():
    """A profile card (all shapes): avatar, name, lines, a button."""
    return [
        {"type": "shape", "shape": "rect", "width": CARD_W, "height": CARD_H, "radius": 34, "fill": "#F3F5FA"},
        {"type": "shape", "shape": "circle", "y": 150, "width": 190, "height": 190,
         "fill": {"type": "linear", "from": BLUE, "to": PINK, "angle": 150}},
        {"type": "shape", "shape": "circle", "y": 185, "width": 74, "height": 74, "fill": "#F3F5FA"},
        {"type": "shape", "shape": "circle", "y": 95, "width": 130, "height": 70, "fill": "#F3F5FA"},
        {"type": "shape", "shape": "pill", "y": 6, "width": 300, "height": 34, "fill": INK},
        {"type": "shape", "shape": "pill", "y": -48, "width": 220, "height": 22, "fill": "#B9BFCC"},
        {"type": "shape", "shape": "pill", "x": -40, "y": -100, "width": 300, "height": 16, "fill": "#D3D8E2"},
        {"type": "shape", "shape": "pill", "x": -70, "y": -134, "width": 240, "height": 16, "fill": "#D3D8E2"},
        {"type": "shape", "shape": "pill", "y": -214, "width": 300, "height": 66, "fill": BLUE},
    ]


def card_group(halftone=True, **kw):
    g = {"type": "group", "x": CARD_X, "raster": {"width": RAST_W, "height": RAST_H, "resolution": 1.5}, "children": card_children()}
    if halftone:
        g["halftone"] = {"columns": COLS, "color": BLUE, "levels": [0.0, 0.95], "invert": True, "gamma": 0.8, "size": 0.95}
    g.update(kw)
    return g


def dot_tracks(start_frame):
    """Every dot of the halftone card, from its place on the card into a stream that runs out to the right."""
    lum = json.loads((MEDIA / "card-lum.json").read_text())
    cell = RAST_W / COLS
    rows = int(RAST_H // cell)
    tracks = []
    seed = 11
    for j in range(rows):
        for i in range(COLS):
            lv = lum[j][i]
            if lv is None:
                continue
            # The halftone's size for this cell: inverted brightness through gamma 0.8 and levels [0, 0.95].
            k = min(1.0, max(0.0, (1 - lv ** 0.8) / 0.95))
            d0 = k * 0.95 * cell
            if d0 < 0.6:
                continue
            x0 = CARD_X + (i + 0.5) * cell - RAST_W / 2
            y0 = RAST_H / 2 - (j + 0.5) * cell
            seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
            r = (seed % 1000) / 1000
            delay = (CARD_X + RAST_W / 2 - x0) / RAST_W * 22 + r * 5
            d1 = 5 + 9 * ((seed >> 10) % 1000) / 1000
            band = 0.16 * y0 + 34 * math.sin(x0 / 90 + r * 6)
            keys = [[start_frame, round(x0, 1), round(y0, 1), round(d0, 2)]]
            f = start_frame + delay
            keys.append([round(f, 2), round(x0, 1), round(y0, 1), round(d0, 2)])
            for s in range(1, 90):
                e = 1 - (1 - min(1, s / 28)) ** 3
                x = x0 + 9 * s + 0.13 * s * s
                y = y0 + (band - y0) * e + 10 * math.sin(s / 6 + r * 9)
                d = d0 + (d1 - d0) * e
                keys.append([round(f + s, 2), round(x, 1), round(y, 1), round(d, 2)])
                if x > 1100:
                    break
            tracks.append({"keys": keys})
    return tracks


def scene_dots():
    collapse_f = round(COLLAPSE * FPS)
    (MEDIA / "dots.json").write_text(json.dumps(dot_tracks(collapse_f)))
    return {"id": "dots", "duration": 5.6, "background": WHITE, "transition": {"type": "blur", "duration": 0.45},
            "camera": {"moves": [{"preset": "pushIn", "amount": 60, "duration": 5.6, "ease": "inOutSine"}]},
            "layers": [
                card_group(end=COLLAPSE + 0.07,
                           keyframes={"halftone": kf((0.6, 1), (1.6, 0, "inOutCubic"), (2.5, 0), (COLLAPSE - 0.1, 1, "inOutCubic")),
                                      "opacity": kf((0, 0), (0.4, 1, "outCubic"))}),
                {"type": "dots", "src": "media/dots.json", "fps": FPS, "at": 0, "start": COLLAPSE, "color": BLUE, "fade": 0},
                text("Any picture,", 84, 600, INK, x=40, y=110, align="left", anchor="left", animate=AUTO, start=0.4, end=COLLAPSE + 0.2,
                     animateOut=AUTO),
                text("in halftone.", 84, 600, MUTED, x=40, y=0, align="left", anchor="left", animate=AUTO, start=1.0, end=COLLAPSE + 0.2,
                     animateOut=AUTO),
                text("Then dots that move.", 84, 600, INK, y=-330, animate=AUTO, start=COLLAPSE + 0.5),
            ]}


# ---------------------------------------------------------------- 6. glass and devices

def dashboard():
    w, h = 1045, 676
    return [
        {"type": "shape", "width": w, "height": h, "fill": "#F7F8FC"},
        {"type": "shape", "x": -w / 2 + 110, "width": 220, "height": h, "fill": WHITE},
        *[{"type": "shape", "shape": "pill", "x": -w / 2 + 110, "y": 230 - i * 52, "width": 150, "height": 18,
           "fill": BLUE if i == 1 else "#DDE1EA"} for i in range(6)],
        text("Launch week", 34, 600, INK, x=-w / 2 + 260, y=270, align="left", anchor="left", letterSpacing=-0.02),
        {"type": "chart", "kind": "area", "data": [12, 18, 15, 26, 31, 29, 44, 52, 61, 74], "x": 110, "y": 40, "width": 680, "height": 300,
         "color": BLUE, "at": 1.4, "duration": 1.4, "gridLines": True},
        *[{"type": "shape", "x": -120 + i * 230, "y": -235, "width": 210, "height": 120, "radius": 18, "fill": WHITE,
           "shadow": {"color": BLUE, "blur": 30, "y": -8, "opacity": 0.08}} for i in range(3)],
    ]


def scene_glass():
    lap = laptop(w=1100, open=108, open_keys=kf((0.15, 18), (1.3, 108, "outCubic")), content=dashboard(),
                 wallpaper=("#F7F8FC",), screen_on=None, keyboard=True, shadow=True, y=-300, z=-120, rotateY=-10)
    lens = {"type": "shape", "shape": "circle", "width": 270, "height": 270, "fill": WHITE, "z": 160,
            "glass": {"blur": 0, "refract": 70, "profile": "lens", "dispersion": 5, "tint": WHITE, "tintAmount": 0.08, "rim": 0.25},
            "shadow": {"color": INK, "blur": 50, "y": -20, "opacity": 0.12},
            "in": {"preset": "scaleIn", "from": 0.5, "at": 1.6, "duration": 0.6},
            "keyframes": {"x": kf((1.6, -330), (4.8, 300, "inOutSine")), "y": kf((1.6, 30), (3.2, 110, "inOutSine"), (4.8, 40, "inOutSine"))}}
    return {"id": "glass", "duration": 4.8, "background": WHITE, "transition": {"type": "blur", "duration": 0.45},
            "lighting": {"shadows": True, "ground": -300, "shadowOpacity": 0.12, "softness": 18},
            "camera": {"y": 40, "moves": [{"preset": "pushIn", "amount": 120, "duration": 4.8, "ease": "inOutSine"},
                                           {"preset": "orbit", "angle": -5, "duration": 4.8, "ease": "inOutSine"}]},
            "layers": [
                text("Glass, depth and real light.", 60, 600, INK, y=440, animate=AUTO, start=0.4),
                lap, lens,
            ]}


# ---------------------------------------------------------------- 7. any reference

TILE_TIMES = [(0, 2.6), (0, 4.4), (1, 2.6), (2, 1.2), (2, 4.6), (3, 2.5), (4, 1.8), (4, 3.6), (5, 1.4), (5, 4.6), (6, 2.0), (6, 4.2)]
PITCH = 700


def scene_remake():
    tiles = []
    n = len(TILE_TIMES)
    for r in range(-3, 4):
        for c in range(-3, 4):
            k = ((r + 3) * 5 + (c + 3) * 3) % n
            tiles.append({"type": "image", "src": f"media/tiles/t{k:02d}.png", "x": c * PITCH, "y": -r * 400, "width": 640, "height": 360,
                          "radius": 22, "shadow": {"color": INK, "blur": 40, "y": -14, "opacity": 0.1}})
    grid = {"type": "group", "children": tiles,
            "keyframes": {"scale": kf((0, 2.8), (2.2, 0.36, "inOutQuart"), (4.4, 0.3, "linear")),
                          "opacity": kf((1.9, 1), (2.6, 0.22, "inOutCubic"))}}
    return {"id": "any-reference", "duration": 4.4, "background": WHITE, "transition": {"type": "blur", "duration": 0.45},
            "layers": [
                grid,
                text("Recreate any reference.", 96, 600, INK, y=40, animate=AUTO, start=2.0, end=2.95, animateOut=AUTO),
                text("remake   trace   compare", 32, 500, BLUE, font="mono", y=-70, letterSpacing=0.02,
                     animate={"preset": "scramble", "at": 2.3, "stagger": 0.012, "chars": "lower"}, end=2.95, animateOut=AUTO),
            ]}


# ---------------------------------------------------------------- 8. the brand

def scene_end():
    return {"id": "brand", "duration": 4.8, "background": WHITE,
            "transition": {"type": "mask", "duration": 1.3, "text": "b", "weight": 700},
            "camera": {"moves": [{"preset": "pushIn", "amount": 50, "duration": 4.8, "ease": "inOutSine"}]},
            "layers": [
                text("Bemotion", 150, 600, INK, y=70, letterSpacing=-0.035, animate={"preset": "build", "at": 0.4}),
                text("Prompt to motion.", 46, 500, MUTED, y=-45, animate=AUTO, start=1.2),
                text("github.com/b9llach/bemotion", 30, 500, BLUE, font="mono", y=-300, letterSpacing=0,
                     animate={"preset": "typewriter", "at": 2.2, "stagger": 0.025}),
            ]}


# ---------------------------------------------------------------- assembly

SCENES = [scene_prompt, scene_spec, scene_type, scene_shapes, scene_3d, scene_dots, scene_glass, scene_remake, scene_end]


def fix(o):
    if isinstance(o, dict):
        return {("in" if k == "in_" else k): fix(v) for k, v in o.items()}
    if isinstance(o, list):
        return [fix(v) for v in o]
    return o


def video(scenes):
    return fix({
        "title": "Bemotion: prompt to motion",
        "fps": FPS, "width": 1920, "height": 1080,
        "theme": {"colors": {"text": INK, "muted": MUTED, "primary": BLUE, "border": HAIR},
                  "fonts": {"display": "Inter", "body": "Inter", "mono": "JetBrains Mono"}},
        "environment": "softbox",
        "post": {"bloom": False, "grain": 0, "vignette": 0, "chromatic": 0},
        "sfx": {"kit": "soft"},
        "scenes": scenes,
    })


def assets():
    """The rendered pieces the film reads: the card's brightness per halftone cell, and stills of the film as tiles."""
    from PIL import Image
    MEDIA.mkdir(parents=True, exist_ok=True)
    tmp = DIR / "_assets.json"
    # 1. The card, plain, alone on white: brightness per halftone cell (None outside the card).
    tmp.write_text(json.dumps(video([{"duration": 0.5, "background": WHITE, "layers": [card_group(halftone=False, x=0)]}])))
    subprocess.run(["node", "bin/bemotion.mjs", "still", str(tmp), "-t", "0.1", "-o", str(DIR / "_card.png")], cwd=ROOT, check=True)
    img = Image.open(DIR / "_card.png").convert("L")
    cell = RAST_W / COLS
    rows = int(RAST_H // cell)
    x0, y0 = 960 - RAST_W / 2, 540 - RAST_H / 2
    lum = []
    for j in range(rows):
        row = []
        for i in range(COLS):
            cx, cy = x0 + (i + 0.5) * cell, y0 + (j + 0.5) * cell
            inside = abs(cx - 960) < CARD_W / 2 - 4 and abs(cy - 540) < CARD_H / 2 - 4
            if not inside:
                row.append(None)
                continue
            box = img.crop((int(cx - cell / 2), int(cy - cell / 2), int(cx + cell / 2), int(cy + cell / 2)))
            px = list(box.getdata())
            row.append(round(sum(px) / len(px) / 255, 4))
        lum.append(row)
    (MEDIA / "card-lum.json").write_text(json.dumps(lum))
    # 2. Tiles: stills of the film itself.
    (MEDIA / "tiles").mkdir(exist_ok=True)
    (MEDIA / "dots.json").write_text("[]")
    first = video([fn() for fn in SCENES[:7]])
    tmp.write_text(json.dumps(first))
    starts, t = [], 0.0
    for s in first["scenes"]:
        t -= (s.get("transition") or {}).get("duration", 0) if s.get("transition", {}).get("type") != "cut" else 0
        starts.append(t)
        t += s["duration"]
    times = [round(starts[si] + lt, 2) for si, lt in TILE_TIMES]
    subprocess.run(["node", "bin/bemotion.mjs", "still", str(tmp), "-t", *map(str, times), "-o", str(DIR / "_tile_{t}.png")], cwd=ROOT, check=True)
    for k, tt in enumerate(times):
        Image.open(DIR / f"_tile_{tt:.2f}.png").convert("RGB").resize((640, 360), Image.LANCZOS).save(MEDIA / "tiles" / f"t{k:02d}.png")
        (DIR / f"_tile_{tt:.2f}.png").unlink()
    (DIR / "_card.png").unlink()
    tmp.unlink()
    print("wrote media/card-lum.json and", len(times), "tiles")


if __name__ == "__main__":
    if "--assets" in sys.argv:
        assets()
    write_spec(DIR / "ad.json", video([fn() for fn in SCENES]))
