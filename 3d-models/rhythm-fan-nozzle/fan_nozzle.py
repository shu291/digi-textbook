#!/usr/bin/env python3
"""ハンディファン用 風集めノズル（集風器）の STL を生成する。

外部ライブラリなしで動く。内壁の輪郭（高さ z と半径 r の折れ線）を 360 度まわして、
内壁・外壁・上下のリングでフタをした閉じた立体をつくる。

    python3 fan_nozzle.py --fan-od 76 --outlet-d 26 -o nozzle.stl

ファンの外径は実測して --fan-od に渡すこと。既定値は目安。

静音について:
  噴流の騒音は出口の風速のおよそ 5〜6 乗で効く。つまり音を決めるのは
  ほぼ --outlet-d ひとつ。細く絞るほど遠くに届くが、その分うるさくなる。
  --chevrons でつける出口のギザギザ（波形）は、出口の空気と周囲の空気が
  一気にぶつかるのをやわらげて、耳につく低めの「ゴー」を高い周波数に
  ずらす。ジェットエンジンのノズルと同じ考えかた。
"""

import argparse
import math
import struct


def smoothstep(t: float) -> float:
    """0→1 をなめらかにつなぐ。急な段差だと風がはがれて、風量も落ちるし音も出る。"""
    return t * t * (3.0 - 2.0 * t)


def build_profile(p) -> list:
    """内壁の (z, r) 点列を下から上の順で返す。"""
    pts = []

    r_collar = p.fan_od / 2.0 + p.clearance          # 差しこみ口の内半径
    r_outlet = p.outlet_d / 2.0                       # 吹き出し口の内半径

    # 1) 入口の面取り（ファンにはめやすくするための広がり）
    steps = 6
    for i in range(steps + 1):
        t = i / steps
        pts.append((p.lead_in * t, r_collar + p.lead_in_flare * (1.0 - t)))

    # 2) ストレートのえり。ファンの頭がここに収まる。
    #    長いほど羽根と絞りの入口が離れて、羽根が出す渦が壁を叩く音が減る。
    pts.append((p.collar_h, r_collar))

    # 3) なめらかな絞り。長くとるほど壁の傾きがゆるくなり、はがれにくい。
    steps = max(24, int(p.taper_h))
    for i in range(1, steps + 1):
        t = i / steps
        z = p.collar_h + p.taper_h * t
        pts.append((z, r_collar + (r_outlet - r_collar) * smoothstep(t)))

    # 4) 出口のストレート。ここで流れの向きがそろう。
    pts.append((p.collar_h + p.taper_h + p.throat_h, r_outlet))

    cleaned = [pts[0]]
    for z, r in pts[1:]:
        if z - cleaned[-1][0] > 1e-9:
            cleaned.append((z, r))
    return cleaned


def build_crown(chevrons: int, depth: float, seg: int) -> list:
    """出口の縁を波形に切り欠く量（各分割ごとの z のさげ幅、0 以下）。

    とがったギザギザは印刷すると薄く欠けやすいので、なめらかな波にしてある。
    """
    if not chevrons or depth <= 0:
        return None
    return [-depth * 0.5 * (1.0 - math.cos(2.0 * math.pi * chevrons * k / seg))
            for k in range(seg)]


