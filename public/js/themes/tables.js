/* 桌布、場景、球桿樣式、球色（純資料；桌布與場景只影響本機畫面，球桿樣式會同步給對手） */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PoolThemes = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const FELTS = {
    classic: { name: '經典綠', c1: '#23915f', c2: '#127148', c3: '#0a4d32', cushion: '#0f6a43', cushionDark: '#0a4a2f' },
    ocean:   { name: '深海藍', c1: '#2f7fc4', c2: '#1d5f9e', c3: '#103f6e', cushion: '#1b5a93', cushionDark: '#123f69' },
    wine:    { name: '酒紅',   c1: '#b0393e', c2: '#8a2227', c3: '#5a1216', cushion: '#7c1f24', cushionDark: '#541217' }
  };
  const SCENES = {
    bar:    { name: '酒吧',   top: '#3a1f12', bottom: '#150b07', lamp: '#ffb45a', bokeh: '#ff9d3a', floor: 'dark', desc: '暖橘吊燈、深木牆' },
    club:   { name: '俱樂部', top: '#142a22', bottom: '#07120e', lamp: '#ffe29a', bokeh: '#9ad7a8', floor: 'tile', desc: '深綠壁紙、黃銅檯燈' },
    cafe:   { name: '咖啡廳', top: '#6b5a46', bottom: '#2a2118', lamp: '#fff3d0', bokeh: '#ffe9b0', floor: 'plank', desc: '明亮窗光、淺木地板' }
  };
  const CUES = {
    maple:    { name: '經典楓木', shaft: '#e6c58a', mid: '#c9a45c', butt: '#3a2013', ring: '#e3a840', tip: '#5aa9e8' },
    ebony:    { name: '黑檀金環', shaft: '#dcbb82', mid: '#b8944e', butt: '#17110d', ring: '#f2c25a', tip: '#5aa9e8' },
    blue:     { name: '深海藍尾', shaft: '#e2c48c', mid: '#c4a15e', butt: '#1c4a9c', ring: '#f4efe2', tip: '#7ec1f2' },
    rosewood: { name: '紅木',     shaft: '#d9b27a', mid: '#b98f55', butt: '#6b241d', ring: '#d9a43e', tip: '#5aa9e8' }
  };
  /* 1~7 全色，9~15 半色用同色，8 黑，0 母球 */
  const BALLC = { 0: '#f6f1e4', 1: '#f0be1e', 2: '#1d4fb8', 3: '#d8322a', 4: '#5a2a8c', 5: '#ee7418', 6: '#1c8a48', 7: '#7a1c24', 8: '#17171a' };
  const SEATS = [
    { name: 'P1', color: '#4aa3ff', dark: '#1d5fa8' },
    { name: 'P2', color: '#ff6b5e', dark: '#a8332a' }
  ];
  function ballColor(id) { return BALLC[id === 0 ? 0 : (id <= 8 ? id : id - 8)]; }
  return { FELTS, SCENES, CUES, BALLC, SEATS, ballColor };
});
