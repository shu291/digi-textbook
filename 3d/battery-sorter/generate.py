#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ころころ電池ソーター ジェネレータ(引き出し式)
===============================================
単3・単4電池を「転がして入れるだけ」でサイズ差により自動仕分けし、
それぞれの「引き出し」の中に整列させて溜めるケースの 3D モデル (STL) を生成する。
Bambu Lab A1 mini (180×180×180mm) で印刷できるサイズ。

仕分けの原理(長さの差を利用):
  上段の坂の床に幅 46mm のスロット(長穴)を開ける。
    * 単4 (長さ 44.5mm) … 44.5 < 46 なのでスロットを橋渡しできず、必ず下へ落ちる
    * 単3 (長さ 50.5mm) … 50.5 > 46 で両端が常に棚(レッジ)に乗り、
      さらにレーン側壁が斜め進入を防ぐため、幾何学的に絶対に落ちない
  → 速度・摩擦・勢いに依存しない確実な選別ができる。
  落ちた単4は下段の坂で右端へ運ばれ、天井の開口から単4引き出しの中へ。
  単3は坂を転がりきって左端から単3引き出しの中へ落ちる。

収納と取り出し:
  各引き出しは内寸の奥行き=電池長+約2mm なので電池は自動的に平行に整列し、
  内側の床が中央仕切り側へ 5° 傾いているので片側から積み重なって溜まる
  (単3 約14本 / 単4 約22本)。前面の指穴に指をかけて手前に引き出すだけ。
  指穴からは中の電池も見える。

出力 (すべて標準ライブラリのみで生成):
  battery_sorter_case.stl        ケース本体(仕分け機構つき)
  battery_sorter_drawer_aa.stl   単3引き出し
  battery_sorter_drawer_aaa.stl  単4引き出し
  preview_iso1.svg               プレビュー画像(組み立て状態)
  mesh.json                      ビューア用メッシュ+パラメータ(コミット対象外)

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
    "out_x": 178.0, "out_y": 62.5, "out_z": 144.0,
    # レーン内幅 (Y) — 引き出しの内寸と一致させる
    "ch_aa": 52.5,   # 単3レーン = 単3長 50.5 + 2.0 (Y: 3〜55.5)
    "ch_aaa": 46.0,  # 単4レーン = 単4長 44.5 + 1.5 (Y: 6.25〜52.25)
    # 仕分けスロット
    "slot_w": 46.0,           # Y方向の幅: 単4は必ず落ち、単3は絶対に落ちない
    "slot_x0": 52.0, "slot_x1": 102.0,   # X方向の開口 50mm (>単4全長)
    # 上段(仕分け坂) — 右が高い。単3は左端 x=30 から単3引き出しへ落下
    "l0_x0": 30.0, "l0_x1": 175.0, "l0_z": 106.0, "l0_t": 4.0, "l0_deg": 10.0,
    # 下段(単4搬送坂) — 左が高い。右端 x=148 から単4引き出しへ落下
    "l1_x0": 44.0, "l1_x1": 148.0, "l1_z0": 88.0, "l1_z1": 74.0, "l1_t": 4.0,
    # 引き出し床の傾き(中央の仕切り側へ下がる)
    "bay_deg": 5.0,
    # 引き出しを収める区画: 仕切り x 86..92, 天井デッキ z 61..65
    "div_x0": 86.0, "div_x1": 92.0, "deck_z0": 61.0, "deck_z1": 65.0,
    # 引き出し (共通): 壁 2.5 / 各所クリアランス 0.5
    #   単3: 外形 x 3.5..85.5, 内寸 x 6..83 × y 3..55.5,  床の低い側 x=83
    #   単4: 外形 x 92.5..174.5, 内寸 x 95..172 × y 6.25..52.25, 低い側 x=95
    "dr_z0": 3.0, "dr_z1": 59.0, "dr_face_z1": 60.5, "dr_floor": 6.5,
    # デッキの落下開口
    "hole_aa": (6.0, 30.0), "hole_aaa": (148.0, 172.0),
    # 投入口 (天板の開口)
    "mouth_x0": 130.0, "mouth_x1": 167.0,
    # 収納数の目安: 5+4+3+2 / 7+6+5+4
    "cap_aa": 14, "cap_aaa": 22,
}

