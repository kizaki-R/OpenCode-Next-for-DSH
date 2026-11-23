# OpenCode-Next（`dsh-opencode-oauth`）

DeepSeek Harness（DSH）的 OpenCode OAuth 與 OpenCode Go 提供者外掛。

> 衍生自 [FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh)。為維持既有設定檔、帳號與歷史紀錄相容，內部套件與 provider 識別碼（`dsh-opencode-oauth`、`opencode-oauth`、`opencode-go-subscription`）維持不變。

直連 OpenCode 官方推論端點（`/inference/openai/v1` 與 `/inference/go/v1`），避免舊版 `/zen` 匿名通道的 403 `FreeTierError` 與單一 IP 429 限流。

---

## 主要功能

1. **雙軌 OAuth 認證**：
   * **自動繼承**：若本機已登入 OpenCode Desktop，外掛啟動時會讀取 `~/.local/share/opencode/opencode.db` 取得憑證，不需重複輸入帳號密碼。
   * **獨立裝置碼登入**：未安裝 OpenCode Desktop 時，執行 `dsh-opencode-login`，於瀏覽器確認「Approve」即可完成授權並保存憑證。
2. **官方正式推論通道**：
   * 免費通道送往 `https://opencode.ai/inference/openai/v1/chat/completions`，使用個人帳號配額，不再依賴受限的 `/zen` 匿名路徑。
3. **推理串流（Reasoning & Text）**：
   * 將上游 `reasoning_content` 即時轉譯為 DSH `reasoning-delta` 分塊。
4. **完整工具呼叫（Tool Call）**：
   * 支援 DSH 檔案讀寫、指令執行等工具呼叫。
5. **模型自動探索與可用性偵測**：
   * 同步 `https://models.opencode.ai/api.json`：新模型須探測成功才公開，既有模型連續兩次模型級失敗才隱藏，明確 404／410 下架則立即隱藏，後續探測成功會自動恢復。
6. **圖形化設定頁**：
   * DSH 設定側邊欄提供「OpenCode-Next」分頁，拆分為「帳號」、「免費模型」、「進階」與「OpenCode Go」四個頁籤，可直接在介面管理登入、自訂選單模型、查看額度與探測狀態。
7. **v2 協議對齊與 Bun 原生傳輸**：
   * **自動偵測 Bun**：偵測到系統 `bun.exe` 時預設啟用 Bun 傳輸，並在「進階」頁籤顯示執行環境狀態。
   * **標頭與參數對齊**：自動注入 `x-opencode-org-id`、`x-opencode-project` 與 `max_completion_tokens`。
   * **工具名稱雙向映射**：請求送出前將工具名稱映射為安全別名，SSE 回傳時再還原為 DSH 原始工具名稱。

---

## 自動偵測可用模型

公開目錄列出的免費模型遠多於免費通道實際供應的數量：有些項目標記為
`status: "deprecated"` 卻仍正常回應，有些看似正常卻回傳 `Model is unavailable`。
因此公開目錄只做為候選清單，與 picker 的發布狀態分開。新模型必須探測成功才會
加入；已在 picker 的模型遇到一次可恢復的模型級失敗仍會保留，連續第二次失敗才
隱藏。明確的 404 `not-found` 與 410 `deprecated` 會立即隱藏；一般 400 的
`unavailable` 訊息不視為下架證據，仍採兩次失敗規則。後續探測成功會立即恢復模型，
並清除連續失敗計數。

背景會以兩種頻率運作：

| 工作 | 預設間隔 | 作用 |
| --- | --- | --- |
| 目錄輪詢 | 15 分鐘 | 重新抓取目錄，只探測新出現的免費模型 |
| 完整重新驗證 | 6 小時 | 重新探測所有候選，讓已下架的模型自動消失 |

探測結果、picker 發布清單與連續失敗計數會寫入
`~/.dsh/opencode-oauth.models.json` 並於重啟後沿用；舊版 v1 快取仍可讀取，新寫入的
快取會保存遲滯狀態。快取過期時會重新完整驗證，但不會先丟棄最後已知的 picker 狀態。

每次探測會發出真實的串流請求，並在收到狀態列後立刻取消：正常模型約
1–2 秒，失效模型約 0.3–1 秒，並以有限並行度執行。若免費通道遭阻擋或整輪結果
不完整，就不提交任何部分模型判定，也不更動可用狀態或失敗計數。單一模型的 403
`RegionError` 只視為模型級失敗，不會判定整條通道失效。

