#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""グラフギア1000（ぺんてる PG1013/1014/1015/1017/1019）をロケットっぽく見せる
外付けアドオン一式を STL で吐くパラメトリック・ジェネレータ。

    python3 rocket_addon.py            # ./stl/ に出力
    python3 rocket_addon.py out_dir    # 出力先を指定
    python3 rocket_addon.py out_dir --mock   # 本体ダミーも一緒に出す（確認用）

標準ライブラリだけで動く（外部依存なし）。寸法はすべて先頭の定数で変えられる。

------------------------------------------------------------------------
本体の寸法（Z は「ペン先＝0」を原点にした軸方向の位置・単位 mm）
------------------------------------------------------------------------
カタログ値（出典は README.md）:
    全長 150mm / 外寸 10 x 9 x 150mm / 重さ 20g
    グリップ径 約9.5〜10mm、軸径 約8.5mm
    先端ガイドパイプ 4mm（固定スリーブ・収納式）
    材質: 軸=アルミ / ノック=ステンレス / クリップ=鉄 / 先金=真鍮 /
          グリップ=シリコンゴム＋真鍮（ローレット）

推定値（カタログに載っていないので現物合わせ前提。ここを直せば全部追従する）:
    グリップ区間、クリップの位置・幅、ノックの径と突き出し量。
    ※クリップを開くとペン先が収納される機構なので、クリップの可動域は
      リングのスリット（切り欠き）で必ず逃がすこと。
