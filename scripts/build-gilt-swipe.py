"""Builds examples/gilt-swipe.json: a white-studio product film for a fictional metal rewards card.

Beats: the card flies in from the left and tips its bottom edge toward the camera, a glare catches the
top-right corner, the card darts off, the camera swings to an angled countertop terminal, the card drops
into the side swipe slot and runs down its length, the status lights fire and the screen approves, and
the cash back lands.
"""
from genlib import ROOT, write_spec
from terminal import MM, FACE_LEN, slot_frame, terminal

WHITE = "#FFFFFF"
INK = "#111114"
MUTED = "#86868B"
GOLD = "#D7AC52"
GOLD_TEXT = "#B5862B"
ENGRAVE = "#6E5016"
SMOOTH = "outQuart"

CARD_W, CARD_H, CARD_D = 520, 328, 7
FACE = CARD_D / 2 + 0.5

GROUND = -380
TERM = {"x": 1650, "z": -700, "rotateY": -30}

# Timeline (scene 1).
T_IN, T_GLARE, T_LEAVE = 0.0, 1.55, 1.95
T_PAN, T_PAN_END = 2.0, 2.9
T_SEAT, T_SLIDE, T_SLIDE_END, T_OUT = 3.05, 3.12, 3.62, 4.15
T_LED = T_SLIDE + 0.08
T_APPROVE = T_SLIDE_END + 0.05
SCENE1 = 7.2

INSERT = 9 * MM  # how deep the card's edge rides in the slot
SLIDE = FACE_LEN * MM / 2 - CARD_W / 2 - 20  # travel either side of the slot center


def txt(text, **kw):
    d = {"type": "text", "text": text, "font": "display", "weight": 500, "letterSpacing": -0.025, "color": INK}
    d.update(kw)
    return d


def chip(x, y):
    lines = [{"type": "shape", "y": dy, "width": 72, "height": 1.4, "fill": "#9C7629"} for dy in (-10, 10)]
    lines += [{"type": "shape", "x": dx, "width": 1.4, "height": 54, "fill": "#9C7629"} for dx in (-12, 12)]
    return {"type": "group", "x": x, "y": y, "children": [
        {"type": "shape", "width": 72, "height": 54, "radius": 10, "fill": {"type": "linear", "from": "#F7E2A8", "to": "#C2953A", "angle": 135},
         "stroke": "#9C7629", "strokeWidth": 1},
    ] + lines}


def card(glare_at=None, **kw):
    front = [
        chip(-170, 36),
        {"type": "icon", "name": "contactless", "x": -102, "y": 36, "size": 34, "color": ENGRAVE, "strokeWidth": 2.1},
        txt("Gilt", x=196, y=114, size=40, weight=600, letterSpacing=-0.03, color=ENGRAVE, align="right", anchor="right"),
        {"type": "shape", "shape": "sparkle", "x": 216, "y": 121, "width": 16, "height": 16, "fill": ENGRAVE},
        txt("4821  0057  1193  0915", x=-218, y=-62, size=24, font="mono", weight=500, letterSpacing=0.04, color=ENGRAVE, align="left", anchor="left"),
        txt("AVERY MORGAN", x=-218, y=-112, size=16, font="body", weight=600, letterSpacing=0.14, color=ENGRAVE, align="left", anchor="left"),
        txt("METAL", x=218, y=-112, size=13, font="body", weight=700, letterSpacing=0.22, color=ENGRAVE, align="right", anchor="right"),
    ]
    if glare_at is not None:
        # A light catch on the top-right corner: a card-shaped additive gradient centered on that corner.
        front.append({
            "type": "shape", "width": CARD_W - 2, "height": CARD_H - 2, "radius": 29, "blend": "add", "z": 0.3,
            "fill": {"type": "radial", "from": "#FFF8E6", "to": "#FFF8E600", "center": [0.46, 0.46]},
            "keyframes": {"opacity": [{"t": glare_at - 0.35, "v": 0}, {"t": glare_at, "v": 0.95, "ease": "outCubic"},
                                      {"t": glare_at + 0.45, "v": 0, "ease": "inOutSine"}]},
        })
    back = [
        # Magnetic stripe along the top edge of the back.
        {"type": "shape", "y": 104, "width": CARD_W, "height": 58, "fill": "#1B1813"},
        {"type": "shape", "x": -60, "y": 10, "width": 300, "height": 42, "radius": 4, "fill": "#F1EADB"},
        txt("Gilt Rewards", x=-218, y=-110, size=15, font="body", weight=600, letterSpacing=0.08, color=ENGRAVE, align="left", anchor="left"),
    ]
    g = {"type": "group", "children": [
        {"type": "mesh", "geometry": "slab", "size": [CARD_W, CARD_H, CARD_D], "radius": 30, "material": "gold", "color": GOLD, "roughness": 0.24,
         "finish": {"type": "brushed", "scratches": 0.04, "smudges": 0.18, "strength": 0.6}},
        {"type": "group", "z": FACE, "children": front},
        {"type": "group", "z": -FACE, "rotateY": 180, "children": back},
    ]}
    g.update(kw)
    return g


