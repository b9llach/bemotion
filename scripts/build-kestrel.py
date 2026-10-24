"""Builds examples/kestrel-business.json: an Apple keynote style kinetic type ad with 3D devices.

Structure follows a classic Apple product film: one to three words at a time, each beat arriving its own
way, hard cuts between black and white, a 3D gradient word wall, a typing indicator, counters, a field of
150 device icons that hand off to a "150" mask the next scene shows through, "IT" morphing into
"demands.", and the 3D bars mark that flies into the brand lockup (a shared element). Kestrel is fictional.
"""
import math

from genlib import ROOT, write_spec

WHITE = "#FFFFFF"
INK = "#1D1D1F"
GRAY = "#86868B"
BLUE = "#2440E8"
GREEN = "#28A745"
WARM = ["#F2A65A", "#D8657F", "#8B4FD8"]  # the keynote gradient: amber, rose, violet
FONT = {"font": "display", "weight": 600, "letterSpacing": -0.03}


# Line styles are engine presets (docs/SPEC.md, "Line styles"): each names how a line comes together.
STYLE = {
    "push": "push", "push-pop": "pushPop", "plop": "plop", "scatter": "scatter",
    "from-left": "fromLeft", "from-right": "fromRight", "up": "lift", "drop": "plop",
    "depth": "depth", "zoom": "focusPull", "chars": "ripple", "tilt": "tipUp",
}


def say(text, t0, t1, size=66, y=0, color=WHITE, stagger=None, move="up", exit=True, **kw):
    """One beat of type, always centered, built the way `move` says. With `exit`, the line leaves with
    the exit that carries on its entrance (animateOut auto) instead of cutting away."""
    anim = {"preset": STYLE[move]}
    if stagger is not None:
        anim["stagger"] = stagger
    layer = {"type": "text", "text": text, "size": size, "y": y, "color": color, **FONT, "start": t0, "end": t1, "animate": anim}
    if exit:
        layer["animateOut"] = {"preset": "auto"}
    layer.update(kw)
    return layer


def dot_word(text, t0, t1, size, color=WHITE, **kw):
    """A word ending in a blue period, like the brand's punctuation."""
    return say(text, t0, t1, size=size, color=color, highlight=[{"text": ".", "color": BLUE}], **kw)


def typing_dots(t0, t1, color=WHITE, dim="#4A4A4F", size=18):
    """Three dots pulsing in a wave, like someone typing."""
    dots = []
    for i in range(3):
        keys = []
        t = t0 + i * 0.12
        while t < t1 + 0.4:
            keys += [{"t": round(t, 3), "v": dim}, {"t": round(t + 0.2, 3), "v": color, "ease": "outSine"},
                     {"t": round(t + 0.5, 3), "v": dim, "ease": "inOutSine"}]
            t += 0.62
        dots.append({"type": "shape", "shape": "circle", "x": (i - 1) * size * 1.35, "width": size, "fill": dim,
                     "keyframes": {"fill": keys}})
    return {"type": "group", "start": t0, "end": t1, "in": {"preset": "scaleIn", "from": 0.6, "duration": 0.3}, "children": dots}


def bars_mark(t0, height=110, bar=30, gap=10, rotate=(-32, 14), dur=1.2, material="glossy", grown=False, **kw):
    """The brand mark in 3D: three glossy bars growing from a shared baseline (group origin = baseline center).
    With `grown`, the bars stand at full height at the final angle from the start (a landing spot for a shared mark)."""
    hs = [0.72, 1.0, 0.56]
    kids = []
    for i, f in enumerate(hs):
        h = height * f
        x = (i - 1) * (bar + gap)
        t = t0 + i * 0.07
        mesh = {"type": "mesh", "geometry": "roundedBox", "size": [bar, h, bar], "radius": 4, "material": material,
                "color": BLUE, "roughness": 0.18, "x": x}
        if grown:
            mesh["y"] = h / 2
        else:
            mesh["keyframes"] = {"scaleY": [{"t": t, "v": 0.001}, {"t": t + 0.55, "v": 1, "ease": "outBack"}],
                                 "y": [{"t": t, "v": 0.0005 * h}, {"t": t + 0.55, "v": h / 2, "ease": "outBack"}]}
        kids.append(mesh)
    if grown:
        return {"type": "group", **kw, "rotateY": rotate[1], "children": kids}
    return {"type": "group", **kw, "keyframes": {"rotateY": [{"t": t0, "v": rotate[0]}, {"t": t0 + dur, "v": rotate[1], "ease": "outCubic"}]},
            "children": kids}


