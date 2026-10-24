"""Writes examples/dev/assets/cube.gltf: a tiny glTF 2.0 file (cube, PBR material, spin animation) for testing the model layer."""
import base64
import json
import math
import pathlib
import struct

faces = [
    ((1, 0, 0), [(1, -1, -1), (1, 1, -1), (1, 1, 1), (1, -1, 1)]),
    ((-1, 0, 0), [(-1, -1, 1), (-1, 1, 1), (-1, 1, -1), (-1, -1, -1)]),
    ((0, 1, 0), [(-1, 1, -1), (-1, 1, 1), (1, 1, 1), (1, 1, -1)]),
    ((0, -1, 0), [(-1, -1, 1), (-1, -1, -1), (1, -1, -1), (1, -1, 1)]),
    ((0, 0, 1), [(-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)]),
    ((0, 0, -1), [(1, -1, -1), (-1, -1, -1), (-1, 1, -1), (1, 1, -1)]),
]
pos, nrm, idx = [], [], []
for n, quad in faces:
    base = len(pos)
    for v in quad:
        pos.append(v)
        nrm.append(n)
    idx += [base, base + 1, base + 2, base, base + 2, base + 3]

times = [0.0, 1.0, 2.0]
quats = []
for t in times:
    a = math.pi * t / 2  # 0 -> 180 degrees around Y over 2 s
    quats.append((0.0, math.sin(a / 2), 0.0, math.cos(a / 2)))

blob = b""
views = []


def add(data: bytes, target=None):
    global blob
    while len(blob) % 4:
        blob += b"\x00"
    views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data), **({"target": target} if target else {})})
    blob += data
    return len(views) - 1


v_pos = add(b"".join(struct.pack("<3f", *p) for p in pos), 34962)
v_nrm = add(b"".join(struct.pack("<3f", *n) for n in nrm), 34962)
v_idx = add(b"".join(struct.pack("<H", i) for i in idx), 34963)
v_time = add(b"".join(struct.pack("<f", t) for t in times))
v_rot = add(b"".join(struct.pack("<4f", *q) for q in quats))

gltf = {
    "asset": {"version": "2.0", "generator": "bemotion test"},
    "scene": 0,
    "scenes": [{"nodes": [0]}],
    "nodes": [{"mesh": 0, "name": "Cube"}],
    "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1}, "indices": 2, "material": 0}]}],
    "materials": [{"pbrMetallicRoughness": {"baseColorFactor": [0.9, 0.35, 0.2, 1], "metallicFactor": 0.1, "roughnessFactor": 0.4}}],
    "accessors": [
        {"bufferView": v_pos, "componentType": 5126, "count": len(pos), "type": "VEC3", "min": [-1, -1, -1], "max": [1, 1, 1]},
        {"bufferView": v_nrm, "componentType": 5126, "count": len(nrm), "type": "VEC3"},
        {"bufferView": v_idx, "componentType": 5123, "count": len(idx), "type": "SCALAR"},
        {"bufferView": v_time, "componentType": 5126, "count": len(times), "type": "SCALAR", "min": [0], "max": [2]},
        {"bufferView": v_rot, "componentType": 5126, "count": len(quats), "type": "VEC4"},
    ],
    "animations": [{"name": "Spin", "channels": [{"sampler": 0, "target": {"node": 0, "path": "rotation"}}],
                    "samplers": [{"input": 3, "output": 4, "interpolation": "LINEAR"}]}],
    "bufferViews": views,
    "buffers": [{"byteLength": len(blob), "uri": "data:application/octet-stream;base64," + base64.b64encode(blob).decode()}],
}
out = pathlib.Path(__file__).resolve().parent.parent / "examples" / "dev" / "assets" / "cube.gltf"
out.write_text(json.dumps(gltf), encoding="utf-8")
print(f"wrote {out}")
