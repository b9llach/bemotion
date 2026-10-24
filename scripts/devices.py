"""Procedural Apple-class devices for Bemotion specs: phone, tablet and laptop.

Each function returns a `group` layer built from extruded meshes and flat layers, at real proportions
(the width you pass sets the scale). Extra keyword arguments (x, y, z, rotateX, keyframes, in...) go on
the outer group.

- phone(): 6.1-inch class phone, titanium frame, black glass, island, optional camera plateau on the back.
- tablet(): 11-inch class tablet with even bezels.
- laptop(): 13-inch class notebook lying in the xz plane (base top at y = 0); `open` is the lid angle.

Screens take `wallpaper` (two or three colors for a soft gradient) and `content` (child layers placed in
screen space, origin at the screen center). `screen_on` lights the screen at that time (dark glass before).
"""


def _rect(w, h, r):
    """Rounded-rectangle profile for an extrude mesh, centered on the origin."""
    return [[-w / 2, -h / 2, r], [w / 2, -h / 2, r], [w / 2, h / 2, r], [-w / 2, h / 2, r]]


def _wall(colors, angle=160):
    if len(colors) == 1:
        return colors[0]
    return {"type": "linear", "from": colors[0], "to": colors[-1], "angle": angle}


def _screen(w, h, r, z, wallpaper, content, screen_on, extra=None):
    """Lit display: wallpaper, content, and a dark glass layer that fades out when the screen wakes."""
    layers = [{"type": "shape", "z": z, "width": w, "height": h, "radius": r, "fill": _wall(wallpaper)}]
    if len(wallpaper) == 3:
        # A soft third color pooled in one corner, like a modern lock screen wallpaper.
        layers.append({"type": "shape", "z": z + 0.05, "width": w, "height": h, "radius": r,
                       "fill": {"type": "radial", "from": wallpaper[1], "to": wallpaper[1] + "00", "center": [0.3, -0.25]}, "opacity": 0.9})
    if content:
        layers.append({"type": "group", "z": z + 0.2, "children": content})
    layers += extra or []
    if screen_on is not None:
        layers.append({"type": "shape", "z": z + 0.5, "width": w + 1, "height": h + 1, "radius": r, "fill": "#040406",
                       "keyframes": {"opacity": [{"t": screen_on, "v": 1}, {"t": screen_on + 0.35, "v": 0, "ease": "outCubic"}]}})
    return layers


def phone(*, w=300, color="#3C3B39", wallpaper=("#1B2A6B", "#6A4BC4", "#E7A3C4"), content=None, screen_on=None,
          back=False, island=True, sheen=0.06, shadow=True, **kw):
    mm = w / 71.5
    h = 146.6 * mm
    d = 8.25 * mm
    r = 11.5 * mm
    front = d / 2
    glass_r = r - 0.7 * mm
    bez = 1.8 * mm
    sw, sh = w - 2 * (0.7 * mm + bez), h - 2 * (0.7 * mm + bez)
    sr = glass_r - bez
    layers = [
        # Brushed titanium band: the extrusion's rounded edge is what catches the studio light.
        {"type": "mesh", "geometry": "extrude", "profile": _rect(w, h, r), "depth": d, "bevel": d * 0.32,
         "material": "metal", "color": color, "roughness": 0.3, "finish": {"type": "brushed", "scratches": 0.02, "smudges": 0.15, "angle": 90},
         "shadow": shadow},
        # Front glass (black border) sits just proud of the frame.
        {"type": "shape", "z": front + 0.3, "width": w - 1.4 * mm, "height": h - 1.4 * mm, "radius": glass_r, "fill": "#050506"},
    ]
    extra = []
    if island:
        extra.append({"type": "shape", "shape": "pill", "z": front + 1.6, "y": sh / 2 - 11 * mm * 0.62 - 3.2 * mm,
                      "width": 18.2 * mm, "height": 5.4 * mm, "fill": "#000000"})
    layers += _screen(sw, sh, sr, front + 0.6, list(wallpaper), content, screen_on, extra)
    if sheen:
        layers.append({"type": "shape", "z": front + 2.2, "width": w - 1.4 * mm, "height": h - 1.4 * mm, "radius": glass_r,
                       "fill": {"type": "radial", "from": "#FFFFFF", "to": "#FFFFFF00", "center": [-0.45, 0.5]}, "blend": "add", "opacity": sheen})
    if back:
        plate = 36 * mm
        cam = []
        for (cx, cy) in [(-8.6, 8.6), (-8.6, -8.6), (8.6, 0)]:
            cam += [
                {"type": "mesh", "geometry": "cylinder", "size": [13 * mm, 2.2 * mm, 13 * mm], "radius": 6.5 * mm, "rotateX": 90,
                 "x": cx * mm, "y": cy * mm, "z": 1.6 * mm, "material": "metal", "color": color, "roughness": 0.22},
                {"type": "shape", "shape": "circle", "x": cx * mm, "y": cy * mm, "z": 2.8 * mm, "width": 10.4 * mm, "fill": "#0A0B10"},
                {"type": "shape", "shape": "circle", "x": cx * mm, "y": cy * mm, "z": 2.9 * mm, "width": 6 * mm,
                 "fill": {"type": "radial", "from": "#3B4A7A", "to": "#07080C"}},
            ]
        layers.append({"type": "group", "z": -front - 0.3, "rotateY": 180, "children": [
            {"type": "shape", "width": w - 1.4 * mm, "height": h - 1.4 * mm, "radius": glass_r, "fill": color},
            {"type": "group", "x": -w / 2 + 6 * mm + plate / 2, "y": h / 2 - 6 * mm - plate / 2, "children": [
                {"type": "mesh", "geometry": "extrude", "profile": _rect(plate, plate, 8 * mm), "depth": 2 * mm, "bevel": 0.8 * mm,
                 "z": 0.8 * mm, "material": "glossy", "color": color, "roughness": 0.15},
                *cam,
            ]},
        ]})
    return {"type": "group", **kw, "children": layers}


