"""A countertop card terminal (the angled kind at store checkouts), built from Bemotion layers.

Real-world proportions: dimensions are in millimetres and scaled so a standard 85.6 mm card is
520 px wide, matching the Gilt card. The body is an extruded side profile: a low front lip with
the chip slot, a long face tilted toward the customer with the screen and keypad, and a taller
back. A swipe groove runs along the right edge of the face, between the body and a side rail.

Coordinates: the group origin sits on the floor under the body's center. +z is the front
(customer side), +y up. `face(...)` children are laid out on the tilted face: x across,
y along the face toward the back, z out of the surface.
"""
import math

MM = 520 / 85.6  # px per mm, from the card width

GRAPHITE = "#2A2C31"
GRAPHITE_RAIL = "#24262A"
KEY = "#33363C"
KEY_TEXT = "#E9EAEE"
KEY_SUB = "#8E929B"
GLASS = "#06070A"
SLOT = "#08090B"

# Side profile in mm as (z, y, corner radius).
PROFILE = [(90, 0, 3), (90, 24, 5), (82, 31, 14), (-78, 117, 16), (-100, 112, 12), (-106, 0, 3)]
FACE_A = (82, 31)
FACE_B = (-78, 117)

BODY_W = 92  # main body width
GROOVE = 4.4  # swipe slot width (a little wider than real so it reads on camera)
RAIL_W = 10  # side rail width
GROOVE_DEPTH = 18  # slot depth below the face
TOTAL_W = BODY_W + GROOVE + RAIL_W
BODY_X = -TOTAL_W / 2 + BODY_W / 2
GROOVE_X = -TOTAL_W / 2 + BODY_W + GROOVE / 2
RAIL_X = TOTAL_W / 2 - RAIL_W / 2

# Face frame.
_dz, _dy = FACE_B[0] - FACE_A[0], FACE_B[1] - FACE_A[1]
FACE_LEN = math.hypot(_dz, _dy)
FACE_TILT = math.degrees(math.atan2(_dy, -_dz))  # angle of the face above horizontal
FACE_ROT_X = -(90 - FACE_TILT)  # rotateX that lays a flat layer onto the face
FACE_MID = ((FACE_A[0] + FACE_B[0]) / 2, (FACE_A[1] + FACE_B[1]) / 2)
FACE_NORMAL = (_dy / FACE_LEN, -_dz / FACE_LEN)


def px(v):
    return round(v * MM, 2)


def face_point(fx, fy, fz=0.0):
    """Face coordinates (mm) to terminal coordinates (px)."""
    uz, uy = _dz / FACE_LEN, _dy / FACE_LEN
    nz, ny = FACE_NORMAL
    z = FACE_MID[0] + uz * fy + nz * fz
    y = FACE_MID[1] + uy * fy + ny * fz
    return px(fx), px(y), px(z)


def _face_line(offset, z_from, z_to):
    """Points (z, y) on a line parallel to the face, `offset` mm above it, between two z values."""
    def y_at(z):
        t = (z - FACE_A[0]) / _dz
        return FACE_A[1] + t * _dy + offset / math.cos(math.radians(FACE_TILT))
    return [(z_from, y_at(z_from)), (z_to, y_at(z_to))]


def _extrude(profile_mm, x_mm, width_mm, color, roughness, bevel_mm, finish=True, material="matte"):
    layer = {
        "type": "mesh", "geometry": "extrude",
        # Profile x is the terminal's z (front), so turn it to run front to back.
        "profile": [[px(p[0]), px(p[1]), px(p[2])] if len(p) > 2 and p[2] else [px(p[0]), px(p[1])] for p in profile_mm],
        "depth": px(width_mm), "bevel": px(bevel_mm),
        "x": px(x_mm), "rotateY": -90,
        "material": material, "color": color, "roughness": roughness, "shadow": True,
    }
    if finish:
        layer["finish"] = {"type": "sandblasted", "scale": 2.5, "strength": 0.35}
    return layer


