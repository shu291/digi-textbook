#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""リレーバトン 3Dモデル生成スクリプト（筒そのまま版・三角ラティス版）

外径・長さは陸上競技規則（長さ 28〜30cm／周囲 12〜13cm／重さ 50g以上）に合わせる。
薄肉の筒そのままか、壁を「三角形の枠（ラティス）」に置きかえてさらに軽くするかを選べる。
差しこみ継手つきで2分割すれば、造形高さ180mm（A1 mini）のプリンタでも刷れる。

つくりかた
----------
筒の壁を「角度θ × 高さz」の平面に展開し、正三角形に近い三角形で敷きつめる。
各三角形セルは

  * SOLID … 三角形をそのまま埋める（両端の握り部・接合部）
  * FRAME … 内側に相似な三角形の穴をあけ、枠（リブ）だけ残す（中央部）

のどちらか。この 2D メッシュを半径方向に押し出す（内半径→外半径）と、
穴あき円筒ができる。押し出しの半径はレベルごとに変えられるので、
分割版のスピゴット（差しこみ継手）の段差もこの仕組みで表現している。

隣りあうセルは辺の分割数が同じなので頂点が必ず一致し、
出力メッシュは閉じた多様体（watertight）になる。生成後に
  * 各有向辺がちょうど 1 回、その逆向きもちょうど 1 回だけ現れるか
  * 符号つき体積が正か
を検査してから STL を書き出す。

使いかた
--------
    python3 baton.py                  # 既定（軽量ラティス版）を stl/ に出力
    python3 baton.py --preset plain   # 穴なしのただの筒（薄肉）
    python3 baton.py --preset legal   # 公式規格重量（50g以上）版
    python3 baton.py --hole 0.8       # 穴を大きくしてさらに軽く
    python3 baton.py --no-thread      # ねじなしの差しこみ継手にする
