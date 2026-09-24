// ホルダー + 制御タイマー + 液晶フード の合わせ確認用
use <sac5a_controller_mount.scad>
use <sac5a_display_hood.scad>

DEV_W = 120; DEV_D = 60; DEV_H = 120;
PLATE_TOP = 10;    // 本体が載る面（ホルダー側の plate_top）
RAIL = 43;

holder();
%translate([-DEV_W/2, -DEV_D/2, PLATE_TOP]) cube([DEV_W, DEV_D, DEV_H]);   // 制御タイマー
%translate([-150, -RAIL/2, -RAIL]) cube([300, RAIL, RAIL]);                // 角パイプ
color("SteelBlue") translate([0, 0, PLATE_TOP + DEV_H]) hood();            // 液晶フード