# ---------------------------------------------------------------- Scene 1: black, the setup

def lerp(a, b, t):
    return a + (b - a) * t


def hex2rgb(h):
    return [int(h[i:i + 2], 16) for i in (1, 3, 5)]


def mix(c1, c2, t):
    a, b = hex2rgb(c1), hex2rgb(c2)
    return "#" + "".join(f"{round(lerp(a[i], b[i], t)):02X}" for i in range(3))


WALL = ["#3940CF", "#6A47C9", "#9C5384", "#D3773E", "#ECA04A"]


def wall_color(t):
    t = min(1, max(0, t))
    n = len(WALL) - 1
    k = min(n - 1, int(t * n))
    return mix(WALL[k], WALL[k + 1], t * n - k)


def dim(x, y):
    """Wall words fade toward the middle so the hero word owns the center."""
    d = math.hypot(x / 1.6, y) / 620
    return 0.18 + 0.82 * min(1, max(0, d - 0.35) / 0.65) ** 1.4


def big_wall(t0, t1):
    """'Big' repeated in a deep wall behind one bright 'Big', colored by a sweep from indigo to amber."""
    size = 330
    w = size * 1.42
    words = []
    for r in range(-3, 4):
        y = -r * size * 0.86
        shift = (r % 2) * (w + 70) * 0.5 - w * 0.2
        for c in range(-4, 5):
            x = c * (w + 70) + shift
            u0 = (x - w / 2 + 2300) / 4600
            u1 = (x + w / 2 + 2300) / 4600
            v = (y + 1300) / 2600
            ta, tb = 0.62 * u0 + 0.38 * (1 - v), 0.62 * u1 + 0.38 * (1 - v)
            words.append({"type": "text", "text": "Big", "size": size, "weight": 700, "letterSpacing": -0.03, "font": "display",
                          "x": x, "y": y, "z": -700 + ((r + c) % 3 - 1) * 70, "opacity": round(0.82 * dim(x, y), 3),
                          "gradient": {"colors": [wall_color(ta), wall_color(tb)], "angle": 100}})
    return [
        {"type": "group", "start": t0, "end": t1, "children": words,
         "keyframes": {"z": [{"t": t0, "v": -120}, {"t": t1, "v": 260, "ease": "linear"}],
                       "opacity": [{"t": t0, "v": 0}, {"t": t0 + 0.12, "v": 1}]}},
        {"type": "text", "text": "Big", "size": 430, "weight": 700, "letterSpacing": -0.035, "font": "display", "y": 10,
         "start": t0, "end": t1, "gradient": {"colors": ["#FFFFFF", "#FFFFFF", "#D2D2D9"], "angle": 150},
         "animate": {"preset": "lift", "by": "line", "duration": 0.4, "ease": "outQuart"},
         "keyframes": {"scale": [{"t": t0, "v": 1}, {"t": t1, "v": 1.07, "ease": "linear"}]}},
    ]


