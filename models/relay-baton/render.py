#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""STLのプレビュー画像（PNG）を作る簡易レンダラ

外部ライブラリを使わず、Zバッファ＋フラットシェーディングで描画して
標準ライブラリの zlib で PNG を書き出す。

    python3 render.py stl/relay-baton-1piece.stl -o preview.png
    python3 render.py stl/relay-baton-split-a.stl stl/relay-baton-split-b.stl \
        -o preview-split.png
"""

import argparse
import math
import os
import struct
import zlib
from array import array

BG = (246, 245, 242)
MATERIAL = (232, 122, 44)      # PLAオレンジ
AMBIENT = 0.30
LIGHT = (-0.35, -0.72, 0.60)   # ビュー座標での光の向き（視点側やや左上）


def load_stl(path):
    with open(path, "rb") as f:
        data = f.read()
    n = struct.unpack("<I", data[80:84])[0]
    tris = []
    off = 84
    for _ in range(n):
        vals = struct.unpack_from("<12f", data, off)
        tris.append((vals[3:6], vals[6:9], vals[9:12]))
        off += 50
    return tris


def transform(tris, spin, tilt, roll):
    """モデルを回して (screen_x, screen_y, depth) に変換する"""
    cs, sn = math.cos(math.radians(spin)), math.sin(math.radians(spin))
    ct, st = math.cos(math.radians(tilt)), math.sin(math.radians(tilt))
    cr, sr = math.cos(math.radians(roll)), math.sin(math.radians(roll))
    out = []
    for tri in tris:
        pts = []
        for (x, y, z) in tri:
            x, y = x * cs - y * sn, x * sn + y * cs      # 長軸まわりに回す
            y, z = y * ct - z * st, y * st + z * ct      # 手前に倒す
            sx, sy, d = x, z, -y                         # 正射影（奥行き=-y）
            pts.append((sx * cr - sy * sr, sx * sr + sy * cr, d))
        out.append(pts)
    return out


def render(groups, width, ss, spin, tilt, roll, gap):
    parts = [transform(load_stl(path), spin, tilt, roll) for path in groups]

    # 複数モデルは横に並べる
    tris, x_cursor = [], 0.0
    for chunk in parts:
        xs = [p[0] for t in chunk for p in t]
        dx = x_cursor - min(xs)
        tris.extend([(p[0] + dx, p[1], p[2]) for p in t] for t in chunk)
        x_cursor = max(xs) + dx + gap

    xs = [p[0] for t in tris for p in t]
    ys = [p[1] for t in tris for p in t]
    pad = 0.04 * max(max(xs) - min(xs), max(ys) - min(ys))
    x0, x1 = min(xs) - pad, max(xs) + pad
    y0, y1 = min(ys) - pad, max(ys) + pad
    W = width * ss
    scale = W / (x1 - x0)
    H = max(1, int(round((y1 - y0) * scale)))

    zbuf = array("f", [-1e30]) * (W * H)
    img = bytearray(BG * (W * H))
    ll = math.sqrt(sum(c * c for c in LIGHT))
    lx, ly, lz = [c / ll for c in LIGHT]

    for t in tris:
        p = [((px - x0) * scale, H - 1 - (py - y0) * scale, pz)
             for (px, py, pz) in t]
        (ax, ay, az), (bx, by, bz), (cx, cy, cz) = p
        area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
        if area == 0.0:
            continue
        # 法線（ビュー座標）。画面の裏を向く面は穴から見える内側なので反転して使う
        ux, uy, uz = t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]
        vx, vy, vz = t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]
        nx = uy * vz - uz * vy
        ny = uz * vx - ux * vz
        nz = ux * vy - uy * vx
        nl = math.sqrt(nx * nx + ny * ny + nz * nz)
        if nl == 0.0:
            continue
        nx, ny, nz = nx / nl, ny / nl, nz / nl
        if nz < 0:
            nx, ny, nz = -nx, -ny, -nz
        shade = AMBIENT + (1.0 - AMBIENT) * max(0.0, nx * lx + ny * ly + nz * lz)
        col = bytes(min(255, int(c * shade + 0.5)) for c in MATERIAL)

        ix0 = max(0, int(math.floor(min(ax, bx, cx))))
        ix1 = min(W - 1, int(math.ceil(max(ax, bx, cx))))
        iy0 = max(0, int(math.floor(min(ay, by, cy))))
        iy1 = min(H - 1, int(math.ceil(max(ay, by, cy))))
        if ix0 > ix1 or iy0 > iy1:
            continue
        inv = 1.0 / area
        for py in range(iy0, iy1 + 1):
            yc = py + 0.5
            row = py * W
            for px in range(ix0, ix1 + 1):
                xc = px + 0.5
                w0 = ((bx - ax) * (yc - ay) - (xc - ax) * (by - ay)) * inv
                w1 = ((xc - ax) * (cy - ay) - (cx - ax) * (yc - ay)) * inv
                if w0 < 0.0 or w1 < 0.0 or w0 + w1 > 1.0:
                    continue
                depth = az + (bz - az) * w1 + (cz - az) * w0
                idx = row + px
                if depth > zbuf[idx]:
                    zbuf[idx] = depth
                    img[idx * 3:idx * 3 + 3] = col
    return downsample(img, W, H, ss)


def downsample(img, W, H, ss):
    if ss == 1:
        return img, W, H
    w, h = W // ss, H // ss
    out = bytearray(w * h * 3)
    for y in range(h):
        for x in range(w):
            r = g = b = 0
            for dy in range(ss):
                base = ((y * ss + dy) * W + x * ss) * 3
                for dx in range(ss):
                    r += img[base + dx * 3]
                    g += img[base + dx * 3 + 1]
                    b += img[base + dx * 3 + 2]
            n = ss * ss
            o = (y * w + x) * 3
            out[o] = r // n
            out[o + 1] = g // n
            out[o + 2] = b // n
    return out, w, h


def write_png(path, img, w, h):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw.extend(img[y * w * 3:(y + 1) * w * 3])

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(bytes(raw), 9)))
        f.write(chunk(b"IEND", b""))


def main():
    ap = argparse.ArgumentParser(description="STLのプレビューPNGを作る")
    ap.add_argument("stl", nargs="+")
    ap.add_argument("-o", "--out", default="preview.png")
    ap.add_argument("--width", type=int, default=900)
    ap.add_argument("--ss", type=int, default=2, help="スーパーサンプリング倍率")
    ap.add_argument("--spin", type=float, default=35.0)
    ap.add_argument("--tilt", type=float, default=12.0)
    ap.add_argument("--roll", type=float, default=33.0)
    ap.add_argument("--gap", type=float, default=18.0)
    args = ap.parse_args()

    img, w, h = render(args.stl, args.width, args.ss,
                       args.spin, args.tilt, args.roll, args.gap)
    write_png(args.out, img, w, h)
    print("%s (%dx%d, %.1f KB)" % (args.out, w, h,
                                   os.path.getsize(args.out) / 1024.0))


if __name__ == "__main__":
    main()