def _keypad():
    """Number keys in three columns plus cancel, clear and enter, with letters like a phone pad."""
    keys = []
    w, h, gap = 17.0, 11.0, 4.0
    rows = [("1", ""), ("2", "ABC"), ("3", "DEF"), ("4", "GHI"), ("5", "JKL"), ("6", "MNO"),
            ("7", "PQRS"), ("8", "TUV"), ("9", "WXYZ"), ("*", ""), ("0", ""), ("#", "")]
    top = -12.0  # face y of the first row's center
    left = -(4 * w + 3 * gap) / 2 + w / 2
    for i, (digit, letters) in enumerate(rows):
        r, c = divmod(i, 3)
        x, y = left + c * (w + gap), top - r * (h + 4.5)
        keys.append({"type": "mesh", "geometry": "roundedBox", "size": [px(w), px(h), px(3.2)], "radius": px(1.6),
                     "material": "matte", "color": KEY, "roughness": 0.5, "x": px(x), "y": px(y), "z": px(1.6)})
        keys.append({"type": "text", "text": digit, "font": "body", "weight": 600, "size": px(5.2), "color": KEY_TEXT,
                     "x": px(x), "y": px(y + (1.3 if letters else 0)), "z": px(3.35)})
        if letters:
            keys.append({"type": "text", "text": letters, "font": "body", "weight": 600, "size": px(2.1), "letterSpacing": 0.12,
                         "color": KEY_SUB, "x": px(x), "y": px(y - 3.1), "z": px(3.35)})
    # Function column: cancel, clear, enter.
    fx = left + 3 * (w + gap)
    span = 4 * h + 3 * 4.5
    fh = (span - 2 * 4.5) / 3
    funcs = [("#D9443F", "x"), ("#F0B93A", "<"), ("#2FA25A", "o")]
    for j, (color, glyph) in enumerate(funcs):
        y = top + h / 2 - fh / 2 - j * (fh + 4.5)
        keys.append({"type": "mesh", "geometry": "roundedBox", "size": [px(w), px(fh), px(3.2)], "radius": px(1.6),
                     "material": "glossy", "color": color, "roughness": 0.35, "x": px(fx), "y": px(y), "z": px(1.6)})
        if glyph == "x":
            keys.append({"type": "icon", "name": "x", "size": px(6), "strokeWidth": 2.6, "color": "#FFFFFF", "x": px(fx), "y": px(y), "z": px(3.35)})
        elif glyph == "<":
            keys.append({"type": "icon", "name": "chevron-left", "size": px(9), "strokeWidth": 2.6, "color": "#4A3606", "x": px(fx), "y": px(y), "z": px(3.35)})
        else:
            keys.append({"type": "shape", "shape": "ring", "width": px(5.6), "strokeWidth": px(0.9), "fill": "#FFFFFF", "x": px(fx), "y": px(y), "z": px(3.35)})
    return keys


def _screen(amount, approve_at, accent):
    """Display content: amount and payment prompt, then an approval."""
    W, H = 74.0, 56.0
    ink, muted = "#101114", "#6B6E76"
    fade_out = {"keyframes": {"opacity": [{"t": approve_at - 0.12, "v": 1}, {"t": approve_at + 0.08, "v": 0}]}}
    fade_in = {"keyframes": {"opacity": [{"t": approve_at, "v": 0}, {"t": approve_at + 0.22, "v": 1, "ease": "outCubic"}]}}
    prompt = {"type": "group", **fade_out, "children": [
        {"type": "text", "text": "Total", "font": "body", "weight": 500, "size": px(4.0), "color": muted, "y": px(18)},
        {"type": "text", "text": amount, "font": "display", "weight": 600, "size": px(11), "letterSpacing": -0.03, "color": ink, "y": px(7)},
        {"type": "shape", "width": px(W - 14), "height": px(0.35), "fill": "#E2E3E7", "y": px(-2.5)},
        {"type": "icon", "name": "contactless", "size": px(9), "strokeWidth": 2.2, "color": accent, "y": px(-11)},
        {"type": "text", "text": "Tap, insert or swipe", "font": "body", "weight": 600, "size": px(3.6), "color": ink, "y": px(-20.5)},
    ]}
    done = {"type": "group", **fade_in, "children": [
        {"type": "shape", "shape": "circle", "width": px(17), "fill": "#2FA25A", "y": px(7),
         "in": {"preset": "scaleIn", "at": approve_at, "duration": 0.45, "from": 0.4, "ease": "outBack"}},
        {"type": "icon", "name": "check", "size": px(10), "strokeWidth": 3, "color": "#FFFFFF", "y": px(7),
         "keyframes": {"progress": [{"t": approve_at + 0.1, "v": 0}, {"t": approve_at + 0.45, "v": 1, "ease": "outCubic"}]}},
        {"type": "text", "text": "Approved", "font": "display", "weight": 600, "size": px(6.5), "letterSpacing": -0.02, "color": ink, "y": px(-9)},
        {"type": "text", "text": "Remove card", "font": "body", "weight": 500, "size": px(3.4), "color": muted, "y": px(-17)},
    ]}
    return [
        # Display panel, lit from within.
        {"type": "shape", "width": px(W), "height": px(H), "radius": px(1.2),
         "fill": {"type": "linear", "from": "#FFFFFF", "to": "#EEF0F4", "angle": 180}},
        prompt,
        done,
    ]


