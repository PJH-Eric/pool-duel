/* 物理參數：只改這個檔就能調手感（伺服器與瀏覽器共用，必須一致） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PoolConfig = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return {
    W: 1000, H: 500,            // 球桌座標（球心活動區之外的庫邊線）
    R: 15.6,                    // 球半徑
    DT: 1 / 240,                // 固定步長
    VMAX: 3600,                 // 力度 100% 初速（單位/秒）
    DECEL: 650,                 // 滾動減速（單位/秒²）
    ZERO_V: 6,                  // 低於此速度視為靜止
    E_BALL: 0.96,               // 球球彈性
    E_RAIL_N: 0.78,             // 庫邊法向保留
    E_RAIL_T: 0.92,             // 庫邊切向保留
    E_JAW: 0.6,                 // 袋口尖角彈性
    JAW_R: 5,                   // 袋口尖角圓半徑
    CORNER_GAP: 36,             // 角袋：庫邊從角落起算的缺口
    SIDE_GAP: 30,               // 邊袋：中點兩側缺口半寬
    CAP_CORNER: 27,             // 角袋捕捉半徑
    CAP_SIDE: 25,               // 邊袋捕捉半徑
    POCKET_SCALE_BIG: 1.25,     // 「加大袋口」倍率
    MAX_SIM_TIME: 30,           // 單桿模擬時間上限（秒）
    // 簡化旋轉
    SPIN_MAX: 0.6,              // 擊球點最大偏移（半徑倍數）
    FOLLOW_K: 0.5,              // 上/下旋：碰球後追/縮係數
    SPIN_DECAY: 0.35,           // 旋轉衰減（每秒）
    SIDE_K: 0.35,               // 側旋碰庫偏折
    SQUIRT: 0.035,              // 側旋造成的出桿偏移
    HEAD_X: 250, FOOT_X: 750, CENTER_Y: 250,
    // 力度曲線：v = VMAX * (0.25p + 0.75p²)
    POWER_LIN: 0.25
  };
});
