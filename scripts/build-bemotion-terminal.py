"""Bemotion, told in a terminal: a prompt is typed, the spec streams out, the render runs, and the video it made
bursts out of the window. Then the film returns to the terminal for the name.

Writes projects/bemotion-terminal/ad.json. Run from the repo root:
  python scripts/build-bemotion-terminal.py [--force]
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from genlib import write_spec  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DIR = ROOT / "projects" / "bemotion-terminal"
FPS = 30

# Editor theme: near black with warm syntax colors.
BG = "#0A0B0E"
WIN = "#121318"
BAR = "#171820"
HAIR = "#262833"
DIM = "#5B606E"
MUTED = "#8B90A0"
TEXT = "#E4E6EC"
AMBER = "#F2B45A"
GREEN = "#A3D17F"
CORAL = "#F08A6C"

# The coffee app in the mini ad.
CREAM = "#F4EBDD"
FOAM = "#FFFBF4"
ESPRESSO = "#2A1A12"
CARAMEL = "#C9772F"
LATTE = "#E3CDB2"
ROAST = "#6B3E22"
SOFT = "#8E7766"

# Terminal geometry (design px). Monospace advance is 0.6 em for JetBrains Mono.
FS = 26
CW = FS * 0.6
LH = 40
W, H = 1500, 860
TITLE_H = 50
X0 = -W / 2 + 46
TOP = H / 2 - TITLE_H - 38
VISIBLE = 19

PROMPT = "~/crema $ "
CMD1 = 'npx bemotion generate "a launch video for Crema, a coffee app"'
CMD2 = "npx bemotion render ad.json -q high"
CLONE = "git clone https://github.com/b9llach/bemotion"

SPEC_LINES = [
    '{',
    '  "title": "Crema launch",',
    '  "theme": { "colors": { "bg": "#F4EBDD", "primary": "#C9772F" } },',
    '  "audio": [{ "src": "music/morning.mp3", "sync": true }],',
    '  "scenes": [',
    '    { "id": "hook", "duration": 3.4,',
    '      "layers": [',
    '        { "type": "text", "text": "Coffee, ready when you are.",',
    '          "animate": { "preset": "auto" } },',
    '        { "type": "group", "id": "cup", "in": "popIn" }',
    '      ] },',
    '    { "id": "order", "transition": { "type": "blur" },',
    '      "layers": [{ "type": "phone", "rotateY": -12 }] },',
    '    { "id": "brand", "duration": 2.8,',
    '      "layers": [{ "type": "text", "text": "Crema", "size": 230 }] }',
    '  ]',
    '}',
]


def kf(*pairs, ease=None):
    out = []
    for p in pairs:
        k = {"t": round(p[0], 4), "v": p[1]}
        e = p[2] if len(p) > 2 else ease
        if e:
            k["ease"] = e
        out.append(k)
    return out


def text(s, size=72, weight=600, color=TEXT, **kw):
    layer = {"type": "text", "text": s, "size": size, "weight": weight, "color": color, "letterSpacing": -0.025}
    layer.update(kw)
    return layer


def mono(s, color=TEXT, x=X0, y=0.0, size=FS, **kw):
    layer = {"type": "text", "text": s, "font": "mono", "size": size, "weight": 500, "color": color, "letterSpacing": 0,
             "align": "left", "anchor": "left", "x": round(x, 2), "y": round(y, 2)}
    layer.update(kw)
    return layer


def typing_times(s, seed=7, pace=1.0):
    """A person typing: quick bursts inside words, small hesitations at spaces and punctuation (deterministic).
    Returns one time per non-space character, from 0."""
    times, t = [], 0.0
    for i, ch in enumerate(s):
        seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
        j = (seed % 1000) / 1000
        if ch == " ":
            t += (0.06 + 0.1 * j) * pace
            continue
        times.append(round(t, 3))
        step = 0.028 + 0.038 * j
        if ch in '",.-/':
            step += 0.07
        if i > 0 and s[i - 1] == " " and j > 0.7:
            step += 0.12  # thinking about the next word
        t += step * pace
    return times


def char_index(s):
    """Index in s of each non-space character (the units a typewriter animates)."""
    return [i for i, ch in enumerate(s) if ch != " "]


def caret(x_text, y, s, at, times, until, blink_after=True, start=None, cw=CW, fs=FS):
    """A block caret that steps along as the characters arrive, then blinks."""
    idx = char_index(s)
    keys = [(at, x_text + cw / 2)]
    for k, tt in enumerate(times):
        t = at + tt
        keys.append((t - 0.001, None))
        keys.append((t, x_text + (idx[k] + 1) * cw + cw / 2))
    xs, last = [], x_text + cw / 2
    for t, v in keys:
        if v is None:
            v = last
        xs.append((t, round(v, 2), "linear"))
        last = v
    end = at + times[-1]
    layer = {"type": "shape", "width": cw, "height": fs * 1.2, "fill": AMBER, "opacity": 0.9, "y": y,
             "start": start if start is not None else at - 0.4, "end": until, "keyframes": {"x": kf(*xs)}}
    if blink_after:
        layer["loop"] = [{"preset": "blink", "period": 0.9, "at": end + 0.25}]
    return layer


# ---------------------------------------------------------------- syntax colors for the JSON

def json_highlight(line):
    """Highlight entries for one line of JSON: keys amber, strings green, numbers and booleans coral."""
    out = []
    i = 0
    n = len(line)
    while i < n:
        ch = line[i]
        if ch == '"':
            j = i + 1
            while j < n and line[j] != '"':
                j += 1
            tok = line[i:j + 1]
            k = j + 1
            while k < n and line[k] == " ":
                k += 1
            is_key = k < n and line[k] == ":"
            out.append((tok, AMBER if is_key else GREEN, i))
            i = j + 1
            continue
        if ch.isdigit() or (ch == "-" and i + 1 < n and line[i + 1].isdigit()):
            j = i + 1
            while j < n and (line[j].isdigit() or line[j] == "."):
                j += 1
            out.append((line[i:j], CORAL, i))
            i = j
            continue
        if line.startswith("true", i) or line.startswith("false", i):
            w = "true" if line.startswith("true", i) else "false"
            out.append((w, CORAL, i))
            i += len(w)
            continue
        i += 1
    hl = []
    for tok, color, pos in out:
        nth = count_occurrences(line[:pos], tok)
        entry = {"text": tok, "color": color}
        if nth:
            entry["nth"] = nth
        hl.append(entry)
    return hl


def count_occurrences(s, tok):
    c, i = 0, 0
    while True:
        j = s.find(tok, i)
        if j < 0:
            return c
        c += 1
        i = j + len(tok)


# ---------------------------------------------------------------- the terminal

def window_chrome(title="zsh  ~/crema"):
    """The window: body, title bar hairline, three quiet window buttons, the title."""
    dots = [{"type": "shape", "shape": "circle", "x": -W / 2 + 30 + i * 24, "y": H / 2 - TITLE_H / 2, "width": 13, "height": 13,
             "fill": c} for i, c in enumerate(["#3A3D49", "#3A3D49", "#3A3D49"])]
    return [
        {"type": "shape", "width": W, "height": H, "radius": 18, "fill": WIN, "stroke": HAIR, "strokeWidth": 1.5,
         "shadow": {"blur": 90, "y": -30, "opacity": 0.6}},
        {"type": "shape", "y": H / 2 - TITLE_H, "width": W - 3, "height": 1.5, "fill": HAIR},
        *dots,
        mono(title, DIM, x=0, y=H / 2 - TITLE_H / 2, size=19, align="center", anchor="center"),
    ]


def row_y(r):
    return TOP - r * LH


def terminal_scene():
    """Scene 1: generate, the spec streams, render, the preview opens."""
    rows = []  # (row, appear time, layers)

    # Row 0: the first command.
    t_cmd1 = 1.0
    times1 = typing_times(CMD1, seed=11, pace=0.72)
    end1 = t_cmd1 + times1[-1]
    xcmd = X0 + len(PROMPT) * CW
    prompt0 = mono(PROMPT, MUTED, y=row_y(0), highlight=[{"text": "~/crema", "color": GREEN}, {"text": "$", "color": AMBER}],
                   animate={"preset": "fade", "by": "char", "at": 0.45, "stagger": 0.012, "duration": 0.05})
    cmd1 = mono(CMD1, TEXT, x=xcmd, y=row_y(0), id="cmd1",
                highlight=[{"text": "npx", "color": AMBER}, {"text": '"a launch video for Crema, a coffee app"', "color": GREEN}],
                animate={"preset": "typewriter", "at": t_cmd1, "times": times1})
    enter1 = end1 + 0.35
    rows.append((0, 0.45, [prompt0, cmd1, caret(xcmd, row_y(0), CMD1, t_cmd1, times1, enter1, start=0.45)]))

    # Row 1: Claude writes the spec.
    rows.append((1, enter1 + 0.1, [mono("  > writing ad.json with Claude", DIM, y=row_y(1), highlight=[{"text": "ad.json", "color": TEXT}],
                                        animate={"preset": "fade", "by": "char", "at": enter1 + 0.1, "stagger": 0.008, "duration": 0.05})]))

    # Rows 2+: the JSON streams in, a few characters at a time.
    t = enter1 + 0.75
    per_char = 0.005
    for k, line in enumerate(SPEC_LINES):
        r = 2 + k
        layer = mono(line, MUTED, y=row_y(r), highlight=json_highlight(line),
                     animate={"preset": "fade", "by": "char", "at": round(t, 3), "stagger": per_char, "duration": 0.04})
        rows.append((r, t, [layer]))
        t += len(line.replace(" ", "")) * per_char + 0.035
    t_spec_done = t

    r = 2 + len(SPEC_LINES)
    t_ok = t_spec_done + 0.25
    rows.append((r, t_ok, [mono("  ok  valid spec, 3 scenes, 9.6 s, 1920x1080", DIM, y=row_y(r),
                                highlight=[{"text": "ok", "color": GREEN}],
                                animate={"preset": "fade", "by": "char", "at": t_ok, "stagger": 0.006, "duration": 0.04})]))

    # The second command.
    r_cmd2 = r + 2
    t_p2 = t_ok + 0.45
    t_cmd2 = t_p2 + 0.35
    times2 = typing_times(CMD2, seed=29, pace=0.7)
    end2 = t_cmd2 + times2[-1]
    enter2 = end2 + 0.3
    prompt2 = mono(PROMPT, MUTED, y=row_y(r_cmd2), highlight=[{"text": "~/crema", "color": GREEN}, {"text": "$", "color": AMBER}],
                   animate={"preset": "fade", "by": "char", "at": t_p2, "stagger": 0.01, "duration": 0.05})
    cmd2 = mono(CMD2, TEXT, x=xcmd, y=row_y(r_cmd2), id="cmd2", highlight=[{"text": "npx", "color": AMBER}, {"text": "-q", "color": CORAL}],
                animate={"preset": "typewriter", "at": t_cmd2, "times": times2})
    rows.append((r_cmd2, t_p2, [prompt2, cmd2, caret(xcmd, row_y(r_cmd2), CMD2, t_cmd2, times2, enter2, blink_after=False, start=t_p2)]))

    # Render output: settings, a progress bar with frame counter, done.
    r_info = r_cmd2 + 1
    t_info = enter2 + 0.1
    rows.append((r_info, t_info, [mono("  rendering  1920x1080  30 fps  motion blur 8x  high", DIM, y=row_y(r_info),
                                       highlight=[{"text": "rendering", "color": AMBER}],
                                       animate={"preset": "fade", "by": "char", "at": t_info, "stagger": 0.006, "duration": 0.04})]))
    r_bar = r_info + 1
    t_bar = t_info + 0.3
    bar_dur = 1.9
    bar_w = 520
    bar_x = X0 + 2 * CW
    rows.append((r_bar, t_bar, [
        {"type": "progress", "x": round(bar_x + bar_w / 2, 2), "y": row_y(r_bar), "width": bar_w, "height": 12, "at": t_bar, "duration": bar_dur,
         "ease": "inOutSine", "color": {"type": "linear", "from": CORAL, "to": AMBER, "angle": 90}, "track": "#23252E",
         "in": {"preset": "fade", "at": t_bar - 0.05, "duration": 0.15}},
        {"type": "counter", "font": "mono", "size": FS, "weight": 500, "color": TEXT, "letterSpacing": 0, "align": "left", "anchor": "left",
         "x": round(bar_x + bar_w + 3 * CW, 2), "y": row_y(r_bar), "from": 0, "to": 288, "prefix": "frame ", "suffix": " / 288",
         "at": t_bar, "duration": bar_dur, "ease": "inOutSine", "in": {"preset": "fade", "at": t_bar - 0.05, "duration": 0.15}},
        {"type": "counter", "font": "mono", "size": FS, "weight": 500, "color": AMBER, "letterSpacing": 0, "align": "left", "anchor": "left",
         "x": round(bar_x + bar_w + 22 * CW, 2), "y": row_y(r_bar), "from": 0, "to": 100, "suffix": "%",
         "at": t_bar, "duration": bar_dur, "ease": "inOutSine", "in": {"preset": "fade", "at": t_bar - 0.05, "duration": 0.15}},
    ]))
    r_done = r_bar + 1
    t_done = t_bar + bar_dur + 0.15
    rows.append((r_done, t_done, [mono("  done  out/ad.mp4  9.6 s  27 MB", DIM, y=row_y(r_done),
                                       highlight=[{"text": "done", "color": GREEN}, {"text": "out/ad.mp4", "color": TEXT}],
                                       animate={"preset": "fade", "by": "char", "at": t_done, "stagger": 0.006, "duration": 0.04})]))

    # Scroll: once the newest row passes the bottom, the content moves up a line at a time.
    scroll = [(0, 0)]
    last = 0
    for rr, ta, _ in sorted(rows, key=lambda x: x[1]):
        need = max(0, rr - (VISIBLE - 1)) * LH
        if need > last:
            scroll.append((round(ta - 0.001, 3), last, "linear"))
            scroll.append((round(ta + 0.09, 3), need, "outCubic"))
            last = need
    final_scroll = last

    t_preview = t_done + 0.35
    content = {"type": "group", "children": [l for _, _, ls in rows for l in ls], "keyframes": {"y": kf(*scroll)}}
    view = {"type": "group", "mask": {"type": "shape", "x": 0, "y": -18, "width": W - 40, "height": H - TITLE_H - 50},
            "children": [content],
            "keyframes": {"opacity": kf((t_preview - 0.1, 1), (t_preview + 0.5, 0.32, "outCubic"))}}
    terminal = {"type": "group", "children": window_chrome() + [view],
                "in": [{"preset": "fade", "at": 0, "duration": 0.6}, {"preset": "scaleIn", "from": 0.94, "at": 0, "duration": 0.9, "ease": "outExpo"}]}

    # The finished video opens over the terminal.
    pw, ph = 640, 360
    preview = {"type": "group", "x": 300, "y": -60, "share": "screen", "z": 2,
               "in": {"preset": "scaleIn", "from": 0.7, "at": t_preview, "duration": 0.55, "ease": "outExpo"},
               "children": [{"type": "shape", "width": pw, "height": ph, "radius": 14, "fill": CREAM,
                             "shadow": {"blur": 70, "y": -24, "opacity": 0.55}},
                            {"type": "group", "scale": pw / 1920, "children": hook_still()}]}
    duration = round(t_preview + 1.3, 2)

    # The camera reads along: onto each command as it is typed, back to watch the spec stream, onto the progress bar.
    y_cmd2 = row_y(r_cmd2) + final_scroll_at(scroll, end2)
    y_bar = row_y(r_bar) + final_scroll
    camera = {"moves": [
        {"preset": "moveTo", "target": "cmd1", "zoom": 1.85, "at": 0.55, "duration": 1.1, "ease": "inOutCubic", "offset": [0, -30]},
        {"preset": "moveTo", "x": -120, "y": 90, "zoom": 1.32, "at": enter1, "duration": 1.1, "ease": "inOutCubic"},
        {"preset": "moveTo", "x": -120, "y": -150, "zoom": 1.36, "at": enter1 + 1.2, "duration": t_spec_done - enter1 - 0.9, "ease": "inOutSine"},
        {"preset": "moveTo", "target": "cmd2", "zoom": 1.8, "at": t_p2 - 0.2, "duration": 0.9, "ease": "inOutCubic", "offset": [0, -30]},
        {"preset": "moveTo", "x": -300, "y": round(y_bar + 10, 1), "zoom": 1.55, "at": enter2, "duration": 0.8, "ease": "inOutCubic"},
        {"preset": "moveTo", "x": 120, "y": -40, "zoom": 1.08, "at": t_done + 0.1, "duration": 1.1, "ease": "inOutCubic"},
    ]}
    _ = y_cmd2
    scene = {"id": "terminal", "duration": duration, "background": BG, "camera": camera,
             "post": {"bloom": {"strength": 0.35}, "grain": 0.02, "vignette": 0.35},
             "layers": [backdrop(), terminal, preview]}
    return scene, final_scroll


def final_scroll_at(scroll, t):
    v = 0
    for k in scroll:
        if k[0] <= t:
            v = k[1]
    return v


def backdrop():
    return {"type": "glow", "color": AMBER, "size": 2200, "intensity": 0.05, "y": -200}


# ---------------------------------------------------------------- the mini ad: Crema

def cup(x=380, y=-30, anim=True):
    """A cup of coffee from shapes: saucer, handle, cup, crema, latte art, steam."""
    def a(d):
        return d if anim else {}
    steam = []
    for i, dx in enumerate([-60, 0, 60]):
        pts = [[dx, 150], [dx + 22, 200], [dx - 18, 255], [dx + 16, 310]]
        s = {"type": "path", "points": pts, "smooth": True, "width": 9, "color": "#CDB59B", "opacity": 0.85}
        if anim:
            s["keyframes"] = {"progress": kf((0.9 + i * 0.12, 0), (1.7 + i * 0.12, 1, "outCubic"))}
            s["loop"] = {"preset": "float", "amount": 8, "period": 2.4, "phase": i * 0.3}
        steam.append(s)
    kids = [
        {"type": "shape", "shape": "pill", "y": -140, "width": 460, "height": 46, "fill": LATTE,
         "shadow": {"color": ROAST, "blur": 40, "y": -14, "opacity": 0.18}, **a({"in": {"preset": "growX", "at": 0.45, "duration": 0.6}})},
        {"type": "shape", "shape": "ring", "x": 160, "y": 10, "width": 120, "height": 120, "strokeWidth": 26, "fill": FOAM,
         **a({"in": {"preset": "popIn", "at": 0.7, "duration": 0.5}})},
        {"type": "shape", "y": -10, "width": 300, "height": 250, "radius": 70, "fill": FOAM,
         "shadow": {"color": ROAST, "blur": 50, "y": -20, "opacity": 0.14}, **a({"in": {"preset": "popIn", "at": 0.55, "duration": 0.6}})},
        {"type": "shape", "shape": "circle", "y": 110, "width": 270, "height": 52, "fill": ROAST,
         **a({"in": {"preset": "growX", "at": 0.75, "duration": 0.45}})},
        {"type": "shape", "shape": "circle", "y": 110, "width": 120, "height": 24, "fill": "#D9B48A",
         **a({"in": {"preset": "scaleIn", "from": 0.2, "at": 0.95, "duration": 0.5}})},
        *steam,
    ]
    return {"type": "group", "x": x, "y": y, "children": kids}


def hook_still():
    """The first frame of the Crema video, for the preview window."""
    return [
        text("Crema", 44, 700, ESPRESSO, font="Bricolage Grotesque", x=-820, y=410, align="left", anchor="left", letterSpacing=-0.03),
        text("Coffee,", 120, 700, ESPRESSO, font="Bricolage Grotesque", x=-820, y=90, align="left", anchor="left", letterSpacing=-0.035),
        text("ready when you are.", 84, 600, CARAMEL, font="Bricolage Grotesque", x=-820, y=-30, align="left", anchor="left", letterSpacing=-0.03),
        cup(anim=False),
    ]


def scene_hook():
    return {"id": "crema-hook", "duration": 3.4, "background": BG, "transition": {"type": "fade", "duration": 0.9},
            "camera": {"moves": [{"preset": "pushIn", "amount": 70, "duration": 3.4, "ease": "inOutSine"}]},
            "post": {"bloom": False, "grain": 0, "vignette": 0},
            "layers": [
                {"type": "shape", "width": 1920, "height": 1080, "radius": 0, "fill": CREAM, "share": "screen"},
                text("Crema", 44, 700, ESPRESSO, font="Bricolage Grotesque", x=-820, y=410, align="left", anchor="left", letterSpacing=-0.03,
                     in_={"preset": "fade", "at": 0.5, "duration": 0.5}),
                text("Coffee,", 120, 700, ESPRESSO, font="Bricolage Grotesque", x=-820, y=90, align="left", anchor="left", letterSpacing=-0.035,
                     animate={"preset": "auto"}, start=0.55),
                text("ready when you are.", 84, 600, CARAMEL, font="Bricolage Grotesque", x=-820, y=-30, align="left", anchor="left",
                     letterSpacing=-0.03, animate={"preset": "auto"}, start=1.1),
                cup(),
            ]}


def order_screen(press):
    """The order screen inside the phone (screen is 362 x 772)."""
    return [
        {"type": "shape", "width": 362, "height": 772, "radius": 44, "fill": FOAM},
        text("Good morning, Sam", 22, 600, SOFT, font="Inter", x=-150, y=300, align="left", anchor="left", letterSpacing=-0.01,
             end=press + 0.3, out={"preset": "fade", "duration": 0.2}),
        text("Your usual?", 38, 700, ESPRESSO, font="Bricolage Grotesque", x=-150, y=255, align="left", anchor="left", letterSpacing=-0.02,
             end=press + 0.3, out={"preset": "fade", "duration": 0.2}),
        {"type": "shape", "y": 60, "width": 310, "height": 300, "radius": 28, "fill": CREAM,
         "in": {"preset": "scaleIn", "from": 0.9, "at": 0.5, "duration": 0.5}},
        {"type": "shape", "shape": "circle", "y": 120, "width": 150, "height": 150, "fill": FOAM,
         "in": {"preset": "popIn", "at": 0.6, "duration": 0.5}},
        {"type": "shape", "shape": "circle", "y": 120, "width": 118, "height": 118, "fill": ROAST,
         "in": {"preset": "popIn", "at": 0.68, "duration": 0.5}},
        {"type": "shape", "shape": "circle", "y": 120, "width": 54, "height": 40, "fill": "#D9B48A",
         "in": {"preset": "popIn", "at": 0.8, "duration": 0.5}},
        text("Oat flat white", 28, 700, ESPRESSO, font="Inter", x=-130, y=10, align="left", anchor="left", letterSpacing=-0.02),
        text("$4.50", 28, 700, CARAMEL, font="Inter", x=130, y=10, align="right", anchor="right", letterSpacing=-0.02),
        *[{"type": "shape", "shape": "pill", "x": -90 + i * 90, "y": -45, "width": 76, "height": 40,
           "fill": CARAMEL if i == 1 else FOAM, "stroke": None if i == 1 else LATTE, "strokeWidth": 1.5} for i in range(3)],
        *[text(s, 20, 700, FOAM if i == 1 else SOFT, font="Inter", x=-90 + i * 90, y=-45, letterSpacing=0) for i, s in enumerate("SML")],
        {"type": "button", "label": "Order ahead", "y": -170, "width": 300, "height": 70, "size": 24, "fill": ESPRESSO, "color": FOAM,
         "press": press},
        text("Pickup  8:42 am  Main St", 20, 600, SOFT, font="Inter", y=-232, letterSpacing=0),
        {"type": "toast", "title": "Ready in 4 min", "body": "Oat flat white, medium", "icon": "clock", "accent": CARAMEL,
         "width": 320, "theme": "light", "y": 300, "z": 6, "start": press + 0.25,
         "in": {"preset": "slideDown", "at": press + 0.25, "duration": 0.55, "distance": 60}},
    ]


def scene_order():
    press = 1.75
    phone_x = 360
    return {"id": "crema-order", "duration": 3.8, "background": CREAM, "transition": {"type": "blur", "duration": 0.4},
            "camera": {"moves": [{"preset": "pushIn", "amount": 80, "duration": 3.8, "ease": "inOutSine"}]},
            "post": {"bloom": False, "grain": 0, "vignette": 0},
            "layers": [
                {"type": "phone", "x": phone_x, "y": -10, "width": 390, "height": 800, "color": "#D9CCBC", "screen": FOAM,
                 "keyframes": {"rotateY": kf((0, -18), (1.4, -4, "outCubic"), (3.8, 3, "inOutSine")),
                               "y": kf((0, -120), (1.2, -10, "outExpo"))},
                 "in": {"preset": "fade", "at": 0, "duration": 0.4},
                 "children": order_screen(press)},
                text("Order ahead.", 104, 700, ESPRESSO, font="Bricolage Grotesque", x=-820, y=70, align="left", anchor="left",
                     letterSpacing=-0.035, animate={"preset": "auto"}, start=0.3),
                text("Skip the line.", 104, 700, CARAMEL, font="Bricolage Grotesque", x=-820, y=-50, align="left", anchor="left",
                     letterSpacing=-0.035, animate={"preset": "auto"}, start=press + 0.3),
                {"type": "cursor", "style": "hand", "z": 60,
                 "path": [{"t": 0.6, "x": 820, "y": -520}, {"t": press - 0.1, "x": phone_x + 10, "y": -190, "ease": "inOutCubic"},
                          {"t": 3.8, "x": phone_x + 120, "y": -330, "ease": "inOutSine"}],
                 "clicks": [press]},
            ]}


def scene_brand():
    return {"id": "crema-brand", "duration": 2.9, "background": CREAM, "transition": {"type": "blur", "duration": 0.4},
            "camera": {"moves": [{"preset": "pushIn", "amount": 60, "duration": 2.9, "ease": "inOutSine"}]},
            "post": {"bloom": False, "grain": 0, "vignette": 0},
            "layers": [
                {"type": "shape", "width": 1920, "height": 1080, "radius": 0, "fill": CREAM, "share": "screen"},
                text("Crema", 240, 700, ESPRESSO, font="Bricolage Grotesque", y=60, letterSpacing=-0.045,
                     animate={"preset": "auto"}, start=0.15),
                text("Order ahead. Pick up hot.", 44, 600, SOFT, font="Inter", y=-100, letterSpacing=-0.02,
                     animate={"preset": "auto"}, start=0.7),
                text("crema.app", 30, 700, CARAMEL, font="Inter", y=-300, letterSpacing=0,
                     in_={"preset": "fade", "at": 1.1, "duration": 0.5}),
            ]}


# ---------------------------------------------------------------- back in the terminal

def static_rows(final_scroll, rows_from):
    """The terminal's last lines as they stood when the render finished (no animation)."""
    out = []
    for r, s, hl, color in rows_from:
        y = row_y(r) + final_scroll
        out.append(mono(s, color, y=y, highlight=hl))
    return out


