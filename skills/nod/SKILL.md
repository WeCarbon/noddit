---
name: nod
description: nod 的完整用法（`decs` 仍是别名）——建节点/子节点、依赖与时序、nod progress/steps 汇报进度、nod ask 请 owner 拍板、子问题、发出去之前的内容批准（--approval-content/--approve-on/approved --check）、外部来源（nod source）、附件、迁移。要写 nod 节点、要 owner 决定或验收、要汇报进度、要接外部通知时加载。
---

规则（每个 session 开头已经注入，英文）是底线；命令自己的输出、报错和 monitor 每一行都会告诉你下一步；这里是完整用法。`decs` 仍然可以用，是 `nod` 的别名。先读：

- `${CLAUDE_PLUGIN_ROOT}/AGENTS.md` —— 给 agent 的全部规矩和示例
- `${CLAUDE_PLUGIN_ROOT}/adapters/README.md` —— 外部来源的同步脚本怎么写
- 任何子命令都可以 `nod <命令> --help`

**只用 nod 命令写。** `decisions/` 下的任何文件——节点、附件、`.ids/`、`queue.json`——都不要用编辑器、sed
或重定向直接改，也不要手动移动、重命名、删除。编号分配、文件锁、队列、状态迁移、附件历史全靠命令维持，手改会悄悄
弄坏它们（另一个 lane 的写入丢失、答复不唤醒、bench 显示错状态）。要改什么就找对应的命令：

| 想做的事 | 命令 |
|---|---|
| 还没有 `decisions/` | `nod init` |
| 新建节点 / 子节点 | `nod add "<标题>" [--task] [--parent <id>] [--after <id>] [--est 30m]`；计划里还没开始的步骤都建成子节点 |
| 补一条记录 / 转记 owner 的话 | `nod note <id> --agent "…"` / `nod note <id> --human --by "owner（对话里说，<你> 转记）" "…"` |
| 开始 / 做完 / 不做了 | `nod start` / `nod done --note` / `nod close --reason` |
| 要 owner 拍板 / 再看一眼 | `nod ask <id> -o 1="…" 2="…"` / `nod ask <id>`；每个选项写清选了会怎样（花多久、谁来做、放弃什么、风险、能不能反悔）和推荐哪个、为什么——`-o` 只放短标签，说明用 heredoc 写在正文里，每个选项一节 `### 1 · <标签>`（app 把它挪到选项卡片上） |
| 等外部（同事、客户、供应商、服务恢复） | `nod hold <id> --on "<谁/什么>" --until <日期>`（必须给回头看的那天；状态是「等待」，不是卡住），到日子 monitor 打 `NODDIT-CHECK-BACK`；恢复用 `nod start` |
| owner 延迟了 / 解除 | owner 可以把节点延迟（bench 里按 d / `nod defer`）：它从可用/活动/需要人类里消失，状态不变；你收到「owner 延迟」就先停手，解除前别动它（`nod undefer` 解除，`nod show deferred` 列出）。`nod defer <id> --until 周五`（3d、15 nov、下周一……，`nod date "<文字>"` 先看是哪天）到那天自己回来，monitor 打 `NODDIT-UNDEFERRED <id>` |
| owner 自己的事 | `assignee: human`，bench 上「你来做」，列在「需要人类」里：**不要开始、接走、展开或去做**，也不会有 check-in 和催办。需要 owner 亲手做的事替他记：`nod add --for me "给供应商打电话" --parent <id>`，等它的活 `--after` 它；`nod assign <id> me` 交给 owner，交回 AI（`--force`）只在他说了时 |
| 进度 | `nod start <id>` 之后它就是本会话的当前节点，`nod progress <pct> "…"` / `nod note "…"` / `nod beat` / `nod steps` / `nod step <n>` 都可以不写 id（`NODDIT_NODE` 设了以它为准；同一会话里的几个子 agent 会互相覆盖，各自写 id 或设 `NODDIT_IDENTITY`）。长命令直接管道：`pytest … \| nod progress --parse pytest`；`nod progress --from-file x.jsonl` 自动认 noddit JSONL 事件；或者 `nod run <id> -- <命令…>` 一条包办：开始、跟进度（替你设 `NODDIT_EVENTS`）、成功 `nod done`、失败 `nod hold` 带上输出末尾。超过 check-in 间隔（默认 30m，`nod config checkin-after`）没更新会收到 `NODDIT-CHECKIN`；还在做但没新内容就 `nod beat`，问满 3 次没回 bench 上标红 |
| 等 owner 答复、等外部来源 | 主 session：plugin 自动启动的 decs monitor；DECS-IDLE 之后或子 agent：用 Monitor 挂 `nod monitor`（子 agent 加 --mine） |
| 附件 / 改标题 / 挪位置 | 和介绍它的消息一起：`nod note/ask … --attach 文件`；补附件 `nod attach`——不给 `--to` 落在你自己最新那条，owner 写过之后再单独 attach 会另起一小节；`--to body\|last\|<n>` 指定段落（`--move 文件 --to 段落` 挪位置）/ `nod retitle` / `nod move` |
| 要发出去的内容（邮件、帖子、给同事的信） | 发之前 `nod attach <id> draft.md --approval-content --approve-on <选项>`（或 `nod ask … --attach`），owner 选了那个选项才算批准；发之前 `nod approved <id> --check draft.md` 必须通过（内容改过就不算） |
| 外部来源（issue、邮箱、反馈表） | lead 用 `nod source register` 登记，同步脚本只同步 id 和标题；新条目由 monitor 推来，处理完 `nod source ack <源> <id>` |
| 负责人派的活（`DECS-BRIEF`、看板里的 ✎） | `nod claim <id>` → `nod expand <id> <<EOF` → 子节点 `--parent --after --est` → `nod ask <id> -o 1="按计划开始" 2="要改（回复里写怎么改）"`；答 1 照常开工，答 2 改了再问；`nod briefs` / `nod sessions`。owner 在对话里让你把他写的一个短节点当派活处理：`nod claim <id>` 然后同样几步 |

