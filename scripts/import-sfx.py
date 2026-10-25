"""Builds the recorded sound-effect kit ("studio") from Kenney's CC0 audio packs.

Each sound is trimmed to its onset (so it lands exactly on its cue), cut to a sensible length, faded out,
loudness-matched within its role, and written as a small mono 48 kHz Ogg file to assets/sfx/studio/<role>/.
src/audio/samples.json lists the files per role.

Packs (CC0, https://kenney.nl): Interface Sounds, UI Audio, Impact Sounds, Casino Audio, RPG Audio.
Run: python scripts/import-sfx.py <folder with the unpacked packs>
"""

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
FF = str(ROOT / "node_modules" / "ffmpeg-static" / "ffmpeg.exe")
OUT = ROOT / "assets" / "sfx" / "studio"
SR = 48000

# role: (files, longest length in s, loudness target as RMS in dBFS over the sound's body)
KIT = {
    "tick": (["casino-audio/card-place-1", "casino-audio/card-slide-1", "casino-audio/card-slide-2", "casino-audio/card-slide-5",
              "casino-audio/card-slide-6", "casino-audio/card-slide-8"], 0.25, -30),
    "key": (["ui-audio/click1", "ui-audio/click2", "ui-audio/click3", "ui-audio/mouseclick1", "ui-audio/mouserelease1"], 0.12, -30),
    "click": (["ui-audio/mouseclick1", "ui-audio/click2", "casino-audio/chip-lay-1", "casino-audio/chip-lay-3"], 0.2, -24),
    "pop": (["impact-sounds/impactWood_light_000", "impact-sounds/impactWood_light_001", "impact-sounds/impactWood_light_002",
             "impact-sounds/impactWood_light_003", "casino-audio/chips-collide-1", "casino-audio/chips-collide-3"], 0.35, -26),
    "swoosh": (["casino-audio/card-slide-3", "casino-audio/card-slide-4", "casino-audio/card-slide-7", "casino-audio/card-shove-1",
                "casino-audio/card-shove-2", "casino-audio/card-shove-3", "casino-audio/card-shove-4"], 0.6, -26),
    "whoosh": (["casino-audio/card-fan-1", "casino-audio/card-fan-2", "rpg-audio/cloth1", "rpg-audio/cloth3", "rpg-audio/cloth2"], 1.0, -24),
    "soft": (["casino-audio/card-place-2", "casino-audio/card-place-3", "casino-audio/card-place-4", "rpg-audio/bookPlace1",
              "rpg-audio/bookPlace2", "rpg-audio/bookPlace3"], 0.4, -28),
    "impact": (["impact-sounds/impactSoft_heavy_000", "impact-sounds/impactSoft_heavy_001", "impact-sounds/impactSoft_heavy_002",
                "impact-sounds/impactSoft_heavy_003", "impact-sounds/impactSoft_heavy_004"], 0.6, -18),
    "sparkle": (["impact-sounds/impactGlass_light_000", "impact-sounds/impactGlass_light_001", "impact-sounds/impactGlass_light_002",
                 "impact-sounds/impactGlass_light_003", "impact-sounds/impactGlass_light_004"], 0.9, -30),
    "chime": (["impact-sounds/impactBell_heavy_000", "impact-sounds/impactBell_heavy_001", "impact-sounds/impactBell_heavy_002"], 1.6, -30),
    "glitch": (["interface-sounds/glitch_001", "interface-sounds/glitch_002", "interface-sounds/glitch_003", "interface-sounds/glitch_004"], 0.3, -26),
}


def find(src: Path, name: str) -> Path:
    pack, stem = name.split("/")
    hits = [p for p in (src / pack).rglob(f"{stem}.ogg")]
    if not hits:
        raise SystemExit(f"missing {name}")
    return hits[0]


def load(path: Path) -> np.ndarray:
    raw = subprocess.run([FF, "-loglevel", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).copy()


def prepare(a: np.ndarray, longest: float, target_db: float) -> np.ndarray:
    env = np.abs(a)
    peak = env.max() or 1
    on = np.where(env > peak * 0.04)[0]
    start = max(0, on[0] - int(0.003 * SR)) if len(on) else 0
    a = a[start:start + int(longest * SR)]
    # Short fade out so a cut never clicks.
    fade = min(len(a), int(0.04 * SR))
    a[-fade:] *= np.linspace(1, 0, fade) ** 2
    body = a[: max(1, int(0.25 * SR))]
    rms = np.sqrt((body ** 2).mean()) or 1e-6
    gain = 10 ** (target_db / 20) / rms
    a = a * gain
    # Never clip.
    if np.abs(a).max() > 0.95:
        a *= 0.95 / np.abs(a).max()
    return a


def main():
    src = Path(sys.argv[1])
    manifest = {}
    if OUT.exists():
        for p in OUT.rglob("*.ogg"):
            p.unlink()
    for role, (files, longest, target) in KIT.items():
        (OUT / role).mkdir(parents=True, exist_ok=True)
        names = []
        for i, name in enumerate(files):
            a = prepare(load(find(src, name)), longest, target)
            out = OUT / role / f"{role}-{i + 1}.ogg"
            subprocess.run([FF, "-loglevel", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-", "-c:a", "libvorbis", "-q:a", "5", str(out)],
                           input=a.astype(np.float32).tobytes(), check=True)
            names.append(out.name)
        manifest[role] = names
    (ROOT / "src" / "audio" / "samples.json").write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8", newline="\n")
    (ROOT / "assets" / "sfx" / "LICENSE.txt").write_text(
        "The recorded sound effects in this folder come from Kenney's audio packs (Interface Sounds, UI Audio,\n"
        "Impact Sounds, Casino Audio, RPG Audio), created and distributed by Kenney (www.kenney.nl).\n\n"
        "License: Creative Commons Zero, CC0 (http://creativecommons.org/publicdomain/zero/1.0/).\n"
        "They were trimmed, faded and loudness-matched by scripts/import-sfx.py.\n", encoding="utf-8", newline="\n")
    total = sum(p.stat().st_size for p in OUT.rglob("*.ogg"))
    print(f"wrote {sum(len(v) for v in manifest.values())} sounds ({total / 1024:.0f} KB) in {len(manifest)} roles")


if __name__ == "__main__":
    main()
