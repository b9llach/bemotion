"""Builds examples/tempo-apple.json: a clean, Apple-style launch film (black, white, one ambient color)."""
import json
import pathlib
from genlib import ROOT, write_spec

INK = "#1D1D1F"
GRAY = "#86868B"
LIGHT = "#F5F5F7"
BLUE = "#0071E3"
SMOOTH = "outQuart"


def txt(text, **kw):
    d = {"type": "text", "text": text, "font": "display", "weight": 600, "letterSpacing": -0.03}
    d.update(kw)
    return d


# Calendar geometry inside the browser content area (1400 x 792, origin at its center).
TOP, HOUR = 240, 77.5
COLS = [-328, -104, 120, 344, 568]
STYLES = {
    "work": {"fill": "#EAF2FE", "bar": BLUE, "title": "#0A4FB5"},
    "focus": {"fill": "#F0F0F2", "bar": INK, "title": INK},
    "personal": {"fill": "#F6F6F8", "bar": "#AEAEB2", "title": "#3A3A3C"},
}


def event(col, start, dur, title, time, style, at):
    st = STYLES[style]
    h = dur * HOUR - 6
    cy = TOP - (start + dur / 2) * HOUR
    return {
        "type": "group", "x": COLS[col], "y": round(cy, 2),
        "in": {"preset": "slideUp", "distance": 14, "at": round(at, 2), "duration": 0.8, "ease": SMOOTH},
        "children": [
            {"type": "shape", "width": 208, "height": round(h, 2), "radius": 10, "fill": st["fill"]},
            {"type": "shape", "x": -98, "width": 4, "height": round(h - 16, 2), "radius": 2, "fill": st["bar"]},
            txt(title, x=-86, y=round(h / 2 - 22, 2), size=15, font="body", weight=600, letterSpacing=-0.01, color=st["title"], align="left", anchor="left"),
            txt(time, x=-86, y=round(h / 2 - 42, 2), size=13, font="body", weight=500, letterSpacing=0, color=GRAY, align="left", anchor="left"),
        ],
    }


EVENTS = [
    (0, 0, 1, "Team standup", "9:00", "work"),
    (0, 2, 2, "Deep work", "11:00 - 1:00", "focus"),
    (1, 1, 1, "Design review", "10:00", "work"),
    (1, 4.5, 1, "1:1 with Maya", "1:30", "personal"),
    (2, 0, 3, "Q4 roadmap", "9:00 - 12:00", "focus"),
    (2, 5, 1, "Customer call", "2:00", "work"),
    (3, 1.5, 1, "Sprint planning", "10:30", "work"),
    (3, 3.5, 1.5, "Deep work", "12:30 - 2:00", "focus"),
    (4, 0, 1, "Standup", "9:00", "work"),
    (4, 2, 1, "Lunch with Alex", "11:00", "personal"),
]
event_layers = [event(c, s, d, t, tm, st, 0.9 + i * 0.07) for i, (c, s, d, t, tm, st) in enumerate(EVENTS)]

# The moment of magic: Tempo finds focus time and drops it in.
found = event(4, 4, 2, "Focus time", "1:00 - 3:00", "work", 3.0)
found["in"] = {"preset": "scaleIn", "from": 0.9, "at": 3.0, "duration": 0.9, "ease": SMOOTH}
found["children"][0]["stroke"] = BLUE
found["children"][0]["strokeWidth"] = 1.5

grid = []
for i in range(9):
    grid.append({"type": "shape", "x": 120, "y": TOP - i * HOUR, "width": 1120, "height": 1, "fill": "#EFEFF2"})
for x in [-216, 8, 232, 456]:
    grid.append({"type": "shape", "x": x, "y": TOP - 4 * HOUR, "width": 1, "height": 8 * HOUR, "fill": "#F0F0F3"})
DAYS = ["Mon 19", "Tue 20", "Wed 21", "Thu 22", "Fri 23"]
headers = [
    txt(d, x=COLS[i], y=280, size=16, font="body", weight=600 if i == 3 else 500, letterSpacing=0, color=BLUE if i == 3 else GRAY)
    for i, d in enumerate(DAYS)
]

sidebar = [
    {"type": "shape", "x": -580, "width": 240, "height": 792, "fill": LIGHT},
    {"type": "shape", "x": -460, "width": 1, "height": 792, "fill": "#E5E5EA"},
    txt("Tempo", x=-670, y=340, size=22, weight=700, color=INK, align="left", anchor="left"),
    txt("CALENDARS", x=-670, y=280, size=12, font="body", weight=600, letterSpacing=0.08, color=GRAY, align="left", anchor="left"),
]
for i, (name, col) in enumerate([("Work", BLUE), ("Focus", INK), ("Personal", "#AEAEB2")]):
    y = 240 - i * 40
    sidebar += [
        {"type": "shape", "shape": "circle", "x": -664, "y": y, "width": 12, "fill": col},
        txt(name, x=-646, y=y, size=16, font="body", weight=500, letterSpacing=0, color=INK, align="left", anchor="left"),
    ]

