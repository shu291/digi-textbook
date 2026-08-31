#!/usr/bin/env bash
# SAC-5A 制御タイマー用ホルダー : STL / 3MF / プレビュー画像を再生成する
#   必要なもの : openscad
#   画像だけ    : DISPLAY がなければ xvfb-run 経由で実行される
set -euo pipefail
cd "$(dirname "$0")"

SRC=sac5a_controller_mount.scad
OUT=stl/sac5a_controller_mount

mkdir -p stl img

echo "==> STL / 3MF"
openscad --export-format binstl -o "$OUT.stl" "$SRC"
openscad                        -o "$OUT.3mf" "$SRC"

# 画像生成は GUI が要る。ヘッドレスなら xvfb-run で包む。
SCAD_GUI=(openscad)
if [ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null 2>&1; then
    SCAD_GUI=(xvfb-run -a openscad)
fi

render() { # render <名前> <rot_x> <rot_z> [投影オプション]
    "${SCAD_GUI[@]}" -o "img/view-$1.png" --imgsize=1100,900 \
        --camera=0,0,0,"$2",0,"$3",0 --viewall --autocenter \
        "${4:---projection=o}" preview.scad >/dev/null
}

echo "==> プレビュー画像"
render iso       62  25 --projection=p
render iso-rear  62 205 --projection=p
render right     90  90
render front     90   0

echo "==> 完了"
ls -la "$OUT".* img/
