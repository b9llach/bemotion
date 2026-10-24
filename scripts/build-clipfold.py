"""Builds examples/clipfold-flow.json: an original launch film in the Flow style.

Flow style: off-white canvas, one indigo-to-sky accent, light-weight type, and continuous motion where
elements morph, fly and dive into the next beat instead of cutting.
"""
import json
import pathlib
from genlib import ROOT, write_spec

BG = "#F6F6FB"
INK = "#14141F"
MUTED = "#8B8BA0"
ACCENT = "#4F46E5"
ACCENT2 = "#38BDF8"
LINE = "#E3E4EE"
SOFT = "#EEF0FF"
SMOOTH = "outQuart"

THUMBS = [(ACCENT, ACCENT2), ("#A78BFA", "#F0ABFC"), ("#38BDF8", "#34D399")]
CARD_SHADOW = {"blur": 46, "y": -20, "opacity": 0.13, "color": ACCENT}
MARK = "M6 3H14L19 8V21H6Z|M14 3V8H19|M10.5 11.5L14.5 14L10.5 16.5Z"


def txt(text, **kw):
    d = {"type": "text", "text": text, "font": "display", "weight": 500, "letterSpacing": -0.025, "color": INK}
    d.update(kw)
    return d


def left(text, x, y, size, **kw):
    return txt(text, x=x, y=y, size=size, align="left", anchor="left", **kw)


def ambient(y=-150, size=2800, intensity=0.06):
    return {"type": "glow", "y": y, "size": size, "color": "#A5B4FC", "intensity": intensity, "blend": "normal"}


def bg():
    return {"type": "background", "style": "solid", "color": BG}


def bars(heights, width=8, color="#C7CAF6", at=None, stagger_out=None):
    out = []
    for h in heights:
        b = {"type": "shape", "width": width, "height": h, "radius": width / 2, "fill": color}
        if at is not None:
            b["in"] = {"preset": "growY", "at": at, "duration": 0.6, "ease": SMOOTH}
        if stagger_out is not None:
            b["out"] = {"preset": "growY", "at": stagger_out, "duration": 0.4}
        out.append(b)
    return out


def clip_card(i, title, length, w=300, h=190):
    a, b = THUMBS[i % len(THUMBS)]
    return {
        "type": "group",
        "children": [
            {"type": "shape", "width": w, "height": h, "radius": 16, "fill": "#FFFFFF", "stroke": LINE, "strokeWidth": 1, "shadow": CARD_SHADOW},
            {"type": "shape", "y": 24, "width": w - 20, "height": h - 70, "radius": 10, "fill": {"type": "linear", "from": a, "to": b, "angle": 135}},
            {"type": "shape", "shape": "circle", "y": 24, "width": 40, "fill": "#FFFFFF", "opacity": 0.9},
            {"type": "icon", "name": "play", "x": 2, "y": 24, "size": 18, "color": a, "strokeWidth": 2.4},
            left(title, -w / 2 + 14, -h / 2 + 22, 16, font="body", weight=600, letterSpacing=-0.01),
            txt(length, x=w / 2 - 14, y=-h / 2 + 22, size=14, font="body", weight=500, letterSpacing=0, color=MUTED, align="right", anchor="right"),
        ],
    }


# Scene A: hook -----------------------------------------------------------------------------------
scene_hook = {
    "id": "hook",
    "duration": 4.6,
    "camera": {"moves": [
        {"preset": "pushIn", "amount": 70, "duration": 3.6, "ease": "inOutSine"},
        {"preset": "moveTo", "at": 3.7, "duration": 0.9, "y": -120, "zoom": 1.9, "ease": "inOutQuart"},
    ]},
    "layers": [
        bg(),
        ambient(),
        txt("58 minutes of meeting.", y=130, size=84, highlight=[{"text": "58 minutes", "color": ACCENT}],
            animate={"preset": "build", "at": 0.2, "stagger": 0.3}),
        {"type": "repeat", "count": 48, "layout": "line", "spacing": 16, "y": -120, "stagger": 0.012,
         "children": bars([40, 92, 60, 124, 74, 52], at=1.4)},
        {"type": "shape", "x": -384, "y": -120, "width": 3, "height": 170, "radius": 1.5, "fill": ACCENT, "start": 2.0,
         "glow": {"size": 12, "intensity": 0.5}, "in": {"preset": "fade", "duration": 0.3},
         "keyframes": {"x": [{"t": 2.0, "v": -384}, {"t": 4.4, "v": 384, "ease": "linear"}]}},
    ],
}