T0 = math.tan(math.radians(P["l0_deg"]))            # 上段勾配
T1 = (P["l1_z0"] - P["l1_z1"]) / (P["l1_x1"] - P["l1_x0"])  # 下段勾配
TB = math.tan(math.radians(P["bay_deg"]))           # 引き出し床勾配

def z0(x):   # 上段 坂の上面高さ
    return P["l0_z"] + (x - P["l0_x0"]) * T0

def z1(x):   # 下段 坂の上面高さ
    return P["l1_z0"] - (x - P["l1_x0"]) * T1

def f_aa(x):   # 単3引き出し 内側床の上面 (仕切り側 x=83 が低い)
    return P["dr_floor"] + (83.0 - x) * TB

def f_aaa(x):  # 単4引き出し 内側床の上面 (仕切り側 x=95 が低い)
    return P["dr_floor"] + (x - 95.0) * TB

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

def translated(tris, dx, dy, dz):
    return [tuple((p[0] + dx, p[1] + dy, p[2] + dz) for p in t) for t in tris]

# ------------------------------------------------------------ ケース本体
def build_case():
    """[(グループ名, 色, [tri...]), ...] を返す。単位 mm。組み立て座標。"""
    frame, aa, aaa = [], [], []
    dx0, dx1 = P["div_x0"], P["div_x1"]
    dz0, dz1 = P["deck_z0"], P["deck_z1"]

    # ---- 外枠
    box(frame, 0, 178, 0, 62.5, 0, 3)            # 底板 (引き出しはこの上を滑る)
    box(frame, 0, 3, 0, 62.5, 2.5, 112)          # 左壁
    box(frame, 175, 178, 0, 62.5, 2.5, 144)      # 右壁
    box(frame, 0, 175.5, 59, 62.5, 2.5, 144)     # 背面壁
    # 仕分け機構の背面はレーン後端 (y=55.5) と面一にする詰め壁
    box(frame, 0, 175.5, 55.5, 59, dz1, 144)
    box(frame, dx0, dx1, 0, 59, 2.5, dz1)        # 引き出しの間の仕切り
    box(frame, dx0, dx1, 3, 55.5, dz1 - 0.5, 78.3)  # 仕切り上の柱(下段坂を支える)
    # デッキ (引き出しの天井 z 61..65)。落下開口2箇所を残して張る
    (ha0, ha1) = P["hole_aa"]; (hb0, hb1) = P["hole_aaa"]
    box(frame, 2.5, ha0, 0, 59, dz0, dz1)        # 単3開口の左
    box(frame, ha1, dx0 + 0.5, 0, 59, dz0, dz1)  # 単3開口の右〜仕切り
    box(frame, ha0, ha1, 0, 3, dz0, dz1)         # 単3開口の前縁
    box(frame, ha0, ha1, 55.5, 59, dz0, dz1)     # 単3開口の後縁
    box(frame, dx1 - 0.5, hb0, 0, 59, dz0, dz1)  # 仕切り〜単4開口の左
    box(frame, hb1, 175.5, 0, 59, dz0, dz1)      # 単4開口の右
    box(frame, hb0, hb1, 0, 6.25, dz0, dz1)      # 単4開口の前縁
    box(frame, hb0, hb1, 52.25, 59, dz0, dz1)    # 単4開口の後縁
    box(frame, 138, 143, 0, 3.7, dz0, 140.5)     # 前面支柱(天板・両坂を支える)
    # 天板(投入口): 開口幅37mm<単4長44.5 なので
    # 縦向き(X方向寝かせ)では入らず、正しい向き(Y方向寝かせ)が強制される
    box(frame, 108, P["mouth_x0"], 0, 55.5, 140, 144)
    box(frame, P["mouth_x1"], 175.5, 0, 55.5, 140, 144)
    box(frame, P["mouth_x0"], P["mouth_x1"], 0, 3.5, 140, 144)
    # 開口の後ろ側は詰め壁+背面壁 (z=144 まで) がそのまま縁になる

    # ---- 単3の経路(上段仕分け坂)。レーン内幅 y 3..55.5
    sx0, sx1 = P["slot_x0"], P["slot_x1"]
    hexp(aa, sx1, 175.5, 3, 56, z0(sx1) - 4, z0(sx1), z0(175.5) - 4, z0(175.5))
    hexp(aa, P["l0_x0"], sx0, 3, 56, z0(P["l0_x0"]) - 4, z0(P["l0_x0"]),
         z0(sx0) - 4, z0(sx0))
    # スロット両側のレッジ(幅3.25) — 単3の両端はここに乗って渡る
    hexp(aa, sx0, sx1, 3, 6.25, z0(sx0) - 4, z0(sx0), z0(sx1) - 4, z0(sx1))
    hexp(aa, sx0, sx1, 52.25, 56, z0(sx0) - 4, z0(sx0), z0(sx1) - 4, z0(sx1))

    # ---- 単4の経路(下段搬送坂 + ガイド壁)
    lx0, lx1 = P["l1_x0"], P["l1_x1"]
    hexp(aaa, lx0, lx1, 3, 56, z1(lx0) - 4, z1(lx0), z1(lx1) - 4, z1(lx1))
    box(aaa, lx0, lx0 + 3.5, 3, 56, 86, 99)      # 左端ストッパ(着地の跳ね返り止め)
    for (ya, yb) in ((3, 6.25), (52.25, 56)):
        # スロット直下: 上段の裏まで伸びてシュートを形成
        hexp(aaa, lx0, sx1, ya, yb, z1(lx0) - 1, z0(lx0) - 3.5,
             z1(sx1) - 1, z0(sx1) - 3.5)
        # 下段坂の上のガイド
        hexp(aaa, sx1, lx1, ya, yb, z1(sx1) - 1, z1(sx1) + 14,
             z1(lx1) - 1, z1(lx1) + 14)

    return [("frame", "#8b93a1", frame),
            ("aa_path", "#e2c377", aa),
            ("aaa_path", "#9dc2ec", aaa)]

