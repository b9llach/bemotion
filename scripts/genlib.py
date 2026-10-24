"""Safe output for the example generator scripts.

Once a spec exists, the JSON is the source of truth: the visual editor and people edit it directly.
A generator only overwrites a spec that it produced itself and that nobody has changed since, so
re-running a script can never silently discard editor changes. The hash of each generated file is
kept in scripts/.generated.json.

Flags every generator accepts:
  --force         overwrite the spec even if it was edited
  --out <file>    write somewhere else (for example to compare against an edited spec)
"""

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LEDGER = ROOT / "scripts" / ".generated.json"


def _sha(text: str) -> str:
    return hashlib.sha256(text.replace("\r\n", "\n").encode("utf-8")).hexdigest()


def _key(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return path.resolve().as_posix()


def _arg(name: str) -> str | None:
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return None


def write_spec(default_out: Path, video: dict) -> Path:
    out = Path(_arg("--out") or default_out)
    text = json.dumps(video, indent=2) + "\n"
    ledger = json.loads(LEDGER.read_text(encoding="utf-8")) if LEDGER.exists() else {}
    key = _key(out)
    if out.exists() and "--force" not in sys.argv:
        current = out.read_text(encoding="utf-8")
        edited = _sha(current) != ledger.get(key) and _sha(current) != _sha(text)
        if edited:
            sys.exit(
                f"{key} was edited after it was generated (in the visual editor or by hand), so it was not overwritten.\n"
                f"The JSON is the source of truth now. To replace it with this script's output anyway, run again with --force.\n"
                f"To compare, write the generated version elsewhere with --out <file>."
            )
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8", newline="\n")
    if not _arg("--out"):
        ledger[key] = _sha(text)
        LEDGER.write_text(json.dumps(ledger, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {key}")
    return out