"""

import math
import os
import struct
import sys

# ====================== 本体（グラフギア1000）の寸法 ======================
PEN = dict(
    total_len=150.0,      # 全長（カタログ値）
    barrel_dia=8.5,       # 軸径（アルミ軸）
    grip_dia=9.5,         # グリップ最大径
    grip_z=(18.0, 50.0),  # グリップ区間（推定）
    tip_cone_z=22.0,      # 先金が軸径に達するあたり（推定）
    sleeve_len=4.0,       # 先端ガイドパイプ長
    knock_dia=6.5,        # ノック（ステンレス）の径（推定）
    knock_z=143.0,        # ノックが軸から出る位置（推定）
    clip_az=0.0,          # クリップのある方位角[deg]。ここを避けてスリットを切る
)

FIT = 0.05   # 軸に対する締めしろ[mm]。ゆるい→増やす / 入らない→0や負にする
SEG = 64     # 円周の分割数。上げると滑らかだがファイルが重くなる

# ====================== 各パーツの寸法 ======================
# 1) エンジンベル：ノックにかぶせる。押すとノック＝点火ボタンになる。
BELL = dict(
    bore=6.6,          # ノック(φ6.5)への圧入穴
    base_z=143.0,      # ベルの底＝軸の後端
    # (Z, 外半径) ノズルの外形。くびれ→末広がりのベル
    outer=[(143.0, 5.40), (145.0, 5.05), (147.0, 4.85), (150.0, 5.20),
           (153.0, 5.85), (156.0, 6.60), (159.0, 7.35), (161.0, 7.80)],
    # (Z, 内半径) スロートから出口へ広がる内側。先頭は必ず bore/2（圧入穴の上端）
    inner=[(151.0, 3.30), (153.0, 4.10), (156.0, 5.10), (159.0, 6.05),
           (161.0, 6.55)],
)

# 2) メインフィン：後端側の軸にパチンとはめる割りリング＋後退翼3枚。
FIN = dict(
    z=(103.0, 143.0),   # リングの区間（後端は軸の後端＝ベルの底に合わせる）
    od=11.0,            # リング外径
    taper=5.0,          # 前端のテーパー長
    slit_deg=110.0,     # クリップ逃げの切り欠き角（クリップを開けるだけ空ける）
    n=3,                # フィン枚数
    root_chord=(108.0, 143.0),  # 付け根の前縁→後縁Z（テーパーが終わる位置から）
    tip_chord=(127.0, 143.0),   # 翼端の前縁→後縁Z（後退角がつく）
    span=10.3,          # リング外周からの張り出し
    thick=(2.6, 1.3),   # 付け根→翼端の厚み
)

# 3) カナード：グリップのすぐ上に付ける小翼3枚。ここにクリップは無い。
CANARD = dict(
    z=(56.0, 70.0),
    od=10.4,
    taper=3.0,
    slit_deg=60.0,
    n=3,
    root_chord=(59.0, 70.0),
    tip_chord=(65.0, 70.0),
    span=6.0,
    thick=(2.2, 1.1),
)

CHAMFER = 0.4    # リング内外の面取り（はめやすさ＋印刷の反り対策）
FIN_EMBED = 0.3  # フィン付け根をリングに食い込ませる量（スライサ上で合体させる）

# ====================== 幾何プリミティブ ======================


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _push(tris, a, b, c):
    """縮退（2点が同じ）した三角形は捨てて追加する。軸上の頂点対策。"""
    if a != b and b != c and c != a:
        tris.append((a, b, c))


def triangulate(poly):
    """単純多角形（2D）を耳切り法で分割。返す三角形の巻き方向は入力の頂点順に合わせる
    （呼び出し側が蓋の向きを制御できるように）。"""
    n = len(poly)
    if n < 3:
        return []
    # 耳切りは反時計回り前提なので、時計回りならいったん反転して最後に戻す
    area2 = sum(poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1]
                for i in range(n))
    cw = area2 <= 0
    idx = list(range(n - 1, -1, -1)) if cw else list(range(n))

    def cross2(o, a, b):
        return ((a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]))

    def inside(p, a, b, c):
        d1, d2, d3 = cross2(a, b, p), cross2(b, c, p), cross2(c, a, p)
        return not ((d1 < 0 or d2 < 0 or d3 < 0) and (d1 > 0 or d2 > 0 or d3 > 0))

    tris, guard = [], 0
    while len(idx) > 3 and guard < 4 * n * n:
        guard += 1
        for a in range(len(idx)):
            i0, i1, i2 = idx[a - 1], idx[a], idx[(a + 1) % len(idx)]
            if cross2(poly[i0], poly[i1], poly[i2]) <= 1e-9:
                continue          # 出っ張っていない＝耳ではない
            if any(inside(poly[k], poly[i0], poly[i1], poly[i2])
                   for k in idx if k not in (i0, i1, i2)):
                continue          # 中に他の頂点を含むので耳ではない
            tris.append((i0, i1, i2))
            idx.pop(a)
            break
        else:
            break
    if len(idx) == 3:
        tris.append(tuple(idx))
    return [t[::-1] for t in tris] if cw else tris


def lathe(profile, a0=0.0, a1=360.0, seg=SEG):
    """(r, z) の閉じた輪郭を Z 軸まわりに回して立体にする。
    a1-a0 が 360 未満なら両端に蓋をして、割りリングになる。"""
    partial = abs((a1 - a0) - 360.0) > 1e-9
    steps = seg if not partial else max(6, int(seg * (a1 - a0) / 360.0))
    angs = [math.radians(a0 + (a1 - a0) * k / steps) for k in range(steps + 1)]
    if not partial:
        angs[-1] = angs[0]

    def P(rz, ang):
        return (rz[0] * math.cos(ang), rz[0] * math.sin(ang), rz[1])

    tris = []
    n = len(profile)
    for i in range(n):
        p, q = profile[i], profile[(i + 1) % n]
        for k in range(len(angs) - 1):
            a, b = angs[k], angs[k + 1]
            v00, v01, v11, v10 = P(p, a), P(p, b), P(q, b), P(q, a)
            _push(tris, v00, v01, v11)
            _push(tris, v00, v11, v10)
    if partial:
        for ang, flip in ((math.radians(a0), False), (math.radians(a1), True)):
            face = [P(rz, ang) for rz in profile]
            for (i, j, k) in triangulate(profile):
                t = (face[i], face[j], face[k])
                _push(tris, *(t[::-1] if flip else t))
    return _orient(tris)


def loft(sections):
    """断面（3D点の列・点数は全断面で同じ）を順につないで筒にし、両端に蓋をする。"""
    tris = []
    for s0, s1 in zip(sections, sections[1:]):
        m = len(s0)
        for i in range(m):
            j = (i + 1) % m
            _push(tris, s0[i], s0[j], s1[j])
            _push(tris, s0[i], s1[j], s1[i])
    for sec, flip in ((sections[0], True), (sections[-1], False)):
        flat = [(p[1], p[2]) for p in sec]   # 断面は X 一定なので (Y,Z) で分割
        for (i, j, k) in triangulate(flat):
            t = (sec[i], sec[j], sec[k])
            _push(tris, *(t[::-1] if flip else t))
    return _orient(tris)


def _orient(tris):
    """符号付き体積が正（＝法線が外向き）になるように必要なら全部ひっくり返す。"""
    vol = sum(_dot(a, _cross(b, c)) for a, b, c in tris) / 6.0
    return tris if vol >= 0 else [t[::-1] for t in tris]


def rot_z(tris, deg):
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return [tuple((p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]) for p in t)
            for t in tris]


# ====================== 部品づくり ======================


def ring_profile(z0, z1, r_in, r_out, taper, ch=CHAMFER):
    """割りリングの断面。前端は taper[mm] のテーパー（整流フェアリング）で軸に馴染ませ、
    後端は面取りだけ。(r, z) の閉じた輪郭を返す。"""
    return [(r_in + ch, z0), (r_in + 0.9, z0), (r_out, z0 + taper),
            (r_out, z1 - ch), (r_out - ch, z1), (r_in + ch, z1),
            (r_in, z1 - ch), (r_in, z0 + ch)]


def fin(root_chord, tip_chord, r0, r1, t0, t1, n_cs=16, stations=8):
    """翼断面を楕円にして根元→翼端へロフトした1枚のフィン。
    +X 方向に伸びる形で作る（あとで rot_z で好きな方位へ回す）。"""
    secs = []
    for k in range(stations):
        u = k / (stations - 1)
        x = r0 + (r1 - r0) * u
        le = root_chord[0] + (tip_chord[0] - root_chord[0]) * u
        te = root_chord[1] + (tip_chord[1] - root_chord[1]) * u
        zc, chord, th = (le + te) / 2.0, te - le, t0 + (t1 - t0) * u
        sec = []
        for m in range(n_cs):
            a = 2.0 * math.pi * m / n_cs
            sec.append((x, th / 2.0 * math.sin(a), zc + chord / 2.0 * math.cos(a)))
        secs.append(sec)
    return loft(secs)


def finned_ring(cfg):
    """割りリング＋フィンn枚。スリットはクリップの方位に合わせて開ける。"""
    r_in = (PEN['barrel_dia'] - FIT) / 2.0
    r_out = cfg['od'] / 2.0
    half = cfg['slit_deg'] / 2.0
    a0 = PEN['clip_az'] + half
    a1 = PEN['clip_az'] + 360.0 - half
    tris = lathe(ring_profile(cfg['z'][0], cfg['z'][1], r_in, r_out, cfg['taper']),
                 a0, a1)
    # フィンは「残っているリング（a0〜a1）」の中で等間隔に置く。
    # 切り口ぎりぎりに立てると付け根が宙に浮くので、両端は半ピッチ分あける。
    arc = a1 - a0
    for i in range(cfg['n']):
        az = a0 + arc * (i + 0.5) / cfg['n']
        blade = fin(cfg['root_chord'], cfg['tip_chord'],
                    r_out - FIN_EMBED, r_out + cfg['span'],
                    cfg['thick'][0], cfg['thick'][1])
        tris += rot_z(blade, az)
    return tris


def engine_bell():
    """ノックにかぶせるロケットノズル。押せばそのままノックできる。"""
    outer = BELL['outer']
    inner = BELL['inner']
    r_bore = BELL['bore'] / 2.0
    # 底面(内周) → 外形を上へ → 出口リップ → ベル内側を下へ → スロート(圧入穴の上端)
    # 最後は輪郭が閉じて、そのまま圧入穴の壁になる
    prof = [(r_bore, BELL['base_z'])]
    prof += [(r, z) for z, r in outer]
    prof += [(r, z) for z, r in reversed(inner)]
    return lathe(prof)


def pencil_mock():
    """確認用の本体ダミー（印刷用ではない）。推定寸法の可視化を兼ねる。"""
    rb, rg = PEN['barrel_dia'] / 2.0, PEN['grip_dia'] / 2.0
    rk = PEN['knock_dia'] / 2.0
    gz0, gz1 = PEN['grip_z']
    prof = [(0.0, 0.0), (0.45, 0.0), (0.45, PEN['sleeve_len']),
            (rb * 0.9, PEN['tip_cone_z']), (rg, gz0), (rg, gz1), (rb, gz1 + 2.0),
            (rb, PEN['knock_z']), (rk, PEN['knock_z']),
            (rk, PEN['total_len']), (0.0, PEN['total_len'])]
    return lathe(prof)


PARTS = {
    'engine_bell': engine_bell,
    'fin_ring': lambda: finned_ring(FIN),
    'canard_ring': lambda: finned_ring(CANARD),
}


# ====================== 出力と検査 ======================


def audit(tris):
    """閉じた立体になっているか（各辺がちょうど2回・逆向きで使われているか）を確認。"""
    edges = {}
    for t in tris:
        for i in range(3):
            a = tuple(round(v, 5) for v in t[i])
            b = tuple(round(v, 5) for v in t[(i + 1) % 3])
            if a == b:
                continue        # 退化三角形（軸上など）は無視
            edges[(a, b)] = edges.get((a, b), 0) + 1
    bad = sum(1 for (a, b), c in edges.items() if c != 1 or edges.get((b, a), 0) != 1)
    vol = sum(_dot(a, _cross(b, c)) for a, b, c in tris) / 6.0
    return bad, vol


def write_stl(path, tris, name):
    with open(path, 'wb') as f:
        f.write((name[:79]).encode('ascii', 'replace').ljust(80, b' '))
        f.write(struct.pack('<I', len(tris)))
        for a, b, c in tris:
            n = _cross(_sub(b, a), _sub(c, a))
            ln = math.sqrt(_dot(n, n)) or 1.0
            f.write(struct.pack('<12fH', n[0] / ln, n[1] / ln, n[2] / ln,
                                *a, *b, *c, 0))


def main(argv):
    out = argv[1] if len(argv) > 1 and not argv[1].startswith('-') else 'stl'
    parts = dict(PARTS)
    if '--mock' in argv:
        parts['pencil_mock'] = pencil_mock
    os.makedirs(out, exist_ok=True)
    for name, build in parts.items():
        tris = build()
        bad, vol = audit(tris)
        path = os.path.join(out, name + '.stl')
        write_stl(path, tris, 'GraphGear1000 rocket kit - ' + name)
        flag = 'OK ' if bad == 0 else 'OPEN EDGES x%d ' % bad
        print('%-14s %5d tri  %8.2f mm^3  %s-> %s' % (name, len(tris), vol, flag, path))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
