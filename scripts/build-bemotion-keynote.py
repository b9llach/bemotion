"""Builds projects/bemotion-keynote/ad.json: "Keynote", an Apple keynote style kinetic type film for Bemotion.

Pure typography. One to three words at a time, every line centered and arriving its own way, hard cuts
between black and white. The story: motion design used to take weeks; now it takes a sentence. A typed
prompt, "You describe it." morphing into "You direct it.", four quick truths (real 3D, every frame
rendered, cut to your music, every format with "16:9" morphing through the other aspect ratios), the
callback "Not weeks." answered by one big warm gradient "Minutes.", and the wordmark set in type.
The opening "Now." is the window into the second scene: a mask transition dives through it.
"""

from genlib import ROOT, write_spec

BLACK = "#000000"
WHITE = "#FFFFFF"
INK = "#1D1D1F"
GRAY = "#86868B"
DARK_GRAY = "#6E6E73"
WARM = ["#F2A65A", "#D8657F", "#8B4FD8"]  # amber, rose, violet
FONT = {"font": "display", "weight": 600, "letterSpacing": -0.035}


def say(text, t0, t1, size=96, y=0, color=WHITE, style="auto", exit=True, **kw):
    """One centered line of type. `style` is an engine line style or "auto"; with `exit` the line leaves with
    the exit that carries on its entrance."""
    anim = kw.pop("animate", None) or {"preset": style}
    layer = {"type": "text", "text": text, "size": size, "y": y, "color": color, **FONT, "start": t0, "end": t1,
             "animate": anim}
    if exit:
        layer["animateOut"] = {"preset": "auto"}
    layer.update(kw)
    return layer


def push_in(dur, amount=80):
    return {"moves": [{"preset": "pushIn", "amount": amount, "duration": dur, "ease": "inOutSine"}]}


def drift_scale(t0, t1, a=1.0, b=1.05):
    """A slow, linear grow while a word holds, so nothing sits still."""
    return {"scale": [{"t": t0, "v": a}, {"t": t1, "v": b, "ease": "linear"}]}


# ---------------------------------------------------------------- 1. black: the old way

def scene_before():
    dur = 6.6
    return {"id": "before", "duration": dur, "background": BLACK, "camera": push_in(dur, 90), "layers": [
        say("Motion design", 0.3, 1.35, size=104, style="push"),
        say("used to take", 1.35, 2.15, size=88, style="depth"),
        say("weeks.", 2.15, 3.05, size=180, weight=700, style="focusPull",
            keyframes=drift_scale(2.15, 3.05, 1, 1.04)),
        say("Keyframe by keyframe.", 3.05, 4.25, size=84, color=WHITE, style="pushPop",
            highlight=[{"text": "by keyframe.", "color": DARK_GRAY}]),
        # The window into the next scene: the mask transition starts over these letters.
        say("Now.", 4.25, dur, size=300, weight=700, style="ripple", exit=False, id="now",
            keyframes=drift_scale(4.6, dur, 1, 1.05)),
    ]}


# ---------------------------------------------------------------- 2. white, through "Now.": the promise

def scene_sentence():
    dur = 3.4
    return {"id": "sentence", "duration": dur, "background": WHITE,
            "transition": {"type": "mask", "text": "Now.", "from": "now", "duration": 1.3},
            "camera": push_in(dur, 70), "layers": [
        say("It takes a sentence.", 1.15, dur, size=96, color=INK, exit=False,
            animate={"preset": "lift", "by": "word", "glide": True, "stagger": 0.16, "duration": 0.6, "ease": "outQuart"},
            highlight=[{"text": "a sentence.", "color": GRAY}],
            keyframes=drift_scale(2.0, dur, 1, 1.05)),
    ]}


# ---------------------------------------------------------------- 3. black: the sentence itself

PROMPT = "A calm launch film. Black and white. Thirty seconds."


def type_times(text, start=0.0):
    """Human typing: quick runs inside words, short pauses at spaces, longer ones after periods."""
    times, t, prev = [], start, ""
    for ch in text:
        if ch == " ":
            prev = ch
            continue
        if prev == " ":
            t += 0.08
        if prev == ".":
            t += 0.16
        times.append(round(t, 3))
        t += 0.026
        prev = ch
    return times


def scene_prompt():
    dur = 3.0
    return {"id": "prompt", "duration": dur, "background": BLACK, "transition": {"type": "cut"},
            "camera": push_in(dur, 60), "layers": [
        {"type": "text", "text": PROMPT, "font": "mono", "size": 46, "weight": 400, "letterSpacing": -0.01,
         "color": "#D2D2D7", "start": 0.0, "end": dur,
         "highlight": [{"text": "Thirty seconds.", "color": GRAY}],
         "animate": {"preset": "typewriter", "at": 0.15, "times": type_times(PROMPT)},
         "animateOut": {"preset": "fade", "by": "word", "stagger": 0.03, "duration": 0.3, "at": dur - 0.45}},
    ]}


# ---------------------------------------------------------------- 4. white: describe, direct

def scene_direct():
    dur = 3.9
    return {"id": "direct", "duration": dur, "background": WHITE, "transition": {"type": "cut"},
            "camera": push_in(dur, 80), "layers": [
        say("You don't animate it.", 0.05, 1.3, size=88, color=INK, style="fromLeft",
            highlight=[{"text": "animate", "color": GRAY}]),
        say("You describe it.", 1.3, dur, size=104, color=INK, exit=False,
            animate={"preset": "lift", "by": "word", "direction": "none", "scale": 0.9, "stagger": 0.09, "duration": 0.5, "ease": "outQuart"},
            morph=[{"text": "You direct it.", "at": 2.6, "duration": 0.75, "ease": "inOutCubic"}],
            keyframes=drift_scale(3.2, dur, 1, 1.03)),
    ]}


