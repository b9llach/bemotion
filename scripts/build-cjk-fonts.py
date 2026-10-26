"""Builds the bundled CJK fallback fonts (assets/fonts/cjk/) from @fontsource's Noto Sans JP, SC and KR.

The @fontsource files keep overlapping contours (they are instances of variable fonts), which troika's
signed distance fields draw as thin seams where strokes cross. This merges the overlaps away and writes
WOFF files the engine loads (src/engine/fonts.ts). Noto Sans is under the SIL Open Font License 1.1
(assets/fonts/cjk/OFL.txt).

Needs: pip install fonttools==4.60.1 skia-pathops==0.8.0.post2
Run: python scripts/build-cjk-fonts.py
"""
import os
import shutil
import sys

from fontTools.ttLib import TTFont
from fontTools.ttLib.removeOverlaps import removeOverlaps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "fonts", "cjk")
SOURCES = {
    "jp": "japanese",
    "sc": "chinese-simplified",
    "kr": "korean",
}
WEIGHTS = [400, 700]


def main():
    os.makedirs(OUT, exist_ok=True)
    for code, subset in SOURCES.items():
        pkg = os.path.join(ROOT, "node_modules", "@fontsource", f"noto-sans-{code}")
        for w in WEIGHTS:
            src = os.path.join(pkg, "files", f"noto-sans-{code}-{subset}-{w}-normal.woff")
            if not os.path.exists(src):
                print(f"missing {src} (npm install first)")
                return 1
            font = TTFont(src)
            removeOverlaps(font)
            font.flavor = "woff"
            dst = os.path.join(OUT, f"noto-sans-{code}-{w}.woff")
            font.save(dst)
            print(f"wrote {os.path.relpath(dst, ROOT)} ({os.path.getsize(dst) // 1024} KB, {len(font.getGlyphOrder())} glyphs)")
        shutil.copyfile(os.path.join(pkg, "LICENSE"), os.path.join(OUT, "OFL.txt"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