def tablet(*, w=560, color="#C9CACE", wallpaper=("#0E3B5C", "#3FA7C9", "#F3D29B"), content=None, screen_on=None, shadow=True, **kw):
    mm = w / 247.6
    h = 178.5 * mm
    d = 6 * mm
    r = 18 * mm
    front = d / 2
    bez = 9.5 * mm
    layers = [
        {"type": "mesh", "geometry": "extrude", "profile": _rect(w, h, r), "depth": d, "bevel": d * 0.3,
         "material": "metal", "color": color, "roughness": 0.36, "finish": {"type": "satin", "smudges": 0.1, "strength": 0.25, "scale": 3}, "shadow": shadow},
        {"type": "shape", "z": front + 0.3, "width": w - 1.2 * mm, "height": h - 1.2 * mm, "radius": r - 0.6 * mm, "fill": "#050506"},
        {"type": "shape", "shape": "circle", "z": front + 0.6, "y": h / 2 - bez / 2, "width": 2.4 * mm, "fill": "#14161C"},
    ]
    layers += _screen(w - 2 * bez, h - 2 * bez, r - bez + 2 * mm, front + 0.6, list(wallpaper), content, screen_on)
    return {"type": "group", **kw, "children": layers}


# Keyboard rows in key units (1u = 18.6 mm); the function row is half height.
_ROWS = [
    [1.5] + [1] * 12 + [1.5 - 0.0],
    [1.5] + [1] * 13,
    [1.75] + [1] * 11 + [1.75],
    [2.25] + [1] * 10 + [2.25],
    [1, 1, 1, 1.25, 5, 1.25, 1, 1, 1, 1],
]


def _keyboard(mm, color):
    u = 18.6 * mm
    gap = 2.4 * mm
    keys = []
    total = 14.5 * u
    top = 0
    fn_h = 9.5 * mm
    # Function row: 14 equal keys.
    fw = total / 14
    for i in range(14):
        keys.append({"type": "shape", "x": -total / 2 + fw * (i + 0.5), "y": top - fn_h / 2,
                     "width": fw - gap, "height": fn_h - gap * 0.8, "radius": 1.6 * mm, "fill": color})
    y = top - fn_h - u / 2
    for row in _ROWS:
        x = -total / 2
        for k in row:
            kw = k * u
            if row is _ROWS[-1] and k == 1 and x > total / 2 - 3.2 * u:
                # Inverted-T arrows: half-height up/down in the middle column, half-height left/right.
                keys.append({"type": "shape", "x": x + kw / 2, "y": y - u / 4, "width": kw - gap, "height": u / 2 - gap * 0.7,
                             "radius": 1.6 * mm, "fill": color})
                if abs(x + kw / 2 - (total / 2 - 1.5 * u)) < 1:
                    keys.append({"type": "shape", "x": x + kw / 2, "y": y + u / 4, "width": kw - gap, "height": u / 2 - gap * 0.7,
                                 "radius": 1.6 * mm, "fill": color})
            else:
                keys.append({"type": "shape", "x": x + kw / 2, "y": y, "width": kw - gap, "height": u - gap,
                             "radius": 1.8 * mm, "fill": color})
            x += kw
        y -= u
    return keys, fn_h + 5 * u