# ---------------------------------------------------------------- 5-8. four truths

def scene_3d():
    dur = 2.7
    return {"id": "real-3d", "duration": dur, "background": BLACK, "transition": {"type": "cut"},
            "camera": push_in(dur, 90), "layers": [
        say("Real 3D.", 0.05, 1.35, size=170, weight=700, style="tipUp"),
        say("Real light.", 1.35, dur, size=120, style="fromRight", exit=False,
            highlight=[{"text": "light.", "color": GRAY}]),
    ]}


def scene_frames():
    dur = 2.6
    return {"id": "frames", "duration": dur, "background": WHITE, "transition": {"type": "cut"},
            "camera": push_in(dur, 70), "layers": [
        say("Every frame,", 0.05, dur, size=110, y=72, color=INK, style="plop", exit=False),
        say("rendered.", 0.75, dur, size=110, y=-62, color=GRAY, exit=False,
            animate={"preset": "lift", "by": "char", "stagger": 0.035, "duration": 0.55, "ease": "outQuart", "blur": 10}),
    ]}


def scene_music():
    dur = 2.5
    return {"id": "music", "duration": dur, "background": BLACK, "transition": {"type": "cut"},
            "camera": push_in(dur, 80), "layers": [
        say("Cut to your music.", 0.05, dur, size=104, exit=False,
            animate={"preset": "build", "stagger": 0.2, "duration": 0.55},
            highlight=[{"text": "your music.", "color": GRAY}]),
    ]}


def scene_formats():
    dur = 3.6
    return {"id": "formats", "duration": dur, "background": WHITE, "transition": {"type": "cut"},
            "camera": push_in(dur, 60), "layers": [
        say("16:9", 0.05, dur, size=230, y=70, color=INK, weight=700, style="scatter", exit=False,
            letterSpacing=-0.02,
            morph=[{"text": "9:16", "at": 0.85, "duration": 0.55},
                   {"text": "1:1", "at": 1.55, "duration": 0.55},
                   {"text": "4:5", "at": 2.25, "duration": 0.55}]),
        say("Every format.", 0.5, dur, size=56, y=-120, color=GRAY, exit=False,
            animate={"preset": "lift", "by": "line", "direction": "up", "distance": 24, "duration": 0.9, "ease": "outQuart"}),
    ]}


# ---------------------------------------------------------------- 9. black: the callback

def scene_minutes():
    dur = 3.0
    return {"id": "minutes", "duration": dur, "background": BLACK, "transition": {"type": "cut"},
            "camera": push_in(dur, 110), "layers": [
        say("Not weeks.", 0.05, 0.95, size=96, color=GRAY, style="collapse"),
        {"type": "text", "text": "Minutes.", "size": 290, **FONT, "weight": 700, "start": 0.95, "end": dur,
         "gradient": {"colors": WARM, "angle": 100},
         "animate": {"preset": "lift", "by": "char", "stagger": 0.05, "duration": 0.75, "ease": "outQuart", "blur": 14, "distance": 40},
         "animateOut": {"preset": "fade", "by": "line", "duration": 0.35, "at": dur - 0.35},
         "keyframes": drift_scale(0.95, dur, 1, 1.06)},
    ]}


# ---------------------------------------------------------------- 10. white: the wordmark

def scene_brand():
    dur = 4.3
    return {"id": "brand", "duration": dur, "background": WHITE, "transition": {"type": "cut"},
            "camera": push_in(dur, 50), "layers": [
        {"type": "text", "text": "Bemotion", "size": 156, **FONT, "weight": 600, "letterSpacing": -0.04, "color": INK,
         "y": 46, "animate": {"preset": "lift", "by": "char", "stagger": 0.04, "duration": 0.8, "ease": "outQuart",
                              "direction": "up", "distance": 30, "blur": 12, "at": 0.15}},
        {"type": "text", "text": "Prompt to motion.", "size": 46, **FONT, "weight": 500, "letterSpacing": -0.02,
         "color": GRAY, "y": -76, "animate": {"preset": "lift", "by": "word", "stagger": 0.1, "duration": 0.8,
                                                  "ease": "outQuart", "at": 0.85}},
        {"type": "text", "text": "github.com/b9llach/bemotion", "size": 28, "font": "display", "weight": 500,
         "letterSpacing": -0.01, "color": INK, "y": -250, "in": {"preset": "fade", "at": 1.5, "duration": 0.8}},
    ]}


video = {
    "title": "Bemotion Keynote",
    "fps": 30,
    "theme": {"colors": {"bg": BLACK, "text": WHITE}, "fonts": {"display": "Inter", "body": "Inter", "mono": "JetBrains Mono"}},
    "post": {"bloom": False, "grain": 0, "vignette": 0, "chromatic": 0},
    "sfx": {"kit": "soft", "volume": 0.5},
    "audio": [{"src": "media/music/lovely-piano-song.mp3", "volume": 1.0, "sync": True, "fadeOut": 2.0}],
    "scenes": [scene_before(), scene_sentence(), scene_prompt(), scene_direct(), scene_3d(), scene_frames(),
               scene_music(), scene_formats(), scene_minutes(), scene_brand()],
}

write_spec(ROOT / "projects" / "bemotion-keynote" / "ad.json", video)