# Scene B: the waveform becomes a written summary -------------------------------------------------
summary_lines = [
    "Launch moves to March 14 after QA sign-off.",
    "Dana owns the pricing page refresh.",
    "Churn is down 12% since the onboarding update.",
    "Next sync: review beta feedback together.",
]
skeleton_w = [760, 560, 700, 620]
b_layers = [
    bg(),
    ambient(),
    {"type": "shape", "width": 1040, "height": 580, "radius": 28, "fill": "#FFFFFF", "stroke": LINE, "strokeWidth": 1,
     "shadow": {"blur": 70, "y": -30, "opacity": 0.12, "color": ACCENT}, "in": {"preset": "focusIn", "duration": 0.7}},
    {"type": "shape", "shape": "sparkle", "x": -470, "y": 230, "width": 26, "height": 26,
     "fill": {"type": "linear", "from": ACCENT2, "to": ACCENT, "angle": 135}, "in": {"preset": "popIn", "at": 0.3}},
    left("Summary", -448, 230, 24, weight=600, **{"in": {"preset": "fade", "at": 0.3}}),
    {"type": "repeat", "count": 44, "layout": "line", "spacing": 20, "y": 10, "stagger": 0.008,
     "children": bars([52, 110, 80, 148, 70, 96], width=8, at=0.25, stagger_out=1.2)},
]
for i, (line, w) in enumerate(zip(summary_lines, skeleton_w)):
    y = 130 - i * 62
    t_line = 2.2 + i * 0.28
    b_layers.append({"type": "shape", "x": -470 + w / 2, "y": y, "width": w, "height": 16, "radius": 8, "fill": LINE, "origin": "left",
                     "in": {"preset": "growX", "at": 1.45 + i * 0.1, "duration": 0.6, "ease": SMOOTH},
                     "out": {"preset": "fade", "at": t_line, "duration": 0.35}})
    b_layers.append(left(line, -470, y, 25, font="body", weight=500, letterSpacing=-0.01,
                         animate={"preset": "blur", "by": "word", "at": t_line, "stagger": 0.035, "duration": 0.5}))
for i, (label, w) in enumerate([("4 decisions", 170), ("7 action items", 200), ("3 highlights", 170)]):
    x = -470 + w / 2 + [0, 186, 402][i]
    b_layers.append({"type": "group", "x": x, "y": -175, "in": {"preset": "scaleIn", "from": 0.85, "at": 3.6 + i * 0.1, "duration": 0.6, "ease": SMOOTH},
                     "children": [
                         {"type": "shape", "shape": "pill", "width": w, "height": 46, "fill": SOFT},
                         txt(label, size=17, font="body", weight=600, letterSpacing=0, color=ACCENT),
                     ]})
scene_summary = {
    "id": "summary",
    "duration": 5.4,
    "transition": {"type": "blur", "duration": 0.4},
    "camera": {"moves": [{"preset": "pushIn", "amount": 70, "duration": 5.4, "ease": "inOutSine"}]},
    "layers": b_layers,
}

# Scene C: the product, and clips lifting off the timeline ----------------------------------------
sidebar = [
    {"type": "shape", "x": -640, "width": 220, "height": 812, "fill": "#F8F8FC"},
    {"type": "shape", "x": -530, "width": 1, "height": 812, "fill": LINE},
    {"type": "shape", "x": -712, "y": 360, "width": 28, "height": 28, "radius": 8, "fill": {"type": "linear", "from": ACCENT2, "to": ACCENT, "angle": 135}},
    {"type": "icon", "d": MARK, "x": -712, "y": 360, "size": 18, "color": "#FFFFFF", "strokeWidth": 2.4},
    left("Clipfold", -690, 360, 19, weight=600),
    {"type": "shape", "x": -640, "y": 296, "width": 196, "height": 40, "radius": 10, "fill": SOFT},
]
for i, (label, icon) in enumerate([("Recordings", "folder"), ("Clips", "play"), ("Shared", "send")]):
    y = 296 - i * 46
    active = i == 0
    sidebar += [
        {"type": "icon", "name": icon, "x": -718, "y": y, "size": 18, "color": ACCENT if active else MUTED},
        left(label, -698, y, 16, font="body", weight=600 if active else 500, letterSpacing=0, color=INK if active else MUTED),
    ]