# ------------------------------------------------------------ 引き出し
def facade_with_hole(tris, x0, x1, hx0, hx1, y0, y1, zb, zt, hz0=26.0, hz1=40.0):
    """指穴(hx0..hx1 × hz0..hz1)をあけた前板を4枚の箱で構成する。"""
    box(tris, x0, x1, y0, y1, zb, hz0)
    box(tris, x0, hx0, y0, y1, hz0, hz1)
    box(tris, hx1, x1, y0, y1, hz0, hz1)
    box(tris, x0, x1, y0, y1, hz1, zt)

def build_drawer_aa():
    """単3引き出し。外形 x 3.5..85.5 / y 0..58 / z 3..60.5 (組み立て座標)"""
    t = []
    facade_with_hole(t, 3.5, 85.5, 30, 58, 0, 3, 3, P["dr_face_z1"])  # 前板+指穴
    box(t, 3.5, 6, 3, 58, 3, 59)          # 左壁
    box(t, 83, 85.5, 3, 58, 3, 59)        # 右壁 (仕切り側: 電池はここに整列)
    box(t, 6, 83, 55.5, 58, 3, 59)        # 後壁
    box(t, 3.5, 85.5, 3, 58, 3, 5.5)      # 床
    # 内側床: 仕切り側 (x=83) へ 5° 下がるくさび → 電池が寄って整列する
    hexp(t, 6, 83, 3, 55.5, 5, f_aa(6), 5, f_aa(83))
    return t

