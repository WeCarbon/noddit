## nod：这个项目的任务和决策都记在 decisions/ 里（MUST FOLLOW）

（`decs` 仍然可以用，是下面每条命令的别名。）

负责人不会在对话里问「现在什么状态、在做什么、有什么要决、进度如何、接下来做什么」——这些都在 `nod bench` 里看。
没记进 nod 的工作，负责人就看不到。用法细节见 `nod --help`，或加载 decs skill。

- **节点**：任务和决策是同一种东西。你自己知道怎么做的用 `--task`，需要负责人回答才能继续的带 `-o` 选项。
  项目根还没有 `decisions/` 就先 `nod init`。
- **只用 nod 命令读写**：`decisions/` 里的文件一律通过 `nod` 改（add / note / ask / attach / start / done / close / retitle / move …），
  不要用编辑器、sed 或重定向直接改，也不要手动挪文件、改文件头、删 `.ids/`。
  命令做不到的事，记一个节点说清楚缺什么，别绕过去。
- **开工先建节点**：接到一件事，第一步 `nod add --task "<≤16 字标题>" --author "<智能体> · <在做什么>"`，
  `nod start <id>`，然后 `export NODDIT_NODE=<id>`。主控会话派工作线时，工作线的节点建在主控会话节点下面（`--parent`）。
- **计划就是子节点**：拆步骤时把还没做的写成子节点（`--parent`），有先后的写 `--after`，能估的写 `--est 30m`。
  中途发现新事项，加子节点，不要只在对话里说。
- **进度要能自己走**：长跑的命令接到 `nod progress`（`pytest … | nod progress --parse pytest`），
  多步流程用 `nod steps` / `nod step`。超过 check-in 的时限（默认 30 分钟，`nod config checkin-after`
  可改）没更新会收到一条 `NODDIT-CHECKIN`——见下。还在做但没新内容可报？`nod beat <id>` 本身就算回报。
- **等外部**：卡在同事、客户、供应商或某个服务上，`nod hold <id> --on "<谁/什么>"`（状态「等待」，不算卡住）；等到了 `nod start <id>`。
- **要负责人拍板**：在当前节点上 `nod ask <id> -o …`，或新建带选项的子节点；答复会从 nod monitor 来（见下）。
- **做完自己标完成，不要等别人**：活合进去、检查（测试、关卡）通过，当场 `nod done <id> --note "<结果、提交>"`。
  核对的人发现不对，用 `nod start <id>` 重新打开——核对不等于收尾。派子智能体时**不要**写「做完别标完成、等我核对」；
  主控会话合并前用 `nod tree <上层节点>` 把每个子节点的状态对一遍，子智能体自己建的子节点也要关掉。
- **收尾**：做完 `nod done <id> --note "<结果>"`；不做了 `nod close <id> --reason obsolete|superseded|merged-into:<id>`。
  取走负责人的答复用 `nod read`，问题解决了或不需要再解决才 `done`。
- **要发出去的内容**：发之前 `nod attach <id> 草稿 --approval-content --approve-on <选项>`，发送前 `nod approved <id> --check 草稿` 必须通过。
  不要用 `--human` 替负责人批准。
- **附件跟着它所附的那条消息，不是堆在最后一块**：`nod attach` 不给 `--to` 默认落你自己最新那条，没有就落正文；
  `nod note <id> "…" --attach a.png` 把回复和证据一起写。`--to body|last|<n>` 显式指定段落。
- **外部来源**：项目有 issue 跟踪、邮箱、反馈表单要跟的，主控会话用 `nod source register` 登记，写后台同步脚本只同步 id 和标题，
  新条目会从 nod monitor 来（见下），处理完 `nod source ack`。
- **延迟**：负责人可以把节点延迟（看板里按 d / `nod defer`）：它从可用/活动/待决里消失，状态不变；你收到「负责人延迟」就先停手，解除前别动它。
- **负责人在对话里说的话要转记**：负责人对某个节点（W305、X4 这类编号，或你知道它指哪个节点）给答复、回复、反馈，
  回复之前先 `nod note <id> --human --by "负责人（对话里说，<你> 转记）" "<原话>"`，截图用 `nod attach`；
  然后 `nod read <id>` 取走，处理完用 `--agent` 记一条做了什么。负责人回复过的节点就轮到你了。
  要负责人再看时用 `nod ask <id>`。