"""

import argparse
import math
import os
import struct

PLA_DENSITY = 1.24          # g/cm^3（PLAの標準的な密度）
FILAMENT_DIA = 1.75         # mm（フィラメント径）


# ---------------------------------------------------------------- メッシュ

class Mesh:
    """三角形メッシュ（頂点は座標で重複排除せず、パラメータ空間のキーで共有）"""

    def __init__(self):
        self.verts = []
        self.tris = []

    def add_tri(self, a, b, c):
        self.tris.append((a, b, c))

    # --- 検査 ---------------------------------------------------------

    def volume(self):
        """符号つき体積 [mm^3]（外向き法線なら正）"""
        v = self.verts
        total = 0.0
        for a, b, c in self.tris:
            ax, ay, az = v[a]
            bx, by, bz = v[b]
            cx, cy, cz = v[c]
            total += (ax * (by * cz - bz * cy)
                      - ay * (bx * cz - bz * cx)
                      + az * (bx * cy - by * cx))
        return total / 6.0

    def check_closed(self):
        """閉じた向きづけ可能多様体かどうか。(ok, メッセージ) を返す"""
        edges = {}
        for a, b, c in self.tris:
            for e in ((a, b), (b, c), (c, a)):
                edges[e] = edges.get(e, 0) + 1
        dup = [e for e, n in edges.items() if n != 1]
        if dup:
            return False, "同じ向きの辺が重複: %d本" % len(dup)
        open_edges = [e for e in edges if (e[1], e[0]) not in edges]
        if open_edges:
            return False, "境界（穴）が開いている: %d本" % len(open_edges)
        return True, "閉じた多様体（三角形 %d / 頂点 %d）" % (
            len(self.tris), len(self.verts))

    def bbox(self):
        xs = [p[0] for p in self.verts]
        ys = [p[1] for p in self.verts]
        zs = [p[2] for p in self.verts]
        return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))

    # --- 出力 ---------------------------------------------------------

    def write_stl(self, path):
        v = self.verts
        with open(path, "wb") as f:
            f.write(b"relay baton (minimal-material lattice)".ljust(80, b"\0"))
            f.write(struct.pack("<I", len(self.tris)))
            for a, b, c in self.tris:
                ax, ay, az = v[a]
                bx, by, bz = v[b]
                cx, cy, cz = v[c]
                ux, uy, uz = bx - ax, by - ay, bz - az
                wx, wy, wz = cx - ax, cy - ay, cz - az
                nx = uy * wz - uz * wy
                ny = uz * wx - ux * wz
                nz = ux * wy - uy * wx
                ln = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
                f.write(struct.pack("<12fH",
                                    nx / ln, ny / ln, nz / ln,
                                    ax, ay, az, bx, by, bz, cx, cy, cz, 0))


# ------------------------------------------------------- 2Dパターン生成

def _lerp_p(p, q, t):
    return (p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)


def _ring_faces(nth, m, z0, z1, rows, out):
    """穴のない段を、縦にそろった四角い帯で埋める。

    三角形で敷きつめると輪が段ごとにずれて面がうねるので、平らな筒の部分は
    同じ角度の頂点が縦に並ぶ四角形で作る。角度の刻みは 2 パラメータ単位
    ＝三角形セルの辺の分割と同じなので、ラティスの段ともぴったり合う。
    """
    for r in range(rows):
        za = z0 + (z1 - z0) * r / rows
        zb = z0 + (z1 - z0) * (r + 1) / rows
        for k in range(nth * m):
            a, b = 2 * k, 2 * k + 2
            out.append(((a, za), (b, za), (b, zb)))
            out.append(((a, za), (b, zb), (a, zb)))


def _frame_faces(tri, inner, m, out):
    """三角形の枠（外周 tri、内周 inner）を細長い帯として三角形化"""
    a, b, c = tri
    ia, ib, ic = inner
    for (p, q, qi, pi) in ((a, b, ib, ia), (b, c, ic, ib), (c, a, ia, ic)):
        for k in range(m):
            t0, t1 = k / m, (k + 1) / m
            p0, p1 = _lerp_p(p, q, t0), _lerp_p(p, q, t1)
            q0, q1 = _lerp_p(pi, qi, t0), _lerp_p(pi, qi, t1)
            out.append((p0, p1, q1))
            out.append((p0, q1, q0))


def _incenter(tri, sx, sy):
    """内心（パラメータ座標）。sx, sy は 1単位あたりの実寸[mm]"""
    (ax, ay), (bx, by), (cx, cy) = tri

    def d(p, q):
        return math.hypot((p[0] - q[0]) * sx, (p[1] - q[1]) * sy)

    la, lb, lc = d(tri[1], tri[2]), d(tri[2], tri[0]), d(tri[0], tri[1])
    s = la + lb + lc
    return ((la * ax + lb * bx + lc * cx) / s,
            (la * ay + lb * by + lc * cy) / s)


def _inradius(tri, sx, sy):
    (ax, ay), (bx, by), (cx, cy) = tri
    ax, bx, cx = ax * sx, bx * sx, cx * sx
    ay, by, cy = ay * sy, by * sy, cy * sy
    area = abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2.0
    per = (math.hypot(bx - ax, by - ay) + math.hypot(cx - bx, cy - by)
           + math.hypot(ax - cx, ay - cy))
    return 2.0 * area / per


# ------------------------------------------------------------------ ねじ

def _thread_profile(ph):
    """台形ねじの山の断面（0=谷 1=山）。斜面は立てて刷って45°未満なのでサポート不要"""
    ph %= 1.0
    if ph < 0.30:
        return ph / 0.30
    if ph < 0.50:
        return 1.0
    if ph < 0.80:
        return (0.80 - ph) / 0.30
    return 0.0


def thread_radius(t, z, th):
    """ねじ部の半径。オスは山を足し、メスは同じ山のぶんだけ内側を削る（右ねじ）"""
    prof = _thread_profile((z - t["z0"]) / t["pitch"] - th / (2.0 * math.pi))
    lead = t.get("lead", 0.0)
    if t["mode"] == "male":
        # 先端と根元は山を消して、入れはじめが引っかからないようにする
        f = 1.0 if lead <= 0 else max(0.0, min(1.0, min(z - t["z0"],
                                                        t["z1"] - z) / lead))
        return t["minor"] + t["depth"] * prof * f
    # メスは入口を山の高さぶん広げておく（オスの山がそのまま入る）
    f = 1.0 if lead <= 0 else max(0.0, min(1.0, (z - t["z0"]) / lead))
    return t["minor"] + t["depth"] * (1.0 - f * (1.0 - prof))


# ------------------------------------------------------------ 本体生成

def build(bands, nth, m, hole, threads=()):
    """bands: 帯（三角形1段分）のリスト。各要素は
         h        段の高さ [mm]
         rin,rout 段の下端の内半径・外半径 [mm]
         rin1,rout1 段の上端（省略時は下端と同じ）
         solid    True なら穴をあけない
       nth : 円周方向のセル数 / m : 1辺の分割数 / hole : 穴の相似比(0-1)
       threads : ねじの指定（thread_radius 参照）。押し出し半径をθにも依存させる
    """
    T = nth * 2 * m                      # 円周方向の全パラメータ単位
    NL = len(bands) * m                  # 高さ方向のレベル数

    # 各レベルの (z, 内半径, 外半径) を段の上下端から線形補間して用意する
    lev = []
    z = 0.0
    for j, bd in enumerate(bands):
        r0 = (bd["rin"], bd["rout"])
        r1 = (bd.get("rin1", bd["rin"]), bd.get("rout1", bd["rout"]))
        for k in range(m + 1):
            if k == 0 and j > 0:
                continue                 # 段の境目は前の段の上端と共有
            t = k / m
            lev.append((z + bd["h"] * t,
                        r0[0] + (r1[0] - r0[0]) * t,
                        r0[1] + (r1[1] - r0[1]) * t))
        z += bd["h"]
    assert len(lev) == NL + 1

    # --- 展開図（θ-z平面）を三角形で敷きつめる -------------------------
    faces = []
    stats = {"cells": 0, "frames": 0, "rib": 0.0, "hole_frac": hole * hole}
    for j, bd in enumerate(bands):
        base0, base1 = (j % 2) * m, ((j + 1) % 2) * m
        z0, z1 = j * m, (j + 1) * m
        if bd["solid"]:
            _ring_faces(nth, m, z0, z1, bd.get("rows", 1), faces)
            continue
        sx = math.pi * (lev[z0][1] + lev[z0][2]) / T      # θ1単位の実寸
        sy = bd["h"] / m                                   # z1単位の実寸
        cells = []
        for i in range(nth):
            # 上向き三角形（底辺が下の段）
            cells.append(((base0 + i * 2 * m, z0),
                          (base0 + (i + 1) * 2 * m, z0),
                          (base0 + i * 2 * m + m, z1)))
            # 下向き三角形（底辺が上の段）
            cells.append(((base1 + (i + 1) * 2 * m, z1),
                          (base1 + i * 2 * m, z1),
                          (base1 + i * 2 * m + m, z0)))
        for cell in cells:
            stats["cells"] += 1
            stats["frames"] += 1
            ic = _incenter(cell, sx, sy)
            inner = tuple((ic[0] + (p[0] - ic[0]) * hole,
                           ic[1] + (p[1] - ic[1]) * hole) for p in cell)
            _frame_faces(cell, inner, m, faces)
            stats["rib"] = 2.0 * (1.0 - hole) * _inradius(cell, sx, sy)

    # --- 展開図を半径方向に押し出して立体にする -------------------------
    mesh = Mesh()
    cache = {}

    def vert(p, side):
        tu, ku = p
        tu %= T
        key = (round(tu, 6), round(ku, 6), side)
        idx = cache.get(key)
        if idx is not None:
            return idx
        i = int(math.floor(ku))
        if i >= NL:
            i = NL - 1
        t = ku - i
        z0, ri0, ro0 = lev[i]
        z1, ri1, ro1 = lev[i + 1]
        zz = z0 + (z1 - z0) * t
        r = (ro0 + (ro1 - ro0) * t) if side else (ri0 + (ri1 - ri0) * t)
        th = tu * (2.0 * math.pi / T)
        for tr in threads:                       # ねじ部だけ半径を差しかえる
            if tr["side"] == side and tr["z0"] - 1e-9 <= zz <= tr["z1"] + 1e-9:
                r = thread_radius(tr, zz, th)
        idx = len(mesh.verts)
        mesh.verts.append((r * math.cos(th), r * math.sin(th), zz))
        cache[key] = idx
        return idx

    def pkey(p):
        return (round(p[0] % T, 6), round(p[1], 6))

    directed = {}
    for f in faces:
        p, q, r = f
        mesh.add_tri(vert(p, 1), vert(q, 1), vert(r, 1))      # 外周面
        mesh.add_tri(vert(r, 0), vert(q, 0), vert(p, 0))      # 内周面
        for e in ((p, q), (q, r), (r, p)):
            directed[(pkey(e[0]), pkey(e[1]))] = e

    # 展開図の境界（穴のふち・両端面）は内外をつなぐ側面になる
    for (ka, kb), (p, q) in directed.items():
        if (kb, ka) in directed:
            continue
        po, pi_ = vert(p, 1), vert(p, 0)
        qo, qi = vert(q, 1), vert(q, 0)
        mesh.add_tri(po, pi_, qi)
        mesh.add_tri(po, qi, qo)

    return mesh, stats


# ------------------------------------------------------------ 仕様の組み立て

def joint_geometry(p):
    """継手まわりの寸法。(沈みこみ seat, 面取り cham, メス入口 entry)"""
    rout = p["od"] / 2.0
    depth = p["thread"]["depth"] if p.get("thread") else 0.0
    sk_minor = rout - p["socket_wall"] - depth
    slope = (rout - (sk_minor - p["fit"])) / p["shoulder"]
    entry = sk_minor + depth
    seat = p["lip"] / slope
    return seat, max(0.0, (rout - entry) / slope - seat), entry


def make_bands(p, kind):
    """(段のリスト, ねじのリスト) を返す。
       kind: 'one'（1本もの） / 'a'（オス側） / 'b'（メス側）"""
    rout = p["od"] / 2.0
    rin = rout - p["wall"]
    plain = p.get("plain", False)      # True なら穴をあけずただの筒にする

    def tube(total, solid_first=0, solid_last=0):
        n = max(1, int(round(total / p["band_h"])))
        return [dict(rin=rin, rout=rout, h=total / n,
                     solid=plain or j < solid_first or j >= n - solid_last)
                for j in range(n)]

    if kind == "one":
        return tube(p["length"], p["grip"], p["grip"]), []

    sh, sp, sk = p["shoulder"], p["spigot_len"], p["socket_len"]
    t = p.get("thread")
    depth = t["depth"] if t else 0.0
    pitch = t["pitch"] if t else 0.0

    # メスの谷（一番細いところ）を、溝の底でも socket_wall だけ肉が残る位置に置く
    sk_minor = rout - p["socket_wall"] - depth
    male_minor = sk_minor - p["fit"]      # オスの谷。すきまのぶんだけ細い
    sp_in = male_minor - p["joint_wall"]

    # オス側の段差はテーパ（急だと空中に刷ることになるので寝かせてある）。
    # メス側の入口に同じ傾きの面取りをつけて、テーパ同士で突きあたるようにする。
    # そうしないと端面がテーパの途中で止まり、継ぎ目に溝ができて全長も伸びる。
    slope = (rout - male_minor) / sh      # 1mmあたり半径がどれだけ細くなるか
    entry = sk_minor + depth              # メスの入口の内半径（ねじ山の頂まで開く）
    seat = p["lip"] / slope               # 突きあたるまでに沈みこむ長さ
    cham = max(0.0, (rout - entry) / slope - seat)   # メス側の面取りの高さ

    # A・Bの造形高さがそろい、かつ合わせて length になるように分ける
    la = (p["length"] - seat - sh - sp) / 2.0
    lb = p["length"] - la - seat

    def joint(total, rin_, rout_):
        """ねじを刻む区間。ピッチの1/10ごとに輪切りにして山の形を出す"""
        rows = max(1, int(round(total / (pitch / 10.0)))) if pitch else 1
        return [dict(rin=rin_, rout=rout_, h=total, solid=True, rows=rows)]

    def spec(mode, z0, z1, minor, side):
        return [dict(side=side, mode=mode, z0=z0, z1=z1, minor=minor,
                     depth=depth, pitch=pitch, lead=t["lead"])] if t else []

    if kind == "a":
        bands = tube(la, solid_first=p["grip"])
        bands.append(dict(h=sh, solid=True, rin=rin, rout=rout,      # 段差
                          rin1=sp_in, rout1=male_minor))
        bands += joint(sp, sp_in, male_minor)                        # おねじ
        return bands, spec("male", la + sh, la + sh + sp, male_minor, 1)
    if kind == "b":
        bands = [dict(h=cham, solid=True, rows=4, rout=rout, rout1=rout,
                      rin=rout - p["lip"], rin1=entry)]              # 入口の面取り
        bands += joint(sk, sk_minor, rout)                           # めねじ
        bands.append(dict(h=sh, solid=True, rin=sk_minor, rout=rout,  # 内径をもどす
                          rin1=rin, rout1=rout))
        bands += tube(lb - cham - sk - sh, solid_last=p["grip"])
        return bands, spec("female", cham, cham + sk, sk_minor, 0)
    raise ValueError(kind)


JOINT = dict(shoulder=3.0, spigot_len=24.0, socket_len=27.0,
             socket_wall=1.6, joint_wall=1.6, fit=0.25, lip=0.8,
             thread=dict(pitch=4.0, depth=1.0, lead=2.0))

PRESETS = {
    # 軽量版：三角ラティスで材料を最小化する
    "light": dict(od=38.5, wall=1.4, length=280.0, bands=16, nth=6, m=8,
                  hole=0.75, grip=1, plain=False, **JOINT),
    # 筒そのまま版：穴なし。薄肉で材料を減らす（公式の50g以上も満たす）
    "plain": dict(od=38.5, wall=1.0, length=280.0, bands=16, nth=6, m=12,
                  hole=0.75, grip=1, plain=True, **JOINT),
    # 公式規格版：50g以上・周囲12〜13cmを満たすラティス版
    "legal": dict(od=39.5, wall=2.2, length=285.0, bands=16, nth=6, m=8,
                  hole=0.66, grip=1, plain=False, **JOINT),
}


def report(name, mesh, stats, p, path, max_h=None):
    ok, msg = mesh.check_closed()
    vol = mesh.volume()
    (x0, y0, z0), (x1, y1, z1) = mesh.bbox()
    grams = vol / 1000.0 * PLA_DENSITY
    fil = vol / (math.pi * (FILAMENT_DIA / 2.0) ** 2) / 1000.0
    print("  %-28s %s" % (name, msg))
    fit = ""
    if max_h:
        fit = "  → 造形高さ%.0fmm に%s" % (max_h,
                                          "収まる" if z1 - z0 <= max_h else "収まらない")
    print("    %-26s %.1f x %.1f x %.1f mm%s" % ("外形寸法",
                                                 x1 - x0, y1 - y0, z1 - z0, fit))
    print("    %-26s %.2f cm3 / PLA約 %.1f g / フィラメント約 %.1f m"
          % ("材料", vol / 1000.0, grams, fil))
    if stats["frames"]:
        print("    %-26s 幅約 %.1f mm・厚さ %.1f mm（開口率 %.0f%%）"
              % ("リブ", stats["rib"], p["wall"], stats["hole_frac"] * 100))
    print("    %-26s %s (%.1f KB)" % ("出力", path,
                                      os.path.getsize(path) / 1024.0))
    if not ok:
        raise SystemExit("メッシュ検査に失敗しました: " + msg)
    if vol <= 0:
        raise SystemExit("法線の向きが反転しています")
    return vol


# ------------------------------------------------------- 印刷時間の見積り

def layer_areas(bands, threads, layer, hole=0.0):
    """層ごとの断面積[mm^2]。ねじ部は山の平均の高さでならし、
       ラティスの段は開口率のぶんだけ減らす（穴まわりの細かい動きは見ていない）"""
    edges, z = [], 0.0
    for bd in bands:
        edges.append((z, z + bd["h"], bd))
        z += bd["h"]
    out, zz = [], layer / 2.0
    while zz < z:
        for (a, b, bd) in edges:
            if a <= zz < b:
                t = (zz - a) / (b - a)
                ri = bd["rin"] + (bd.get("rin1", bd["rin"]) - bd["rin"]) * t
                ro = bd["rout"] + (bd.get("rout1", bd["rout"]) - bd["rout"]) * t
                break
        for tr in threads:
            if tr["z0"] <= zz <= tr["z1"]:
                mean = tr["minor"] + 0.5 * tr["depth"]      # 山の平均の高さ
                if tr["mode"] == "male":
                    ro = mean
                else:
                    ri = mean
        area = math.pi * (ro * ro - ri * ri)
        if not bd["solid"]:
            area *= 1.0 - hole * hole
        out.append(area)
        zz += layer
    return out


def job_time(parts, layer, width, speed, overhead=1.0, min_layer=4.0,
             warmup=180.0):
    """同じ皿に parts を並べたときの印刷時間[秒]のおおよそ。

    インフィル0%なので、層の押し出し長さ ＝ 断面積 ÷ 線幅。
    冷却のための最短層時間と、層替え・移動のぶんを足す。
    """
    t = warmup
    for i in range(max(len(a) for a in parts)):
        area = sum(a[i] for a in parts if i < len(a))
        n = sum(1 for a in parts if i < len(a))
        t += max(min_layer, area / width / speed + overhead * n)
    return t


def hhmm(sec):
    return "%d時間%02d分" % (sec // 3600, (sec % 3600) // 60) if sec >= 3600 \
        else "%d分" % (sec // 60)


def solid_tube_volume(p, length):
    rout = p["od"] / 2.0
    rin = rout - p["wall"]
    return math.pi * (rout ** 2 - rin ** 2) * length


def main():
    ap = argparse.ArgumentParser(description="リレーバトンのSTLを生成する")
    ap.add_argument("--preset", choices=sorted(PRESETS), default="light")
    ap.add_argument("--outdir", default=os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "stl"))
    for key, help_ in (("od", "外径[mm]"), ("wall", "肉厚[mm]"),
                       ("length", "全長[mm]"), ("hole", "穴の相似比0-1"),
                       ("fit", "ねじのすきま[mm]。きつければ増やす")):
        ap.add_argument("--" + key, type=float, help=help_)
    ap.add_argument("--nth", type=int, help="円周方向のセル数")
    ap.add_argument("--bands", type=int, help="長さ方向の段数(偶数)")
    ap.add_argument("--m", type=int,
                    help="1辺の分割数（偶数）。円周は nth×m 分割になる")
    ap.add_argument("--only", choices=["one", "split"], help="片方だけ出力")
    ap.add_argument("--plain", action="store_true",
                    help="穴をあけずただの筒にする")
    ap.add_argument("--lattice", action="store_true",
                    help="三角ラティスにする（--plain の打ち消し）")
    ap.add_argument("--no-thread", action="store_true",
                    help="ねじをやめて、ただ差しこむだけの継手にする")
    ap.add_argument("--max-height", type=float, default=180.0,
                    help="プリンタの造形高さ[mm]（既定180＝A1 mini）")
    ap.add_argument("--name", default="relay-baton", help="出力ファイル名の頭")
    ap.add_argument("--speed", type=float, default=150.0,
                    help="印刷時間の見積りに使う速度[mm/s]")
    ap.add_argument("--width", type=float, default=0.42,
                    help="印刷時間の見積りに使う線幅[mm]")
    args = ap.parse_args()

    p = dict(PRESETS[args.preset])
    for key in ("od", "wall", "length", "hole", "fit", "nth", "bands", "m"):
        if getattr(args, key) is not None:
            p[key] = getattr(args, key)
    if args.plain:
        p["plain"] = True
    if args.lattice:
        p["plain"] = False
    if args.no_thread:
        p["thread"] = None
    if p["m"] % 2:
        raise SystemExit("--m は偶数にしてください（リングとラティスの頂点をそろえるため）")
    if p["bands"] % 2:
        raise SystemExit("--bands は偶数にしてください（分割版で半分にするため）")
    p["band_h"] = p["length"] / p["bands"]

    os.makedirs(args.outdir, exist_ok=True)
    seg = p["nth"] * p["m"]
    print("プリセット: %s（%s）  外径%.1fmm 肉厚%.1fmm 全長%.0fmm 円周%d分割"
          % (args.preset, "筒そのまま" if p["plain"] else "三角ラティス",
             p["od"], p["wall"], p["length"], seg))
    print("  丸さ: 面のへこみ %.3f mm（%.1f°きざみ）"
          % (p["od"] / 2.0 * (1 - math.cos(math.pi / seg)), 360.0 / seg))
    seat, cham, _ = joint_geometry(p)
    if p["thread"]:
        print("  継手: ねじ ピッチ%.1fmm 山の高さ%.1fmm（右ねじ）／かみ合い長さ%.0fmm"
              % (p["thread"]["pitch"], p["thread"]["depth"], p["spigot_len"]))
    else:
        print("  継手: 差しこみのみ／長さ%.0fmm" % p["spigot_len"])
    print("        メス側の入口に%.2fmmの面取り。テーパ同士が突きあたって"
          "%.2fmm沈み、外面は段差なくつながる" % (cham, seat))
    print("  参考: 同寸法の穴なし円筒 = %.2f cm3 / PLA約 %.1f g"
          % (solid_tube_volume(p, p["length"]) / 1000.0,
             solid_tube_volume(p, p["length"]) / 1000.0 * PLA_DENSITY))

    jobs = []
    if args.only != "split":
        jobs.append(("one", "1本もの（全長%.0fmm）" % p["length"],
                     args.name + "-1piece.stl"))
    if args.only != "one":
        jobs.append(("a", "分割A（差しこみ側）", args.name + "-a.stl"))
        jobs.append(("b", "分割B（受け側）", args.name + "-b.stl"))

    shapes = {}
    total_split = 0.0
    for kind, label, fname in jobs:
        bands, threads = make_bands(p, kind)
        shapes[kind] = (bands, threads)
        mesh, stats = build(bands, p["nth"], p["m"], p["hole"], threads)
        path = os.path.join(args.outdir, fname)
        mesh.write_stl(path)
        vol = report(label, mesh, stats, p, path, args.max_height)
        if kind in ("a", "b"):
            total_split += vol
    if total_split:
        ha = sum(b["h"] for b in shapes["a"][0])
        hb = sum(b["h"] for b in shapes["b"][0])
        overlap = p["spigot_len"] + p["shoulder"] - seat   # Bの中に隠れる長さ
        print("  %-28s A %.1f ＋ B %.1f − 差しこみ %.1f = %.1f mm"
              % ("組み立て後の全長", ha, hb, overlap, ha + hb - overlap))
        print("  %-28s %.2f cm3 / PLA約 %.1f g"
              % ("分割版 合計", total_split / 1000.0,
                 total_split / 1000.0 * PLA_DENSITY))
        print("  印刷時間の目安（線幅%.2fmm・%.0fmm/s・インフィル0%%・あくまで概算）"
              % (args.width, args.speed))
        for layer in (0.20, 0.24, 0.28):
            a, b = (layer_areas(*shapes[k], layer=layer, hole=p["hole"])
                    for k in ("a", "b"))
            print("    層厚%.2fmm : A %s ／ B %s ／ 2本を1皿で %s"
                  % (layer,
                     hhmm(job_time([a], layer, args.width, args.speed)),
                     hhmm(job_time([b], layer, args.width, args.speed)),
                     hhmm(job_time([a, b], layer, args.width, args.speed))))


if __name__ == "__main__":
    main()