calendar_ui = sidebar + [
    txt("October 2026", x=-420, y=340, size=30, weight=700, color=INK, align="left", anchor="left"),
    {"type": "shape", "shape": "pill", "x": 590, "y": 340, "width": 180, "height": 36, "fill": LIGHT},
    {"type": "shape", "shape": "pill", "x": 545, "y": 340, "width": 86, "height": 30, "fill": "#FFFFFF", "shadow": {"blur": 8, "y": -2, "opacity": 0.12}},
    txt("Week", x=545, y=340, size=14, font="body", weight=600, letterSpacing=0, color=INK),
    txt("Month", x=635, y=340, size=14, font="body", weight=500, letterSpacing=0, color=GRAY),
] + headers + grid + event_layers + [found]


def phone_row(i, title, time, accent, at, highlight=False):
    entrance = (
        {"preset": "scaleIn", "from": 0.9, "at": at, "duration": 0.9, "ease": SMOOTH}
        if highlight
        else {"preset": "slideUp", "distance": 20, "at": at, "duration": 0.8, "ease": SMOOTH}
    )
    card = {"type": "shape", "width": 326, "height": 76, "radius": 16, "fill": "#1C1C1E"}
    if highlight:
        card.update({"stroke": BLUE, "strokeWidth": 1.5})
    return {
        "type": "group", "y": 190 - i * 90, "in": entrance,
        "children": [
            card,
            {"type": "shape", "x": -149, "width": 4, "height": 50, "radius": 2, "fill": accent},
            txt(title, x=-132, y=12, size=17, font="body", weight=600, letterSpacing=-0.01, color="#F5F5F7", align="left", anchor="left"),
            txt(time, x=-132, y=-14, size=14, font="body", weight=500, letterSpacing=0, color="#8E8E93", align="left", anchor="left"),
        ],
    }


def camera(amount, duration):
    return {"moves": [{"preset": "pushIn", "amount": amount, "duration": duration, "ease": "inOutSine"}]}