def hero_card():
    """Scene 1, first half: flies in, tips toward the camera, catches the light, darts off to the right."""
    hero = {"x": -360, "y": 70, "z": 140}
    k = {
        "x": [{"t": T_IN, "v": -1500}, {"t": 1.3, "v": hero["x"], "ease": SMOOTH}, {"t": T_LEAVE, "v": hero["x"] + 30},
              {"t": T_LEAVE + 0.4, "v": 1500, "ease": "inQuad"}],
        "y": [{"t": T_IN, "v": 160}, {"t": 1.3, "v": hero["y"], "ease": SMOOTH}, {"t": T_LEAVE, "v": hero["y"] + 12},
              {"t": T_LEAVE + 0.4, "v": 380, "ease": "inQuad"}],
        "z": [{"t": T_IN, "v": 300}, {"t": 1.3, "v": hero["z"], "ease": SMOOTH}, {"t": T_LEAVE, "v": hero["z"]},
              {"t": T_LEAVE + 0.4, "v": -200, "ease": "inQuad"}],
        # Bottom edge tips toward the camera (negative rotateX).
        "rotateX": [{"t": T_IN, "v": 8}, {"t": 1.3, "v": -30, "ease": SMOOTH}, {"t": T_LEAVE, "v": -32}, {"t": T_LEAVE + 0.4, "v": -10, "ease": "inQuad"}],
        "rotateY": [{"t": T_IN, "v": 48}, {"t": 1.3, "v": 16, "ease": SMOOTH}, {"t": T_LEAVE, "v": 12}, {"t": T_LEAVE + 0.4, "v": 60, "ease": "inQuad"}],
        "rotateZ": [{"t": T_IN, "v": -16}, {"t": 1.3, "v": -5, "ease": SMOOTH}, {"t": T_LEAVE, "v": -4}, {"t": T_LEAVE + 0.4, "v": 14, "ease": "inQuad"}],
    }
    return card(glare_at=T_GLARE, id="card", keyframes=k, end=T_LEAVE + 0.45,
                **{"in": {"preset": "blurIn", "duration": 0.5, "blur": 14}})


