#!/usr/bin/env python3
"""リズムのハンディファン用 風集めノズル（集風器）の STL を生成する。

外部ライブラリなしで動く。プロファイル（内壁の半径 r と高さ z の折れ線）を
360度まわして、内壁・外壁・上下のリングでフタをした閉じた立体をつくる。

    python3 fan_nozzle.py --fan-od 76 --outlet-d 26 -o nozzle.stl

ファンの外径は実測して --fan-od に渡すこと。既定値は目安。
"""

import argparse
import math
import struct

Tri = tuple  # ((x,y,z), (x,y,z), (x,y,z))


def smoothstep(t: float) -> float:
    """0→1 をなめらかにつなぐ。急な段差だと風がはがれて風量が落ちる。"""
    return t * t * (3.0 - 2.0 * t)


def build_profile(p) -> list:
    """内壁の (z, r) 点列を下から上の順で返す。"""
    pts = []

    r_collar = p.fan_od / 2.0 + p.clearance          # 差しこみ口の内半径
    r_outlet = p.outlet_d / 2.0                       # 吹き出し口の内半径

    # 1) 入口の面取り（はめやすくするための広がり）
    steps = 6
    for i in range(steps + 1):
        t = i / steps
        z = p.lead_in * t
        r = r_collar + p.lead_in_flare * (1.0 - t)
        pts.append((z, r))

    # 2) ストレートのえり（ファンの頭にかぶさる部分）
    pts.append((p.collar_h, r_collar))

    # 3) なめらかな絞り
    steps = max(24, int(p.taper_h))
    for i in range(1, steps + 1):
        t = i / steps
        z = p.collar_h + p.taper_h * t
        r = r_collar + (r_outlet - r_collar) * smoothstep(t)
        pts.append((z, r))

    # 4) 出口のストレート（ここで流れの向きがそろう）
    pts.append((p.collar_h + p.taper_h + p.throat_h, r_outlet))

    # z が重複した点を落とす
    cleaned = [pts[0]]
    for z, r in pts[1:]:
        if z - cleaned[-1][0] > 1e-9:
            cleaned.append((z, r))
    return cleaned


def revolve(profile, wall: float, seg: int) -> list:
    """プロファイルを回して、肉厚 wall の閉じた筒をつくる。"""
    tris = []
    cos = [math.cos(2.0 * math.pi * k / seg) for k in range(seg)]
    sin = [math.sin(2.0 * math.pi * k / seg) for k in range(seg)]

    def pt(r, z, k):
        return (r * cos[k], r * sin[k], z)

    def quad(a, b, c, d):
        tris.append((a, b, c))
        tris.append((a, c, d))

    for i in range(len(profile) - 1):
        z0, r0 = profile[i]
        z1, r1 = profile[i + 1]
        for k in range(seg):
            k2 = (k + 1) % seg
            # 内壁（法線は軸の側＝風の通り道に向く）
            quad(pt(r0, z0, k2), pt(r0, z0, k), pt(r1, z1, k), pt(r1, z1, k2))
            # 外壁（法線は外向き）
            quad(pt(r0 + wall, z0, k), pt(r0 + wall, z0, k2),
                 pt(r1 + wall, z1, k2), pt(r1 + wall, z1, k))

    # 下端と上端のリングでフタをする
    z_b, r_b = profile[0]
    z_t, r_t = profile[-1]
    for k in range(seg):
        k2 = (k + 1) % seg
        quad(pt(r_b, z_b, k), pt(r_b, z_b, k2),
             pt(r_b + wall, z_b, k2), pt(r_b + wall, z_b, k))
        quad(pt(r_t, z_t, k2), pt(r_t, z_t, k),
             pt(r_t + wall, z_t, k), pt(r_t + wall, z_t, k2))
    return tris