def scene_close(final_scroll):
    n = len(SPEC_LINES)
    r_ok = 2 + n
    r_cmd2 = r_ok + 2
    tail = [
        (2 + k, line, json_highlight(line), MUTED) for k, line in enumerate(SPEC_LINES)
    ] + [
        (r_ok, "  ok  valid spec, 3 scenes, 9.6 s, 1920x1080", [{"text": "ok", "color": GREEN}], DIM),
        (r_cmd2, PROMPT + CMD2, [{"text": "~/crema", "color": GREEN}, {"text": "$", "color": AMBER}, {"text": "npx", "color": AMBER},
                                 {"text": "-q", "color": CORAL}, {"text": CMD2[4:12], "color": TEXT}, {"text": CMD2[13:], "color": TEXT}], MUTED),
        (r_cmd2 + 1, "  rendering  1920x1080  30 fps  motion blur 8x  high", [{"text": "rendering", "color": AMBER}], DIM),
        (r_cmd2 + 2, "  ####################################  frame 288 / 288   100%", [{"text": "100%", "color": AMBER}], DIM),
        (r_cmd2 + 3, "  done  out/ad.mp4  9.6 s  27 MB", [{"text": "done", "color": GREEN}, {"text": "out/ad.mp4", "color": TEXT}], DIM),
    ]
    first_visible = final_scroll // LH
    tail = [t for t in tail if t[0] >= first_visible]
    clear_at = 1.95
    old = {"type": "group", "children": static_rows(final_scroll, tail),
           "keyframes": {"opacity": kf((0, 0.32), (1.4, 0.32), (clear_at, 0, "inCubic"))}, "end": clear_at + 0.05}

    # The terminal is cleared; the name is set in type, and the clone command is typed on the bottom row.
    t_clone = 3.1
    times = typing_times(CLONE, seed=41, pace=0.8)
    cs = 32
    ccw = cs * 0.6
    y_clone = -200
    x_left = -(len(CLONE) + 2) * ccw / 2
    xcmd = x_left + 2 * ccw
    clone_prompt = mono("$ ", AMBER, x=x_left, y=y_clone, size=cs,
                        animate={"preset": "fade", "by": "char", "at": t_clone - 0.35, "stagger": 0.02, "duration": 0.05})
    clone = mono(CLONE, TEXT, x=xcmd, y=y_clone, size=cs, highlight=[{"text": "git", "color": AMBER}, {"text": "https://github.com/b9llach/bemotion", "color": GREEN}],
                 animate={"preset": "typewriter", "at": t_clone, "times": times})
    duration = 6.6
    pw, ph = 640, 360
    landing = {"type": "group", "x": 300, "y": -60, "share": "screen", "z": 2,
               "keyframes": {"scale": kf((1.45, 1), (1.85, 0.0, "inBack")), "opacity": kf((1.6, 1), (1.85, 0))}, "end": 1.9,
               "children": [{"type": "shape", "width": pw, "height": ph, "radius": 14, "fill": CREAM,
                             "shadow": {"blur": 70, "y": -24, "opacity": 0.55}},
                            text("Crema", 240 * pw / 1920, 700, ESPRESSO, font="Bricolage Grotesque", y=20 * pw / 1920, letterSpacing=-0.045)]}
    terminal = {"type": "group", "children": window_chrome("zsh  ~") + [
        old,
        text("Bemotion", 168, 600, TEXT, font="Inter", y=90, letterSpacing=-0.04, animate={"preset": "build", "at": 2.05}),
        text("Prompt to motion.", 50, 500, MUTED, font="Inter", y=-40, letterSpacing=-0.02, highlight=[{"text": "motion.", "color": AMBER}],
             animate={"preset": "auto"}, start=2.65),
        clone_prompt, clone,
        caret(xcmd, y_clone, CLONE, t_clone, times, duration, start=t_clone - 0.35, cw=ccw, fs=cs),
    ]}
    return {"id": "close", "duration": duration, "background": BG, "transition": {"type": "fade", "duration": 0.9},
            "post": {"bloom": {"strength": 0.35}, "grain": 0.02, "vignette": 0.35},
            "camera": {"z": 260, "keyframes": {"z": kf((0, 260), (1.7, 60, "inOutCubic"), (duration, -40, "linear"))},
                       "moves": [{"preset": "drift", "amount": 4, "speed": 0.2}]},
            "layers": [backdrop(), terminal, landing]}


# ---------------------------------------------------------------- assembly

def fix(o):
    if isinstance(o, dict):
        return {("in" if k == "in_" else k): fix(v) for k, v in o.items() if v is not None}
    if isinstance(o, list):
        return [fix(v) for v in o]
    return o


def build():
    term, final_scroll = terminal_scene()
    scenes = [term, scene_hook(), scene_order(), scene_brand(), scene_close(final_scroll)]
    return fix({
        "title": "Bemotion: terminal",
        "fps": FPS, "width": 1920, "height": 1080,
        "theme": {"colors": {"bg": BG, "text": TEXT, "muted": MUTED, "primary": AMBER, "secondary": CORAL, "border": HAIR},
                  "fonts": {"display": "Inter", "body": "Inter", "mono": "JetBrains Mono"}},
        "background": BG,
        "environment": "softbox",
        "audio": [{"src": "media/music/electro-chill-a.mp3", "sync": True, "volume": 0.5, "fadeOut": 2}],
        "sfx": {"mute": ["soft"]},
        "motionBlur": {"samples": 8, "shutter": 0.3},
        "scenes": scenes,
    })


if __name__ == "__main__":
    write_spec(DIR / "ad.json", build())