summary_panel = [
    {"type": "shape", "x": -180, "y": 90, "width": 640, "height": 360, "radius": 18, "fill": "#FFFFFF", "stroke": LINE, "strokeWidth": 1},
    {"type": "shape", "shape": "sparkle", "x": -474, "y": 238, "width": 18, "height": 18, "fill": ACCENT},
    left("Summary", -458, 238, 18, weight=600),
]
for i, line in enumerate(summary_lines[:3]):
    summary_panel.append({"type": "shape", "shape": "circle", "x": -470, "y": 186 - i * 46, "width": 7, "fill": ACCENT})
    summary_panel.append(left(line, -454, 186 - i * 46, 16, font="body", weight=500, letterSpacing=0))
for i, (label, w) in enumerate([("4 decisions", 120), ("7 action items", 140), ("3 highlights", 120)]):
    summary_panel.append({"type": "group", "x": -474 + w / 2 + [0, 132, 284][i], "y": 22, "children": [
        {"type": "shape", "shape": "pill", "width": w, "height": 32, "fill": SOFT},
        txt(label, size=13, font="body", weight=600, letterSpacing=0, color=ACCENT)]})
right_panel = [
    {"type": "shape", "x": 400, "y": 90, "width": 440, "height": 360, "radius": 18, "fill": "#FFFFFF", "stroke": LINE, "strokeWidth": 1},
    left("Speakers", 202, 238, 18, weight=600),
    {"type": "chart", "kind": "donut", "data": [38, 27, 21, 14], "x": 290, "y": 70, "width": 170, "height": 170,
     "colors": [ACCENT, ACCENT2, "#A78BFA", "#F9A8D4"], "at": 0.8, "duration": 1.2},
]
for i, (initials, fill, name, share) in enumerate([("DK", "#C7D2FE", "Dana K.", "38%"), ("ML", "#BAE6FD", "Marco L.", "27%"), ("AS", "#DDD6FE", "Aisha S.", "21%"), ("JT", "#FBCFE8", "Jon T.", "14%")]):
    y = 170 - i * 50
    right_panel += [
        {"type": "avatar", "initials": initials, "x": 420, "y": y, "size": 34, "fill": fill, "color": INK},
        left(name, 446, y, 15, font="body", weight=500, letterSpacing=0),
        txt(share, x=600, y=y, size=14, font="body", weight=500, letterSpacing=0, color=MUTED, align="right", anchor="right"),
    ]
segments = [(-420, 170), (60, 210), (470, 150)]
timeline = [
    {"type": "shape", "y": -250, "width": 1380, "height": 100, "radius": 16, "fill": "#F8F8FC", "stroke": LINE, "strokeWidth": 1},
    left("Timeline", -670, -175, 15, font="body", weight=600, letterSpacing=0, color=MUTED),
    {"type": "repeat", "count": 84, "layout": "line", "spacing": 16, "y": -250, "children": bars([22, 48, 34, 62, 28, 42], width=6, color="#CDD0F2")},
]
for i, (x, w) in enumerate(segments):
    timeline.append({"type": "shape", "x": x, "y": -250, "width": w, "height": 82, "radius": 10, "fill": "#4F46E51F", "stroke": ACCENT, "strokeWidth": 1.5,
                     "in": {"preset": "fade", "at": 1.2 + i * 0.15}, "keyframes": {"intensity": [{"t": 2.45, "v": 1}, {"t": 2.6, "v": 1.6}, {"t": 3.0, "v": 1}]}})