def terminal(*, amount="$48.20", approve_at=99.0, led_at=None, accent="#1F6FEB", brand="tapline", **kw):
    """The terminal as one group. `led_at` lights the four contactless status lights in turn."""
    # The groove is cut along the face between z 72 and -68 and closed at both ends: the piece of
    # body under it follows the body outline except along the face, where it drops by the slot depth.
    (gz0, gy0), (gz1, gy1) = _face_line(-GROOVE_DEPTH, 66, -60)
    (ez0, ey0), (ez1, ey1) = _face_line(0, 72, -68)
    under_groove = [(90, 0, 3), (90, 24, 5), (82, 31, 14), (ez0, ey0, 0), (gz0, gy0, 4), (gz1, gy1, 4), (ez1, ey1, 0),
                    (-78, 117, 16), (-100, 112, 12), (-106, 0, 3)]
    (fz0, fy0), (fz1, fy1) = _face_line(-1.2, 68, -62)
    (fz2, fy2), (fz3, fy3) = _face_line(-GROOVE_DEPTH - 1, 66, -60)
    groove_floor = [(fz0, fy0, 0), (fz1, fy1, 0), (fz3, fy3, 0), (fz2, fy2, 0)]

    sx, sy, sz = face_point(0, 0)
    screen_y = 42.0
    face_children = [
        # Glass over the display, slightly proud of the face.
        {"type": "mesh", "geometry": "slab", "size": [px(84), px(66), px(1.6)], "radius": px(3), "material": "glossy",
         "color": GLASS, "roughness": 0.06, "y": px(screen_y), "z": px(0.8)},
        {"type": "group", "y": px(screen_y), "z": px(1.75), "children": _screen(amount, approve_at, accent)},
        # Reflection sweeping across the glass.
        {"type": "shape", "width": px(84), "height": px(66), "radius": px(3), "blend": "add", "y": px(screen_y), "z": px(1.9),
         "fill": {"type": "linear", "from": "#FFFFFF22", "to": "#FFFFFF00", "angle": 120}},
        {"type": "text", "text": brand, "font": "display", "weight": 600, "size": px(3.6), "letterSpacing": -0.01,
         "color": "#5B5F68", "y": px(4.5), "z": px(0.3)},
    ]
    # Contactless status lights above the screen.
    for i in range(4):
        light = {"type": "shape", "shape": "circle", "width": px(1.9), "x": px(-9 + i * 6), "y": px(screen_y + 37.5), "z": px(0.3),
                 "fill": "#4A4D55"}
        if led_at is not None:
            on = led_at + i * 0.09
            light["keyframes"] = {"fill": [{"t": on - 0.01, "v": "#4A4D55"}, {"t": on + 0.04, "v": "#3DDC84"}]}
            light["glow"] = {"size": 6, "intensity": 0.6}
        face_children.append(light)
    face_children += _keypad()

    children = [
        _extrude(PROFILE, BODY_X, BODY_W, GRAPHITE, 0.62, 3.2),
        # The side rail has the same outline, so the right side reads as one solid body.
        _extrude(PROFILE, RAIL_X, RAIL_W, GRAPHITE_RAIL, 0.6, 2.4),
        _extrude(under_groove, GROOVE_X, GROOVE + 1.2, GRAPHITE, 0.62, 0),
        # A dark floor at the bottom of the slot, so it reads as an opening.
        _extrude(groove_floor, GROOVE_X, GROOVE + 1.0, SLOT, 0.95, 0, finish=False),
        # Chip slot on the front lip.
        {"type": "shape", "width": px(68), "height": px(7), "radius": px(3.5), "fill": "#1C1D21",
         "x": px(BODY_X), "y": px(14), "z": px(90) + 0.6},
        {"type": "shape", "width": px(60), "height": px(1.5), "radius": px(0.75), "fill": SLOT,
         "x": px(BODY_X), "y": px(14), "z": px(90) + 0.9},
        # The tilted face.
        {"type": "group", "id": "terminal-face", "x": px(BODY_X), "y": sy, "z": sz, "rotateX": round(FACE_ROT_X, 3),
         "children": face_children},
    ]
    g = {"type": "group", "children": children}
    g.update(kw)
    return g


def slot_frame():
    """Where the card rides in the swipe groove, in terminal coordinates.

    Returns the face-group transform (x, y, z, rotateX) and the groove's x on the face, so a card
    placed inside a group with that transform can slide along y (face direction).
    """
    sx, sy, sz = face_point(0, 0)
    return {"x": px(GROOVE_X), "y": sy, "z": sz, "rotateX": round(FACE_ROT_X, 3)}
