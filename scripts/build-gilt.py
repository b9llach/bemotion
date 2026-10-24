"""Builds examples/gilt-card.json: an original launch film for a fictional metal rewards card.

The camera follows a gold metal card as it flies through a checkout register; the payment is approved,
gold coins burst out the far side and cash back counts up. Dark, warm, premium.
"""
import json
import pathlib
import sys

BLACK = "#07060A"
INK = "#F5EFE2"
MUTED = "#9C9384"
GOLD = "#E2B85A"
GOLD_LIGHT = "#F6DD9A"
GOLD_DEEP = "#8A6420"
ENGRAVE = "#5A400F"
SMOOTH = "outQuart"

CARD_W, CARD_H, CARD_D = 520, 328, 8
FACE = CARD_D / 2 + 0.6


def txt(text, **kw):
    d = {"type": "text", "text": text, "font": "display", "weight": 500, "letterSpacing": -0.025, "color": INK}
    d.update(kw)
    return d


def left(text, x, y, size, **kw):
    return txt(text, x=x, y=y, size=size, align="left", anchor="left", **kw)


def chip(x, y):
    lines = [{"type": "shape", "y": dy, "width": 74, "height": 1.6, "fill": GOLD_DEEP} for dy in (-10, 10)]
    lines += [{"type": "shape", "x": dx, "width": 1.6, "height": 56, "fill": GOLD_DEEP} for dx in (-13, 13)]
    return {"type": "group", "x": x, "y": y, "children": [
        {"type": "shape", "width": 74, "height": 56, "radius": 11, "fill": {"type": "linear", "from": GOLD_LIGHT, "to": "#B98A2F", "angle": 135},
         "stroke": GOLD_DEEP, "strokeWidth": 1.2},
    ] + lines}


def card(**kw):
    """The metal card: a gold slab with engraved front details and a back face."""
    front = [
        chip(-170, 34),
        {"type": "icon", "name": "contactless", "x": -100, "y": 34, "size": 36, "color": ENGRAVE, "strokeWidth": 2.2},
        txt("Gilt", x=200, y=112, size=42, weight=600, letterSpacing=-0.03, color=ENGRAVE, align="right", anchor="right"),
        {"type": "shape", "shape": "sparkle", "x": 222, "y": 120, "width": 18, "height": 18, "fill": ENGRAVE},
        left("4821  0057  1193  0915", -218, -62, 25, font="mono", weight=500, letterSpacing=0.04, color=ENGRAVE),
        left("AVERY MORGAN", -218, -112, 17, font="body", weight=600, letterSpacing=0.14, color=ENGRAVE),
        txt("METAL", x=218, y=-112, size=14, font="body", weight=700, letterSpacing=0.22, color=ENGRAVE, align="right", anchor="right"),
    ]
    back = [
        {"type": "shape", "y": 92, "width": CARD_W, "height": 62, "fill": "#17140F"},
        {"type": "shape", "x": -60, "y": 0, "width": 300, "height": 44, "radius": 4, "fill": "#E9DFC6"},
        left("Gilt Rewards", -218, -110, 16, font="body", weight=600, letterSpacing=0.08, color=ENGRAVE),
    ]
    g = {
        "type": "group",
        "children": [
            {"type": "mesh", "geometry": "slab", "size": [CARD_W, CARD_H, CARD_D], "radius": 30, "material": "gold", "color": GOLD},
            {"type": "group", "z": FACE, "children": front},
            {"type": "group", "z": -FACE, "rotateY": 180, "children": back},
        ],
    }
    g.update(kw)
    return g


def still_test():
    return {
        "fps": 30,
        "environment": "studio",
        "post": {"bloom": {"strength": 0.35, "threshold": 1.1}, "grain": 0.02, "vignette": 0.35, "tonemap": "aces", "exposure": 1.0},
        "scenes": [{
            "duration": 4,
            "layers": [
                {"type": "background", "style": "radial", "colors": ["#1A140C", BLACK], "center": [0, 120]},
                card(rotateX=-14, rotateY=28, loop={"preset": "spin", "axis": "y", "speed": 30}),
            ],
        }],
    }