def box(hx: float, hy: float, z0: float, z1: float, angle: float) -> list:
    """軸を通る板（整流フィン）を1枚。z軸まわりに angle だけ回して置く。"""
    c, s = math.cos(angle), math.sin(angle)

    def v(x, y, z):
        return (x * c - y * s, x * s + y * c, z)

    corners = [(-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)]
    bot = [v(x, y, z0) for x, y in corners]
    top = [v(x, y, z1) for x, y in corners]

    tris = [(bot[0], bot[2], bot[1]), (bot[0], bot[3], bot[2]),
            (top[0], top[1], top[2]), (top[0], top[2], top[3])]
    for i in range(4):
        j = (i + 1) % 4
        tris.append((bot[i], bot[j], top[j]))
        tris.append((bot[i], top[j], top[i]))
    return tris


def straightener(p, profile) -> list:
    """出口の手前に十字の整流フィンを入れて、渦を止めて直進させる。"""
    r_outlet = p.outlet_d / 2.0
    z_top = profile[-1][0]
    z_bot = max(0.0, z_top - p.vane_h)
    tris = []
    for i in range(p.vanes // 2):
        tris += box(r_outlet, p.vane_t / 2.0, z_bot, z_top,
                    math.pi * i / (p.vanes // 2))
    return tris


def normal(t):
    (ax, ay, az), (bx, by, bz), (cx, cy, cz) = t
    ux, uy, uz = bx - ax, by - ay, bz - az
    vx, vy, vz = cx - ax, cy - ay, cz - az
    nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    n = math.sqrt(nx * nx + ny * ny + nz * nz)
    return (0.0, 0.0, 0.0) if n == 0 else (nx / n, ny / n, nz / n)


def write_stl(path: str, tris: list, name: str) -> None:
    with open(path, "wb") as f:
        f.write(name.encode("ascii", "replace")[:80].ljust(80, b" "))
        f.write(struct.pack("<I", len(tris)))
        for t in tris:
            f.write(struct.pack("<3f", *normal(t)))
            for v in t:
                f.write(struct.pack("<3f", *v))
            f.write(struct.pack("<H", 0))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fan-od", type=float, default=76.0, help="ファン頭部の外径 mm（実測して指定）")
    ap.add_argument("--clearance", type=float, default=0.6, help="はめあいのすきま（片側）mm")
    ap.add_argument("--wall", type=float, default=2.0, help="肉厚 mm")
    ap.add_argument("--collar-h", type=float, default=20.0, help="えりの高さ mm")
    ap.add_argument("--lead-in", type=float, default=3.0, help="入口面取りの高さ mm")
    ap.add_argument("--lead-in-flare", type=float, default=1.0, help="入口の広がり mm")
    ap.add_argument("--taper-h", type=float, default=46.0, help="絞りの高さ mm")
    ap.add_argument("--outlet-d", type=float, default=26.0, help="吹き出し口の内径 mm")
    ap.add_argument("--throat-h", type=float, default=14.0, help="出口ストレートの高さ mm")
    ap.add_argument("--segments", type=int, default=192, help="円周の分割数")
    ap.add_argument("--vanes", type=int, default=0, help="整流フィンの枚数（0 か 4）")
    ap.add_argument("--vane-t", type=float, default=1.2, help="フィンの厚み mm")
    ap.add_argument("--vane-h", type=float, default=16.0, help="フィンの高さ mm")
    ap.add_argument("-o", "--out", default="rhythm-fan-nozzle.stl")
    p = ap.parse_args()

    if p.vanes not in (0, 4):
        ap.error("--vanes は 0 か 4")

    profile = build_profile(p)
    tris = revolve(profile, p.wall, p.segments)
    if p.vanes:
        tris += straightener(p, profile)

    write_stl(p.out, tris, "rhythm handy fan wind concentrator")

    z_top = profile[-1][0]
    area_in = math.pi * (p.fan_od / 2.0) ** 2
    area_out = math.pi * (p.outlet_d / 2.0) ** 2
    print(f"{p.out}: {len(tris)} 面")
    print(f"  全高 {z_top:.1f} mm / 最大外径 {(p.fan_od / 2 + p.clearance + p.wall) * 2:.1f} mm")
    print(f"  差しこみ内径 {p.fan_od + p.clearance * 2:.1f} mm / 吹き出し口 {p.outlet_d:.1f} mm")
    print(f"  断面の絞り比 約 {area_in / area_out:.1f} 倍（＝出口の風速の目安）")


if __name__ == "__main__":
    main()