video = {
    "title": "Tempo",
    "fps": 30,
    "theme": {
        "colors": {"bg": "#000000", "text": INK, "muted": GRAY, "surface": "#FFFFFF", "surface2": LIGHT, "border": "#E5E5EA", "primary": BLUE},
        "fonts": {"display": "Inter", "body": "Inter", "mono": "JetBrains Mono"},
    },
    "post": {"bloom": False, "grain": 0, "vignette": 0, "chromatic": 0},
    "motionBlur": {"samples": 8, "shutter": 0.5},
    "scenes": [
        {
            "id": "intro", "duration": 3.2, "camera": camera(80, 3.2),
            "layers": [
                {"type": "background", "style": "solid", "color": "#000000"},
                {"type": "glow", "y": -80, "size": 1500, "color": "#3B82F6", "intensity": 0.13, "in": {"preset": "fade", "duration": 2.4}},
                txt("Meet Tempo.", size=132, color="#F5F5F7", letterSpacing=-0.035,
                    animate={"preset": "lift", "by": "word", "at": 0.5, "stagger": 0.14, "duration": 1.1, "ease": SMOOTH}),
            ],
        },
        {
            "id": "promise", "duration": 3.4, "transition": {"type": "fade", "duration": 0.5}, "camera": camera(60, 3.4),
            "layers": [
                {"type": "background", "style": "solid", "color": "#FFFFFF"},
                txt("Your week,", y=72, size=120, color=INK, letterSpacing=-0.035,
                    animate={"preset": "lift", "by": "line", "at": 0.3, "duration": 1.0, "ease": SMOOTH}),
                txt("finally in focus.", y=-72, size=120, color=GRAY, letterSpacing=-0.035,
                    animate={"preset": "lift", "by": "line", "at": 0.6, "duration": 1.0, "ease": SMOOTH}),
            ],
        },
        {
            "id": "calendar", "duration": 6.2, "transition": {"type": "blur", "duration": 0.6}, "camera": camera(150, 6.2),
            "layers": [
                {"type": "background", "style": "radial", "colors": ["#FFFFFF", "#EEF1F6"], "center": [0, -120], "intensity": 1.2},
                {"type": "glow", "y": -40, "size": 1800, "color": "#7AB8FF", "intensity": 0.16, "blend": "normal"},
                {
                    "type": "browser", "theme": "light", "url": "tempo.app/week", "width": 1400, "height": 840, "y": -10,
                    "shadow": {"blur": 120, "y": -60, "opacity": 0.16},
                    "in": {"preset": "fade", "duration": 1.0},
                    "keyframes": {
                        "rotateX": [{"t": 0, "v": 18}, {"t": 2.6, "v": 0, "ease": "smooth"}],
                        "z": [{"t": 0, "v": -260}, {"t": 2.6, "v": 0, "ease": "smooth"}],
                    },
                    "children": calendar_ui,
                },
                {
                    "type": "toast", "theme": "light", "title": "Tempo found 2 hours of focus", "body": "Friday, 1:00 - 3:00",
                    "icon": "sparkles", "accent": BLUE, "width": 460, "x": 560, "y": -400, "z": 60, "start": 3.6,
                    "in": {"preset": "slideUp", "distance": 30, "duration": 0.9, "ease": SMOOTH},
                },
            ],
        },
        {
            "id": "mobile", "duration": 4.6, "transition": {"type": "fade", "duration": 0.6}, "camera": camera(80, 4.6),
            "layers": [
                {"type": "background", "style": "solid", "color": "#000000"},
                {"type": "glow", "x": 420, "size": 1500, "color": "#2563EB", "intensity": 0.17, "in": {"preset": "fade", "duration": 2}},
                txt("Plans your day.\nAutomatically.", x=-820, y=40, size=92, color="#F5F5F7", align="left", anchor="left", lineHeight=1.08,
                    letterSpacing=-0.035, highlight=[{"text": "Automatically.", "color": GRAY}],
                    animate={"preset": "lift", "by": "line", "at": 0.3, "stagger": 0.18, "duration": 1.0, "ease": SMOOTH}),
                {
                    "type": "phone", "x": 420, "y": -10, "color": "#1C1C1E", "screen": "#000000",
                    "in": {"preset": "focusIn", "duration": 1.4, "ease": SMOOTH},
                    "keyframes": {"rotateY": [{"t": 0, "v": -28}, {"t": 4.6, "v": -10, "ease": "smooth"}]},
                    "children": [
                        txt("Today", x=-150, y=320, size=34, weight=700, color="#F5F5F7", align="left", anchor="left"),
                        txt("Thursday, October 22", x=-150, y=282, size=15, font="body", weight=500, letterSpacing=0, color="#8E8E93", align="left", anchor="left"),
                        phone_row(0, "Sprint planning", "10:30", BLUE, 0.8),
                        phone_row(1, "Deep work", "12:30 - 2:00", "#F5F5F7", 0.92),
                        phone_row(2, "Customer call", "2:00", BLUE, 1.04),
                        phone_row(3, "Focus time", "3:00 - 5:00", BLUE, 2.2, highlight=True),
                        phone_row(4, "Gym", "6:00", "#636366", 1.16),
                    ],
                },
            ],
        },
        {
            "id": "stat", "duration": 3.4, "transition": {"type": "fade", "duration": 0.5}, "camera": camera(60, 3.4),
            "layers": [
                {"type": "background", "style": "solid", "color": "#FFFFFF"},
                {
                    "type": "counter", "from": 0, "to": 3.5, "decimals": 1, "suffix": " hours", "y": 60, "size": 180, "weight": 600,
                    "letterSpacing": -0.04, "color": INK, "at": 0.3, "duration": 2.0, "ease": SMOOTH, "in": {"preset": "focusIn", "duration": 1.0},
                },
                txt("back in every person's week.", y=-90, size=40, font="body", weight=500, letterSpacing=-0.01, color=GRAY,
                    animate={"preset": "lift", "by": "line", "at": 0.7, "duration": 0.9, "ease": SMOOTH}),
            ],
        },
        {
            "id": "end", "duration": 4.2, "transition": {"type": "black", "duration": 0.8}, "camera": camera(50, 4.2),
            "layers": [
                {"type": "background", "style": "solid", "color": "#000000"},
                {"type": "glow", "y": -40, "size": 1700, "color": "#3B82F6", "intensity": 0.13, "in": {"preset": "fade", "duration": 2.4}},
                {
                    "type": "group", "y": 60, "in": {"preset": "focusIn", "at": 0.3, "duration": 1.4, "ease": SMOOTH},
                    "children": [
                        {"type": "shape", "shape": "circle", "x": -178, "width": 96, "fill": {"type": "linear", "from": "#FFFFFF", "to": "#C7CCD6", "angle": 160}},
                        {"type": "icon", "name": "clock", "x": -178, "size": 50, "color": "#000000", "strokeWidth": 2.2},
                        txt("Tempo", x=55, size=120, color="#F5F5F7", letterSpacing=-0.04),
                    ],
                },
                txt("Available today on Mac, iPhone and the web.", y=-70, size=34, font="body", weight=500, letterSpacing=-0.01, color=GRAY,
                    **{"in": {"preset": "fade", "at": 1.3, "duration": 1.0}}),
                txt("tempo.app", y=-140, size=24, font="body", weight=600, letterSpacing=0, color="#F5F5F7",
                    **{"in": {"preset": "fade", "at": 1.8, "duration": 1.0}}),
            ],
        },
    ],
}

write_spec(ROOT / "examples" / "tempo-apple.json", video)