def build_drawer_aaa():
    """単4引き出し。外形 x 92.5..174.5 / y 0..55 / z 3..60.5 (組み立て座標)
    内寸の奥行きを 46 にするため、前板の裏にスペーサ (y 3..6.25) を持つ。"""
    t = []
    facade_with_hole(t, 92.5, 174.5, 119, 147, 0, 3, 3, P["dr_face_z1"])
    facade_with_hole(t, 95, 172, 119, 147, 3, 6.25, 5, 59)   # スペーサ(指穴も貫通)
    box(t, 92.5, 95, 3, 55, 3, 59)        # 左壁 (仕切り側: 電池はここに整列)
    box(t, 172, 174.5, 3, 55, 3, 59)      # 右壁
    box(t, 95, 172, 52.25, 55, 3, 59)     # 後壁
    box(t, 92.5, 174.5, 3, 55, 3, 5.5)    # 床
    hexp(t, 95, 172, 6.25, 52.25, 5, f_aaa(95), 5, f_aaa(172))
    return t

def build_drawers():
    return [("drawer_aa", "#caa14e", build_drawer_aa()),
            ("drawer_aaa", "#79a8dc", build_drawer_aaa())]

def build_preview_batteries():
    """プレビュー画像用に、経路の要所へ電池を配置(STLには含めない)。"""
    bat_aa, bat_aaa = [], []
    yc = 29.25
    battery(bat_aa, 130, yc, z0(130) + 7.4, P["aa_d"], P["aa_l"])   # 坂を転がる単3
    battery(bat_aaa, 80, yc, 96, P["aaa_d"], P["aaa_l"])            # 落下中の単4
    # 単3引き出しの中 (5+2)
    for (x, lay) in [(75.75, 0), (61.25, 0), (46.75, 0), (32.25, 0), (17.75, 0),
                     (68.5, 1), (54.0, 1)]:
        battery(bat_aa, x, yc, f_aa(x) + 7.25 + lay * 12.3, P["aa_d"], P["aa_l"])
    # 単4引き出しの中 (7+3)
    for k in range(7):
        x = 100.25 + k * 10.5
        battery(bat_aaa, x, yc, f_aaa(x) + 5.25, P["aaa_d"], P["aaa_l"])
    for k in range(3):
        x = 105.5 + k * 10.5
        battery(bat_aaa, x, yc, f_aaa(x) + 5.25 + 9.1, P["aaa_d"], P["aaa_l"])
    return [("bat_aa", "#a8790f", bat_aa), ("bat_aaa", "#2660ad", bat_aaa)]

# ------------------------------------------------------------ 出力
def write_stl(path, tris, note):
    with open(path, "wb") as f:
        f.write(note.encode()[:79].ljust(80, b" "))
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
        x, y, z = p[0] - 89, p[1] - 31, p[2] - 72
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
    drawers = build_drawers()
    for (name, _, ts) in case + drawers:
        v = volume(ts)
        assert v > 0, f"{name}: 法線が裏返っています (V={v:.0f})"
        print(f"  {name:10s} {len(ts):4d} tris  {v / 1000:8.1f} cm^3")

    case_tris = [t for (_, _, ts) in case for t in ts]
    n = write_stl(os.path.join(HERE, "battery_sorter_case.stl"), case_tris,
                  "battery sorter case (AA/AAA), unit=mm, fits A1 mini")
    print(f"battery_sorter_case.stl       : {n} 三角形")
    # 引き出しは原点基準に移して単体の STL に
    n = write_stl(os.path.join(HERE, "battery_sorter_drawer_aa.stl"),
                  translated(drawers[0][2], -3.5, 0, -3),
                  "AA drawer, unit=mm")
    print(f"battery_sorter_drawer_aa.stl  : {n} 三角形")
    n = write_stl(os.path.join(HERE, "battery_sorter_drawer_aaa.stl"),
                  translated(drawers[1][2], -92.5, 0, -3),
                  "AAA drawer, unit=mm")
    print(f"battery_sorter_drawer_aaa.stl : {n} 三角形")

    data = mesh_json(case + drawers)
    with open(os.path.join(HERE, "mesh.json"), "w") as f:
        f.write(data)

    preview = case + drawers + build_preview_batteries()
    render_svg(os.path.join(HERE, "preview_iso1.svg"), preview, -28, 26)
    print("preview_iso1.svg")

    if args.inject:
        inject(os.path.join(HERE, args.inject), data)
        print(f"{args.inject} にメッシュを注入しました")

if __name__ == "__main__":
    main()