def scene_setup():
    T = {}
    layers = [
        say("When you work at a", 0.25, 1.55, move="push", stagger=0.14),
        say("small", 1.55, 2.25, move="zoom"),
    ]
    # "business." with the 3D bar mark growing at its left.
    word_x = -95
    layers += [
        {"type": "group", "start": 2.25, "end": 3.35,
         "keyframes": {"scale": [{"t": 2.25, "v": 1}, {"t": 3.35, "v": 1.12, "ease": "inSine"}]},
         "children": [
             bars_mark(2.25, height=96, bar=26, gap=9, x=word_x - 70, y=-26, z=20),
             {"type": "text", "text": "business.", "size": 76, **FONT, "x": word_x, "align": "left", "color": WHITE,
              "highlight": [{"text": ".", "color": BLUE}],
              "animate": {"preset": "lift", "by": "line", "duration": 0.5, "ease": "outQuart", "at": 2.32}},
         ]},
        say("IT", 3.35, 3.85, size=84, move="depth"),
        say("can be a", 3.85, 4.35, move="plop", stagger=0.09),
    ]
    layers += big_wall(4.35, 5.25)
    layers += [
        dot_word("deal.", 5.25, 6.0, 96, move="drop"),
        typing_dots(6.0, 6.9),
        say("At first,", 6.9, 7.55, size=80, move="from-left"),
        say("it was just", 7.55, 8.15, size=80, move="chars"),
        say("a few of you.", 8.15, 9.0, size=80, move="scatter"),
        say("Then one day,", 9.0, 9.6, size=80, move="depth"),
        say("there were", 9.6, 10.2, size=80, move="from-right"),
        {"type": "counter", "from": 1, "to": 50, "at": 10.22, "duration": 0.6, "ease": "outCubic", "size": 150, **FONT,
         "color": WHITE, "start": 10.2, "end": 11.15, "in": {"preset": "slideUp", "distance": 40, "duration": 0.35, "ease": "outQuart"},
         "keyframes": {"scale": [{"t": 10.2, "v": 1}, {"t": 11.15, "v": 1.08, "ease": "linear"}]}},
        say("And 50 people", 11.15, 12.0, size=72, move="plop",
            keyframes={"scale": [{"t": 11.45, "v": 1}, {"t": 12.0, "v": 0.78, "ease": "inOutCubic"}]}),
    ]
    return {"id": "setup", "duration": 12.0, "background": "#000000", "layers": layers}


# ---------------------------------------------------------------- Scene 2: white, the problem

def scene_problem():
    return {"id": "problem", "duration": 2.3, "background": WHITE, "transition": {"type": "cut"}, "layers": [
        say("could mean 150 devices to manage.", 0.05, 2.3, size=62, color=INK, stagger=0.11, move="push",
            highlight=[{"text": "150 devices", "gradient": {"colors": ["#7A45D6", "#C46796", "#E79B5A"], "angle": 90}}],
            keyframes={"scale": [{"t": 1.2, "v": 1}, {"t": 2.3, "v": 1.06, "ease": "inSine"}]}),
    ]}


# ---------------------------------------------------------------- Scene 3: 150 devices, as icons

def scene_devices():
    """150 device icons ripple out from the center, then step back behind the count. The next scene
    shows through the count's own digits (a mask transition from it), and the view dives into them."""
    dur = 3.8
    cols, rows = 15, 10
    icons = []
    kinds = ["smartphone", "monitor", "smartphone", "smartphone", "monitor"]
    for r in range(rows):
        for c in range(cols):
            x = (c - (cols - 1) / 2) * 118
            y = ((rows - 1) / 2 - r) * 96
            i = r * cols + c
            at = 0.1 + math.hypot(x, y * 1.3) / 1100 * 0.9
            icons.append({"type": "icon", "name": kinds[(i * 7) % 5], "x": x, "y": y, "size": 44, "strokeWidth": 1.8, "color": "#3A3A3C",
                          "in": {"preset": "popIn", "from": 0.4, "at": round(at, 3), "duration": 0.45}})
    return {"id": "devices", "duration": dur, "background": WHITE, "transition": {"type": "cut"},
            "camera": {"moves": [{"preset": "pushIn", "amount": 120, "duration": dur, "ease": "inOutSine"}]},
            "layers": [
                {"type": "group", "children": icons,
                 "keyframes": {"opacity": [{"t": 1.25, "v": 1}, {"t": 1.7, "v": 0.16, "ease": "inOutSine"}]}},
                {"type": "counter", "from": 1, "to": 150, "at": 1.25, "duration": 0.85, "ease": "outCubic", "size": 230, "weight": 700,
                 "font": "display", "letterSpacing": -0.03, "color": INK, "y": 40, "start": 1.25, "id": "count",
                 "in": {"preset": "focusIn", "duration": 0.6}},
                say("devices", 1.45, 2.3, size=56, color=GRAY, y=-110, move="up"),
            ]}


# ---------------------------------------------------------------- Scene 4: black, the turn

