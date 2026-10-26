"""Speech recognition with word timestamps, for voiceovers (run by src/cli/transcribe.ts).

Reads a JSON request on stdin:
  {"audio": "<file>", "out": "<file.json>", "model": "small", "language": "en" | null,
   "prompt": "<optional text that biases the vocabulary>", "device": "auto" | "cuda" | "cpu"}
and writes to `out`:
  {"model", "device", "language", "words": [{"w", "start", "end", "p"}]}
with times in seconds into the file and p the word probability.

Uses faster-whisper (CTranslate2) when installed, otherwise openai-whisper. On a GPU it runs in
float16; when CUDA cannot be used it falls back to the CPU (int8). Exit code 3: no Whisper installed.
"""
import json
import sys


def log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def run_faster(req):
    from faster_whisper import WhisperModel

    model_name = req["model"]
    devices = ["cuda", "cpu"] if req.get("device", "auto") == "auto" else [req["device"]]
    last = None
    for device in devices:
        compute = "float16" if device == "cuda" else "int8"
        try:
            model = WhisperModel(model_name, device=device, compute_type=compute)
            segments, info = model.transcribe(
                req["audio"],
                language=req.get("language") or None,
                word_timestamps=True,
                initial_prompt=req.get("prompt") or None,
                beam_size=5,
                vad_filter=False,
                condition_on_previous_text=False,
            )
            words = []
            for seg in segments:
                for w in seg.words or []:
                    words.append({"w": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3), "p": round(w.probability, 3)})
            return {"model": model_name, "device": device, "language": info.language, "engine": "faster-whisper", "words": words}
        except Exception as e:  # CUDA libraries missing or out of memory: try the next device
            last = e
            if device == "cuda" and len(devices) > 1:
                log(f"GPU transcription unavailable ({type(e).__name__}: {str(e)[:200]}), using the CPU")
    raise last


def run_openai(req):
    import torch
    import whisper

    device = req.get("device", "auto")
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    model = whisper.load_model(req["model"], device=device)
    result = model.transcribe(
        req["audio"],
        language=req.get("language") or None,
        word_timestamps=True,
        initial_prompt=req.get("prompt") or None,
        fp16=device == "cuda",
        condition_on_previous_text=False,
    )
    words = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []):
            words.append({"w": w["word"].strip(), "start": round(w["start"], 3), "end": round(w["end"], 3), "p": round(w.get("probability", 1.0), 3)})
    return {"model": req["model"], "device": device, "language": result.get("language"), "engine": "openai-whisper", "words": words}


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--check":
        for mod in ("faster_whisper", "whisper"):
            try:
                __import__(mod)
                print(mod)
                return 0
            except ImportError:
                pass
        return 3
    req = json.loads(sys.stdin.read())
    try:
        import faster_whisper  # noqa: F401
        runner = run_faster
    except ImportError:
        try:
            import whisper  # noqa: F401
            runner = run_openai
        except ImportError:
            log("Whisper is not installed: pip install faster-whisper (or openai-whisper)")
            return 3
    out = runner(req)
    with open(req["out"], "w", encoding="utf-8", newline="") as f:
        json.dump(out, f)
    log(f"Transcribed {len(out['words'])} words ({out['engine']} {out['model']} on {out['device']}, language {out['language']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