## 接通知：nod monitor（MUST FOLLOW）

- **主控会话不用自己挂**：decs plugin 在每个会话开始时自动启动 `nod monitor --here`（只盯当前项目，整个会话有效，不会到期）。
  每一行就是一件要处理的事：负责人的答复/回复 → `nod read` 取走，然后在节点上回一句要做什么（简单记一笔，或
  一步到位用 `nod read <id> --ack "…"`）——负责人看得到的回复本身就是会通知的事件，这点很重要；
  `DECS-UNCLAIMED` → 有答复没人取，去取；外部来源新条目 → 处理后 `nod source ack`；
  `NODDIT-CHECKIN` → 马上在那个节点上用 `nod progress`、`nod note`，或者没有新内容就 `nod beat <id>`
  回报——问满 3 次没回看板会标出来（多数是搭着别的消息一起来，静默够久也可能自己单独出现）；
  `NODDIT-STALE` → 有些既不待决策、也没人在做的节点放太久了，逐个 `nod start`、`nod defer`、`nod close`
  或重新规划；`DECS-ERROR` → 看一眼，监听会继续。
- **`DECS-IDLE`**：连续 2 小时没有事件，监听自己下线了。之后又有要等负责人回复的事，自己挂：
  `Monitor({ command: "nod monitor", description: "nod", timeout_ms: 1800000 })`，到期原样重挂（它自己记得看到哪）。
- **裸的 `nod monitor` 只盯 cwd 所在的项目**——跟 `--here` 一样，只是没项目时不会退出。要盯所有登记过的
  项目得显式加 `--all-projects`；别图省事随手加上，那意味着也会收到其他项目的节点。
- **子智能体 / 队友只管自己的节点，必须用 `--mine`**：自己挂监听时一律 `nod monitor --mine`；
  队友会话里 plugin 自动启动的监听会认出自己是队友、自动只推自己提的节点。
  收到不是自己的节点，不处理，那是主控会话的事。plugin 的监听不一定在进程内的子智能体里跑，开工就自己挂，到期原样重挂。
  `nod whoami` 能看到监听用来匹配的身份（`NODDIT_IDENTITY`，没设就是署名的名字加 session id），
  这个身份会（看不见地）打在你写的每一笔上，所以转记负责人的原话不会反过来推给你自己。
- 主控会话一律不加 `--mine`（替子智能体提的节点署的是子智能体的名字，加了就收不到）。
- 不要用后台终端跑 `nod wait`、不要自己写轮询脚本、不要用 `nod watch`（那是给人看的）。

## 负责人派活：接走 → 展开 → 确认（MUST FOLLOW）

- 负责人用几个字派活——自己终端里的 `nod add "…"`、看板里按 `p`、app 的新建任务框。这种节点叫派活：
  看板里是 ✎，文件头 `intake: true`，负责人的原话原样放在 `## 原话` 下。主控会话的 monitor 会打出
  `DECS-BRIEF <id> …`（5 分钟还没人接会再提醒一次）；`--mine` 的 monitor 只收自己节点下面的派活。
- **先接走**：`nod claim <id>`。它是原子的——说别人已经接了，就别碰。没接到的派活不要去展开。
- **展开**：`nod expand <id> [--title "…"] <<'EOF' … EOF`——做什么、为什么、做完的标准；假设要标明是假设。
  「原话」下面的字一个都不改。
- **拆分**：子节点 `nod add --task "…" --parent <id> --after <id> --est 30m`。
- **开工前负责人先确认**：`nod ask <id> -o 1="按计划开始" 2="要改（回复里写怎么改）"`，不设默认。
  答 1 → `nod read <id>`，照常执行；答 2 → 按意见改（再 expand、调整子节点），再问一次。
- 负责人在对话里让你这样处理他写的短节点：`nod claim <id>`，然后一样的步骤。
  负责人在对话里说了一件新活：`nod add --brief --author owner "<他的原话>"`。
- `nod briefs` 列出等着的派活；`nod sessions` 看谁在线。开新会话（`nod session start`）由负责人决定，不要自己开。