### 探測會提早停手，而且會告訴你停在哪

免費通道的每日額度很少，所以探測遇到以下兩種情況會立刻熔斷，不再送剩下的請求：

| 情況 | 為什麼停 |
| --- | --- |
| 任一模型回 `429`（限流／額度用盡） | 再送 40 幾個請求只會把當天額度一次燒完 |
| 通道本身不可達（`403` 風控、`401`、`5xx`、`402`） | 剩下每個請求都只會拿到同一個錯誤 |

熔斷後**未探測的模型保留上一次的判定**，不會被標成失敗。設定頁會顯示
「本輪只驗了 N/M」以及停手原因，並把這個狀態寫進快取，重啟後仍然看得到。
完整跑完的一輪會清掉這個標記。

看到「可用 13、但只有 4 筆探測紀錄」時，那不是資料損壞，而是第 4 個模型撞到
限流就收手了。等額度重置後再探一次，或先看那 13 個已知可用的模型。

### 額度什麼時候回來

上游 429 會帶 `retry-after` 標頭（實測 `5397`，約 90 分鐘）。此外掛會讀它並換算成
本地時間：

```
免費額度已用盡：額度預計今天 08:18 解除（約 1 小時 27 分後）。
```

上游沒給這個標頭時，畫面不會顯示任何時間——不猜。這比猜一個「大概五分鐘」
有用得多，因為猜錯只會讓你每五分鐘撞一次同樣的牆。

### 上下文長度與輸出上限

每個模型的容量由上游目錄決定，差距很大：

| 模型 | 上下文 | 最大輸出 |
| --- | --- | --- |
| `deepseek-v4.1-flash-free` | 200000 | 32000 |
| `beam-free` | 1048576 | 131072 |
| `minimax-m3.1-flash-free` | 1000000 | 512000 |
| `trinity-large-preview-free` | 131072 | 131072 |

設定頁可對單一模型覆寫上下文長度（點「上下文」欄的數字）。可填範圍是
`1024`–`100000000`，刻意開得很寬：真正的上限在上游，硬編一個小上限只會讓人
以為自己填錯。填超過上游上限時，上游回 `400 context-overflow`，外掛會提示
「請縮短訊息或壓縮後重試」，不會誤判成模型下架。

覆寫只影響 DSH 端的預算計算，不會提高上游的實際上限。

### 為什麼 effort 值要照抄目錄

上游會以 `400 [unsupported_value]` 拒絕不支援的 effort 值，且每個模型接受的
集合都不同（例如 `beam-free` 接受 `low` 到 `max` 但不接受 `minimal`，而
`deepseek-v4.1-flash-free` 只接受 `low`、`high`、`max`）。目錄把「不推理」
寫成 `none`，DSH 寫成 `off`，由 adapter 在送出時轉回。

---

## 📦 安裝至 DSH Profile

### 方式 1：本地目錄軟連結（推薦開發／直接使用）

在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的 `dependencies` 中加入：
```json
{
  "dependencies": {
    "dsh-opencode-oauth": "link:/path/to/OpenCode-Next-for-DSH"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-opencode-oauth"
      ]
    }
  }
}
```

### 方式 2：使用打包後的 tgz 安裝（推薦給其他電腦）

```bash
dsh plugin --profile desktop add ./dsh-opencode-oauth-0.9.5.tgz
```

> **改完程式碼要重新打包。** `npm pack` 只會裝進 `package.json` 的 `files` 白名單
> 所列的檔案，所以新增檔案（例如 `lib/ui.js`、`lib/failures.js`）之後若沒有重新
> 打包，其他電腦裝到的會是舊版——而且不會有任何錯誤訊息，只會「少了設定頁」或
> 「失敗分類沒生效」。
>
> 驗證方式：`npm test` 裡的 `test/package.test.mjs` 會把目錄內那份 tgz 解開，
> 逐檔與現在的原始碼做 SHA-256 比對，不一致就紅燈並列出是哪幾個檔案。這比事後
> 在別台機器上才發現少了檔案可靠得多。

### 方式 1 的路徑要改成該台電腦的位置

上面的 `link:` 路徑是**這台開發機**的路徑，直接複製到別的電腦會指向不存在的目錄。
在別台電腦請改成該機器的實際路徑，或直接用方式 2 安裝 tgz。

