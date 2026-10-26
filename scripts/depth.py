"""
Monocular depth estimation for Bemotion's image `depth` (called by src/cli/depth.ts).

    python -I scripts/depth.py <image> <out.png> [--model depth-anything/Depth-Anything-V2-Small-hf]

Writes a 16-bit grayscale PNG the size of the image: white is near, black is far (relative depth,
stretched to the full range). Uses Depth Anything V2 Small (Apache-2.0) through transformers, on the
GPU when there is one. Pre- and post-processing are done in torch without numpy, so it also works
where numpy and torch disagree on versions.

Exit codes: 0 done, 2 a missing package (message on stderr), 1 anything else.
"""
import sys


def fail(msg, code=1):
    sys.stderr.write(msg.rstrip() + "\n")
    sys.exit(code)


def main():
    args = sys.argv[1:]
    model_id = "depth-anything/Depth-Anything-V2-Small-hf"
    if "--model" in args:
        i = args.index("--model")
        model_id = args[i + 1]
        del args[i:i + 2]
    if len(args) != 2:
        fail("usage: depth.py <image> <out.png> [--model id]")
    src, out = args

    try:
        import warnings
        warnings.filterwarnings("ignore")
        import torch
        import torch.nn.functional as F
        from PIL import Image
    except ImportError as e:
        fail(f"missing Python package: {e.name}. Install torch and Pillow.", 2)
    try:
        from transformers import AutoModelForDepthEstimation
    except ImportError:
        fail("missing Python package: transformers. Install it with: python -m pip install transformers==4.46.3", 2)

    img = Image.open(src)
    img.load()
    img = img.convert("RGB")
    w, h = img.size

    # The model sees the image with its short side at 518 px, both sides multiples of 14.
    scale = 518 / min(w, h)
    mw = max(14, int(round(w * scale / 14)) * 14)
    mh = max(14, int(round(h * scale / 14)) * 14)
    small = img.resize((mw, mh), Image.BICUBIC)
    x = torch.frombuffer(bytearray(small.tobytes()), dtype=torch.uint8).view(mh, mw, 3)
    x = x.permute(2, 0, 1).float().div(255.0)
    mean = torch.tensor([0.485, 0.456, 0.406]).view(3, 1, 1)
    std = torch.tensor([0.229, 0.224, 0.225]).view(3, 1, 1)
    x = ((x - mean) / std).unsqueeze(0)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    try:
        model = AutoModelForDepthEstimation.from_pretrained(model_id).to(device).eval()
    except Exception as e:  # noqa: BLE001 - shown to the user as is
        fail(f"could not load the depth model {model_id}: {e}")
    with torch.no_grad():
        pred = model(pixel_values=x.to(device)).predicted_depth  # (1, mh, mw), larger = nearer
        pred = F.interpolate(pred.unsqueeze(1), size=(h, w), mode="bicubic", align_corners=False)[0, 0]
        pred = pred.float().cpu()

    # Stretch to the full range, ignoring the extreme 0.5% at each end.
    flat = pred.flatten()
    if flat.numel() > 4_000_000:
        flat = flat[:: flat.numel() // 4_000_000 + 1]
    lo = torch.quantile(flat, 0.005)
    hi = torch.quantile(flat, 0.995)
    d = ((pred - lo) / max(float(hi - lo), 1e-6)).clamp(0, 1)
    v = (d * 65535.0).round().to(torch.int32)
    # 16-bit little-endian bytes without numpy.
    lo_b = (v & 255).to(torch.uint8)
    hi_b = (v >> 8).to(torch.uint8)
    data = torch.stack([lo_b, hi_b], dim=-1).flatten().tolist()
    Image.frombytes("I;16", (w, h), bytes(data)).save(out, format="PNG")
    print(f"{w}x{h} {device} {model_id}")


if __name__ == "__main__":
    main()