header = [
    left("Weekly sync", -480, 345, 32, weight=600),
    left("58 min  ·  4 speakers  ·  Today", -480, 305, 16, font="body", weight=500, letterSpacing=0, color=MUTED),
    {"type": "button", "label": "Make clips", "icon": "wand", "x": 600, "y": 338, "size": 17, "height": 46, "width": 170, "fill": ACCENT, "press": 2.4},
]
clips_out = []
targets = [(-470, 190, 420), (0, 250, 470), (470, 190, 420)]
titles = [("Launch date", "0:42"), ("Pricing owner", "0:31"), ("Churn win", "0:55")]
for i, ((sx, sw), (tx, ty, tz), (title, length)) in enumerate(zip(segments, targets, titles)):
    at = 2.75 + i * 0.12
    card = clip_card(i, title, length)
    card.update({
        "start": at, "dof": False,
        "motionPath": {"points": [[sx, -260, 0], [sx * 0.6 + tx * 0.4, 60, tz * 0.5], [tx, ty, tz]], "at": at, "duration": 1.05, "ease": "inOutCubic",
                        "trail": {"color": ACCENT2, "width": 5, "length": 0.45}},
        "in": {"preset": "scaleIn", "from": 0.4, "duration": 0.6, "ease": SMOOTH},
    })
    clips_out.append(card)
scene_product = {
    "id": "product",
    "duration": 5.6,
    "transition": {"type": "blur", "duration": 0.45},
    "camera": {
        "dof": {"z": 0, "strength": 0.03, "max": 20},
        "keyframes": {"dofZ": [{"t": 2.7, "v": 0}, {"t": 3.8, "v": 440, "ease": "inOutCubic"}]},
        "moves": [{"preset": "pushIn", "amount": 120, "duration": 5.6, "ease": "inOutSine"}],
    },
    "layers": [
        bg(),
        ambient(intensity=0.07),
        {"type": "browser", "theme": "light", "url": "app.clipfold.ai/weekly-sync", "width": 1500, "height": 860, "y": -10,
         "shadow": {"blur": 120, "y": -60, "opacity": 0.13, "color": ACCENT},
         "in": {"preset": "fade", "duration": 0.7},
         "keyframes": {"rotateX": [{"t": 0, "v": 16}, {"t": 2.2, "v": 0, "ease": "smooth"}], "z": [{"t": 0, "v": -300}, {"t": 2.2, "v": 0, "ease": "smooth"}]},
         "children": sidebar + header + summary_panel + right_panel + timeline},
        {"type": "cursor", "style": "hand", "z": 80,
         "path": [{"t": 1.4, "x": 820, "y": -520}, {"t": 2.25, "x": 606, "y": 322, "ease": "inOutCubic"}, {"t": 3.2, "x": 760, "y": 120, "ease": "inOutCubic"}],
         "clicks": [2.4], "in": {"preset": "fade", "at": 1.3, "duration": 0.3}, "out": {"preset": "fade", "at": 3.0, "duration": 0.3}},
    ] + clips_out,
}

# Scene D: a cloud of clips ----------------------------------------------------------------------
cloud_titles = [("Launch date", "0:42"), ("Pricing owner", "0:31"), ("Churn win", "0:55"), ("Beta feedback", "1:04"), ("QA sign-off", "0:28"), ("Roadmap", "0:47")]
templates = []
for i, (title, length) in enumerate(cloud_titles):
    c = clip_card(i, title, length)
    c["in"] = {"preset": "scaleIn", "from": 0.6, "duration": 0.8, "ease": SMOOTH}
    templates.append(c)
scene_cloud = {
    "id": "clips",
    "duration": 4.2,
    "transition": {"type": "blur", "duration": 0.35},
    "camera": {"dof": {"z": 0, "strength": 0.045, "max": 26}, "moves": [{"preset": "pushIn", "amount": 170, "duration": 4.2, "ease": "inOutSine"}]},
    "layers": [
        bg(),
        ambient(intensity=0.07),
        {"type": "repeat", "count": 12, "layout": "scatter", "area": [2200, 1150, 1500], "jitter": 34, "stagger": 0.035, "seed": 11, "children": templates},
        {"type": "shape", "width": 1080, "height": 150, "radius": 75, "fill": BG, "opacity": 0.86, "blur": 30, "in": {"preset": "fade", "at": 0.4}},
        txt("One meeting. Twelve clips.", size=70, highlight=[{"text": "Twelve clips.", "color": ACCENT}],
            animate={"preset": "build", "at": 0.5, "stagger": 0.28}),
    ],
}

