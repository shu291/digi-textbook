#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
六角鉛筆ソード / HEX PENCIL SWORD
=================================

普通の六角鉛筆（JIS 対辺 7.8mm・長さ 176mm）に差し込む 4 つの部品。
全部はめると 1 本の剣になる。

    z=226 ┐
          │  BLADE   剣身（先端キャップ兼用）  144mm
    z= 82 ┤
          │  GUARD   鍔                        16mm
    z= 66 ┤
          │  GRIP    握り（縄巻き風の螺旋溝）   54mm
    z= 12 ┤
          │  POMMEL  柄頭                      20mm
    z= -8 ┘
                                   全長 234mm

STL は「輪（リング）の積み重ね」だけで組み立てている。
外側の面・内側（穴）の面・端の輪っか蓋、をそれぞれ張るので
ブーリアン演算のライブラリが要らず、numpy だけで動く。

    python3 generate.py            # STL + プレビュー PNG を出力
    python3 generate.py --no-preview

寸法を変えたいときは下の「調整パラメータ」だけ触ればよい。
"""

import argparse
import math
import os
import struct
import sys
import zlib

import numpy as np

# ---------------------------------------------------------------------------
# 調整パラメータ（ここだけ触れば寸法が変わる）
# ---------------------------------------------------------------------------

# --- 鉛筆 ---
PENCIL_AF = 7.8          # 六角鉛筆の対辺距離 (JIS S 6005 は 7.6〜8.0)
PENCIL_LEN = 175.0       # 新品の鉛筆の長さ（部品の形には影響しない。図の見た目だけ）

# --- はめあい ---
BORE_AF = 8.45           # 穴の対辺距離。ゆるい＝下げる / きつい＝上げる
RIB_AF = 7.95            # 抜け止めリブの頂点での実効対辺距離
RIB_COUNT = 6            # リブの本数（六角の「面」の真ん中を押す＝6本）
RIB_HALF_ANG = 6.0       # リブの角度半幅 [deg]

# --- 各部品の長さ ---
POMMEL_LEN = 20.0
GRIP_LEN = 54.0
GUARD_LEN = 16.0
BLADE_LEN = 144.0
BLADE_SOCKET = 96.0      # 剣身が鉛筆をくわえる深さ

# --- メッシュの細かさ ---
N_THETA = 180            # 円周方向の分割数（60 の約数刻みになるよう 180 推奨）
GRIP_STEP = 0.75         # 握りを z 方向に刻む間隔 [mm]

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
STL_DIR = os.path.join(OUT_DIR, "stl")
PNG_DIR = os.path.join(OUT_DIR, "preview")

# 組み立てたときの各部品の下端 z
Z_POMMEL = -8.0
Z_GRIP = Z_POMMEL + POMMEL_LEN          # 12
Z_GUARD = Z_GRIP + GRIP_LEN             # 66
Z_BLADE = Z_GUARD + GUARD_LEN           # 82

TH = np.arange(N_THETA) * 2.0 * math.pi / N_THETA
COS_T = np.cos(TH)
SIN_T = np.sin(TH)


# ---------------------------------------------------------------------------
# 断面 → 極座標半径
# ---------------------------------------------------------------------------

def hex_radii(across_flats):
    """正六角形。x 軸上に頂点、y 軸に面が向く（＝厚み方向が対辺距離）。"""
    a = across_flats / 2.0
    t = np.mod(TH, math.pi / 3.0) - math.pi / 6.0
    return a / np.cos(t)


def polygon_radii(poly):
    """原点から星形に見える多角形を、TH の各方向へレイを飛ばして半径にする。"""
    P = np.asarray(poly, dtype=float)
    E = np.roll(P, -1, axis=0) - P
    px, py = P[:, 0][None, :], P[:, 1][None, :]
    ex, ey = E[:, 0][None, :], E[:, 1][None, :]
    c, s = COS_T[:, None], SIN_T[:, None]

    den = c * ey - s * ex
    with np.errstate(divide="ignore", invalid="ignore"):
        u = (s * px - c * py) / den
        t = (px + u * ex) * c + (py + u * ey) * s

    ok = np.isfinite(u) & (u >= -1e-9) & (u <= 1 + 1e-9) & np.isfinite(t) & (t > 0)
    t = np.where(ok, t, -np.inf)
    r = t.max(axis=1)
    if not np.all(np.isfinite(r)):
        raise ValueError("断面が原点から星形になっていない")
    return r


def blade_radii(half_w, half_t, ridge, edge_flat=0.30):
    """刀身の断面。中央に鎬（平らな帯）、そこから二段の刃付けで刃先へ。

              ____________              ← 鎬地（平ら / 幅 2*ridge）
             /            \\            ← ゆるい面
        <                      >         ← 急な面 → 刃先（ほんの少し平ら）
             \\____________/

    二段にすると光の当たり方が変わって、刃の筋がはっきり出る。
    """
    e = min(edge_flat, half_t * 0.4)
    r = min(ridge, half_w * 0.8)
    bx = r + (half_w - r) * 0.30            # 面の折れ目
    by = half_t - (half_t - e) * 0.14
    poly = [
        (half_w, e), (bx, by), (r, half_t), (-r, half_t), (-bx, by), (-half_w, e),
        (-half_w, -e), (-bx, -by), (-r, -half_t), (r, -half_t), (bx, -by), (half_w, -e),
    ]
    return polygon_radii(poly)


def superellipse_radii(hx, hy, n):
    """|x/hx|^n + |y/hy|^n = 1。n=2 で楕円、n を上げると角丸長方形。"""
    c = np.abs(COS_T / hx) ** n
    s = np.abs(SIN_T / hy) ** n
    return (c + s) ** (-1.0 / n)


def rib_profile(depth):
    """抜け止めリブ：六角の面の中央（30°, 90°, ...）を内側へ depth だけ出っ張らせる。"""
    if depth <= 0:
        return np.zeros_like(TH)
    pitch = 2.0 * math.pi / RIB_COUNT
    d = np.mod(TH - math.pi / 6.0, pitch)
    d = np.minimum(d, pitch - d)
    w = np.clip(d / math.radians(RIB_HALF_ANG), 0.0, 1.0)
    return depth * np.cos(w * math.pi / 2.0) ** 2


RIB_DEPTH = max(0.0, (BORE_AF - RIB_AF) / 2.0)


def bore_levels(z_bottom, z_top, rib_bands=()):
    """穴（内側の面）の輪を積む。rib_bands = [(下端z, 上端z), ...] にリブを立てる。"""
    ramp = 0.8
    base = hex_radii(BORE_AF)
    marks = [(z_bottom, 0.0), (z_top, 0.0)]
    for lo, hi in rib_bands:
        marks += [(lo - ramp, 0.0), (lo, 1.0), (hi, 1.0), (hi + ramp, 0.0)]

    out, seen = [], set()
    for z, amount in sorted(marks):
        if z < z_bottom - 1e-9 or z > z_top + 1e-9:
            continue
        z = min(max(z, z_bottom), z_top)
        key = (round(z, 4), round(amount, 4))
        if key in seen:
            continue
        seen.add(key)
        out.append((z, base - rib_profile(RIB_DEPTH * amount)))
    return out


# ---------------------------------------------------------------------------
# メッシュ組み立て
# ---------------------------------------------------------------------------

class Mesh:
    def __init__(self):
        self._v = []
        self._f = []
        self._n = 0

    def add_ring(self, radii, z):
        xyz = np.stack([radii * COS_T, radii * SIN_T, np.full(N_THETA, float(z))], axis=1)
        base = self._n
        self._v.append(xyz)
        self._n += N_THETA
        return base

    def add_point(self, x, y, z):
        base = self._n
        self._v.append(np.array([[x, y, z]], dtype=float))
        self._n += 1
        return base

    def tri(self, a, b, c):
        self._f.append((a, b, c))

    def arrays(self):
        return np.concatenate(self._v, axis=0), np.asarray(self._f, dtype=np.int64)


def add_stack(mesh, levels, outward):
    """z 昇順の [(z, radii), ...] を筒状に張る。outward=False で法線を内向きに。"""
    bases = [mesh.add_ring(r, z) for z, r in levels]
    for lo, hi in zip(bases, bases[1:]):
        for j in range(N_THETA):
            k = (j + 1) % N_THETA
            if outward:
                mesh.tri(lo + j, lo + k, hi + k)
                mesh.tri(lo + j, hi + k, hi + j)
            else:
                mesh.tri(lo + j, hi + k, lo + k)
                mesh.tri(lo + j, hi + j, hi + k)
    return bases[0], bases[-1]


def add_annulus(mesh, outer_base, inner_base, up):
    """外周リングと内周リングの間に輪っか状の蓋を張る。up=True で法線 +z。"""
    for j in range(N_THETA):
        k = (j + 1) % N_THETA
        if up:
            mesh.tri(outer_base + j, outer_base + k, inner_base + k)
            mesh.tri(outer_base + j, inner_base + k, inner_base + j)
        else:
            mesh.tri(outer_base + j, inner_base + j, inner_base + k)
            mesh.tri(outer_base + j, inner_base + k, outer_base + k)


def add_cap(mesh, ring_base, z, up):
    """リングを中心からの扇で塞ぐ。"""
    c = mesh.add_point(0.0, 0.0, z)
    for j in range(N_THETA):
        k = (j + 1) % N_THETA
        if up:
            mesh.tri(c, ring_base + j, ring_base + k)
        else:
            mesh.tri(c, ring_base + k, ring_base + j)


def make_part(outer_levels, inner_levels):
    """外形と穴から中空の部品をつくる。穴が途中で終われば行き止まりの袋穴になる。"""
    mesh = Mesh()
    o_lo, o_hi = add_stack(mesh, outer_levels, outward=True)
    i_lo, i_hi = add_stack(mesh, inner_levels, outward=False)

    if abs(outer_levels[0][0] - inner_levels[0][0]) > 1e-9:
        raise ValueError("外形と穴の下端の高さが違う")
    add_annulus(mesh, o_lo, i_lo, up=False)

    if abs(outer_levels[-1][0] - inner_levels[-1][0]) < 1e-9:
        add_annulus(mesh, o_hi, i_hi, up=True)
    else:
        add_cap(mesh, o_hi, outer_levels[-1][0], up=True)     # 外側の天面
        add_cap(mesh, i_hi, inner_levels[-1][0], up=False)    # 袋穴の天井
    return mesh.arrays()


def volume(V, F):
    """発散定理で体積 [mm^3]。閉じていないと意味のない値になる。"""
    t = V[F]
    return float(np.abs(np.einsum("ij,ij->i", t[:, 0], np.cross(t[:, 1], t[:, 2])).sum()) / 6.0)


def check_closed(F, name):
    """全ての有向辺が 1 回ずつ、逆向きと対で現れる＝閉じた立体、を確認する。"""
    e = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]], axis=0)
    key = e[:, 0].astype(np.int64) * (F.max() + 1) + e[:, 1]
    rev = e[:, 1].astype(np.int64) * (F.max() + 1) + e[:, 0]
    if len(np.unique(key)) != len(key):
        raise AssertionError(f"{name}: 同じ向きの辺が重複している")
    if not np.all(np.isin(rev, key)):
        raise AssertionError(f"{name}: 穴があいている（対になる逆向きの辺がない）")


# ---------------------------------------------------------------------------
# 部品ごとの形
# ---------------------------------------------------------------------------

def part_blade():
    """剣身。下 96mm が鉛筆をくわえる袋穴、その先 48mm は中実で切先まで細る。"""
    # (z, 半幅, 半厚, 鎬の半幅)
    profile = [
        (0.0,   10.60, 6.00, 3.30),  # 鍔に乗る根元
        (3.0,   11.05, 6.00, 3.35),
        (8.0,   11.30, 6.00, 3.40),  # 肩（いちばん幅広 22.6mm）
        (50.0,  10.90, 5.95, 3.40),
        (96.0,  10.20, 5.90, 3.40),  # 袋穴の終わり。ここまでは肉厚が要る
        (118.0,  9.00, 4.90, 3.00),
        (132.0,  6.90, 3.60, 2.40),
        (138.0,  4.90, 2.50, 1.70),
        (142.0,  2.70, 1.40, 0.95),
        (144.0,  1.10, 0.60, 0.35),  # 切先はわざと 2.2×1.2mm の平ら
    ]
    outer = [(z, blade_radii(w, t, r)) for z, w, t, r in profile]
    inner = bore_levels(0.0, BLADE_SOCKET, rib_bands=[(6.0, 16.0)])
    return make_part(outer, inner)


def part_guard():
    """鍔。根元から 45° で立ち上がって翼になるので、サポート無しで刷れる。"""
    profile = [
        (0.0,   8.10, 6.90),        # 握りの上に乗る根元
        (1.5,   9.10, 6.78),
        (4.0,  11.30, 6.62),        # ここから翼。傾きはどこも 43° 以下
        (7.0,  14.00, 6.45),
        (10.0, 16.70, 6.28),
        (12.5, 18.90, 6.13),
        (14.0, 20.20, 6.05),
        (14.9, 20.60, 6.02),        # 翼の先端（全幅 41.2mm）
        (15.5, 17.00, 6.00),
        (16.0, 11.20, 6.00),        # 天面。この上に剣身が乗る
    ]
    outer = [(z, blade_radii(hw, t, min(max(hw * 0.30, 3.3), 6.0))) for z, hw, t in profile]
    inner = bore_levels(0.0, GUARD_LEN, rib_bands=[(4.0, 11.0)])
    return make_part(outer, inner)


def part_grip():
    """握り。ゆるい鼓形＋8 条の螺旋溝で、柄巻きみたいに見せる。"""
    kz = [0.0, 4.0, 27.0, 50.0, 54.0]
    khx = [7.45, 7.20, 6.92, 7.20, 7.45]
    khy = [7.00, 6.75, 6.48, 6.75, 7.00]

    n_groove, depth = 8, 0.60
    half_ang = math.radians(11.0)
    helix = math.radians(8.0)       # 1mm 進むごとに何度ねじれるか
    pitch = 2.0 * math.pi / n_groove

    def radii(z):
        base = superellipse_radii(np.interp(z, kz, khx), np.interp(z, kz, khy), 4.0)
        d = np.mod(TH - helix * z, pitch)
        d = np.minimum(d, pitch - d)
        w = np.clip(d / half_ang, 0.0, 1.0)
        fade = np.clip(min(z, GRIP_LEN - z) / 4.0, 0.0, 1.0)   # 端は溝を消して平らな縁に
        return base - depth * fade * np.cos(w * math.pi / 2.0) ** 2

    steps = int(round(GRIP_LEN / GRIP_STEP))
    outer = [(z, radii(z)) for z in (i * GRIP_LEN / steps for i in range(steps + 1))]
    inner = bore_levels(0.0, GRIP_LEN, rib_bands=[(8.0, 16.0), (38.0, 46.0)])
    return make_part(outer, inner)


def part_pommel():
    """柄頭。底は平らでベッドに直に置ける。上端は握りの下端と同じ太さ。"""
    # (z, hx, hy, 角ばり具合)
    profile = [
        (0.0,  5.50, 4.85, 3.0),
        (3.5,  8.40, 7.35, 3.2),
        (7.0,  9.40, 8.20, 3.4),    # いちばん太いところ 18.8×16.4mm
        (11.0, 8.70, 7.60, 3.5),
        (15.0, 8.00, 7.10, 3.7),
        (16.0, 7.75, 6.85, 3.8),    # 飾りの溝
        (17.0, 7.70, 6.80, 3.8),
        (18.0, 8.05, 7.20, 3.9),
        (20.0, 7.45, 7.00, 4.0),    # 握りの下端に合わせる
    ]
    outer = [(z, superellipse_radii(hx, hy, n)) for z, hx, hy, n in profile]
    inner = bore_levels(1.8, POMMEL_LEN, rib_bands=[(4.0, 11.0)])

    # 他の部品と違って下端は塞がっている（袋穴が上から掘られている）ので手で張る
    mesh = Mesh()
    o_lo, o_hi = add_stack(mesh, outer, outward=True)
    i_lo, i_hi = add_stack(mesh, inner, outward=False)
    add_cap(mesh, o_lo, outer[0][0], up=False)        # ぺったり平らな底
    add_annulus(mesh, o_hi, i_hi, up=True)            # 穴の口
    add_cap(mesh, i_lo, inner[0][0], up=True)         # 袋穴の底
    return mesh.arrays()


def part_fit_rings():
    """はめあい確認用の輪っか 3 個。高さで見分ける（低い＝きつい）。

        高さ  8mm → BORE_AF - 0.25
        高さ 11mm → BORE_AF          ← 本番の部品と同じ
        高さ 14mm → BORE_AF + 0.25

    本番と同じく抜け止めリブも付けてあるので、「挿さるか」だけでなく
    「押し込んだあと落ちないか」まで、そのまま確かめられる。
    """
    verts, faces = [], []
    n_off = 0
    for i, delta in enumerate((-0.25, 0.0, +0.25)):
        h = 8.0 + i * 3.0
        rim = superellipse_radii(7.4, 6.6, 4.0)
        hexr = hex_radii(BORE_AF + delta)
        rib = rib_profile(max(0.0, (BORE_AF - RIB_AF) / 2.0))
        outer = [(0.0, rim), (h, rim)]
        inner = [(0.0, hexr), (1.6, hexr), (2.4, hexr - rib),
                 (h - 2.4, hexr - rib), (h - 1.6, hexr), (h, hexr)]
        V, F = make_part(outer, inner)
        verts.append(V + np.array([(i - 1) * 20.0, 0.0, 0.0]))
        faces.append(F + n_off)
        n_off += len(V)
    return np.concatenate(verts), np.concatenate(faces)


# ---------------------------------------------------------------------------
# STL 出力
# ---------------------------------------------------------------------------

def write_stl(path, V, F):
    tri = V[F].astype(np.float64)
    nrm = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    ln = np.linalg.norm(nrm, axis=1, keepdims=True)
    nrm = np.divide(nrm, ln, out=np.zeros_like(nrm), where=ln > 0)

    block = np.concatenate([nrm[:, None, :], tri], axis=1).astype("<f4")
    block = np.ascontiguousarray(block).reshape(len(F), 12).view(np.uint8).reshape(len(F), 48)
    rec = np.zeros((len(F), 50), dtype=np.uint8)
    rec[:, :48] = block

    with open(path, "wb") as fh:
        fh.write(b"HEX PENCIL SWORD".ljust(80, b"\0"))
        fh.write(struct.pack("<I", len(F)))
        fh.write(rec.tobytes())


# ---------------------------------------------------------------------------
# プレビュー描画（自前の Z バッファ・ラスタライザ）
# ---------------------------------------------------------------------------

def write_png(path, rgb):
    h, w, _ = rgb.shape
    lines = b"".join(b"\x00" + rgb[y].tobytes() for y in range(h))

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(lines, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)


def _rot(axis, deg):
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    if axis == "x":
        return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])
    if axis == "y":
        return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def render(parts, path, size, spin=0.0, tilt=0.0, roll=90.0,
           margin=0.05, ss=2, bg=(250, 249, 246)):
    """parts = [(V, F, (r,g,b)), ...] を平行投影でフラットシェーディングする。

    spin  剣を自分の軸まわりに回す（0=平地が正面 / 90=真横から）
    tilt  画面の横軸まわりに倒す
    roll  画面内での回転（既定 90 で剣が水平に寝る）
    """
    W, H = size[0] * ss, size[1] * ss

    # 剣の軸（ワールド z）を画面の上向きに持ってくる基本姿勢
    base = np.array([[1.0, 0, 0], [0, 0, 1.0], [0, -1.0, 0]])
    R = _rot("z", roll) @ _rot("x", tilt) @ base @ _rot("z", spin)

    cam = [(V @ R.T, F, col) for V, F, col in parts]
    allv = np.concatenate([v for v, _, _ in cam])
    lo, hi = allv.min(axis=0), allv.max(axis=0)
    ctr = (lo + hi) / 2.0
    span = (hi - lo)[:2]
    scale = min(W * (1 - 2 * margin) / span[0], H * (1 - 2 * margin) / span[1])

    zbuf = np.full((H, W), -np.inf)
    img = np.zeros((H, W, 3), np.float64)
    img[:] = bg

    light = np.array([-0.42, 0.38, 0.82])
    light /= np.linalg.norm(light)

    for V, F, col in cam:
        sx = (V[:, 0] - ctr[0]) * scale + W / 2.0
        sy_ = H / 2.0 - (V[:, 1] - ctr[1]) * scale
        sz = V[:, 2]
        P = np.stack([sx, sy_, sz], axis=1)

        tri = P[F]
        n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        # 画面 y を上下反転して焼いているので、こちらを向いた面はラスタ法線が -z
        keep = n[:, 2] < 0
        tri, n = tri[keep], n[keep]
        if not len(tri):
            continue

        nw = np.cross(V[F[keep][:, 1]] - V[F[keep][:, 0]], V[F[keep][:, 2]] - V[F[keep][:, 0]])
        nw /= np.maximum(np.linalg.norm(nw, axis=1, keepdims=True), 1e-12)
        lam = np.clip(nw @ light, 0.0, 1.0)
        shade = 0.30 + 0.62 * lam + 0.22 * lam ** 14    # 環境光 + 拡散 + 弱いハイライト
        base = np.array(col, dtype=float)
        colors = np.clip(shade[:, None] * base, 0, 255)

        x0 = np.clip(np.floor(tri[:, :, 0].min(axis=1)).astype(int), 0, W - 1)
        x1 = np.clip(np.ceil(tri[:, :, 0].max(axis=1)).astype(int), 0, W - 1)
        y0 = np.clip(np.floor(tri[:, :, 1].min(axis=1)).astype(int), 0, H - 1)
        y1 = np.clip(np.ceil(tri[:, :, 1].max(axis=1)).astype(int), 0, H - 1)
        area = ((tri[:, 1, 0] - tri[:, 0, 0]) * (tri[:, 2, 1] - tri[:, 0, 1])
                - (tri[:, 2, 0] - tri[:, 0, 0]) * (tri[:, 1, 1] - tri[:, 0, 1]))

        for i in range(len(tri)):
            if abs(area[i]) < 1e-9 or x1[i] < x0[i] or y1[i] < y0[i]:
                continue
            xs = np.arange(x0[i], x1[i] + 1) + 0.5
            ys = np.arange(y0[i], y1[i] + 1) + 0.5
            gx, gy = np.meshgrid(xs, ys)
            a, b, c = tri[i]
            w0 = ((b[0] - a[0]) * (gy - a[1]) - (gx - a[0]) * (b[1] - a[1])) / area[i]
            w1 = ((gx - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (gy - a[1])) / area[i]
            inside = (w0 >= -1e-9) & (w1 >= -1e-9) & (w0 + w1 <= 1 + 1e-9)
            if not inside.any():
                continue
            z = a[2] + w1 * (b[2] - a[2]) + w0 * (c[2] - a[2])
            sub = zbuf[y0[i]:y1[i] + 1, x0[i]:x1[i] + 1]
            hit = inside & (z > sub)
            if not hit.any():
                continue
            sub[hit] = z[hit]
            img[y0[i]:y1[i] + 1, x0[i]:x1[i] + 1][hit] = colors[i]

    out = img.reshape(H // ss, ss, W // ss, ss, 3).mean(axis=(1, 3))
    write_png(path, np.clip(out, 0, 255).astype(np.uint8))


# ---------------------------------------------------------------------------

STEEL = (176, 186, 198)
BRASS = (196, 158, 84)
LEATHER = (92, 66, 54)
WOOD = (214, 168, 82)


def pencil_mesh(z_bottom, length):
    """プレビュー用。中身の鉛筆（削った先端つき）。"""
    a = PENCIL_AF / 2.0
    r = hex_radii(PENCIL_AF)
    levels = [(z_bottom, r), (z_bottom + length - 20.0, r),
              (z_bottom + length - 3.0, r * (2.2 / a)), (z_bottom + length, r * (0.35 / a))]
    mesh = Mesh()
    lo, hi = add_stack(mesh, levels, outward=True)
    add_cap(mesh, lo, levels[0][0], up=False)
    add_cap(mesh, hi, levels[-1][0], up=True)
    return mesh.arrays()


def shifted(part, dz):
    V, F = part
    return V + np.array([0.0, 0.0, dz]), F


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-preview", action="store_true")
    args = ap.parse_args()

    os.makedirs(STL_DIR, exist_ok=True)
    os.makedirs(PNG_DIR, exist_ok=True)

    items = [
        ("01_blade_ken",   "剣身",   part_blade(),  Z_BLADE,  STEEL),
        ("02_guard_tsuba", "鍔",     part_guard(),  Z_GUARD,  BRASS),
        ("03_grip_tsuka",  "握り",   part_grip(),   Z_GRIP,   LEATHER),
        ("04_pommel",      "柄頭",   part_pommel(), Z_POMMEL, BRASS),
    ]

    print(f"鉛筆 対辺 {PENCIL_AF}mm / 穴 対辺 {BORE_AF}mm / リブ頂点 {RIB_AF}mm")
    print(f"全長 {Z_BLADE + BLADE_LEN - Z_POMMEL:.0f}mm\n")

    total_cc = 0.0
    for name, jp, (V, F), _, _ in items:
        check_closed(F, name)
        write_stl(os.path.join(STL_DIR, name + ".stl"), V, F)
        h = V[:, 2].max() - V[:, 2].min()
        w = V[:, 0].max() - V[:, 0].min()
        d = V[:, 1].max() - V[:, 1].min()
        cc = volume(V, F) / 1000.0
        total_cc += cc
        print(f"  {name:<16} {jp:<3}  {w:5.1f} x {d:5.1f} x {h:6.1f} mm  "
              f"{len(F):6d} 面  中実体積 {cc:5.2f} cm3")

    V, F = part_fit_rings()
    check_closed(F, "fit rings")
    write_stl(os.path.join(STL_DIR, "05_fit_test_rings.stl"), V, F)
    print(f"  {'05_fit_test_rings':<16} {'試し':<3}  はめあい確認用 3 個         "
          f"{len(F):6d} 面  中実体積 {volume(V, F) / 1000.0:5.2f} cm3")
    print(f"\n  4 部品あわせて {total_cc:.1f} cm3（中実）／ 充填 20% ならフィラメント約 "
          f"{total_cc * 0.45 * 1.24:.0f} g 前後")

    if args.no_preview:
        return

    print("\nプレビューを描画中 ...")
    assembled = [(shifted(p, dz)[0], p[1], col) for _, _, p, dz, col in items]
    pencil = pencil_mesh(-6.2, PENCIL_LEN)

    render(assembled, os.path.join(PNG_DIR, "01_assembled_front.png"),
           (1400, 300), spin=0, tilt=0)
    render(assembled, os.path.join(PNG_DIR, "02_assembled_edge.png"),
           (1400, 260), spin=90, tilt=0)
    render(assembled, os.path.join(PNG_DIR, "03_assembled_3q.png"),
           (1400, 380), spin=34, tilt=13)

    # 部品を一列に並べた図（鉛筆 → 柄頭 → 握り → 鍔 → 剣身 の順に差していく）
    row, z = [(shifted(pencil, 6.2)[0], pencil[1], WOOD)], PENCIL_LEN + 20.0
    for _, _, p, _, col in reversed(items):
        row.append((shifted(p, z - p[0][:, 2].min())[0], p[1], col))
        z += (p[0][:, 2].max() - p[0][:, 2].min()) + 12.0
    render(row, os.path.join(PNG_DIR, "04_parts.png"), (1600, 300), spin=28, tilt=11)

    # 書くとき：剣身を抜くと鉛筆の先が出る
    writing = [(shifted(p, dz)[0], p[1], col) for _, _, p, dz, col in items[1:]]
    writing.append((pencil[0], pencil[1], WOOD))
    render(writing, os.path.join(PNG_DIR, "05_writing_mode.png"),
           (1400, 340), spin=28, tilt=12)

    # 柄まわりの寄り（握りの螺旋溝と鍔の形）
    render(writing[:-1], os.path.join(PNG_DIR, "06_hilt_detail.png"),
           (1200, 520), spin=26, tilt=16)

    print("完了")


if __name__ == "__main__":
    sys.exit(main())