---

## 🔑 獨立登入（非桌面版環境）

若在沒有安裝 OpenCode Desktop 的新電腦上使用：
```bash
npx dsh-opencode-login
# 或
node bin/login.mjs
```
依照終端提示在瀏覽器打開授權連結，確認驗證碼後點擊同意。成功後會同時寫入：

* `~/.dsh/opencode-oauth.token.json`（舊版單一憑證檔，權限 `0600`）
* `~/.dsh/opencode-oauth.accounts.json`（帳號清單。已有相同憑證就不重複新增，並把該帳號設為目前使用中）

DSH 有帳號清單時會優先讀它。若 CLI 只寫舊檔，這次登入不會生效。每次 OAuth HTTP 請求有 15 秒逾時；授權被拒絕、代碼過期或整段等待逾時時，終端會印出原因，不會靜默結束。

---

## ⚙️ 設定選項（cordis.patch.yml）

預設零配置開箱即用。若需自訂，可在 `cordis.patch.yml` 加入：
```yaml
- id: dsh-opencode-oauth
  name: "dsh-opencode-oauth"
  config:
    providerId: "opencode-oauth"        # 在模型清單中顯示的 provider ID
    providerName: "OpenCode (OAuth)"    # 顯示名稱
    streamIdleTimeoutMs: 60000          # 串流靜默逾時（毫秒）
    autoDetectModels: true              # 設為 false 可固定使用靜態清單
    catalogPollMs: 900000               # 15 分鐘；設為 0 可停用新模型輪詢
    probeIntervalMs: 21600000           # 6 小時完整重新驗證
    probeCachePath: ""                  # 預設 ~/.dsh/opencode-oauth.models.json
    imagePixelBudget: 640000            # 800x800；超過此像素的圖片會先縮小
    imageMaxBytes: 2097152              # 每張投影後的圖片上限 2 MiB
```

`streamIdleTimeoutMs` 處理的是「免費通道回了 `200` 之後就完全沒動靜」的情況：連線
還開著，但一個 frame 都不來。沒有這個逾時，整個回合會一路卡到 TCP 逾時，而 DSH
這端也拿不到任何可以重試的錯誤。看門狗會直接中止底層的 fetch 並拋出 `TIMEOUT`，
這個代碼列在 `SAFE_RETRY_POLICY.retryableCodes` 裡。等待**第一個** frame 時採用
`DEFAULT_FIRST_EVENT_MS` 與此值的較小者。

`imagePixelBudget` 與 `imageMaxBytes` 限制交給附件服務的投影尺寸。這兩個值刻意固定
而不採動態調整：請求變體 ID 是「附件 + 這個目標尺寸」的雜湊，若目標每次呼叫都變動，
快取就會每一輪都失效。

---

## 🖥️ 設定頁（DSH 設定 → OpenCode OAuth）

開啟 DSH 設定頁，左側會多一個「OpenCode OAuth」分頁（排序 14），內容分成四區：

| 區塊 | 內容 |
| --- | --- |
| 標題列 | 健康狀態徽章（正常／即將過期／尚未探測／尚未登入／已過期／沒有模型回應）＋一句結論 |
| 授權狀態 | 憑證來源、到期時間、是否可自動更新；按鈕：重新驗證憑證／登入（或重新登入）／登出 |
| 模型 | 可用數／總數、探測時間、搜尋框、「只看有問題的」篩選、逐模型狀態／延遲／說明，以及每個模型的上下文容量設定 |
| 診斷資訊 | provider 識別碼、外掛版本、探測間隔、目錄輪詢、圖片像素預算與位元組上限 |

在模型列展開「上下文大小」，可選擇跟隨 OpenCode 目錄值或手動覆寫；「恢復預設值」會移除該模型的覆寫，不會發送探測請求。手動值會影響 DSH 收到的模型容量與預算，但不會提高上游實際上限，也不會更改 DSH 的壓縮策略。設定只保存模型 ID 與數字，位置為 `~/.dsh/opencode-oauth.context.json`（若設定 `DSH_HOME`，則存於該目錄）。

按下「登入」後，分頁會顯示裝置碼與驗證網址，並在授權完成前每 2 秒自動輪詢一次
（平時為 15 秒）。

### 憑證不會離開主機

