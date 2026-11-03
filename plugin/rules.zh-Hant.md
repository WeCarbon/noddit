## nod：這個專案的任務和決策都記在 decisions/ 裡（MUST FOLLOW）

（`decs` 仍然可以用，是下面每條命令的別名。）

負責人不會在對話裡問「現在什麼狀態、在做什麼、有什麼要決、進度如何、接下來做什麼」——這些都在 `nod bench` 裡看。
沒記進 nod 的工作，負責人就看不到。用法細節見 `nod --help`，或載入 decs skill。

- **節點**：任務和決策是同一種東西。你自己知道怎麼做的用 `--task`，需要負責人回答才能繼續的帶 `-o` 選項。
  專案根目錄還沒有 `decisions/` 就先 `nod init`。
- **只用 nod 指令讀寫**：`decisions/` 裡的檔案一律透過 `nod` 改（add / note / ask / attach / start / done / close / retitle / move …），
  不要用編輯器、sed 或重新導向直接改，也不要手動搬檔案、改檔頭、刪 `.ids/`。
  指令做不到的事，記一個節點說清楚缺什麼，別繞過去。
- **開工先建節點**：接到一件事，第一步 `nod add --task "<≤16 字標題>" --author "<AI 代理> · <在做什麼>"`，
  `nod start <id>`，然後 `export NODDIT_NODE=<id>`。主控工作階段派工作線時，工作線的節點建在主控工作階段節點下面（`--parent`）。
- **計畫就是子節點**：拆步驟時把還沒做的寫成子節點（`--parent`），有先後的寫 `--after`，能估的寫 `--est 30m`。
  中途發現新事項，加子節點，不要只在對話裡說。
- **進度要能自己走**：長跑的指令接到 `nod progress`（`pytest … | nod progress --parse pytest`），
  多步流程用 `nod steps` / `nod step`。`nod progress --from-file x.jsonl` 會自動識別 noddit 的
  JSONL 事件格式（Python 套件的 `progress_events` / pytest 插件寫的）。或者整件事交給
  `nod run <id> -- <cmd…>`：開始、跟進度（自動設好 `NODDIT_EVENTS`），退出碼 0 就 `nod done`，
  失敗就 `nod hold --on "failing: …" --until 明天` 並附上輸出的尾段。超過 check-in 的時限（預設 30 分鐘，
  `nod config checkin-after` 可改）沒更新會收到一條 `NODDIT-CHECKIN`——見下。還在做但沒新內容可報？
  `nod beat <id>` 本身就算回報。
- **等外部**：卡在同事、客戶、供應商或某個服務上，`nod hold <id> --on "<誰/什麼>" --until <日期>`（必須給回來看的日子，到期 monitor 會提醒你去問）（狀態「等待」，不算卡住）；等到了 `nod start <id>`。
- **要負責人拍板**：在目前節點上 `nod ask <id> -o …`，或新建帶選項的子節點；回覆會從 nod monitor 來（見下）。
- **做完自己標完成，不要等別人**：工作合併進去、檢查（測試、關卡）通過，當下就 `nod done <id> --note "<結果、提交>"`。
  核對的人發現不對，用 `nod start <id>` 重新開啟——核對不等於收尾。派子 AI 代理時**不要**寫「做完別標完成、等我核對」；
  主控工作階段合併前用 `nod tree <上層節點>` 把每個子節點的狀態對一遍，子 AI 代理自己建的子節點也要關掉。
- **收尾**：做完 `nod done <id> --note "<結果>"`；不做了 `nod close <id> --reason obsolete|superseded|merged-into:<id>`。
  收走負責人的回覆用 `nod read`，問題解決了或不需要再解決才 `done`。
- **要發出去的內容**：發之前 `nod attach <id> 草稿 --approval-content --approve-on <選項>`，發送前 `nod approved <id> --check 草稿` 必須通過。
  不要用 `--human` 替負責人核准。
- **附件跟著它所附的那條訊息，不是堆在最後一塊**：附件和介紹它的那條訊息一起寫：`nod note <編號> "…" --attach 檔案`（或 `nod ask … --attach`）；單獨 `nod attach` 不給 `--to` 預設落你自己最新那條，負責人在那之後寫過就先另起一條你的短段落，都沒有才落正文；
  `nod note <id> "…" --attach a.png` 把回覆和證據一起寫。`--to body|last|<n>` 明確指定段落。
- **外部來源**：專案有 issue 追蹤、信箱、意見表單要跟的，主控工作階段用 `nod source register` 登記，寫後端同步腳本只同步 id 和標題，
  新項目會從 nod monitor 來（見下），處理完 `nod source ack`。
- **延後**：負責人可以把節點延後（看板裡按 d / `nod defer`）：它從可用/活動/人類工作裡消失，狀態不變；你收到「負責人延後」就先停手，解除前別動它。
  `nod defer <id> --until 週五`（或 3天後、11月15日、fri）到那天自己回來；monitor 會印出 `NODDIT-UNDEFERRED <id>`——當作剛解除延後，接著做。
