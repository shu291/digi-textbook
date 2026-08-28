#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ころころ電池ソーター ジェネレータ
=================================
単3・単4電池を「転がして入れるだけ」でサイズ差により自動仕分けし、
別々のビンに整列させて溜めるケースの 3D モデル (STL) を生成する。
Bambu Lab A1 mini (180×180×180mm) で印刷できるサイズ。

仕分けの原理(長さの差を利用):
  上段の坂の床に幅 46mm のスロット(長穴)を開ける。
    * 単4 (長さ 44.5mm) … 44.5 < 46 なのでスロットを橋渡しできず、必ず下へ落ちる
    * 単3 (長さ 50.5mm) … 50.5 > 46 で両端が常に棚(レッジ)に乗り、
      さらにレーン側壁が斜め進入を防ぐため、幾何学的に絶対に落ちない
  → 速度・摩擦・勢いに依存しない確実な選別ができる。
  落ちた単4は下段の坂で右端へ運ばれ、単4ビンへ。
  単3はそのまま坂を転がりきって左端から単3ビンへ落ちる。

収納と取り出し:
  各ビンは内幅=電池長+約2mm なので電池は自動的に平行に整列し、
  床が中央の仕切りに向かって 5° 傾いているので仕切り際から積み重なって
  溜まる(単3 約14本 / 単4 約22本)。前面の大きな取り出し窓の位置に
  いちばん下の電池が常に転がってくるので、つまんで取るだけ。

出力 (すべて標準ライブラリのみで生成):
  battery_sorter.stl   バイナリ STL(ケース本体・原点は左手前下、単位 mm)
  preview_iso1.svg     プレビュー画像
  mesh.json            ビューア用メッシュ+パラメータ(コミット対象外)

使い方:
  python3 generate.py                  # 上記ファイルを生成
  python3 generate.py --inject PATH    # ビューア HTML の埋め込みメッシュを更新