設定頁會回報**憑證是否存在**與**何時到期**，但**永遠不會**把 access token 或
refresh token 送到瀏覽器，網頁端也不會接受任何祕密輸入。這是刻意的設計：
分頁在瀏覽器裡執行，把權杖放進去等於把它暴露給任何一個能讀取該頁面的腳本。

### 為什麼健康狀態的說明是本地翻譯的

主機端 `status.js` 產生的是固定中文句子；若英文介面直接顯示它，就會變成中英夾雜。
因此前端改以穩定的 `health` 代碼去查自己的字典，只有遇到不認識的代碼時才退回主機
字串。`test/render.test.mjs` 會斷言英文頁面不得出現任何中文字元，防止這個問題復發。

### 同時按下登入兩次只會產生一組裝置碼

「檢查有沒有一筆進行中的登入 → 向上游索取裝置碼 → 寫回進行中」之間有一個 `await`。
少了防護時，兩個幾乎同時到達的請求都會看到「沒有進行中的登入」，於是各自索取一組
裝置碼，後寫入的那組覆蓋前面那組——使用者照著畫面核准了第一組，而外掛追蹤的已經
是第二組，於是登入看似完成卻沒有憑證。這個症狀很難重現（表現成「登入有時候要按
兩次」），所以 `lib/web-api.js` 用 `deviceCodeRequest` 讓並行的第二個請求共用同一組
裝置碼，而不是自己也去要一組。

另外用 `loginGeneration` 記錄登入的世代：若使用者在等待期間按下登出，那個還卡在
`await` 的請求醒來後不會再把登入寫回去，也不會回傳驗證網址（否則前端會開一個早已
失效的驗證頁）。`test/race.test.mjs` 固定住這些行為，`test/race-mutation.test.mjs`
則會刻意把修正拿掉、確認那些檢查真的抓得到問題——一支永遠全綠的測試可能只是在空轉。

---

## 🧯 失敗分類

上游的失敗統一由 `lib/failures.js` 分類，並掛到丟出的錯誤上成為 `.failure` 快照——
因為執行階段只讀這個東西。

第三方 adapter **必須**附上 `.failure`，且 `failure.code` 要跟錯誤自己的 `code` 一致。
`normalizeLlmFailure` 只會在兩者相符時採用該快照，否則會用
`harnessErrorCode(error)` 重新組一個；而這個函式對「不是 `HarnessError` 的東西」一律
回答 `UNKNOWN`。也就是說，**單純的 `Error` 只要自己塞 `.code`，一律會被壓成
`UNKNOWN`**。這件事曾讓 watchdog 的 `TIMEOUT` 永遠對不上
`SAFE_RETRY_POLICY.retryableCodes`，文件上寫的重試行為其實是死碼。

同一個路徑上另外修了兩個缺陷：

- **`403` 沒有分流**：現在會讀回應主體的 `error.type`，把 `FreeTierError`（免費通道
  拒絕這個請求）與 `RegionError`（這個模型在此地區不可用）分開，兩者會給出不同的
  說明，而不是同一個籠統的認證失敗。
- **退路代碼是 `UPSTREAM`**，而它不在 DSH 的失敗代碼家族裡。路由是靠
  `HarnessError.code`，所以無法辨識的代碼不會被任何重試策略挑中；現在未對應的
  4xx 一律回報 `TRANSPORT` 加上 `http-<狀態碼>` 作為原因，既不重試也不丟失資訊。

---

## 🧪 驗證與測試

```bash
# 語法檢查
npm run check

# 完整測試套件（憑證、目錄、可用性探測、設定解析、失敗分類、外掛進入點、
# 設定頁、畫面渲染、併發競態、串流、工具調用、交付物完整性）
npm test

# 快速連線測試
npm run smoke
```

### 交付物完整性

`test/package.test.mjs` 盯的是「送出去的東西」而不是「磁碟上的原始碼」。這個區別
來自一個真實的疏漏：程式碼全部改好、測試全綠、實地端點也驗過，但 `npm pack` 產出的
tgz 是兩小時前的版本，缺了當天新增的四個檔案。別台電腦裝下去**不會有任何錯誤**，
只是沒有設定頁、失敗分類也沒生效。

