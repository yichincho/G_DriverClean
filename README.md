# Google 雲端硬碟與 Gmail 空間清理中心

本專案為純前端直連 Google 官方 API 的本地網頁工具，協助您快速檢視 Google 帳號總容量分配，並依照 **「資料天數（修改／寄件日期）」** 與 **「大檔案／附件大小（MB）」** 精準篩選與批次清理 Google 雲端硬碟及 Gmail 佔用空間。

---

## 主要功能特色

1. **空間使用量總覽（Storage Quota Dashboard）**
   - 即時統計總配額、已用空間、Google 雲端硬碟使用中檔案、雲端硬碟垃圾桶，以及 Gmail 與其他服務的佔用比例。
   - 提供一鍵快速清理捷徑（直接篩選 100 MB 以上大檔、超過 180 天未修改檔案、Drive 垃圾桶、超過 5 MB 且超過 180 天之 Gmail 信件）。
2. **Google 雲端硬碟清理（Drive Cleaner）**
   - **大檔案門檻**：支援不限大小、10 MB、50 MB、100 MB、500 MB、1 GB 以上或自訂 MB 門檻。
   - **資料天數門檻**：支援超過 30 天、90 天、180 天、365 天、730 天或自訂天數。
   - **類型與位置篩選**：可依影片、壓縮檔、圖片、PDF 與文件、關鍵字過濾，並切換「一般檔案」或「垃圾桶檔案」。
   - **批次清理**：勾選時即時計算「預計釋放總容量」，支援批次移至垃圾桶、批次永久刪除，以及一鍵清空垃圾桶。
3. **Gmail 大容量與舊信件清理（Gmail Cleaner）**
   - 自動組合標準 Gmail 搜尋語法（例如 `larger:5M older_than:180d has:attachment`）。
   - 支援依容量（MB）、天數、分類（含附件、促銷、社群、系統更新、垃圾桶）與關鍵字篩選。
   - 顯示信件主旨、寄件者、預估容量與收到天數，支援批次移至垃圾桶或透過 `batchDelete` 批次永久刪除。
4. **免憑證模擬展示模式（Demo Mode）**
   - 尚未申請 Google Cloud 憑證前，可於首頁點擊「進入模擬展示模式體驗」，立即測試所有篩選、天數統計與刪除流程。

---

## 快速啟動方式

> **注意**：Google OAuth 2.0 安全規則不允許直接雙擊開啟 `index.html`（`file://` 協定）。請務必透過本地伺服器存取 `http://localhost:8080`。

1. 雙擊資料夾內的 **`啟動雲端清理工具.bat`**。
2. 系統將啟動本地 Python 伺服器並自動開啟瀏覽器前往 `http://localhost:8080`。
3. 或於終端機執行：
   ```bash
   cd c:\AI\google
   python server.py
   ```

---

## Google 雲端硬碟與 Gmail 登入操作 — 一步一步教學

（本教學內容亦完整內建於網頁的「登入教學」分頁中）

### 步驟 01：建立 Google Cloud 專案
1. 前往 [Google Cloud Console](https://console.cloud.google.com/) 並登入您要清理的 Google 帳號。
2. 點擊上方專案選擇器，點選「**新增專案（New Project）**」。
3. 填入專案名稱（例如 `MyDriveCleaner`）並點擊「建立」，完成後切換至該專案。

### 步驟 02：同時啟用 Google Drive API 與 Gmail API
1. 在左側選單點擊「**API 和服務**」→「**程式庫（Library）**」。
2. 搜尋 **`Google Drive API`**，點進去後按「**啟用（Enable）**」。
3. 返回程式庫，再次搜尋 **`Gmail API`**，點進去後按「**啟用（Enable）**」。

### 步驟 03：設定 OAuth 同意畫面與加入「測試使用者」
1. 在左側選單開啟「**Google Auth Platform**」（或舊版「OAuth 同意畫面」），點擊「開始設定」。
2. **使用者類型**：選擇「**外部（External）**」（一般個人 `@gmail.com` 帳號皆選此項）。
3. 填寫應用程式名稱（例如 `Drive and Gmail Cleaner`）與支援電子郵件（輸入您的 Gmail），聯絡資訊亦填入您的信箱後儲存。
4. 點選左側「**目標對象（Audience）**」，在「**測試使用者（Test users）**」區塊點擊「**新增使用者**」，務必將您要登入清理的 Gmail 地址加入清單。
   - **重要提示**：若未加入測試使用者，登入時會出現 `Error 403: access_denied`。

### 步驟 04：建立「網頁應用程式」OAuth 用戶端 ID
1. 在左側選單點選「**用戶端（Clients）**」（或「憑證」→「建立憑證」→「OAuth 用戶端 ID」）。
2. 應用程式類型選擇「**網頁應用程式（Web application）**」。
3. 在「**已授權的 JavaScript 來源（Authorized JavaScript origins）**」點擊「新增 URI」，填入：
   ```text
   http://localhost:8080
   ```
   （請確認網址結尾**沒有**斜線 `/`）
4. 「已授權的重新導向 URI」保留空白即可，點擊「建立」。
5. 複製產生的 **用戶端編號（Client ID）**（結尾為 `.apps.googleusercontent.com`）。

### 步驟 05：在網頁輸入 Client ID 並登入授權
1. 開啟 `http://localhost:8080`，切換至「**登入教學**」分頁或首頁右側快速設定卡。
2. 貼上您的 Client ID 並點擊「**儲存 Client ID**」（僅存於您的本機瀏覽器 `localStorage`）。
3. 點擊「**立即登入 Google 帳號**」，選擇您的測試帳號。
4. 遇到「Google 尚未驗證這個應用程式」畫面時，點擊左下角「**進階（Advanced）**」→「**前往應用程式（不安全）**」。
5. 在權限授權畫面中，請務必勾選允許存取「Google 雲端硬碟」與「Gmail 讀取及永久刪除」的核取方塊，按下「繼續」即可開始清理。

---

## 檔案結構

- `index.html`：主網頁介面（包含總覽、雲端硬碟清理、Gmail 清理、一步步登入教學分頁與確認對話框）
- `styles.css`：深色極簡視覺樣式表與動態系統
- `app.js`：OAuth 2.0 認證、Drive API v3 與 Gmail API v1 操作及模擬展示模式邏輯
- `server.py`：Python 本地 HTTP 靜態伺服器（預設綁定 `http://localhost:8080`）
- `啟動雲端清理工具.bat`：Windows 一鍵啟動腳本
- `README.md`：專案與登入操作說明文件
