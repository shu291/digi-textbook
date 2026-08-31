// =============================================================================
//  定刻起床装置 個人簡易型 SAC-5A型  制御タイマー(型式 SUK-49) 用
//  ベッドフレーム(43 x 43 角パイプ)引っ掛けホルダー
// -----------------------------------------------------------------------------
//  構造
//    ・角パイプに「上からかぶせる」サドル(∩形)
//    ・その外側面に、左右2枚のサイドプレートでぶら下がるポケット
//    ・制御タイマーは上から落とし込んで差し込む
//
//  寸法根拠 (新光電業(株) SAC-5A型 取扱説明書「主な製品仕様」)
//    制御タイマー(SUK-49)  高さ 120 × 幅 120 × 奥行 60 (mm) / 500 (g)
//
//  設計上の逃がし
//    ・背面 : 送風機プラグ差込口 / 電源ケーブル差込口 / 電池カバー(ツマミ)
//             → 背面はほぼ全開。さらにレール外面から STANDOFF だけ離す。
//             → 落とし込み量 DROP により、差込口が角パイプの下端より下に来る
//                ので、プラグを挿しても角パイプに当たらない。
//    ・正面 : 下半分が操作ボタン11個 → リップは FRONT_LIP_H の低い縁のみ。
//             上部の停止A/停止B・ディスプレイはサドルより上に出る。
//
//  座標系 : Z=0 レール上面 / Y=0 レール断面中心 / X = レール長手方向
//           +Y = ベッドの外側(ポケット側) / -Y = ベッド側
//  単位   : mm
// =============================================================================

$fn = 64;

// --------------------------------------------------- 制御タイマー(SUK-49)
DEV_W   = 120;   // 幅   (X)
DEV_H   = 120;   // 高さ (Z) ※参考値。ポケットは全高を覆わない
DEV_D   = 60;    // 奥行 (Y)
DEV_CLR = 1.5;   // 片側クリアランス(角R・印刷誤差ぶん)

// ------------------------------------------------------- ベッドフレーム
RAIL_W   = 43;   // 角パイプ 幅   (Y)
RAIL_H   = 43;   // 角パイプ 高さ (Z) ※掛かりは LEG_DROP で決まる
RAIL_CLR = 0.6;  // はめあいクリアランス(全幅)。きつい→0.8 / 緩い→0.4

// --------------------------------------------------------------- 肉厚等
WALL     = 4;    // 一般肉厚(サイドプレート・リップ)
FLOOR_T  = 5;    // ポケット床厚
TOP_T    = 5;    // サドル天板厚
LEG_DROP = 38;   // サドル脚の掛かり深さ(RAIL_H=43 に対して)

// ------------------------------------------------------------- ポケット
STANDOFF     = 12;  // サドル外面 → 本体背面 の隙間(コネクタ/ツマミ逃がし)
DROP         = 100; // レール上面 → 本体底面 の落とし込み量
SIDE_H_BACK  = 72;  // サイドプレート高さ(背面側)
SIDE_H_FRONT = 28;  // サイドプレート高さ(正面側) ※テーパでつなぐ
FRONT_LIP_H  = 10;  // 正面リップ高さ(操作ボタンを塞がない高さ)
BACK_LIP_H   = 14;  // 背面リップ高さ(本体の位置決め)

// ----------------------------------------------------------- クランプねじ
CLAMP_SCREWS = true; // M4x25 を2本、ベッド側の脚から締めてガタ止め
SCREW_D      = 3.4;  // M4 タッピング下穴
BOSS_D       = 11;   // ねじボス外径
BOSS_L       = 6;    // ねじボス突出量(45度テーパでサポートレス)
SCREW_X      = 30;   // ねじ位置(中心からの距離)
SCREW_Z      = -20;  // ねじ高さ

// ------------------------------------------------------------- オプション
LIGHTEN      = true; // サドルの肉抜き窓
FLOOR_WINDOW = true; // 床の肉抜き / ゴミ抜き窓
CABLE_NOTCH  = true; // 背面リップのケーブル逃がし(左右対称)
PLACE_ON_BED = true; // true: 底面が Z=0 に来るよう移動(スライサ用)

// =============================================================================
//  派生寸法
// =============================================================================
cav_w     = RAIL_W + RAIL_CLR;      // レールが通る空間の幅
cav_y     = cav_w / 2;              // その内壁 Y
out_y     = cav_y + WALL;           // サドル外面 Y

pocket_w  = DEV_W + 2 * DEV_CLR;
pocket_d  = DEV_D + 2 * DEV_CLR;
px        = pocket_w / 2;           // ポケット内壁 X
cx        = px + WALL;              // 外壁 X (= サイドプレート外面)

floor_top = -DROP;                  // 本体が載る面
floor_bot = floor_top - FLOOR_T;

back_y    = out_y + STANDOFF;       // 本体 背面の位置
front_y   = back_y + pocket_d;      // 本体 正面の位置
cf_y      = front_y + WALL;         // ポケット外面(正面側)

saddle_x  = 2 * cx;                 // サドル長さ = サイドプレート外面まで

// 対角2点から直方体をつくる汎用モジュール
module bx(x0, x1, y0, y1, z0, z1)
    translate([min(x0, x1), min(y0, y1), min(z0, z1)])
        cube([abs(x1 - x0), abs(y1 - y0), abs(z1 - z0)]);