會發生這件事是因為 `npm pack` 只裝 `files` 白名單內的檔案，而開發機是用 junction
把原始碼掛進 profile——**本機跑的是即時原始碼，別人跑的是 tgz**，兩者會無聲分岔。
所以這支測試會逐檔雜湊比對目錄裡那份 tgz 與現在的原始碼，不一致就紅燈並提示重新
打包。它同時檢查 `exports["./client"]` 與 `dsh.client` 指向的檔案真的會進包，以及
包內沒有硬編碼的磁碟路徑。

`test/config-layers.test.mjs` 另外驗證 `lib/config.js` 取得 `schemastery` 的三層
退路。三層都不會報錯，所以壞掉時症狀很隱蔽：外掛照樣載入、預設值照樣正確，只有
欄位層級的驗證（`min`/`max`）靜默消失。測試用「超出下限的值會不會被擋下來」分辨
目前載入的是真的驗證器還是內建的 stub，並確認第二層改用 `DSH_HOME` /
`DSH_PROFILE_DIR` 推導 profile 目錄，而不是把開發機的使用者名稱編進出貨的檔案。

---

## 免費配額與出口 IP

OpenCode 免費模型的 `Free usage limit reached` 主要依**網路出口 IP**（以及工作區／組織）計算。同一出口上，換帳號、換新設備或刷新 Token **不會**解除已耗盡的配額。能做的是等滾動視窗重置，或改用你自己控制的另一個出口網路。這不是換帳號就能繞過的限制。

帶有約 48,000 秒 `retry-after` 的偽裝限流，與上面這個真配額不同。前者已用 Bun 傳輸與官方請求形狀對齊處理；後者換傳輸也解不了。

## Bun

免費通道會拒絕 Node.js 送出的請求。此外掛使用系統裡另外安裝的 Bun，OpenCode Desktop 本身不附 `bun` 執行檔。