def scene_turn():
    """Comes in through the "150" mask (1.3 s), so its beats start once the dive has landed. "IT" grows
    into "IT demands." and then into one big gradient "demands.", which the camera flies through."""
    return {"id": "turn", "duration": 5.9, "background": "#000000",
            "transition": {"type": "mask", "text": "150", "from": "count", "duration": 1.3}, "layers": [
        typing_dots(0.65, 1.45),
        say("That's small", 1.45, 2.2, size=100, move="tilt"),
        dot_word("business.", 2.2, 2.7, 100, move="drop"),
        say("with not so small", 2.7, 3.45, size=84, move="push-pop", stagger=0.12, exit=False,
            keyframes={"scale": [{"t": 3.05, "v": 1}, {"t": 3.45, "v": 1.18, "ease": "inQuart"}]}),
        say("IT", 3.45, 5.9, size=120, weight=700, move="depth", exit=False,
            morph=[{"text": "IT demands.", "at": 3.9, "duration": 0.55},
                   {"text": "demands.", "at": 4.55, "duration": 0.6, "size": 220, "gradient": {"colors": WARM, "angle": 95}}],
            keyframes={"scale": [{"t": 5.15, "v": 1}, {"t": 5.4, "v": 1.05, "ease": "linear"}, {"t": 5.9, "v": 9, "ease": "inQuart"}],
                       "x": [{"t": 5.4, "v": 0}, {"t": 5.9, "v": -260, "ease": "inQuart"}]}),
    ]}


# ---------------------------------------------------------------- Scene 5: white, the answer

def scene_answer():
    """Ends on the mark, big and alone: it is shared with the lockup, so it flies into place beside the wordmark."""
    return {"id": "answer", "duration": 4.0, "background": WHITE, "transition": {"type": "cut"}, "layers": [
        say("That's where we come in.", 0.1, 1.6, size=56, color=INK, move="from-right"),
        {"type": "text", "text": "Introducing", "size": 64, **FONT, "start": 1.65, "end": 3.0,
         "gradient": {"colors": WARM, "angle": 90},
         "animate": {"preset": "rise", "by": "char", "stagger": 0.045, "duration": 0.55, "ease": "outQuart", "distance": 36},
         "animateOut": {"preset": "fade", "by": "char", "stagger": 0.04, "duration": 0.3, "at": 2.2}},
        bars_mark(2.45, height=230, bar=64, gap=21, y=-115, rotate=(-38, -8), dur=1.3, share="mark", start=2.45),
    ]}


# ---------------------------------------------------------------- Scene 6: the lockup

def scene_lockup():
    """The mark lands here from the answer scene (shared, during the 0.9 s fade), then the wordmark lifts in beside it."""
    return {"id": "lockup", "duration": 3.6, "background": WHITE, "transition": {"type": "fade", "duration": 0.9}, "layers": [
        {"type": "group", "x": -18, "y": 30, "children": [
            bars_mark(0, height=76, bar=21, gap=7, x=-252, y=-24, rotate=(-38, -8), grown=True, share="mark"),
            {"type": "text", "text": "Kestrel Business", "size": 66, **FONT, "x": -195, "align": "left", "color": INK,
             "animate": {"preset": "lift", "by": "word", "stagger": 0.1, "duration": 0.6, "ease": "outQuart", "at": 0.8}},
        ]},
        {"type": "text", "text": "Every device. Handled.", "size": 30, "weight": 500, "font": "display", "letterSpacing": -0.02,
         "color": GRAY, "y": -70, "in": {"preset": "fade", "at": 1.4, "duration": 0.6}},
    ]}


video = {
    "title": "Kestrel Business",
    "fps": 30,
    "environment": {"src": "hdri:studio_small_09", "intensity": 1.0, "rotation": 40},
    "theme": {"colors": {"bg": "#000000", "text": WHITE}, "fonts": {"display": "Inter", "body": "Inter", "mono": "JetBrains Mono"}},
    "post": {"bloom": False, "grain": 0, "vignette": 0, "chromatic": 0},
    "scenes": [scene_setup(), scene_problem(), scene_devices(), scene_turn(), scene_answer(), scene_lockup()],
}

write_spec(ROOT / "examples" / "kestrel-business.json", video)