命令做不到的，记一个节点说清楚缺什么（或者到 noddit 仓库提 issue）——不要绕过去手改。

## 接通知：nod monitor（MUST FOLLOW）

- **主 session / lead 不用自己挂**：decs plugin 在每个 session 开始时自动启动 `nod monitor --here`（只盯当前项目，整个 session 有效，不会到期）。
  每一行就是一件要处理的事：owner 的答复/回复 → `nod read` 取走，然后在节点上回一句要做什么（简单记一笔，或
  一步到位用 `nod read <id> --ack "…"`）——owner 看得到的回复本身就是会触发通知的事件，这点很重要；
  `DECS-UNCLAIMED` → 有答复没人取，去取；外部来源新条目 → 处理后 `nod source ack`；
  `NODDIT-CHECKIN` → 马上在那个节点上用 `nod progress`、`nod note`，或者没有新内容就 `nod beat <id>`
  回报——问满 3 次没回 bench 上会标出来（多数搭着别的消息一起来，静默够久也可能自己单独出现）；
  `NODDIT-STALE` → 有些既不待决策、也没人在做的节点放太久了，逐个 `nod start`、`nod defer`、`nod close`
  或重新规划；`NODDIT-TIDY` → `nod tidy` 看哪里节点树和状态对不上，逐个修；`DECS-ERROR` → 看一眼，monitor 会继续。
  每一行末尾都写了下一步，照着做就行。
- **`DECS-IDLE`**：连续 2 小时没有事件，monitor 自己下线了。之后又有要等 owner 回复的事，自己挂：
  `Monitor({ command: "nod monitor", description: "nod", timeout_ms: 1800000 })`，到期原样重挂（它自己记得看到哪）。
- **裸的 `nod monitor` 只盯 cwd 所在的项目**——跟 `--here` 一样，只是没项目时不会退出。要盯所有登记过的
  项目得显式加 `--all-projects`；别图省事随手加上，那意味着也会收到其他项目的节点。
- **子 agent / teammate 只管自己的节点，必须用 `--mine`**：自己挂 monitor 时一律 `nod monitor --mine`；
  teammate 会话里 plugin 自动启动的 monitor 会认出自己是 teammate、自动只推自己提的节点。
  收到不是自己的节点，不处理，那是 lead 的事。plugin 的 monitor 不一定在进程内的子 agent 里跑，开工就自己挂，到期原样重挂。
  `nod whoami` 能看到 monitor 用来匹配的身份（`NODDIT_IDENTITY`，没设就是署名的名字加 session id），
  这个身份会（看不见地）打在你写的每一笔上，所以转记 owner 的原话不会反过来推给你自己。
- lead / 主 session 一律不加 `--mine`（替子 agent 提的节点署的是子 agent 的名字，加了就收不到）。
- 不要用后台 shell 跑 `nod wait`、不要自己写轮询脚本、不要用 `nod watch`（那是给人看的）。

几个最容易错的：

- **做完自己标完成，不要等别人**：活合进去、检查（测试/gate）通过，当场 `nod done <id> --note "<结果、提交>"`。
  核对的人发现不对，用 `nod start <id>` 重新打开——核对不等于收尾。派子 agent 时**不要**写「做完别标完成、等我核对」；
  lead 合并前用 `nod tree <上层节点>` 把每个子节点的状态对一遍，子 agent 自己建的子节点也要关掉。
- 标题 ≤ 32 列（约 16 个汉字），只写「要决什么 / 要做什么」，细节放正文。
- 正文用 heredoc 喂给 `nod add`；正文里写了 `## 选项` 就要和 `-o` 一致。
- owner 在对话里的话，回复前先 `nod note <id> --human --by "owner（对话里说，<你> 转记）"`。
- 只有 owner 本人的答复算批准要发出去的内容；不要用 `--human` 替 owner 批准。
- 不要在后台跑 `nod watch`，它不退出，是给人看的。
- **负责人派的活**（`DECS-BRIEF`）：先 `nod claim <id>`（原子的，说别人接了就别碰）；`nod expand` 写清做什么 / 为什么 /
  做完的标准，假设标明是假设，「原话」一个字不改；拆子节点；`nod ask` 请负责人确认，答 1 之前不开工。
  不要自己 `nod session start`，开不开新会话是负责人的事。