- **負責人自己的事**（`assignee: human`，看板上標「你來做」，列在「人類工作」裡）：永遠不要開始、接走、展開或去做——
  它不會有 check-in，也不會被催。需要負責人親手做的事可以替他記一件：`nod add --for me "給供應商打電話" --parent <id>`，
  等它的活用 `--after` 排在它後面。把一件事交給負責人用 `nod assign <id> me`；交回給 AI（`nod assign <id> ai --force`）只在他說了的時候。
- **負責人在對話裡說的話要轉記**：負責人對某個節點（W305、X4 這類編號，或你知道它指哪個節點）給回覆、回應、意見，
  回覆之前先 `nod note <id> --human --by "owner（對話裡說，<你> 轉記）" "<原話>"`，截圖用 `nod attach`；
  然後 `nod read <id>` 收走，處理完用 `--agent` 記一筆做了什麼。負責人回覆過的節點就輪到你了。
  要負責人再看時用 `nod ask <id>`。

## 接通知：nod monitor（MUST FOLLOW）

- **主控工作階段不用自己掛**：decs 外掛在每個工作階段開始時自動啟動 `nod monitor --here`（只盯目前專案，整個工作階段有效，不會到期）。
  每一行就是一件要處理的事：負責人的回覆/回應 → `nod read` 收走，然後在節點上回一句要做什麼
  （簡單記一筆，或一步到位用 `nod read <id> --ack "…"`）——負責人看得到的回覆本身就是會通知的事件，
  這點很重要；`DECS-UNCLAIMED` → 有回覆沒人收，去收；外部來源新項目 → 處理後 `nod source ack`；
  `NODDIT-CHECKIN` → 馬上在那個節點上用 `nod progress`、`nod note`，或沒有新內容就 `nod beat <id>`
  回報——問滿 3 次沒回看板會標出來（多半搭著別的訊息一起來，靜默夠久也可能自己單獨出現）；
  `NODDIT-STALE` → 有些既不待決策、也沒人在做的節點放太久了，逐一 `nod start`、`nod defer`、`nod close`
  或重新規劃；`DECS-ERROR` → 看一眼，監聽會繼續。
- **`DECS-IDLE`**：連續 2 小時沒有事件，監聽自己下線了。之後又有要等負責人回覆的事，自己掛：
  `Monitor({ command: "nod monitor", description: "nod", timeout_ms: 1800000 })`，到期原樣重掛（它自己記得看到哪）。
- **裸的 `nod monitor` 只盯 cwd 所在的專案**——跟 `--here` 一樣，只是沒專案時不會退出。要盯所有登記過的
  專案得明確加 `--all-projects`；別圖方便隨手加上，那表示也會收到其他專案的節點。
- **子 AI 代理 / 隊友只管自己的節點，必須用 `--mine`**：自己掛監聽時一律 `nod monitor --mine`；
  隊友工作階段裡外掛自動啟動的監聽會認出自己是隊友、自動只推自己提的節點。
  收到不是自己的節點，不處理，那是主控工作階段的事。外掛的監聽不一定在行程內的子 AI 代理裡跑，開工就自己掛，到期原樣重掛。
  `nod whoami` 能看到監聽用來比對的身份（`NODDIT_IDENTITY`，沒設就是署名的名字加工作階段 id），
  這個身份會（看不見地）打在你寫的每一筆上，所以轉記負責人的原話不會反過來推給你自己。
- 主控工作階段一律不加 `--mine`（替子 AI 代理提的節點署的是子 AI 代理的名字，加了就收不到）。
- 不要用背景終端機跑 `nod wait`、不要自己寫輪詢腳本、不要用 `nod watch`（那是給人看的）。

## 負責人派活：接走 → 展開 → 確認（MUST FOLLOW）

- 負責人用幾個字派活——自己終端機裡的 `nod add "…"`、看板裡按 `p`、app 的新建任務框。這種節點叫派活：
  看板裡是 ✎，檔頭 `intake: true`，負責人的原話原樣放在 `## 原话` 下。主控工作階段的監聽會印出
  `DECS-BRIEF <id> …`（5 分鐘還沒人接會再提醒一次）；`--mine` 的監聽只收自己節點下面的派活。
- **先接走**：`nod claim <id>`。它是原子的——說別人已經接了，就別碰。沒接到的派活不要去展開。
- **展開**：`nod expand <id> [--title "…"] <<'EOF' … EOF`——做什麼、為什麼、做完的標準；假設要標明是假設。
  「原話」下面的字一個都不改。
- **拆分**：子節點 `nod add --task "…" --parent <id> --after <id> --est 30m`。
- **開工前負責人先確認**：`nod ask <id> -o 1="按計畫開始" 2="要改（回覆裡寫怎麼改）"`，不設預設。
  答 1 → `nod read <id>`，照常執行；答 2 → 按意見改（再 expand、調整子節點），再問一次。
- 負責人在對話裡讓你這樣處理他寫的短節點：`nod claim <id>`，然後一樣的步驟。
  負責人在對話裡說了一件新活：`nod add --brief --author owner "<他的原話>"`。
- `nod briefs` 列出等著的派活；`nod sessions` 看誰在線。開新工作階段（`nod session start`）由負責人決定，不要自己開。
