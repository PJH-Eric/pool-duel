/* 物理參數：只改這個檔就能調手感（伺服器與瀏覽器共用，必須一致） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PoolConfig = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const CFG = {
    W: 1000, H: 500,            // 球桌座標（球心活動區之外的庫邊線）
    R: 15.6,                    // 球半徑
    DT: 1 / 240,                // 固定步長
    VMAX: 3300,                 // 力度 100% 初速（單位/秒）
    BREAK_BOOST_MIN: 1.15, BREAK_BOOST_MAX: 1.25,   // 開球實際初速 = 力度換算初速 × 隨機倍率（shot.boost，介面力度數字不變）
    DECEL: 560,                // 滑動階段減速（球剛被擊出／被撞時：球還在「滑」，摩擦大）
    DECEL_ROLL: 200,            // 純滾動階段減速（滑動結束後：只剩滾動阻力，球才能滑得又遠又順）
    SLIDE_END: 0.714,           // 滑動結束時的速度比（5/7：不帶旋轉的球滑到速度剩 5/7 就轉成純滾動）
    DECEL_EFF: 0,               // 等效減速（下面算出來，電腦估力道用）
    ZERO_V: 6,                  // 低於此速度視為靜止
    E_BALL: 0.96,               // 球球彈性
    E_RAIL_N: 0.78,             // 庫邊法向保留
    E_RAIL_T: 0.92,             // 庫邊切向保留
    E_JAW: 0.6,                 // 袋口尖角彈性
    JAW_R: 5,                   // 袋口尖角圓半徑
    CORNER_GAP: 32.9,           // 角袋：庫邊從角落起算的缺口，微幅收窄入口
    SIDE_GAP: 27,               // 邊袋：中點兩側缺口半寬
    // 進袋門檻依球半徑計算；中袋只容許極小比例跨過可見袋緣。
    HOLE_R_CORNER: 26, HOLE_R_SIDE: 20,    // 黑洞半徑
    HOLE_OFF_CORNER: 20, HOLE_OFF_SIDE: 22,  // 袋心移到檯面外，由導槽連接庫邊入口
    CORNER_CAPTURE_EASE: 0.5, // 角袋只補償極小的物理取樣誤差，不改變可見袋口
    POCKET_REST_V: 12,          // 球速低於此值視為已停在袋緣，套用補償
    POCKET_REST_ASSIST: 3,      // 補償：停在袋緣的球，球心離洞心 ≤ 洞半徑＋此值就掉進去
    POCKET_FALL_SPEED: 20,      // 球已深入袋內且慢下來時，沿袋內斜面滑向袋心
    SIDE_CAPTURE_EASE_RATIO: 0.02, // 中袋只放寬球半徑的 2%，不改變可見洞口
    POCKET_SCALE_BIG: 1.25,     // 「加大袋口」倍率
    MAX_SIM_TIME: 30,           // 單桿模擬時間上限（秒）
    // 簡化旋轉
    SPIN_MAX: 0.6,              // 擊球點最大偏移（半徑倍數）
    FOLLOW_K: 0.5,              // 上/下旋：碰球後追/縮係數
    SPIN_DECAY: 0.04,           // 旋轉衰減（每秒）；刻意很小，定桿才能在長距離也穩定
    // 三種常用出桿（擊球點上下位置，單位＝擊球點盤半徑，負＝偏上）：
    //   推桿（追球）＝偏上；定桿＝剛好偏下一點點，正撞後母球停在原地；拉桿（縮球）＝偏下較多
    PRESET_FOLLOW: -0.6, PRESET_DRAW: 0.8,
    // 跳桿：母球飛過擋路的球再落地。飛行距離 = JUMP_MIN + JUMP_K × 力度(0~1)；飛行中不碰球、不進袋、沒有摩擦，落地損失速度
    JUMP_MIN: 130, JUMP_K: 330, JUMP_LAND: 0.8,
    SIDE_K: 0.35,               // 側旋碰庫偏折
    SQUIRT: 0,                  // 側旋造成的出桿偏移（關閉：畫面瞄準線＝實際出球方向）
    HEAD_X: 250, FOOT_X: 750, CENTER_Y: 250,
    // 力度曲線：v = VMAX * (0.25p + 0.75p²)
    POWER_LIN: 0.25
  };
  // 一顆球從初速 v 滑 + 滾到停下的距離 = v² / (2·DECEL_EFF)
  const r2 = CFG.SLIDE_END * CFG.SLIDE_END;
  CFG.PRESET_STOP = (1 - CFG.E_BALL) / (2 * CFG.FOLLOW_K);   // 正撞時母球剛好停住的下旋量（0.04）
  CFG.DECEL_EFF = 1 / ((1 - r2) / CFG.DECEL + r2 / CFG.DECEL_ROLL);
  return CFG;
});
