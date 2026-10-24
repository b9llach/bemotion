"""Development scene: the checkout terminal alone on the white set, for judging the model.

Writes examples/dev/terminal-test.json. Usage: python scripts/dev-terminal.py [hdri|softbox]
"""
import json
import sys

from genlib import ROOT
from terminal import terminal

GROUND = -380
env = sys.argv[1] if len(sys.argv) > 1 else "hdri"

video = {
    "title": "Terminal test",
    "fps": 30,
    "environment": {"src": "hdri:studio_small_09", "intensity": 1.0, "rotation": 40} if env == "hdri" else "softbox",
    "lighting": {"shadows": True, "ground": GROUND, "shadowOpacity": 0.2, "softness": 16, "key": [-0.3, 1, 0.5]},
    "theme": {"colors": {"bg": "#FFFFFF", "text": "#111114"}, "fonts": {"display": "Inter", "body": "Inter", "mono": "JetBrains Mono"}},
    "post": {"bloom": False, "grain": 0, "vignette": 0},
    "motionBlur": False,
    "scenes": [{
        "id": "terminal",
        "duration": 4,
        "camera": {"y": 520, "z": 120, "targetY": GROUND + 300, "targetZ": 0,
                   "keyframes": {"orbit": [{"t": 0, "v": -18}, {"t": 4, "v": 18, "ease": "linear"}]}},
        "layers": [
            {"type": "background", "style": "radial", "colors": ["#FFFFFF", "#EEEEF1"], "center": [0, 200], "intensity": 1.3},
            terminal(id="terminal", y=GROUND, rotateY=-30, approve_at=3.0, led_at=2.5),
        ],
    }],
}

out = ROOT / "examples" / "dev" / "terminal-test.json"
out.write_text(json.dumps(video, indent=2) + "\n", encoding="utf-8", newline="\n")
print(f"wrote {out}")