if __name__ == "__main__" and "--test" in sys.argv:
    p = pathlib.Path(__file__).resolve().parent.parent / "examples" / "dev" / "card-test.json"
    p.write_text(json.dumps(still_test(), indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {p}")


# ---------------------------------------------------------------------------------------------------
# Full film
# ---------------------------------------------------------------------------------------------------
import math

DIST = 1080 / 2 / math.tan(math.radians(15))  # default camera distance (fov 30)
REG_Z = -2600
PASS_Y = 240
PATH = [[0, 0, 0], [260, 140, -900], [-120, PASS_Y, -1900], [0, PASS_Y, REG_Z], [0, PASS_Y + 520, REG_Z - 1500]]
LAUNCH, FLIGHT = 3.3, 2.8


def pass_time():
    """When the card crosses the ring plane (polyline approximation of the curve, inOutSine ease)."""
    seg = [math.dist(PATH[i], PATH[i + 1]) for i in range(len(PATH) - 1)]
    u = sum(seg[:3]) / sum(seg)
    p = math.acos(1 - 2 * u) / math.pi
    return LAUNCH + p * FLIGHT


PASS = round(pass_time(), 2)


def register():
    screen = [
        {"type": "shape", "width": 380, "height": 150, "radius": 18, "fill": "#0C0B09", "stroke": "#3A3428", "strokeWidth": 1.5},
        txt("Total", x=-150, y=38, size=20, font="body", weight=500, letterSpacing=0, color=MUTED, align="left", anchor="left", end=PASS),
        txt("$48.20", x=-150, y=-14, size=52, weight=600, color=INK, align="left", anchor="left", end=PASS),
        {"type": "group", "start": PASS, "in": {"preset": "popIn", "duration": 0.6}, "children": [
            {"type": "shape", "shape": "circle", "x": -118, "width": 58, "fill": GOLD},
            {"type": "icon", "name": "check", "x": -118, "size": 30, "color": BLACK, "strokeWidth": 3,
             "keyframes": {"progress": [{"t": PASS + 0.05, "v": 0}, {"t": PASS + 0.45, "v": 1, "ease": "outCubic"}]}},
            txt("Approved", x=-72, y=0, size=40, weight=600, color=GOLD_LIGHT, align="left", anchor="left"),
        ]},
    ]
    flash = [{"t": PASS - 0.05, "v": "#7A561A"}, {"t": PASS + 0.05, "v": "#FFF3CF"}, {"t": PASS + 1.2, "v": "#B9892E", "ease": "outCubic"}]
    return {
        "type": "group", "id": "register", "z": REG_Z,
        "in": {"preset": "fade", "at": LAUNCH + 0.2, "duration": 0.9},
        "children": [
            {"type": "mesh", "geometry": "plane", "size": [9000, 9000, 1], "material": "glossy", "color": "#0A090B", "roughness": 0.18, "y": -180, "rotateX": -90},
            {"type": "mesh", "geometry": "torus", "radius": 440, "tube": 30, "material": "brushed", "color": "#2C2B30", "y": PASS_Y},
            {"type": "mesh", "geometry": "torus", "radius": 440, "tube": 5, "material": "neon", "color": "#7A561A", "emissiveIntensity": 3, "y": PASS_Y, "z": 31,
             "keyframes": {"color": flash}},
            {"type": "mesh", "geometry": "slab", "size": [860, 240, 440], "radius": 46, "material": "brushed", "color": "#26252A", "y": -60},
            {"type": "group", "y": -60, "z": 221, "children": screen},
            {"type": "icon", "name": "contactless", "x": 330, "y": -60, "z": 221, "size": 44, "color": "#5E5547", "strokeWidth": 2},
        ],
    }


def scene_journey():
    free_z = REG_Z + 2250 - DIST
    return {
        "id": "journey",
        "duration": 9.0,
        "camera": {
            "follow": {"target": "card", "offset": [0, 70, 950]},
            "keyframes": {
                "follow": [{"t": 0, "v": 0}, {"t": LAUNCH - 0.2, "v": 0}, {"t": LAUNCH + 0.6, "v": 1, "ease": "inOutCubic"},
                           {"t": PASS + 0.2, "v": 1}, {"t": PASS + 1.3, "v": 0, "ease": "inOutCubic"}],
                "z": [{"t": 0, "v": 0}, {"t": LAUNCH - 0.2, "v": -380, "ease": "inOutSine"}, {"t": LAUNCH + 0.6, "v": -380},
                      {"t": PASS, "v": free_z}, {"t": 9.0, "v": free_z + 260, "ease": "inOutSine"}],
                "y": [{"t": LAUNCH + 0.6, "v": 0}, {"t": PASS, "v": 380}],
                "targetY": [{"t": LAUNCH + 0.6, "v": 0}, {"t": PASS, "v": 360}],
                "targetZ": [{"t": LAUNCH + 0.6, "v": 0}, {"t": PASS, "v": REG_Z}],
            },
            "moves": [{"preset": "orbit", "at": LAUNCH + 0.4, "duration": 3.4, "angle": -16, "ease": "inOutSine"}],
        },
        "layers": [
            {"type": "background", "style": "radial", "colors": ["#17120A", BLACK], "center": [0, 140], "intensity": 1.3},
            {"type": "particles", "count": 700, "motion": "drift", "area": [3600, 2000, 4200], "z": -1500, "size": [2, 5],
             "colors": [GOLD_LIGHT, GOLD, "#FFFFFF"], "speed": 0.6},
            txt("Meet Gilt.", y=-300, size=76, weight=500, letterSpacing=-0.03,
                animate={"preset": "build", "at": 0.6, "stagger": 0.32}, **{"out": {"preset": "fade", "at": LAUNCH - 0.5, "duration": 0.4}}),
            txt("The metal card that pays you back.", y=-385, size=30, font="body", color=MUTED, letterSpacing=-0.01,
                animate={"preset": "blur", "by": "word", "at": 1.4, "stagger": 0.05}, **{"out": {"preset": "fade", "at": LAUNCH - 0.5, "duration": 0.4}}),
            register(),
            card(
                id="card",
                motionPath={"points": PATH, "at": LAUNCH, "duration": FLIGHT, "ease": "inOutSine"},
                keyframes={
                    "rotateY": [{"t": 0, "v": 34}, {"t": LAUNCH - 0.3, "v": -16, "ease": "inOutSine"}, {"t": LAUNCH + 0.5, "v": 0, "ease": "inOutCubic"}],
                    "rotateX": [{"t": 0, "v": -12}, {"t": LAUNCH - 0.3, "v": -6, "ease": "inOutSine"}, {"t": LAUNCH + 0.5, "v": -14, "ease": "inOutCubic"}],
                    "rotateZ": [{"t": LAUNCH + 0.4, "v": 0}, {"t": LAUNCH + 1.4, "v": -14, "ease": "inOutSine"}, {"t": PASS - 0.1, "v": 0, "ease": "inOutSine"}],
                },
                **{"in": {"preset": "focusIn", "duration": 1.2, "blur": 18}, "out": {"preset": "blurIn", "at": PASS + 0.35, "duration": 0.6}},
            ),
            {"type": "confetti", "pieces": "coin", "at": PASS + 0.02, "z": REG_Z, "y": PASS_Y, "count": 70, "power": 1500, "gravity": 1100, "drag": 1.6,
             "size": [40, 62], "colors": [GOLD_LIGHT, GOLD, "#C99A3E"], "duration": 3.2},
            {"type": "counter", "from": 0, "to": 1.45, "decimals": 2, "prefix": "+$", "z": REG_Z, "y": 880, "size": 96, "weight": 600,
             "color": GOLD_LIGHT, "start": PASS + 0.15, "at": PASS + 0.2, "duration": 1.2, "ease": SMOOTH,
             "in": {"preset": "focusIn", "duration": 0.8}},
            txt("back, instantly.", z=REG_Z, y=790, size=34, font="body", color=INK, letterSpacing=-0.01, start=PASS + 0.3,
                animate={"preset": "blur", "by": "word", "at": PASS + 0.4, "stagger": 0.06}),
        ],
    }


def scene_rewards():
    bullets = []
    for i, line in enumerate(["No annual fee", "Rewards paid the moment you pay", "Cast in solid metal"]):
        y = -90 - i * 62
        bullets += [
            {"type": "shape", "shape": "sparkle", "x": -808, "y": y, "width": 20, "height": 20, "fill": GOLD, "in": {"preset": "popIn", "at": 1.4 + i * 0.15}},
            txt(line, x=-780, y=y, size=30, font="body", color=INK, letterSpacing=-0.01, align="left", anchor="left",
                **{"in": {"preset": "blurIn", "at": 1.45 + i * 0.15, "duration": 0.6}}),
        ]
    return {
        "id": "rewards",
        "duration": 4.8,
        "transition": {"type": "blur", "duration": 0.45},
        "camera": {"moves": [{"preset": "pushIn", "amount": 80, "duration": 4.8, "ease": "inOutSine"}]},
        "layers": [
            {"type": "background", "style": "radial", "colors": ["#17120A", BLACK], "center": [420, 0], "intensity": 1.2},
            card(x=440, y=10, scale=0.95, rotateY=-26, rotateX=-8,
                 loop=[{"preset": "sway", "amount": 6, "period": 6}, {"preset": "float", "amount": 10, "period": 4}],
                 **{"in": {"preset": "focusIn", "duration": 1.2, "blur": 20}}),
            txt("3% back", x=-820, y=150, size=130, weight=600, color=GOLD_LIGHT, letterSpacing=-0.04, align="left", anchor="left",
                animate={"preset": "blur", "by": "char", "at": 0.25, "stagger": 0.035}),
            txt("on every purchase.", x=-820, y=40, size=50, color=INK, letterSpacing=-0.02, align="left", anchor="left",
                animate={"preset": "lift", "by": "line", "at": 0.7}),
        ] + bullets,
    }


def scene_end():
    return {
        "id": "end",
        "duration": 4.8,
        "transition": {"type": "fade", "duration": 0.5},
        "camera": {"moves": [{"preset": "pushIn", "amount": 60, "duration": 4.8, "ease": "inOutSine"}]},
        "layers": [
            {"type": "background", "style": "radial", "colors": ["#1A140B", BLACK], "center": [0, 120], "intensity": 1.2},
            card(y=110, scale=0.82, rotateX=-10,
                 keyframes={"rotateY": [{"t": 0, "v": -200}, {"t": 1.6, "v": -8, "ease": "outQuart"}, {"t": 4.8, "v": 10, "ease": "inOutSine"}]},
                 **{"in": {"preset": "focusIn", "duration": 1.0, "blur": 22}}),
            {"type": "group", "y": -205, "in": {"preset": "focusIn", "at": 1.3, "duration": 1.0}, "children": [
                txt("Gilt", x=-14, size=96, weight=600, color=INK, letterSpacing=-0.04),
                {"type": "shape", "shape": "sparkle", "x": 92, "y": 30, "width": 30, "height": 30, "fill": GOLD},
            ]},
            txt("Gold that pays you back.", y=-300, size=32, font="body", color=MUTED, letterSpacing=-0.01,
                animate={"preset": "build", "at": 1.9, "stagger": 0.22}),
            txt("Apply in the Gilt app", y=-370, size=20, font="body", weight=600, color=GOLD, letterSpacing=0.04,
                **{"in": {"preset": "fade", "at": 2.9, "duration": 0.8}}),
        ],
    }


def film():
    return {
        "title": "Gilt",
        "fps": 30,
        "environment": "studio",
        "theme": {"colors": {"bg": BLACK, "text": INK, "muted": MUTED, "primary": GOLD, "secondary": GOLD_LIGHT}, "fonts": {"display": "Inter", "body": "Inter"}},
        "post": {"bloom": {"strength": 0.3, "threshold": 1.25, "radius": 0.45}, "grain": 0.025, "vignette": 0.4, "tonemap": "aces"},
        "motionBlur": {"samples": 10, "shutter": 0.6},
        "sounds": [
            {"sound": "whoosh", "at": LAUNCH + 0.1, "gain": 1.0},
            {"sound": "whoosh", "at": PASS - 0.35, "gain": 0.9},
            {"sound": "chime", "at": PASS + 0.05, "gain": 1.0},
        ],
        "scenes": [scene_journey(), scene_rewards(), scene_end()],
    }


if __name__ == "__main__" and "--test" not in sys.argv:
    from genlib import ROOT, write_spec

    write_spec(ROOT / "examples" / "gilt-card.json", film())
