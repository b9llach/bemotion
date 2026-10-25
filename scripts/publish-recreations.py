"""Publishes the two recreation examples so they build from the repo alone.

The remakes are built locally from personal sources (examples/openai-*, examples/context-*, never committed).
This copies every file a remake's spec refers to into examples/media/<name>/ and writes the spec next to the
other examples with its paths rewritten:

  examples/openai-refreshed-public.json -> examples/refreshed-recreation.json   (media in examples/media/refreshed/)
  examples/context-people-search.json   -> examples/people-search-recreation.json (media in examples/media/people-search/)

The OpenAI Sans font is not redistributable, so the public Refreshed spec sets its type in Inter (OFL) instead,
instanced from the Inter variable font at the weights the film uses.

Run from the repo root after rebuilding a remake: python scripts/publish-recreations.py
"""

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EX = ROOT / "examples"
INTER_VF = Path("C:/Windows/Fonts/Inter-VariableFont_opsz,wght.ttf")
STAND_IN = "Inter Display"

JOBS = [
    ("openai-refreshed-public.json", "refreshed-recreation.json", "openai-media", "refreshed"),
    ("context-people-search.json", "people-search-recreation.json", "context-media", "people-search"),
]


def publish(src_name, dst_name, media_dir, name):
    text = (EX / src_name).read_text(encoding="utf-8")
    spec = json.loads(text)
    out_dir = EX / "media" / name
    if out_dir.exists():
        shutil.rmtree(out_dir)
    refs = sorted(set(re.findall(rf'"({re.escape(media_dir)}/[^"]+)"', text)))
    fonts = spec.get("fonts", {})
    skip = set()
    if "OpenAI Sans" in fonts:
        # Not redistributable: replace with Inter at the same weights.
        skip = set(fonts["OpenAI Sans"].values())
        new = {}
        for w in fonts["OpenAI Sans"]:
            dst = out_dir / "fonts" / f"Inter-{w}.ttf"
            dst.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run([sys.executable, "-m", "fontTools.varLib.instancer", str(INTER_VF), "opsz=28", f"wght={w}", "--remove-overlaps", "-o", str(dst), "-q"], check=True)
            new[w] = f"media/{name}/fonts/Inter-{w}.ttf"
        # Rename the family only where it names a font (the film's own text still says OpenAI Sans).
        text = text.replace('"font": "OpenAI Sans"', f'"font": "{STAND_IN}"')
        spec = json.loads(text)
        spec["fonts"] = {STAND_IN: new, **{k: v for k, v in spec["fonts"].items() if k != "OpenAI Sans"}}
        theme_fonts = spec.get("theme", {}).get("fonts", {})
        for k, v in theme_fonts.items():
            if v == "OpenAI Sans":
                theme_fonts[k] = STAND_IN
        text = json.dumps(spec, indent=1)
        # Inter is under the SIL Open Font License: ship its license with the files.
        shutil.copy2(ROOT / "node_modules" / "@fontsource" / "inter" / "LICENSE", out_dir / "fonts" / "OFL.txt")
    copied = 0
    for ref in refs:
        if ref in skip:
            continue
        rel = ref[len(media_dir) + 1:]
        dst = out_dir / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(EX / ref, dst)
        copied += 1
    text = text.replace(f'"{media_dir}/', f'"media/{name}/')
    left = re.findall(r'"[a-z]+-media/[^"]+"', text)
    if left:
        raise SystemExit(f"{dst_name}: unpublished references remain: {left[:3]}")
    (EX / dst_name).write_text(text.rstrip("\n") + "\n", encoding="utf-8", newline="\n")
    size = sum(f.stat().st_size for f in out_dir.rglob("*") if f.is_file())
    print(f"{dst_name}: {copied} files ({size / 1e6:.1f} MB) in examples/media/{name}/")


if __name__ == "__main__":
    for job in JOBS:
        publish(*job)
