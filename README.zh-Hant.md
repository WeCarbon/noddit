[English](README.md) · [简体中文](README.zh-Hans.md) · **繁體中文** · [Français](README.fr.md) · [العربية](README.ar.md)

# Noddit

*Where you and your AI hand work to each other.*

你把一件兩小時的工作交給一個 AI 代理——或者五個 AI 代理，各管一塊——然後就不
管了。一小時後，其中三個卡在一個問題上，等在你沒盯著的對話視窗裡，你連哪個
還在跑都分不清。

**Noddit 給你的 AI 代理一個地方放工作和問題，給你一個畫面看著全部。AI 代理
發問，你按一個鍵回覆，AI 代理當場收到通知，接著往下做。**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/WeCarbon/noddit/main/docs/app.zh-Hant.dark.png">
  <img alt="Noddit 桌面 app：「可用」視圖，打開一個待決策問題，兩個選項是卡片，還有進度條和一條等 AI 來接的新任務" src="https://raw.githubusercontent.com/WeCarbon/noddit/main/docs/app.zh-Hant.png">
</picture>

<sub>桌面 app——<a href="https://github.com/WeCarbon/noddit/releases/latest">下載 macOS、Windows、Linux 版</a></sub>

![示範：nod 看板一打開就是一棵進行中的任務樹；讀一個待決策問題，按一個鍵回覆，然後 agent 用 nod read 取走回覆](https://raw.githubusercontent.com/WeCarbon/noddit/main/docs/demo.gif)

<sub>在終端機裡</sub>

## 為什麼

| 沒有 Noddit | 有了 Noddit |
|---|---|
| AI 代理在對話裡問「A 還是 B？」，你沒看到，它就等一個小時。 | 所有待決問題都在一個畫面上，卡住 AI 代理的排在最前面。 |
| 你答了，答案捲走了，下一個工作階段根本沒看到。 | 問題和你的回覆是 git 裡的一個 markdown 檔案，永久留著。 |
| 「你在做什麼？到哪了？」——你只能問，還得打斷它。 | 每個任務都帶進度條；不動了先變灰，再變紅。 |
| 五個 AI 代理共用一個 `TODO.md`，挑中同一個編號，互相覆蓋。 | 每個任務是自己的檔案、自己的編號；多少個 AI 代理同時寫都行。 |
| 你一離開，一切就停了。 | 每個問題都帶預設值，寫清楚不答會怎樣；AI 代理照常做別的事。 |

它不是用來排計畫的任務板。它是一條線，連著執行中的 AI 代理和你：它的問題
傳到你這裡，你的回覆傳回它那裡，兩邊都留得住。

## 看起來是這樣

1. AI 代理碰到一個選擇。它不在對話裡問，而是執行：

   ```sh
   nod ask W4 -o 1="Keep current CDN" 2="Switch to Fastly" --default 1
   ```

2. 你在任意終端機執行 `nod`。W4 排在最上面，標著 ◆ 待決，帶著兩個選項和
   各自的代價。

3. 你按 `2`。

4. AI 代理立刻收到通知，讀到「Switch to Fastly」，接著往下做。問題和你的
   回覆都留在 `decisions/active/4-pick-cdn.md` 裡，進了 git。

## 快速開始（Claude Code）

```sh
npm i -g @wecarbon/noddit
cd your-project && nod init
```

然後，在 Claude Code 裡：

```
/plugin marketplace add wecarbon/noddit
/plugin install decs@decisions-md
```

就這樣。照常給 AI 代理派任務。它會自己用 nod 記錄工作、提出問題。在另一個
終端機執行 `nod` 看著就行。

用別的 AI 代理？把 [`AGENTS.md`](AGENTS.md) 貼進它的指令——這些規則都是普通的
CLI 呼叫，任何能執行終端機的 AI 代理都能照著做。

## 三個詞

- **節點** —— AI 代理正在做的一件事。一個 markdown 檔案。
- **待決** —— 一個需要你回覆的節點。它帶著選項出現；按一個數字就行。
- **看板** —— 執行 `nod` 看到的那個畫面。全部內容，即時的。

這就是開始要知道的全部。剩下的內容講的是它底層怎麼運作。

---

## 想法

一種東西——**節點**——一個編號空間。

節點是 AI 要做的一件事。AI 代理自己知道怎麼做，就直接做。需要先問負責人的，
節點就變成**待決策**，帶著選項、預設值，以及沒人回答會怎樣。一個正在執行的
節點碰到問題，不會另開一筆新記錄，它自己就變成一個問題，回答之後再變回執行中。

```
decisions/
  decs.json                                  # {"letter": "W"} → refs 讀作 W12
  active/12-ship-v2-4.md                     # 一個還在進行的根節點
  active/12-ship-v2-4/13-run-test-suite.md   # 子節點住在父節點的資料夾裡
  archived/9-rotate-api-keys.md              # 完成或關閉的，永久保留
  attachments/12/after.png
  .ids/12                                    # 零位元組的占位檔（O_EXCL）
```

每個節點都是獨立檔案，編號用 `O_EXCL` 占位，所以任意數量的 AI 代理都能同時寫，
不會互相覆蓋。因為全是 git 裡的 markdown，歷史、diff、review、grep 全部不用
額外花力氣。

## 你會得到什麼

**給人用的——看板。** `nod bench` 是一個涵蓋你註冊過的所有專案的即時終端
UI。六個分頁：

| 分頁 | 顯示什麼 |
|---|---|
| **可用** | 現在能動的：執行中、在等人、可以開始、需要你決定、已經回答了 |
| **活動** | 正在發生的：只有執行中和待決策的 |
| **人類工作** | 等你處理的：需要你決定的問題，加上你自己的待辦——卡住 AI 代理的那些排最前面 |
| **等待** | 卡在外部的：同事、客戶、某個服務，等得最久的排最前面 |
| **即時** | 任何人改動過的全部節點，最新的排最前面，完成的也算 |
| **全部** | 全部節點，完成的折進一行 `✓ 已完成 N` |

左邊是帶進度條和「多久沒動」標記的節點樹（超過 30 分鐘沒更新變灰，超過一小時
變紅）。右邊是選中節點的詳情：狀態、緊急程度、*「你不回的話會怎樣」*、父節點、
依賴、正文、附件。按 `1`–`9` 回覆，`Enter` 取預設值。截圖在終端裡直接渲染
（iTerm2、kitty、Ghostty、WezTerm）。

**給 AI 代理用的——一套 CLI 和一份約定。** AI 代理建節點、拆成子節點、回報進度、
問問題，也會收到你回覆的通知：

```sh
nod add "Ship v2.4" --task --author "lead · release"          # → W12
nod add "Run full test suite" --task --parent W12 --after W14
nod start W13
pytest | nod progress --parse pytest                           # 進度條自己走
nod ask W15 -o 1="Short & playful" 2="Plain & direct" --default 2 <<'EOF'
**What.** The first screen new users see after sign-up …
EOF
```

**人類工作，和 AI 的工作並排放著。** `nod add <title> --for me` 替你自己
派一件待辦，不是給 AI 的——沒有 AI 代理會啟動它、來問它的進度，或是把它
當成一則待展開的派工。`nod assign <id> me|ai` 可以之後把一個節點在兩者
之間移動。看板的**人類工作**分頁把兩種都列出來：等你決定的問題，加上你
自己的待辦，卡住 AI 代理的排最前面。

**里程碑。** `nod add <title> --milestone`（或是 `nod assign <id>
milestone`）把一個節點標成一個目標，下面掛著子目標和具體的工作——這是一個
階段，不是一項任務。它從不自己啟動或完成；看板上顯示成 `⚑`，帶著子節點的
完成/總數，也不需要 `--due`，不過你還是可以給它一個。

**到期日、預估、重複週期。** 在 `nod add` 或 `nod edit` 上加 `--due <date>`
給任何節點訂一個截止日期——過期了就在看板和 app 裡變紅。`--est 2h` 記下這
項工作花誰的時間：你自己的待辦算你的時間，其餘算 AI 的；父節點會把子樹裡
兩邊各自加總。`--every 3d` 給一個節點自己的週期，這樣 `nod defer --every`
（或是看板上的 `D`）就會把它延後到今天加上這個週期，不用每次手動輸入日期。

**提醒是 AI 的工作，不是你的。** `nod add --remind "fri 2pm"`（或是
`nod edit --remind`）在那個時刻給 AI 排一項普通任務——它從不跟選項、派工
或 `--for` 混在一起。到了時間，`nod monitor` 會告訴那個節點自己的 AI 代理
一次，帶著下一步該做什麼（先告訴負責人，再 `nod done`）；桌面 app 也會
提醒你。

**不用輪詢的通知。** `nod monitor` 每行印出一件 AI 代理要處理的事——負責人的
回答、一則回覆、外部來源的新項目、五分鐘沒人收走的答案——而且記得每個
工作階段看到哪裡了。它靠檔案系統事件叫醒自己，不是計時器，所以不用等下
一輪輪詢。Claude Code 外掛會在整個工作階段期間自動啟動一個
（`nod monitor --here`，只盯目前的專案）；連續兩小時沒事件會自己下線，印出
一行 `DECS-IDLE`。子 AI 代理，或是 `DECS-IDLE` 之後的工作階段，用 Claude Code
的 Monitor 工具自己掛一個：

```
Monitor({ command: "nod monitor --mine", description: "nod", timeout_ms: 1800000 })
```

一則回覆或記錄超過一兩行，就要帶 `--summary`；通知、回覆卡片的標題、看板裡
顯示的都是這一句，不是全文。

**依賴與順序。** `--after W13` 會把一個節點擋住，直到 W13 完成。你還是可以
提前回答問題；節點會以**待開始**的狀態等著，輪到它才開始。

**外部來源，按自己的排程同步。** 把一個很薄的轉接器接到 GitHub issue、
Azure DevOps、客服信箱或意見表單上。它只同步*參照*（編號 + 標題，可選
url / 狀態 / 來源），絕不同步正文，絕不同步憑證。註冊的時候帶上
`--sync-cmd "..." --every 10m`，你自己正在跑的 `nod monitor` 就會按這個
間隔自己跑同步——這條指令只存在你本機上（`~/.decs/source-sync.json`），
不進儲存庫，所以複製這個儲存庫的人不會執行到任何指令。看板的標題列會按
來源告訴你清了沒、卡在誰手上：

```
外部來源 github-issues ✗ 未處理 2 等 W7 1   support-inbox ✓清了
```

**替任何要發出去的東西加上核准關卡。** 用 `--approval-content` 附上一份草稿，
nod 會記下它的 sha256。送出前，AI 代理跑 `nod approved W20 --check draft.html`
——除非*你*專門為*這份內容*選過核准選項，否則就不會通過。AI 代理把對話裡的
「發吧」當成你的核准是行不通的。

**延後。** 在任何東西上按 `d` 讓它從眼前消失。它會離開各個工作檢視，但狀態
不變；正在做它的 AI 代理會收到「負責人延後」，解除之前先別動它。

**一次對多個節點動手。** 在看板上按 `Space` 標記一行；標記了任意幾個之後，
同樣那些單節點的鍵——延後、啟動、換人、標重要、歸檔——會對全部標記的節點
一起生效。桌面 app 裡 `⌘`-點、`⇧`-點或是拖一個框也是一樣的效果，app 還會
同步在原地改標題/描述、縮放和平移圖片、內嵌預覽 Markdown/HTML——這兩個
介面具體對應到哪裡，見下面的[開發](#開發)。

## 安裝

需要 Node 22.18+（TypeScript 直接執行，沒有建置步驟）。

```sh
git clone https://github.com/wecarbon/noddit.git
cd noddit && npm install
export PATH="$PWD/bin:$PATH"          # add to your shell profile

cd ~/code/your-project
nod init --letter W                  # creates decisions/, registers the project
nod add "Try nod" --task --author "me · kicking the tyres"
nod                                  # the bench (same as nod bench); q to quit
```

### 搭配 Claude Code

這個專案同時是一個 Claude Code 外掛市集。外掛會在每個工作階段開頭注入使用
規則（外加專案裡還開著的節點，讓恢復的工作階段能接著自己的工作做下去），
替整個工作階段啟動一個 `nod monitor`，讓你的回覆不用輪詢就能傳到 AI 代理，
還會提醒 AI 代理在回覆之前，先把你在對話裡說的話記到對應節點上。

```
/plugin marketplace add wecarbon/noddit
/plugin install decs@decisions-md
```

（`/plugin marketplace add /path/to/noddit` 對本機的複本也適用。）

完整的 AI 代理用法在 [`AGENTS.md`](AGENTS.md)——如果你用別的 AI 代理框架，直接
把它貼進你自己的 `AGENTS.md` / `CLAUDE.md`。這些規則都是 CLI 呼叫，任何能跑
終端機的 AI 代理都能照著做。

## 語言

`nod` 按下面的順序選介面語言：

1. 任何指令上的 `--lang <code>`，比如 `nod bench --lang fr`
2. `NODDIT_LANG` 環境變數（舊名字 `DECS_LANG` 也還認）
3. `nod config lang <code>`——按使用者存在 `~/.decs/config.json`（也就是
   `$NODDIT_HOME/config.json`）。單獨跑 `nod config lang` 會顯示目前的語言和
   它從哪裡來；`nod config lang --off` 會移除這項設定。
4. 系統語言設定（`LC_ALL` / `LC_MESSAGES` / `LANG`，忽略 `C` / `POSIX`）：
   `zh_CN` → `zh-Hans`，`zh_TW` / `zh_HK` → `zh-Hant`，`fr_*` → `fr`，
   `ar_*` → `ar`
5. 這些環境變數都沒設的時候，用作業系統的顯示語言——純 Windows 終端（cmd、
   PowerShell）就沒有這些變數，nod 會依 Node 的 `Intl` 讀到的結果來決定
6. 否則就是英語——nod 沒有對應翻譯的語言，也會落到英語

可用代碼：`en`、`zh-Hans`、`zh-Hant`、`fr`、`ar`。外掛的提示提醒遵循同一套
解析邏輯；工作階段開頭注入的規則（`plugin/rules.md`）不論介面語言都是英文。

阿拉伯語是從右往左排的。`NODDIT_BIDI=visual|terminal`（舊名字 `DECS_BIDI`
也還認，或 `nod config bidi visual|terminal`，`--off` 移除）決定怎麼排：`visual`
（預設）是 nod 自己用 Unicode 雙向演算法重新排每一行，給那些只會嚴格從左往右
畫面的終端用（例如 macOS 內建的 Terminal）；`terminal` 是 nod 按邏輯順序寫，
把嵌在裡面的從左到右片段（像 W12 這樣的參照、數字、指令、英文標題）包進
Unicode 隔離符，給自己處理雙向排版的終端用（開了 bidi 的 iTerm2、kitty、
基於 VTE 的終端）。阿拉伯語下看板本身也會鏡像：清單在右邊，詳情在左邊。
輸出到管線和 `--json` 永遠是邏輯順序，腳本和 AI 代理讀到的不受影響。相對時間
（「3 天前」這種）也跟著語言走。

磁碟上的檔案格式不會跟著語言變：nod 永遠寫同一批標題和詞（`## 选项`、
`### 1 · …`、`## 已答（…）`、`## 回复（…）`、`## 补充（…）`、`## 附件`、
`## 子问题`、`验收通过`……），這樣不管團隊裡每個人的 CLI 說什麼語言，專案都能
讀。手動寫檔案時，剖析器也認得 `## Options`、`## Attachments`、`## Questions`
這幾個英文寫法。見下面的[檔案格式](#檔案格式)。

## 一次工作階段是怎樣的

1. 你給主控工作階段一個目標。它跑 `nod add "Ship v2.4" --task`，啟動它，再拆成
   帶 `--after` 依賴關係的子節點。
2. 它把各條工作線（子 AI 代理）分出去，各帶自己的節點。每條工作線把長指令接進
   `nod progress`，看板上的進度條自己走。
3. 一條工作線走到分岔口。它跑 `nod ask <id> -o …`，帶著選項、代價和預設值。
   節點在你的看板上變成黃色的 `◆`。
4. 你按 `2`。`nod monitor` 叫醒那條工作線，它跑 `nod read`，接著做，最後
   `nod done <id> --note "412/412 passing"`。
5. 你從來不用問「現在到哪了」——下週，整個故事還在 `decisions/archived/` 裡。

## CLI 速查表

| | |
|---|---|
| `nod init [--letter W]` | 在這裡建 `decisions/` 並註冊專案 |
| `nod add <title> [--task] [-o 1=… 2=…]` | 新建節點；帶選項就是待決策。正文來自 stdin |
| `nod add <title> --parent W12 --after W13` | 子節點，排在另一個之後 |
| `nod start / done / close <id>` | 待開始 → 執行中 → 已完成 / 已關閉（`--reason obsolete\|superseded\|merged-into:W15`） |
| `nod ask <id> -o 1=… 2=…` | 執行中的節點需要負責人拍板 |
| `nod hold <id> --on "Carol: icon set" --until fri` | 在等外部某人（積極延後，紫色）；不算卡住——同 `nod defer --on` |
| `nod add <title> --for me` · `nod assign <id> me\|ai` | 替自己派一件待辦，不是給 AI 的——列在**人類工作**裡 |
| `nod add <title> --milestone [--due …]` | 一個目標，下面掛子目標，從不自己啟動或完成 |
| `nod edit <id> --due <date> --est 2h --every 3d --remind "fri 2pm"` | 到期日 · 花誰的時間 · 重複週期 · AI 的提醒 |
| `nod progress <pct> "msg"` · `… \| nod progress --parse pytest` | 回報進度（或者讓管線自己回報） |
| `nod steps <id> "a" "b" "c"` · `nod step <id> 2` | 多步驟的工作，百分比幫你算好 |
| `nod note <id> "…" [--summary "…"]` | 追加一筆記錄（預設是 AI 代理；`--human` 給負責人用）；超過一兩行就要帶摘要 |
| `nod push <id> 2 [--note …]` | 記一筆回答 |
| `nod monitor [--mine] [--here] [--idle-exit 2h]` | AI 代理的通知串流 |
| `nod read <id>` · `nod queue` | 收走回答 / 看還有哪些沒收 |
| `nod attach <id> file [--approval-content --approve-on 1]` | 附上一個檔案；可以掛上核准關卡 |
| `nod approved <id> --check <file>` | 只有這份內容被核准過才會退出 0 |
| `nod defer <id> [--until <date>]` · `nod undefer <id>` | 延後到某天或先放著（消極延後，灰色）/ 解除延後 |
| `nod show [open\|active\|deferred\|…] [--stale]` · `nod tree` · `nod get <id>` | 讀這個儲存區 |
| `nod search <words> [--all]` | 標題、正文、記錄、附件名稱 |
| `nod source register/sync/push/list/items/ack` | 外部來源 |
| `nod changes --since <t>` | 游標之後的一切，方便接上進度 |
| `nod bench [.\|<dir>…] [--view decide]` | 即時畫面 |
| `nod` | 在終端機裡等於 `nod bench`；接管線或在腳本裡時印出用法 |
| `nod config [<設定> [<值>\|--off]]` | 你的設定：lang、bidi、view、images、mouse、idle-exit、unclaimed-after（看板裡按 `,` 也能改） |

編號可以寫成 `305`、`W305`（專案字母）、`web:305`（專案名稱），或是舊式的
`D305`。`nod <command> --help` 有其他細節。

## 看板快捷鍵

| 鍵 | |
|---|---|
| `↑` `↓` | 移動 |
| `←` `→` · `-` `+` | 折疊 / 展開（跨工作階段記住） |
| `Tab` `Shift-Tab` | 切換檢視 |
| `1`–`9` · `Enter` | 回覆 · 取預設值 |
| `w` | 跳到下一個卡住 AI 代理的節點 |
| `g` 或 `:` | 跳到一個編號 |
| `Ctrl-L` | 跳到跨專案的主要 AI 代理，離線就啟動一個 |
| `N` | 回覆但不決定（節點回到 AI 代理手上） |
| `d` | 延後 / 解除延後 |
| `@` | 換人：你的待辦 ↔ AI 的 |
| `m` | 切換這個節點是不是里程碑 |
| `Space` | 標記 / 取消標記一行；標記了任意幾個，`d D s @ ! A` 會對全部生效 |
| `X` · `A` | 帶理由關閉 · 標記看過並歸檔 |
| `M` | 挪動模式：↑/↓ 在同一個上層下面（清單裡是同一組）挪，⏎ 結束；app 裡直接拖 |
| `i` · `o` | 挑選並檢視圖片 · 開啟一個附件 |
| `j` `k` `Ctrl-F` `Ctrl-B` | 滾動詳情面板 |
| `Z` · `?` · `q` | 精簡正文 · 所有快捷鍵 · 離開 |
| `,` | 設定（語言、從右到左文字、滑鼠等） |

滑鼠也能用：點分頁、節點、選項或附件；滾輪滾動滑鼠所在的那個面板。

## 檔案格式

節點是帶 YAML 檔頭的 markdown。人可以在任何編輯器裡讀它；AI 代理和
看板都走 CLI，由它處理鎖定和歷史。

```markdown
---
id: 1
title: Choose a CDN
author: lane-perf · static assets
status: needs_decision
created: 2026-03-14T10:12:03+00:00
urgency: high
default: "1"
if_no_answer: stay; re-measure Friday
reversible: true
---

**What.** Static assets are served from one region.

**Why now.** APAC p95 doubled last week.

## 选项

### 1 · Stay on current CDN

### 2 · Move to edge provider

## 补充（agent · lane-perf · static assets · 2026-03-14 10:20:41）

Measured again: 1.9 s p95 from Singapore.
```

這些標題——`## 选项`、`## 补充（…）`，以及其他幾個——都是固定的詞，不會被
翻譯：為什麼，以及每個人怎麼選自己的語言，見上面的[語言](#語言)。

一個節點還可以帶幾個可選欄位，用對應的 `nod add` / `nod edit` 參數設定，
不用手動改檔案：`due`、`est`、`every`、`remind_at`、`assignee`（`human`
表示這是你自己的待辦）、`milestone`（`true` 表示這是一個帶子目標的目標）。
看板和 app 都直接從檔頭讀這些欄位。

狀態：`not_started` 待開始 · `in_progress` 執行中 · `waiting` 等待 ·
`needs_decision` 待決策 · `decided` 已決策待 AI 取走 · `completed` 已完成 ·
`closed` 已關閉。子節點住在一個和父節點檔案同名的資料夾裡；編號是扁平的，
所以搬動一個節點只是改個檔名，所有參照照樣成立。

## 設計原則

- **是檔案，不是服務。** 一切都在 `decisions/` 裡，跟你的程式碼一起進版本
  控制，不裝 nod 也能讀。
- **檔案系統就是鎖。** 編號來自 `O_EXCL` 檔案；每次寫入都在自己的鎖下重新讀
  節點，透過先寫入再改名落地。二十幾個並發寫入者會拿到連續的編號，誰都不會
  丟——這點有測試保證。
- **只有一種東西。** 任務和決策是同一個節點。概念更少，一個編號空間，一棵樹。
- **人從來不用問。** 狀態、進度、多久沒動、卡在誰手上——全在看板上，不在
  對話裡。
- **角色寫清楚。** 每一段附加的內容都說明是人還是 AI 代理寫的、誰寫的、什麼
  時候寫的。只有人的回答才能核准要發出去的內容。
- **從外面來的是參照，不是內容。** 外部來源只同步編號和標題；正文和憑證留在
  它們原來的地方。

## 常見問題

**這只是給 Claude Code 用的嗎？**
不是。CLI 跟 AI 代理無關——任何能跑終端機的東西都能呼叫它。Claude Code 外掛
加了工作階段開頭的規則，並用 `CLAUDECODE` / `CLAUDE_SESSION_ID` 區分 AI 代理
的終端機和你自己的，順便標記是誰寫的。其他地方，自己設 `NODDIT_ROLE=agent`
和 `NODDIT_SESSION`（舊名字 `DECS_ROLE` / `DECS_SESSION` 也還認）。

**能用 git worktree 嗎？**
能。`nod` 永遠解析到主要工作目錄的 `decisions/`，所以各條工作線的 worktree
共用同一個儲存區。

**同時管理好幾個專案？**
`nod init` 替每個專案註冊一下；不帶參數的 `nod bench` 會按專案字母分組，
開啟全部專案。

**沒人回答怎麼辦？**
每個問題都帶一個預設值和一個 `--if-no-answer`。`nod wait --timeout` 會以
退出碼 2 結束並印出預設值——這就是該照它繼續的時候。

**可以手動改檔案嗎？**
讀是自由的。要寫，用 CLI：它負責保持編號、鎖、回答佇列和附件歷史的一致性。

**我有一份舊的 `DECISIONS.md`。**
`nod migrate --dir <project> --dry-run`，確認沒問題後拿掉 `--dry-run` 再跑
一次。

## Python SDK

Noddit 另有一個小小的 Python 套件：[PyPI 上的 `noddit`](https://pypi.org/project/noddit/)（只用標準函式庫，Python 3.10 以上）。它讓 Python 裡的長任務把進度回報到節點上——測試或腳本跑在裝不了 `nod` 的地方（例如 Docker 容器）時特別有用。pytest 外掛每跑完一個測試寫一行 JSON；`progress_events` 讓任何腳本也這樣寫。宿主機上用 `nod progress --from-file` 或 `nod run` 讀這個檔案，節點的進度條就會跟著走。

```sh
pip install noddit
pytest --noddit-events events.jsonl          # or NODDIT_EVENTS=events.jsonl pytest
nod run W12 --events events.jsonl -- pytest  # the node's progress bar follows the run
```

```python
from noddit import progress_events

ev = progress_events("events.jsonl")
ev.start(total=23, label="recalculate")
ev.step(done=5, msg="table 3")
ev.finish(ok=True, summary="23 tables")
```

事件格式見 [`python/docs/progress-events.md`](python/docs/progress-events.md)。

## 開發

```sh
npm test            # node --test
npm run typecheck   # tsc --noEmit
node scripts/render-screenshot.ts --out docs/screenshot.zh-Hant   # regenerate docs/screenshot.<lng>.svg/.png (mock data)
```

桌面 app（`app/src`）和終端看板（`src/tui`）要保持功能對齊——
[`docs/app-tui-parity.md`](docs/app-tui-parity.md) 記錄每個功能在兩邊各自
的落點，哪邊改了都要在這份表裡加一行。

## 授權

[MIT](LICENSE) © 2026 WeCarbon
