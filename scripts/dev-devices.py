"""Development scene: the procedural devices on the white set, for judging the models.

Writes examples/dev/devices-test.json.
"""
import json

from genlib import ROOT
from devices import laptop, phone, tablet

GROUND = -300

video = {
    "title": "Devices test",
    "fps": 30,
    "environment": {"src": "hdri:studio_small_09", "intensity": 1.0, "rotation": 40},
    "lighting": {"shadows": True, "ground": GROUND, "shadowOpacity": 0.18, "softness": 18, "key": [-0.3, 1, 0.5]},
    "theme": {"colors": {"bg": "#FFFFFF", "text": "#111114"}, "fonts": {"display": "Inter", "body": "Inter", "mono": "JetBrains Mono"}},
    "post": {"bloom": False, "grain": 0, "vignette": 0},
    "motionBlur": False,
    "scenes": [{
        "id": "devices",
        "duration": 4,
        "camera": {"y": 420, "z": 300, "targetY": GROUND + 150,
                   "keyframes": {"orbit": [{"t": 0, "v": -20}, {"t": 4, "v": 20, "ease": "linear"}]}},
        "layers": [
            {"type": "background", "style": "radial", "colors": ["#FFFFFF", "#EDEDF0"], "center": [0, 200], "intensity": 1.3},
            laptop(w=900, y=GROUND, z=-150, open=112),
            phone(w=170, x=640, y=GROUND + 180, z=80, rotateY=-20, rotateX=-8),
            phone(w=170, x=-660, y=GROUND + 180, z=80, rotateY=200, back=True, color="#7D7A74"),
            tablet(w=420, x=-430, y=GROUND + 4, z=360, rotateX=-90, rotate=12),
        ],
    }],
}

out = ROOT / "examples" / "dev" / "devices-test.json"
out.write_text(json.dumps(video, indent=2) + "\n", encoding="utf-8", newline="\n")
print(f"wrote {out}")