def revolve(profile, wall: float, seg: int, crown=None) -> list:
    """輪郭を z 軸まわりに回して、肉厚 wall の閉じた筒をつくる。"""
    tris = []
    cos = [math.cos(2.0 * math.pi * k / seg) for k in range(seg)]
    sin = [math.sin(2.0 * math.pi * k / seg) for k in range(seg)]
    last = len(profile) - 1

    def pt(i, k, off=0.0):
        z, r = profile[i]
        if crown and i == last:
            z += crown[k]
        r += off
        return (r * cos[k], r * sin[k], z)

    def quad(a, b, c, d):
        tris.append((a, b, c))
        tris.append((a, c, d))

    for i in range(last):
        for k in range(seg):
            k2 = (k + 1) % seg
            # 内壁（法線は軸の側＝風の通り道に向く）
            quad(pt(i, k2), pt(i, k), pt(i + 1, k), pt(i + 1, k2))
            # 外壁（法線は外向き）
            quad(pt(i, k, wall), pt(i, k2, wall),
                 pt(i + 1, k2, wall), pt(i + 1, k, wall))

    # 下端と上端のリングでフタをする
    for k in range(seg):
        k2 = (k + 1) % seg
        quad(pt(0, k), pt(0, k2), pt(0, k2, wall), pt(0, k, wall))
        quad(pt(last, k2), pt(last, k), pt(last, k, wall), pt(last, k2, wall))
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
    """出口の手前に十字のフィンを入れて、渦を止めて直進させる。

    風はまとまるが、羽根とフィンの数の組み合わせによっては「ヒュイーン」という
    音程のある音が出ることがある。静かさを優先するなら使わない。
    """
    z_top = profile[-1][0] - max(0.0, p.chevron_depth if p.chevrons else 0.0)
    z_bot = max(0.0, z_top - p.vane_h)
    return [t for i in range(p.vanes // 2)
            for t in box(p.outlet_d / 2.0, p.vane_t / 2.0, z_bot, z_top,
                         math.pi * i / (p.vanes // 2))]


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


def write_svg(path: str, profile, wall: float, crown_depth: float) -> None:
    """断面図を書き出す。印刷前に形を目で確かめる用。"""
    H = profile[-1][0]
    scale, margin = 3.0, 30.0
    r_max = max(r for _, r in profile) + wall
    W = r_max * 2 * scale + margin * 2
    Ht = H * scale + margin * 2

    def X(r):
        return W / 2 + r * scale

    def Y(z):
        return Ht - margin - z * scale

    def wall_path(sign):
        pts = ([(X(sign * r), Y(z)) for z, r in profile]
               + [(X(sign * (r + wall)), Y(z)) for z, r in reversed(profile)])
        return "M " + " L ".join(f"{x:.2f},{y:.2f}" for x, y in pts) + " Z"

    valley = ""
    if crown_depth > 0:
        y = Y(H - crown_depth)
        valley = (f'<line x1="{X(-r_max):.1f}" y1="{y:.1f}" '
                  f'x2="{X(r_max):.1f}" y2="{y:.1f}" stroke="#d98324" '
                  f'stroke-width="1" stroke-dasharray="4 3"/>'
                  f'<text x="{X(r_max) - 4:.1f}" y="{y - 4:.1f}" text-anchor="end" '
                  f'font-family="sans-serif" font-size="10" fill="#d98324">'
                  f'波形の谷</text>')

    open(path, "w").write(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W:.0f}" height="{Ht:.0f}" '
        f'viewBox="0 0 {W:.0f} {Ht:.0f}">\n'
        f'<rect width="100%" height="100%" fill="#faf9f7"/>\n'
        f'<path d="{wall_path(1)}" fill="#7a8ba6" stroke="#2f3a4a" stroke-width="1"/>\n'
        f'<path d="{wall_path(-1)}" fill="#7a8ba6" stroke="#2f3a4a" stroke-width="1"/>\n'
        f'<line x1="{W / 2:.1f}" y1="{margin / 2:.1f}" x2="{W / 2:.1f}" '
        f'y2="{Ht - margin / 2:.1f}" stroke="#c0392b" stroke-width="1" '
        f'stroke-dasharray="6 3"/>\n{valley}\n'
        f'<text x="6" y="{Y(0) + 4:.1f}" font-family="sans-serif" font-size="11" '
        f'fill="#2f3a4a">0</text>\n'
        f'<text x="6" y="{Y(H) + 4:.1f}" font-family="sans-serif" font-size="11" '
        f'fill="#2f3a4a">{H:.0f}mm</text>\n</svg>\n')


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fan-od", type=float, default=76.0, help="ファン頭部の外径 mm（実測して指定）")
    ap.add_argument("--clearance", type=float, default=0.6, help="はめあいのすきま（片側）mm")
    ap.add_argument("--wall", type=float, default=2.0, help="肉厚 mm。厚いほど壁が鳴きにくい")
    ap.add_argument("--collar-h", type=float, default=20.0, help="えりの深さ mm")
    ap.add_argument("--lead-in", type=float, default=3.0, help="入口面取りの高さ mm")
    ap.add_argument("--lead-in-flare", type=float, default=1.0, help="入口の広がり mm")
    ap.add_argument("--taper-h", type=float, default=46.0, help="絞りの高さ mm。長いほど静か")
    ap.add_argument("--outlet-d", type=float, default=26.0,
                    help="吹き出し口の内径 mm。音を決める最大の要素で、大きいほど静か")
    ap.add_argument("--throat-h", type=float, default=14.0, help="出口ストレートの高さ mm")
    ap.add_argument("--segments", type=int, default=192, help="円周の分割数")
    ap.add_argument("--chevrons", type=int, default=0, help="出口の波形の山の数（0 で平ら、12 程度）")
    ap.add_argument("--chevron-depth", type=float, default=6.0, help="波形の深さ mm")
    ap.add_argument("--vanes", type=int, default=0, help="整流フィンの枚数（0 か 4）")
    ap.add_argument("--vane-t", type=float, default=1.2, help="フィンの厚み mm")
    ap.add_argument("--vane-h", type=float, default=16.0, help="フィンの高さ mm")
    ap.add_argument("--svg", help="断面図の出力先（省略で書き出さない）")
    ap.add_argument("-o", "--out", default="rhythm-fan-nozzle.stl")
    p = ap.parse_args()

    if p.vanes not in (0, 4):
        ap.error("--vanes は 0 か 4")
    if p.outlet_d >= p.fan_od:
        ap.error("--outlet-d はファン外径より小さくすること")
    if p.chevrons:
        if p.chevron_depth >= p.throat_h:
            ap.error(f"--chevron-depth は --throat-h ({p.throat_h}) より小さくすること")
        # 継ぎ目ができないよう、分割数を山の数の倍数にそろえる
        p.segments = max(1, round(p.segments / p.chevrons)) * p.chevrons

    profile = build_profile(p)
    crown = build_crown(p.chevrons, p.chevron_depth, p.segments)
    tris = revolve(profile, p.wall, p.segments, crown)
    if p.vanes:
        tris += straightener(p, profile)

    write_stl(p.out, tris, "handy fan wind concentrator")
    if p.svg:
        write_svg(p.svg, profile, p.wall, p.chevron_depth if p.chevrons else 0.0)

    ratio = (p.fan_od / p.outlet_d) ** 2
    print(f"{p.out}: {len(tris)} 面")
    print(f"  全高 {profile[-1][0]:.1f} mm / 最大外径 "
          f"{(p.fan_od / 2 + p.clearance + p.wall) * 2:.1f} mm")
    print(f"  差しこみ内径 {p.fan_od + p.clearance * 2:.1f} mm / 吹き出し口 {p.outlet_d:.1f} mm")
    print(f"  断面の絞り比 約 {ratio:.1f} 倍（出口の風速の目安。音もここで決まる）")
    if p.chevrons:
        print(f"  出口は {p.chevrons} 山 / 深さ {p.chevron_depth:.1f} mm の波形")


if __name__ == "__main__":
    main()