def laptop(*, w=1100, color="#C8CACF", open=110, open_keys=None, wallpaper=("#0B1020", "#1E2A55"), content=None,
           screen_on=None, keyboard=True, shadow=True, **kw):
    """Notebook lying on the xz plane with the base's top at y = 0 and the hinge at the back.

    `open` is the lid angle in degrees (0 closed, 90 upright, 110 typical). `open_keys` keyframes it.
    """
    mm = w / 304.1
    deck = 215 * mm
    t_base = 7.6 * mm
    t_lid = 4.2 * mm
    lid_h = 212 * mm
    r = 11 * mm
    finish = {"type": "satin", "smudges": 0.1, "strength": 0.25, "scale": 3}
    base = [
        {"type": "mesh", "geometry": "extrude", "profile": _rect(w, deck, r), "depth": t_base, "bevel": 2.4 * mm,
         "rotateX": -90, "y": -t_base / 2, "material": "metal", "color": color, "roughness": 0.4, "finish": finish, "shadow": shadow},
    ]
    top = []  # flat details on the deck, drawn in the deck's plane (x right, y toward the hinge)
    if keyboard:
        keys, kb_h = _keyboard(mm, "#141518")
        kb_top = deck / 2 - 15 * mm
        top.append({"type": "group", "y": kb_top, "children": keys})
    else:
        kb_h = 105 * mm
        kb_top = deck / 2 - 15 * mm
        top.append({"type": "shape", "y": kb_top - kb_h / 2, "width": 270 * mm, "height": kb_h, "radius": 3 * mm, "fill": "#1A1B1F"})
    tp_h = 82 * mm
    top.append({"type": "shape", "y": -deck / 2 + 9 * mm + tp_h / 2, "width": 122 * mm, "height": tp_h, "radius": 6 * mm,
                "fill": "#00000010", "stroke": "#0000001C", "strokeWidth": 0.6 * mm})
    base.append({"type": "group", "rotateX": -90, "y": 0.4, "children": top})
    # Thumb notch on the front edge.
    base.append({"type": "shape", "shape": "pill", "rotateX": 0, "y": -t_base / 2, "z": deck / 2 + 0.3, "width": 46 * mm, "height": 3.4 * mm,
                 "fill": "#00000022"})

    disp_w, disp_h = 289 * mm, 187 * mm
    disp_y = lid_h - 6.5 * mm - disp_h / 2
    lid_children = [
        {"type": "mesh", "geometry": "extrude", "profile": _rect(w, lid_h, r), "depth": t_lid, "bevel": 1.6 * mm,
         "y": lid_h / 2, "z": -t_lid / 2, "material": "metal", "color": color, "roughness": 0.4, "finish": finish, "shadow": shadow},
        {"type": "shape", "y": lid_h / 2, "z": 1.2, "width": w - 2.2 * mm, "height": lid_h - 2.2 * mm, "radius": r - 1.1 * mm, "fill": "#050506"},
        {"type": "group", "y": disp_y, "children": _screen(disp_w, disp_h, 3.5 * mm, 2.4, list(wallpaper), content, screen_on, [
            {"type": "shape", "z": 4.0, "y": disp_h / 2 - 2.6 * mm, "width": 31 * mm, "height": 6.6 * mm, "radius": 2.4 * mm, "fill": "#000000"},
        ])},
        # Glass reflection across the display.
        {"type": "shape", "y": lid_h / 2, "z": 5.0, "width": w - 2.2 * mm, "height": lid_h - 2.2 * mm, "radius": r - 1.1 * mm,
         "fill": {"type": "linear", "from": "#FFFFFF", "to": "#FFFFFF00", "angle": 135}, "blend": "add", "opacity": 0.035},
    ]
    lid = {"type": "group", "z": -deck / 2 + 2 * mm, "y": 0.2, "rotateX": 90 - open, "children": lid_children}
    if open_keys:
        lid["keyframes"] = {"rotateX": [{**k, "v": 90 - k["v"]} for k in open_keys]}
    hinge = {"type": "mesh", "geometry": "cylinder", "size": [7 * mm, w * 0.78, 7 * mm], "radius": 3.4 * mm, "rotateZ": 90,
             "y": -1.6 * mm, "z": -deck / 2 + 2.2 * mm, "material": "metal", "color": "#2A2B2F", "roughness": 0.4}
    return {"type": "group", **kw, "children": base + [hinge, lid]}