def swipe_card():
    """Scene 1, second half: in the slot's frame (x across the face, y along it, z out of it).

    The card stands on its long edge in the groove, front facing out to the right and reading
    upright, rides from the back of the slot to the front, then lifts away.
    """
    seat_z = CARD_H / 2 - INSERT
    above = seat_z + 520
    k = {
        "x": [{"t": T_PAN_END - 0.3, "v": 420}, {"t": T_SEAT, "v": 0, "ease": "outCubic"}, {"t": T_SLIDE_END, "v": 0},
              {"t": T_OUT, "v": 260, "ease": "inCubic"}],
        "y": [{"t": T_PAN_END - 0.3, "v": SLIDE + 260}, {"t": T_SEAT, "v": SLIDE, "ease": "outCubic"},
              {"t": T_SLIDE, "v": SLIDE}, {"t": T_SLIDE_END, "v": -SLIDE, "ease": "inOutSine"},
              {"t": T_OUT, "v": -SLIDE - 420, "ease": "inCubic"}],
        "z": [{"t": T_PAN_END - 0.3, "v": above}, {"t": T_SEAT, "v": seat_z, "ease": "outCubic"}, {"t": T_SLIDE_END, "v": seat_z},
              {"t": T_OUT, "v": seat_z + 640, "ease": "inCubic"}],
        # Settles upright into the groove, then tips forward as it is pulled out.
        "rotateZ": [{"t": T_PAN_END - 0.3, "v": -14}, {"t": T_SEAT, "v": 0, "ease": "outCubic"}, {"t": T_SLIDE_END, "v": 0},
                    {"t": T_OUT, "v": 22, "ease": "inCubic"}],
    }
    inner = card(id="swipe-card", rotateX=90, rotateY=90, start=T_PAN_END - 0.32, end=T_OUT + 0.05, keyframes=k)
    return {"type": "group", **slot_frame(), "children": [inner]}


def scene_swipe():
    tx, tz = TERM["x"], TERM["z"]
    # Camera: straight-on hero framing, then a swing to a three-quarter view of the terminal's slot side.
    cam = {
        "x": [{"t": 0, "v": -60}, {"t": T_PAN, "v": -60}, {"t": T_PAN_END, "v": tx, "ease": "inOutCubic"},
              {"t": T_OUT, "v": tx}, {"t": T_OUT + 1.3, "v": tx - 420, "ease": "inOutCubic"}],
        "y": [{"t": 0, "v": 0}, {"t": T_PAN, "v": 0}, {"t": T_PAN_END, "v": 560, "ease": "inOutCubic"}],
        "z": [{"t": 0, "v": 60}, {"t": T_PAN, "v": -40, "ease": "inOutSine"}, {"t": T_PAN_END, "v": tz + 260, "ease": "inOutCubic"},
              {"t": SCENE1, "v": tz + 200, "ease": "inOutSine"}],
        "targetX": [{"t": 0, "v": -60}, {"t": T_PAN, "v": -60}, {"t": T_PAN_END, "v": tx, "ease": "inOutCubic"},
                    {"t": T_OUT, "v": tx}, {"t": T_OUT + 1.3, "v": tx - 420, "ease": "inOutCubic"}],
        "targetY": [{"t": 0, "v": 0}, {"t": T_PAN, "v": 0}, {"t": T_PAN_END, "v": GROUND + 330, "ease": "inOutCubic"}],
        "targetZ": [{"t": 0, "v": 0}, {"t": T_PAN, "v": 0}, {"t": T_PAN_END, "v": tz, "ease": "inOutCubic"}],
        "orbit": [{"t": 0, "v": 0}, {"t": T_PAN, "v": 0}, {"t": T_PAN_END, "v": 10, "ease": "inOutCubic"}, {"t": SCENE1, "v": 18, "ease": "inOutSine"}],
    }
    term = terminal(id="terminal", x=tx, y=GROUND, z=tz, rotateY=TERM["rotateY"], approve_at=T_APPROVE, led_at=T_LED,
                    amount="$48.20", accent="#B5862B", brand="tapline")
    term["children"].append(swipe_card())
    payoff = {"type": "group", "x": tx - 1180, "y": GROUND + 520, "z": tz + 120, "rotateY": 8, "start": T_OUT + 0.15,
              "in": {"preset": "focusIn", "duration": 0.8}, "children": [
        {"type": "counter", "from": 0, "to": 1.45, "decimals": 2, "prefix": "+$", "size": 120, "weight": 600, "letterSpacing": -0.04,
         "color": GOLD_TEXT, "at": T_OUT + 0.25, "duration": 1.1, "ease": SMOOTH, "align": "left", "anchor": "left"},
        txt("cash back, the moment you pay", y=-88, size=32, font="body", color=MUTED, letterSpacing=-0.01, align="left", anchor="left",
            animate={"preset": "blur", "by": "word", "at": T_OUT + 0.55, "stagger": 0.05}),
    ]}
    return {
        "id": "swipe",
        "duration": SCENE1,
        "camera": {"keyframes": cam},
        "layers": [
            {"type": "background", "style": "radial", "colors": [WHITE, "#EFEFF2"], "center": [0, 200], "intensity": 1.3},
            term,
            hero_card(),
            payoff,
        ],
    }