# Scene E: the clips fold into the logo -----------------------------------------------------------
fold_cards = []
for i, (rot, x0) in enumerate([(-10, -60), (8, 60), (0, 0)]):
    top = i == 2
    k = {
        "x": [{"t": 0.9, "v": x0}, {"t": 1.6, "v": -236, "ease": "inOutQuart"}],
        "y": [{"t": 0.9, "v": 0}, {"t": 1.6, "v": 4, "ease": "inOutQuart"}],
        "rotate": [{"t": 0.9, "v": rot}, {"t": 1.6, "v": 0, "ease": "inOutQuart"}],
        "width": [{"t": 1.0, "v": 300}, {"t": 1.6, "v": 118, "ease": "inOutQuart"}],
        "height": [{"t": 1.0, "v": 190}, {"t": 1.6, "v": 118, "ease": "inOutQuart"}],
        "radius": [{"t": 1.0, "v": 16}, {"t": 1.6, "v": 32, "ease": "inOutQuart"}],
    }
    shape = {"type": "shape", "width": 300, "height": 190, "radius": 16, "fill": {"type": "linear", "from": "#FFFFFF", "to": "#FFFFFF", "angle": 135},
             "stroke": LINE, "strokeWidth": 1, "shadow": CARD_SHADOW, "keyframes": k,
             "in": {"preset": "scaleIn", "from": 0.8, "at": i * 0.08, "duration": 0.7, "ease": SMOOTH}}
    if top:
        k["fill"] = [{"t": 1.25, "v": "#FFFFFF"}, {"t": 1.7, "v": ACCENT2}]
        k["fillTo"] = [{"t": 1.25, "v": "#FFFFFF"}, {"t": 1.7, "v": ACCENT}]
        k["strokeWidth"] = [{"t": 1.3, "v": 1}, {"t": 1.6, "v": 0}]
    else:
        shape["out"] = {"preset": "fade", "at": 1.5, "duration": 0.25}
    fold_cards.append(shape)
    if top:
        fold_cards.append({"type": "group", "x": 0, "y": 24, "children": [
            {"type": "shape", "width": 280, "height": 120, "radius": 10, "fill": {"type": "linear", "from": ACCENT, "to": ACCENT2, "angle": 135}},
            {"type": "icon", "name": "play", "size": 22, "color": "#FFFFFF", "strokeWidth": 2.4}],
            "out": {"preset": "fade", "at": 0.9, "duration": 0.3}})
scene_logo = {
    "id": "logo",
    "duration": 5.4,
    "transition": {"type": "blur", "duration": 0.4},
    "camera": {"moves": [{"preset": "pushIn", "amount": 50, "duration": 5.4, "ease": "inOutSine"}]},
    "layers": [
        bg(),
        ambient(y=-40, intensity=0.07),
    ] + fold_cards + [
        {"type": "icon", "d": MARK, "x": -236, "y": 4, "size": 66, "color": "#FFFFFF", "strokeWidth": 2.1,
         "start": 1.6, "keyframes": {"progress": [{"t": 1.6, "v": 0}, {"t": 2.2, "v": 1, "ease": "inOutCubic"}]}},
        txt("Clipfold", x=96, y=4, size=108, weight=600, letterSpacing=-0.035, **{"in": {"preset": "focusIn", "at": 1.85, "duration": 1.0}}),
        txt("Meetings, made watchable.", y=-130, size=36, color=MUTED, animate={"preset": "build", "at": 2.6, "stagger": 0.24}),
        txt("clipfold.ai", y=-200, size=22, font="body", weight=600, letterSpacing=0.01, color=INK, **{"in": {"preset": "fade", "at": 3.5, "duration": 0.8}}),
    ],
}

video = {
    "title": "Clipfold",
    "fps": 30,
    "theme": {
        "colors": {"bg": BG, "text": INK, "muted": MUTED, "primary": ACCENT, "secondary": ACCENT2, "surface": "#FFFFFF", "surface2": "#F8F8FC", "border": LINE},
        "fonts": {"display": "Inter", "body": "Inter", "mono": "JetBrains Mono"},
    },
    "post": {"bloom": False, "grain": 0, "vignette": 0, "chromatic": 0},
    "motionBlur": {"samples": 10, "shutter": 0.55},
    "scenes": [scene_hook, scene_summary, scene_product, scene_cloud, scene_logo],
}

write_spec(ROOT / "examples" / "clipfold-flow.json", video)
