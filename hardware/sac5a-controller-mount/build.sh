#!/usr/bin/env bash
# SAC-5A ホルダー + 液晶フード : STL / 3MF / プレビュー画像を再生成する
#   必要なもの : openscad
#   画像だけ    : DISPLAY がなければ xvfb-run 経由で実行される
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p stl img

for part in sac5a_controller_mount sac5a_display_hood; do
    echo "==> $part : STL / 3MF"
    openscad --export-format binstl -o "stl/$part.stl" "$part.scad"
    openscad                        -o "stl/$part.3mf" "$part.scad"
done

# 画像生成は GUI が要る。ヘッドレスなら xvfb-run で包む。
SCAD_GUI=(openscad)
if [ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null 2>&1; then
    SCAD_GUI=(xvfb-run -a openscad)
fi

render() { # render <出力名> <シーン.scad> <rot_x> <rot_z> [投影オプション]
    "${SCAD_GUI[@]}" -o "img/$1.png" --imgsize=1100,900 \
        --camera=0,0,0,"$3",0,"$4",0 --viewall --autocenter \
        "${5:---projection=o}" "$2" >/dev/null
}

echo "==> プレビュー画像 : ホルダー単体"
render view-iso       preview.scad 62  25 --projection=p
render view-iso-rear  preview.scad 62 205 --projection=p
render view-right     preview.scad 90  90
render view-front     preview.scad 90   0

echo "==> プレビュー画像 : フード込みの組み合わせ"
render hood-iso    preview_assembly.scad 62  25 --projection=p
render hood-front  preview_assembly.scad 90   0
render hood-right  preview_assembly.scad 90  90

echo "==> 完了"
ls -la stl/ img/
