# 撞球對決（pool-duel）

寫實質感的 2 人撞球：**簡化九球／八號球（正式規則）／14-1 連續進球**。可以一個人對電腦（幼幼班、簡單、普通、困難、神話）、
自由練習，也能開線上房間 1 對 1、邀請連結、最多 20 人觀戰、聊天。零依賴（只用 Node 內建模組），
橫向／直向／手機／平板都能操作。

規格唯一來源是 [`規劃書.md`](規劃書.md)，美術稿在 [`美術/`](美術)。

## 怎麼玩起來

**最簡單**：雙擊 `啟動遊戲.bat`（自動找 Node、等伺服器起來再開瀏覽器）。

**命令列**：

```
npm start
```

開 <http://localhost:3160>。埠號固定 **3160**（3000～3140 已被 `C:\Eric\AI Agent` 其他遊戲佔用，其中 3100 是大富翁），
要改就設環境變數 `PORT` 或抄 `.env.example` 成 `.env`。

**只想單機玩、不想裝 Node**：直接用瀏覽器打開 `public/index.html`（線上對戰需要伺服器）。

## 怎麼驗

```
npm test                # 快速完整檢查：物理、三種規則、袋口、AI 合法性與線上房間（約 1–2 分鐘）
npm run verify:full     # 再加困難／簡單與神話／困難 AI 的 20 場勝率統計（本機約 7 分鐘，依設備而異）
npm run test:online     # 只跑線上整合（真的開 WebSocket）
```

`npm test`／`npm run verify` 同時執行物理／規則／AI 與線上整合，所有既有案例都保留；任一組失敗就回報失敗，並顯示各組與總耗時。線上測試仍使用真實倒數與重連等待時間。

Pages 部署後會自動讀取線上的 `version.json`，比對本次 commit SHA；最多重試 12 次，版本不符會讓工作流程失敗。也可手動執行 `node scripts/check-deployment.js <網站網址> <完整 commit SHA>` 確認版本。

## 架構重點

- **物理**：固定步長 1/240 秒、只用 + − × ÷ √，同樣輸入一定得到同樣結果；擊球方向量化、力道 0～1000。
  單機在瀏覽器算；線上由**伺服器用同一份引擎模擬**（防作弊），玩家端只重播動畫並採用伺服器狀態。
- **規則**：`public/js/rules.js` 把三種玩法寫成純函式（狀態 JSON → 擊球 → 新狀態），線上與單機共用。
- **AI**：`public/js/ai.js`，用同一個物理引擎試打候選球再依強度挑選（幼幼班只挑安全好打的、不會犯規）。
- **線上**：`lib/`（自寫 RFC 6455 WebSocket）。房間、座位、觀戰、邀請連結、聊天、30 秒斷線保留位置、回合倒數。
- **畫面**：Canvas，逐像素球面著色、球會依滾動方向轉動；直向時整張桌子旋轉 90°。

## 部署

- 後端：`render.yaml`（Render，Singapore，零依賴）。環境變數 `ALLOW_ORIGIN` 填前端網域。
- 前端：`.github/workflows/pages.yml` 會把 `public/` 發到 GitHub Pages，並用
  `scripts/inject-server-url.js` 把 `GAME_SERVER_URL` 注入 `public/js/config.js`。
  改 workflow 裡的 `DEFAULT_GAME_SERVER_URL` 即可換後端。
- 尚未建立任何雲端服務；要上線請自行建立 Render 服務後再把網址填進去。

## 目錄

```
server.js            HTTP 靜態檔 + /health /api/presence /api/rooms + WebSocket /ws
lib/                 ws.js、protocol.js、rooms.js、match-loop.js
public/              index.html、css/、js/（physics、rules、ai、render、game、online、lobby、app…）
tests/               verify.js、online-check.js
scripts/             inject-server-url.js
美術/                風格板與畫面稿（SVG + 預覽 PNG）
```