1. 到 [bun.sh](https://bun.sh) 安裝。
2. 打開 DSH 設定 → OpenCode OAuth → 進階。
3. 若顯示未安裝，按「重新檢測」。不用重啟 DSH。

偵測只接受出現在系統 PATH 上的絕對路徑，避免工作目錄裡的同名執行檔被拿去跑。

## 範圍探測

模型表的探測按鈕會跟著目前篩選變：

| 畫面 | 按鈕 | 行為 |
| --- | --- | --- |
| 全部、沒有搜尋 | 重新探測 | 探測候選清單 |
| 「可用」 | 探測可用 (n) | 只探測目前看得到的模型 |
| 其他篩選或搜尋 | 探測清單 (n) | 同上，只送出可見的 `modelIds` |

結果是增量合併。這次沒探測到的模型，其延遲、可用狀態與歷史紀錄會留在 `~/.dsh/opencode-oauth.models.json`。切換帳號或重啟 DSH 不會清掉這份快取。篩選（例如停在「可用」）記在這個瀏覽器的 `localStorage`。

上下文長度不要在列上展開。點該列「上下文」的數字（例如 `200k`）會開啟獨立視窗。

## 從 OpenCode Desktop 匯入

設定頁帳號區有「從 OpenCode Desktop 匯入」。它只讀 Desktop 的登入狀態，不改 Desktop 的資料庫。同一組憑證再按一次不會新增重複帳號，只會切到已存在的那筆。本機只有 API key 時會拒絕，因為免費通道不接受 API key。

## 匿名通道

進階設定裡的「匿名通道」預設關閉。打開後，推論請求不帶個人 Token，走 OpenCode 沒有承諾會一直保留的公開匿名通道。它可能隨時失效或被限流，而且仍然受出口 IP 約束。只有接受這個風險時才打開。

## OpenCode Go（訂閱資格驗證、模型目錄與文字／工具推論）

本外掛內建獨立、預設關閉的 `opencode-go-subscription` provider 接點（`goSubscription.enabled` 預設為 `false`），不會影響既有免費 `opencode-oauth` 的模型清單、登入、設定、快取或通道行為：

- **獨立憑證解析與設定頁管理**：使用 OpenCode Console Personal API Key，優先透過 DSH 安全憑證服務（`goSubscription.credentialRef`，預設 `OPENCODE_GO_API_KEY`）解析，不可用時退回環境變數。可在「設定頁 → OpenCode Go」透過密碼欄位直接呼叫 `ctx.credentials.set`／`ctx.credentials.unset` 儲存或清除金鑰（不預填明文、只顯示已儲存或未設定；若目前 DSH 行程不支援 `credentials.set`，按鈕會保持停用，絕不改寫進外掛設定或 JSON 檔案）。不沿用 OAuth token（`st_*`）或 `org_id`，不自動匯入其他外掛憑證，且不將明文 key 寫入一般設定、狀態 API、錯誤或日誌。
- **官方唯讀端點**：以 Bearer key 依序查詢 `GET https://opencode.ai/inference/go/v1/usage` 驗證訂閱資格與 `GET https://opencode.ai/inference/go/v1/models` 取得工作區模型目錄，固定 `https://opencode.ai` 目的地且不跟隨重新導向。換 key 或停用時會清除獨立快取（`~/.dsh/opencode-go.cache.json`）並阻擋舊請求回寫。
- **文字串流與工具呼叫**：推論固定送往 `POST https://opencode.ai/inference/go/openai/v1/chat/completions`（`redirect: 'manual'`、`stream_options.include_usage`），`x-opencode-session` 必須來自 DSH 實際會話 ID（缺漏直接拒絕）。不沿用 CLI 身分標頭、Bun 請求改寫、工具別名或假工具；不自動換帳號、不跨 provider 退回、不自動重送計費請求，並分開保留 `usage.cost`、`usage.opencode.billing_source` 與 `usage.opencode.allowance`（未提供維持 `null`，不當成 `0`）。
- **啟動自動載入、額度圖表與自訂 Go 選單**：儲存 Personal API Key 後，DSH 啟動（包含 `credentials` 服務延遲注入完成時）會在背景自動查詢唯讀 `/usage` 與 `/models` 並同步選單，不消耗推論額度。OpenCode Go 分頁提供 `5h Limit`、`7D Limit`、`1M Limit` 進度條、可收合的「金鑰」管理抽屜，以及左側「顯示」勾選欄（持久化於 `~/.dsh/opencode-oauth.go-picker.json`）。
- **正式選單門檻與依目錄自動圖片支援**：僅結構合格且狀態有效之 Go 對話模型會進入正式選單。圖片輸入（透過 DSH `attachments` 服務轉成 `image_url` data URI）會依上游 Go 目錄宣告自動開放給 `modalities.input` 含 `image`／`image/*` 的入選模型（含未來上架的新視覺模型，實際可否辨識以上游端點為準）；未宣告圖片輸入或模態未知之模型維持純文字，於附圖送出前直接拒絕（絕不靜默丟圖繼續送純文字，也不退回免費 OAuth），且不開放影片、音訊或 PDF 等其他檔案附件。

## 🚦 發布紀律：1.0.0 必須先取得明確同意

**不要自行升到 1.0.0。** 測試全綠不是發布決策。要達到 1.0.0，得先開口問，
而不是自己推論。

這條規則來自一次真的犯過的錯：測試全過之後就直接升上 1.0.0，但當時稽核裡還有
兩項沒做，而且設定頁從來沒有人實際看過畫面。測試從頭到尾都是綠的——它證明的是
「預期的行為沒壞」，這跟「這東西可以發布」是兩個不同的主張。

升 1.0.0 之前，必須與使用者逐項確認這四件事：

1. **講好的項目全部完成。** 不是「測試過關」，是實際的範圍，包含過程中先擱下的
   部分。
2. **有人真的看過畫面。** 測試驗證的是投影出來的文字，抓不到排版、顏色、
   溢出。這台機器上 DSH 桌面版會用驗證權杖擋住 GUI，代理程式開不進去——
   只能由使用者看，並且明說看過了。
3. **改動之後真的有實際用過。** 尤其是錯誤訊息與健康狀態這種「只有在失敗那一刻
   才看得出來」的改動。
4. **使用者親口說要升 1.0.0。** 不是「弄好就改」，也不是「都弄好了就改」——
   那是條件句，而條件有沒有成立不該由代理程式自己認定。

1.0.0 以下的版本可以自行調整，不需要先問。版本檢查請只驗證 semver 格式、
不要鎖死特定數字——鎖死會讓那條測試變成「改到它變綠為止」。

---

## 📄 授權條款與來源聲明
MIT License © 2026（見 [LICENSE](./LICENSE)）。本專案衍生自原作者 [FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh)（`Copyright (c) 2026 FishBottle7`），並保留內部識別名稱以維持既有用戶設定相容。