def scene_end():
    return {
        "id": "end",
        "duration": 4.6,
        "transition": {"type": "blur", "duration": 0.45},
        "camera": {"moves": [{"preset": "pushIn", "amount": 60, "duration": 4.6, "ease": "inOutSine"}]},
        "layers": [
            {"type": "background", "style": "radial", "colors": [WHITE, "#EFEFF2"], "center": [0, 200], "intensity": 1.3},
            card(glare_at=1.5, y=120, scale=0.78, rotateX=-24,
                 keyframes={"rotateY": [{"t": 0, "v": 30}, {"t": 4.6, "v": -14, "ease": "inOutSine"}],
                            "rotateZ": [{"t": 0, "v": -6}, {"t": 4.6, "v": -2, "ease": "inOutSine"}]},
                 loop={"preset": "float", "amount": 8, "period": 4},
                 **{"in": {"preset": "focusIn", "duration": 1.0, "blur": 20}}),
            txt("Every swipe pays you back.", y=-180, size=64, letterSpacing=-0.03, animate={"preset": "build", "at": 0.7, "stagger": 0.26}),
            {"type": "group", "y": -290, "in": {"preset": "fade", "at": 2.2, "duration": 0.8}, "children": [
                txt("Gilt", x=-150, size=38, weight=600, letterSpacing=-0.03),
                {"type": "shape", "shape": "sparkle", "x": -111, "y": 10, "width": 14, "height": 14, "fill": GOLD_TEXT},
                {"type": "shape", "x": -76, "width": 1.5, "height": 30, "fill": "#D2D2D7"},
                txt("3% back on everything", x=60, size=24, font="body", weight=500, color=MUTED, letterSpacing=-0.01),
            ]},
        ],
    }


video = {
    "title": "Gilt Swipe",
    "fps": 30,
    "environment": {"src": "hdri:studio_small_09", "intensity": 1.0, "rotation": 40},
    "lighting": {"shadows": True, "ground": GROUND, "shadowOpacity": 0.18, "softness": 16, "key": [-0.3, 1, 0.5]},
    "theme": {"colors": {"bg": WHITE, "text": INK, "muted": MUTED, "primary": GOLD_TEXT}, "fonts": {"display": "Inter", "body": "Inter", "mono": "JetBrains Mono"}},
    "post": {"bloom": {"strength": 0.2, "threshold": 1.15, "radius": 0.4}, "grain": 0, "vignette": 0},
    "motionBlur": {"samples": 12, "shutter": 0.6},
    "sounds": [
        {"sound": "whoosh", "at": 0.05, "gain": 0.8},
        {"sound": "sparkle", "at": T_GLARE - 0.1, "gain": 0.5},
        {"sound": "whoosh", "at": T_LEAVE + 0.05, "gain": 0.9},
        {"sound": "soft", "at": T_SEAT - 0.05, "gain": 0.7},
        {"sound": "swoosh", "at": T_SLIDE, "gain": 1.0},
        {"sound": "chime", "at": T_APPROVE, "gain": 0.9},
    ],
    "scenes": [scene_swipe(), scene_end()],
}

write_spec(ROOT / "examples" / "gilt-swipe.json", video)