// =============================================================================
//  1. サドル : 角パイプに上からかぶせる ∩ 形
// =============================================================================
module saddle() {
    // 天板
    bx(-cx, cx, -out_y, out_y, 0, TOP_T);
    // 脚(ベッド側 / 外側)
    bx(-cx, cx, -out_y, -cav_y, -LEG_DROP, TOP_T);
    bx(-cx, cx,  cav_y,  out_y, -LEG_DROP, TOP_T);
    // クランプねじボス : 45度円錐でサポートレス
    if (CLAMP_SCREWS)
        for (sx = [-1, 1])
            translate([sx * SCREW_X, -out_y, SCREW_Z])
                rotate([90, 0, 0])
                    cylinder(d1 = BOSS_D + 2 * BOSS_L, d2 = BOSS_D, h = BOSS_L);
}

// サドル天板の肉抜き窓
//   脚(z < 0)は切らないので、天板を抜いても全体は一体のまま繋がる。
module saddle_lighten() {
    if (LIGHTEN)
        for (sx = [-1, 1])
            bx(sx * 15, sx * 47, -out_y - 1, out_y + 1, 0, TOP_T + 1);
}

// レールが入る空間(下方向に開口)+ 差し込みリード面取り + 天板内隅の逃がし
module rail_cavity() {
    len = saddle_x + 20;
    bx(-len / 2, len / 2, -cav_y, cav_y, -(LEG_DROP + 40), 0);
    // 下端の面取り(はめやすく)
    hull() {
        bx(-len / 2, len / 2, -cav_y, cav_y, -LEG_DROP, -LEG_DROP + 0.01);
        bx(-len / 2, len / 2, -(cav_y + 2.5), cav_y + 2.5,
           -LEG_DROP - 3, -LEG_DROP - 2.99);
    }
    // 天板内隅の逃がし(積層のダレとパイプ角Rを吸収)
    for (sy = [-1, 1])
        translate([-len / 2, sy * cav_y, 0])
            rotate([0, 90, 0])
                cylinder(d = 4, h = len);
}

module clamp_holes() {
    if (CLAMP_SCREWS)
        for (sx = [-1, 1])
            translate([sx * SCREW_X, cav_y - 0.01, SCREW_Z])
                rotate([90, 0, 0])
                    cylinder(d = SCREW_D, h = cav_y + out_y + BOSS_L + 2);
}

// =============================================================================
//  2. サイドプレート : サドル → スタンドオフ → ポケット側壁 を一枚でつなぐ
//     Y-Z 平面の板なので、片持ち曲げに対して最も効率のよい向きになる
// =============================================================================
SIDE_PROFILE = [
    [cav_y,  TOP_T],                      // 背面上端(サドル天板の高さ)
    [back_y, TOP_T],                      // スタンドオフぶん張り出し
    [back_y, floor_top + SIDE_H_BACK],    // 側壁 背面側の高さ
    [cf_y,   floor_top + SIDE_H_FRONT],   // 正面へ向かってテーパ
    [cf_y,   floor_bot],                  // 正面下端
    [cav_y,  floor_bot],                  // 背面下端
];

module side_plate() {
    translate([px, 0, 0])
        rotate([90, 0, 90])            // (x,y,z) -> (z,x,y) : YZ平面の板をX方向に押し出す
            linear_extrude(WALL)
                polygon(SIDE_PROFILE);
}

module side_plates() {
    side_plate();
    mirror([1, 0, 0]) side_plate();
}

// =============================================================================
//  3. ポケット : 床 + 前後リップ (背面中央と正面上半分は開放のまま)
// =============================================================================
module cradle() {
    // 床(サドル直下まで伸ばしてサイドプレートと一体化)
    bx(-cx, cx, cav_y, cf_y, floor_bot, floor_top);
    // 正面リップ(操作ボタンを避ける低さ)
    bx(-cx, cx, front_y, cf_y, floor_bot, floor_top + FRONT_LIP_H);
    // 背面リップ(本体の位置決め)
    bx(-cx, cx, back_y - WALL, back_y, floor_bot, floor_top + BACK_LIP_H);
}

module floor_cut() {
    if (FLOOR_WINDOW)
        bx(-40, 40, back_y + 14, front_y - 14, floor_bot - 1, floor_top + 1);
}

// 背面リップのケーブル逃がし(左右対称なので取り付け向きを選ばない)
module cable_cut() {
    if (CABLE_NOTCH)
        for (sx = [-1, 1])
            bx(sx * 16, sx * 52, back_y - WALL - 1, back_y + 1,
               floor_top - 0.01, floor_top + BACK_LIP_H + 1);
}

// =============================================================================
//  組み立て
// =============================================================================
module holder() {
    difference() {
        union() {
            saddle();
            side_plates();
            cradle();
        }
        rail_cavity();
        saddle_lighten();
        clamp_holes();
        floor_cut();
        cable_cut();
    }
}

// 参考表示 : 制御タイマー本体(STL には含まれない)
module device_ghost() {
    %translate([-DEV_W / 2, back_y, floor_top])
        cube([DEV_W, DEV_D, DEV_H]);
}

// 参考表示 : ベッドフレーム角パイプ
module rail_ghost() {
    %translate([-150, -RAIL_W / 2, -RAIL_H])
        cube([300, RAIL_W, RAIL_H]);
}

if (PLACE_ON_BED)
    translate([0, 0, -floor_bot]) holder();
else
    holder();