"""
import argparse
import json
import math
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- パラメータ
P = {
    # 電池寸法 (JIS)
    "aa_d": 14.5, "aa_l": 50.5,      # 単3
    "aaa_d": 10.5, "aaa_l": 44.5,    # 単4
    # 外形 (A1 mini のビルドボリューム 180^3 に収まること)
    "out_x": 178.0, "out_y": 59.5, "out_z": 122.0,
    # 壁
    "wall_x": 3.0,   # 左右壁厚
    "wall_y": 3.5,   # 前後壁厚
    "base": 3.0,     # 底板厚
    # レーン内幅 (Y)
    "ch_aa": 52.5,   # 単3レーン = 単3長 50.5 + 2.0
    "ch_aaa": 46.0,  # 単4レーン = 単4長 44.5 + 1.5  (=スロット幅)
    # 仕分けスロット
    "slot_w": 46.0,           # Y方向の幅: 単4は必ず落ち、単3は絶対に落ちない
    "slot_x0": 52.0, "slot_x1": 102.0,   # X方向の開口 50mm (>単4全長)
    # 上段(仕分け坂) — 右が高い。単3は左端 x=30 から単3ビンへ落下
    "l0_x0": 30.0, "l0_x1": 175.0, "l0_z": 84.0, "l0_t": 4.0, "l0_deg": 10.0,
    # 下段(単4搬送坂) — 左が高い。右端 x=148 から単4ビンへ落下
    "l1_x0": 44.0, "l1_x1": 148.0, "l1_z0": 66.0, "l1_z1": 52.0, "l1_t": 4.0,
    # ビン床の傾き(中央の仕切りに向かって下がる)
    "bay_deg": 5.0,
    # ビン仕切り
    "div_x0": 86.0, "div_x1": 92.0,
    # 投入口 (天板の開口)
    "mouth_x0": 130.0, "mouth_x1": 167.0,
    # 前面の取り出し窓 (仕切りの両脇, z 8〜48)
    "win_aa": (40.0, 86.0), "win_aaa": (92.0, 138.0),
    # 収納数の目安(ビュー・表示用): 5+4+3+2 / 7+6+5+4
    "cap_aa": 14, "cap_aaa": 22,
}

T0 = math.tan(math.radians(P["l0_deg"]))            # 上段勾配
T1 = (P["l1_z0"] - P["l1_z1"]) / (P["l1_x1"] - P["l1_x0"])  # 下段勾配
TB = math.tan(math.radians(P["bay_deg"]))           # ビン床勾配

def z0(x):   # 上段 坂の上面高さ
    return P["l0_z"] + (x - P["l0_x0"]) * T0

def z1(x):   # 下段 坂の上面高さ
    return P["l1_z0"] - (x - P["l1_x0"]) * T1

def f_aa(x):   # 単3ビン床上面 (仕切り側=右が低い → 仕切り際に整列)
    return 4.0 + (P["div_x0"] - x) * TB

def f_aaa(x):  # 単4ビン床上面 (仕切り側=左が低い → 仕切り際に整列)
    return 4.0 + (x - P["div_x1"]) * TB

# ------------------------------------------------------------ メッシュ生成系
def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])

def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])

def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

def quad(tris, a, b, c, d, nd):
    """四角形 a-b-c-d を三角形2枚で追加。法線が nd 向きになるよう自動反転。"""
    n = cross(sub(b, a), sub(c, a))
    if dot(n, nd) < 0:
        a, b, c, d = a, d, c, b
    tris.append((a, b, c))
    tris.append((a, c, d))

def hexp(tris, x1, x2, y1, y2, b1, t1, b2, t2):
    """X方向に上下面が直線変化する六面体(壁・板・くさびすべてこれで表現)。
    b1,t1 = x1 での底/天、b2,t2 = x2 での底/天。Y方向には一定。"""
    v0 = (x1, y1, b1); v1 = (x2, y1, b2); v2 = (x2, y2, b2); v3 = (x1, y2, b1)
    v4 = (x1, y1, t1); v5 = (x2, y1, t2); v6 = (x2, y2, t2); v7 = (x1, y2, t1)
    quad(tris, v0, v1, v2, v3, (0, 0, -1))
    quad(tris, v4, v5, v6, v7, (0, 0, 1))
    quad(tris, v0, v1, v5, v4, (0, -1, 0))
    quad(tris, v3, v2, v6, v7, (0, 1, 0))
    quad(tris, v0, v3, v7, v4, (-1, 0, 0))
    quad(tris, v1, v2, v6, v5, (1, 0, 0))

def box(tris, x1, x2, y1, y2, zb, zt):
    hexp(tris, x1, x2, y1, y2, zb, zt, zb, zt)

def cylinder_y(tris, cx, cy, cz, r, ln, seg=20):
    """Y軸に平行な円柱(プレビュー用電池)。cy は中心。"""
    y0, y1 = cy - ln / 2.0, cy + ln / 2.0
    pts = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        pts.append((cx + r * math.cos(a), cz + r * math.sin(a)))
    for i in range(seg):
        (xa, za) = pts[i]
        (xb, zb) = pts[(i + 1) % seg]
        quad(tris, (xa, y0, za), (xb, y0, zb), (xb, y1, zb), (xa, y1, za),
             (xa - cx, 0, za - cz))
        tris.append(((cx, y0, cz), (xb, y0, zb), (xa, y0, za)))
        tris.append(((cx, y1, cz), (xa, y1, za), (xb, y1, zb)))

def battery(tris, cx, cy, cz, d, ln):
    """電池: 本体円柱 + プラス極の突起(+Y側)"""
    r = d / 2.0
    cylinder_y(tris, cx, cy, cz, r, ln - 1.6, seg=22)
    cylinder_y(tris, cx, cy + ln / 2.0 - 0.8, cz, r * 0.36, 1.6, seg=12)

def volume(tris):
    v = 0.0
    for (a, b, c) in tris:
        v += dot(a, cross(b, c))
    return v / 6.0

# ------------------------------------------------------------ ケースの部品
def build_case():
    """[(グループ名, 色, [tri...]), ...] を返す。単位 mm。"""
    frame, aa, aaa = [], [], []
    dx0, dx1 = P["div_x0"], P["div_x1"]

    # ---- 外枠
    # 底板はビン床(z=0から立ち上げ)と重ならないよう分割する
    box(frame, 0, 178, 0, 3, 0, 3)               # 底板 前縁
    box(frame, 0, 178, 56.5, 59.5, 0, 3)         # 底板 後縁
    box(frame, 0, 2.5, 3, 56.5, 0, 3)            # 底板 左
    box(frame, dx0 + 0.5, dx1 - 0.5, 3, 56.5, 0, 3)  # 底板 中央(仕切り下)
    box(frame, 175.5, 178, 3, 56.5, 0, 3)        # 底板 右
    box(frame, 0, 3, 0, 59.5, 2.5, 90)           # 左壁
    box(frame, 175, 178, 0, 59.5, 2.5, 122)      # 右壁
    box(frame, 0, 175.5, 56, 59.5, 2.5, 122)     # 背面壁
    # 前面壁: 仕切りの両脇に大きな取り出し窓 (z 8〜48)。窓下の帯が電池止め
    box(frame, 0, P["win_aa"][0], 0, 3.5, 2.5, 48)       # 左端〜単3窓
    box(frame, P["win_aa"][0], P["win_aa"][1], 0, 3.5, 2.5, 8)   # 単3窓の下帯
    box(frame, dx0, dx1, 0, 3.5, 2.5, 48)                # 中央柱(仕切り前)
    box(frame, P["win_aaa"][0], P["win_aaa"][1], 0, 3.5, 2.5, 8) # 単4窓の下帯
    box(frame, P["win_aaa"][1], 178, 0, 3.5, 2.5, 48)    # 単4窓〜右端
    box(frame, 138, 143, 0, 3.7, 2.5, 118.5)     # 前面支柱(天板・両坂を支える)
    # 天板(投入口): 開口幅37mm<単4長44.5 なので
    # 縦向き(X方向寝かせ)では入らず、正しい向き(Y方向寝かせ)が強制される
    box(frame, 108, P["mouth_x0"], 0, 56.5, 118, 122)
    box(frame, P["mouth_x1"], 175.5, 0, 56.5, 118, 122)
    box(frame, P["mouth_x0"], P["mouth_x1"], 0, 3.5, 118, 122)
    # 開口の後ろ側は背面壁(z=122 まで)がそのまま縁になる
    box(frame, dx0, dx1, 3.5, 56.5, 2.5, 56.5)   # ビン仕切り(下段坂の支えを兼ねる)

    # ---- 単3の経路(上段仕分け坂 + 単3ビン床)
    sx0, sx1 = P["slot_x0"], P["slot_x1"]
    hexp(aa, sx1, 175.5, 3.5, 56.5, z0(sx1) - 4, z0(sx1), z0(175.5) - 4, z0(175.5))
    hexp(aa, P["l0_x0"], sx0, 3.5, 56.5, z0(P["l0_x0"]) - 4, z0(P["l0_x0"]),
         z0(sx0) - 4, z0(sx0))
    # スロット両側のレッジ(幅3.25) — 単3の両端はここに乗って渡る
    hexp(aa, sx0, sx1, 3.5, 6.75, z0(sx0) - 4, z0(sx0), z0(sx1) - 4, z0(sx1))
    hexp(aa, sx0, sx1, 52.75, 56.5, z0(sx0) - 4, z0(sx0), z0(sx1) - 4, z0(sx1))
    # 単3ビン床(仕切りに向かって下がる)。底板を兼ねて z=0 から立ち上げる
    hexp(aa, 2.5, dx0 + 0.5, 3.3, 56.5, 0, f_aa(2.5), 0, f_aa(dx0 + 0.5))

    # ---- 単4の経路(下段搬送坂 + ガイド壁 + 単4ビン床)
    lx0, lx1 = P["l1_x0"], P["l1_x1"]
    hexp(aaa, lx0, lx1, 3.5, 56.5, z1(lx0) - 4, z1(lx0), z1(lx1) - 4, z1(lx1))
    box(aaa, lx0, lx0 + 3.5, 3.5, 56.5, 64, 77)   # 左端ストッパ(着地の跳ね返り止め)
    # ガイド壁(内幅46)
    for (ya, yb) in ((3.5, 6.75), (52.75, 56.5)):
        # スロット直下: 上段の裏まで伸びてシュートを形成
        hexp(aaa, lx0, sx1, ya, yb, z1(lx0) - 1, z0(lx0) - 3.5,
             z1(sx1) - 1, z0(sx1) - 3.5)
        # 下段坂の上のガイド
        hexp(aaa, sx1, lx1, ya, yb, z1(sx1) - 1, z1(sx1) + 14,
             z1(lx1) - 1, z1(lx1) + 14)
    # 単4ビンの側壁: 積み重なっても整列するよう天井(下段坂の裏)まで。
    # ただし前側(y手前)は取り出し窓の範囲だけ低い柵(z=8)にして手が入るように
    wa, wb = P["win_aaa"]
    hexp(aaa, dx1, wb, 3.5, 6.75, f_aaa(dx1) - 1, 8, f_aaa(wb) - 1, 8)
    hexp(aaa, wb, lx1, 3.5, 6.75, f_aaa(wb) - 1, z1(wb) - 3.5,
         f_aaa(lx1) - 1, z1(lx1) - 3.5)
    hexp(aaa, lx1, 175.5, 3.5, 6.75, f_aaa(lx1) - 1, 48.5,
         f_aaa(175.5) - 1, 48.5)
    hexp(aaa, dx1, lx1, 52.75, 56.5, f_aaa(dx1) - 1, z1(dx1) - 3.5,
         f_aaa(lx1) - 1, z1(lx1) - 3.5)
    hexp(aaa, lx1, 175.5, 52.75, 56.5, f_aaa(lx1) - 1, 48.5,
         f_aaa(175.5) - 1, 48.5)
    # 単4ビン床(仕切りに向かって下がる)。底板を兼ねて z=0 から立ち上げる
    hexp(aaa, dx1 - 0.5, 175.5, 3.3, 56.5, 0, f_aaa(dx1 - 0.5), 0, f_aaa(175.5))

    return [("frame", "#8b93a1", frame),
            ("aa_path", "#e2c377", aa),
            ("aaa_path", "#9dc2ec", aaa)]

def build_preview_batteries():
    """プレビュー画像用に、経路の要所へ電池を配置(STLには含めない)。"""
    bat_aa, bat_aaa = [], []
    yc = 29.75
    battery(bat_aa, 130, yc, z0(130) + 7.4, P["aa_d"], P["aa_l"])   # 坂を転がる単3
    battery(bat_aaa, 80, yc, 78, P["aaa_d"], P["aaa_l"])            # 落下中の単4
    # 仕切り際に積み重なった単3 (5+2)
    for (x, lay) in [(78.75, 0), (64.25, 0), (49.75, 0), (35.25, 0), (20.75, 0),
                     (71.5, 1), (57.0, 1)]:
        battery(bat_aa, x, yc, f_aa(x) + 7.25 + lay * 12.3, P["aa_d"], P["aa_l"])
    # 仕切り際に積み重なった単4 (7+3)
    for k in range(7):
        x = 97.25 + k * 10.5
        battery(bat_aaa, x, yc, f_aaa(x) + 5.25, P["aaa_d"], P["aaa_l"])
    for k in range(3):
        x = 102.5 + k * 10.5
        battery(bat_aaa, x, yc, f_aaa(x) + 5.25 + 9.1, P["aaa_d"], P["aaa_l"])
    return [("bat_aa", "#a8790f", bat_aa), ("bat_aaa", "#2660ad", bat_aaa)]

# ------------------------------------------------------------ 出力
def write_stl(path, groups):
    tris = [t for (_, _, ts) in groups for t in ts]
    with open(path, "wb") as f:
        f.write(b"battery sorter case (AA/AAA), unit=mm, fits A1 mini".ljust(80, b" "))
        f.write(struct.pack("<I", len(tris)))
        for (a, b, c) in tris:
            n = cross(sub(b, a), sub(c, a))
            ln = math.sqrt(dot(n, n)) or 1.0
            f.write(struct.pack("<12fH",
                                n[0] / ln, n[1] / ln, n[2] / ln,
                                *a, *b, *c, 0))
    return len(tris)

def mesh_json(groups):
    r2 = lambda v: round(v, 2)
    return json.dumps({
        "params": {**{k: v for (k, v) in P.items() if not isinstance(v, tuple)},
                   "t0": T0, "t1": T1, "tb": TB},
        "groups": [{"name": n, "color": c,
                    "tris": [[[r2(x), r2(y), r2(z)] for (x, y, z) in t]
                             for t in ts]}
                   for (n, c, ts) in groups],
    }, separators=(",", ":"))

def subdivide(tris, max_edge=16.0):
    """ペインターアルゴリズムの奥行きソート精度を上げるため三角形を細分化。"""
    out = list(tris)
    done = []
    while out:
        (a, b, c) = out.pop()
        e = [(dot(sub(b, a), sub(b, a)), 0), (dot(sub(c, b), sub(c, b)), 1),
             (dot(sub(a, c), sub(a, c)), 2)]
        e.sort()
        if e[-1][0] <= max_edge * max_edge:
            done.append((a, b, c))
            continue
        k = e[-1][1]
        if k == 0:
            m = tuple((a[i] + b[i]) / 2 for i in range(3))
            out += [(a, m, c), (m, b, c)]
        elif k == 1:
            m = tuple((b[i] + c[i]) / 2 for i in range(3))
            out += [(a, b, m), (a, m, c)]
        else:
            m = tuple((c[i] + a[i]) / 2 for i in range(3))
            out += [(a, b, m), (m, b, c)]
    return done

def render_svg(path, groups, yaw_deg, pitch_deg, w=1080, h=780):
    """簡易ペインターアルゴリズムでフラットシェーディングの SVG を描く。"""
    groups = [(n, c, subdivide(ts)) for (n, c, ts) in groups]
    ya, pa = math.radians(yaw_deg), math.radians(pitch_deg)
    cy_, sy_ = math.cos(ya), math.sin(ya)
    cp, sp = math.cos(pa), math.sin(pa)

    def proj(p):
        x, y, z = p[0] - 89, p[1] - 29.75, p[2] - 61
        x1 = x * cy_ - y * sy_
        y1 = x * sy_ + y * cy_
        up = y1 * sp + z * cp
        depth = y1 * cp - z * sp
        return x1, up, depth

    faces = []
    light = (-0.42, -0.55, 0.72)
    ll = math.sqrt(dot(light, light))
    light = (light[0] / ll, light[1] / ll, light[2] / ll)
    for rank, (_, color, ts) in enumerate(groups):
        cr = int(color[1:3], 16); cg = int(color[3:5], 16); cb = int(color[5:7], 16)
        for (a, b, c) in ts:
            n = cross(sub(b, a), sub(c, a))
            ln2 = math.sqrt(dot(n, n)) or 1.0
            n = (n[0] / ln2, n[1] / ln2, n[2] / ln2)
            pa_, pb_, pc_ = proj(a), proj(b), proj(c)
            nx1 = n[0] * cy_ - n[1] * sy_
            ny1 = n[0] * sy_ + n[1] * cy_
            ndepth = ny1 * cp - n[2] * sp
            if ndepth > 0:          # 裏面カリング
                continue
            nup = ny1 * sp + n[2] * cp
            shade = 0.52 + 0.48 * max(0.0, dot((nx1, nup, -ndepth), light))
            col = "#%02x%02x%02x" % (min(255, int(cr * shade)),
                                     min(255, int(cg * shade)),
                                     min(255, int(cb * shade)))
            # グループ順の微小バイアスで近接同一平面のちらつきを抑える
            depth = (pa_[2] + pb_[2] + pc_[2]) / 3.0 - 0.15 * rank
            faces.append((depth, col, (pa_, pb_, pc_)))
    faces.sort(key=lambda f: -f[0])

    xs = [q[0] for (_, _, t) in faces for q in t]
    ys = [q[1] for (_, _, t) in faces for q in t]
    sc = min((w - 80) / (max(xs) - min(xs)), (h - 80) / (max(ys) - min(ys)))
    ox = w / 2 - sc * (max(xs) + min(xs)) / 2
    oy = h / 2 + sc * (max(ys) + min(ys)) / 2
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">',
           f'<rect width="{w}" height="{h}" fill="#f2f4f7"/>']
    for (_, col, t) in faces:
        pts = " ".join(f"{ox + sc * q[0]:.1f},{oy - sc * q[1]:.1f}" for q in t)
        out.append(f'<polygon points="{pts}" fill="{col}" stroke="{col}" '
                   f'stroke-width="0.5" stroke-linejoin="round"/>')
    out.append("</svg>")
    with open(path, "w") as f:
        f.write("".join(out))

def inject(html_path, data):
    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read()
    m0, m1 = "/*MESH-JSON-START*/", "/*MESH-JSON-END*/"
    i, j = html.index(m0), html.index(m1)
    html = html[: i + len(m0)] + data + html[j:]
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--inject", metavar="HTML",
                    help="ビューア HTML の埋め込みメッシュを更新する")
    args = ap.parse_args()

    case = build_case()
    for (name, _, ts) in case:
        v = volume(ts)
        assert v > 0, f"{name}: 法線が裏返っています (V={v:.0f})"
        print(f"  {name:9s} {len(ts):4d} tris  {v / 1000:8.1f} cm^3")

    n = write_stl(os.path.join(HERE, "battery_sorter.stl"), case)
    print(f"battery_sorter.stl  : {n} 三角形")

    data = mesh_json(case)
    with open(os.path.join(HERE, "mesh.json"), "w") as f:
        f.write(data)

    preview = case + build_preview_batteries()
    render_svg(os.path.join(HERE, "preview_iso1.svg"), preview, -28, 30)
    print("preview_iso1.svg")

    if args.inject:
        inject(os.path.join(HERE, args.inject), data)
        print(f"{args.inject} にメッシュを注入しました")

if __name__ == "__main__":
    main()
