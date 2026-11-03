# agent 怎么用 nod

这份是给 AI agent 的完整用法。可以整段贴进项目的 `AGENTS.md` / `CLAUDE.md`；装了
Claude Code 插件的话，精简版规则（`plugin/rules.md`，只有英文一份）会在每个 session 开头自动注入，
这里是细节和示例。`decs` 仍然可以用，是 `nod` 的别名。

---

## 你在做的事都是 decisions/ 里的节点（MUST FOLLOW）

**节点**是 agent 要做的一件事。你自己知道怎么做的，就是一个普通节点；要 owner 先回答
一个问题才知道做不做、怎么做的，这个节点的状态就是「待决策」。只有这一种东西，
一个编号空间。对话会滚走，文件不会，所以 owner 不用问你就能看到你在干什么。

### 开工时建节点，规划时细化成子节点

```sh
nod add "发布 v2.4" --task --author "<lane> · <在做什么>"             # 打印 W312
nod add "跑全量测试" --task --parent W312 --after W313                # 子节点，排在 W313 后面
nod start W312      # 待开始 → 执行中
nod done W312 --note "测试 412/412 通过"     # → 已完成
nod close W312 --reason obsolete            # 不做了：superseded | obsolete | merged-into:W15
```

- lead 起 lane 时给它建一个节点；lane 是子 lane 的，就建在 lead 的节点下面（`--parent`）。
- lane 规划时把自己的节点细化成子节点。bench 里 owner 看到的就是这棵树一点点展开。
- `--after` 写先后顺序。排在没完成的节点后面的，`nod start` 会拒绝。
- 标题最多 32 列（约 16 个汉字），只写要做/要决什么，超了 `nod add` 直接拒绝。
  背景、数字、PR 号都放正文。老的长标题用 `nod retitle <id> "<短标题>"` 改。

### 要 owner 拍板

```sh
nod add "<一句话说清要决什么>" --author "<agent 名> · <它在做什么>" \
    -o 1="<选项一>" 2="<选项二>" --default 1 \
    --urgency high --if-no-answer "先不上线，周五再问" --reversible yes <<'EOF'
**是什么。** 这个东西是什么、从哪冒出来的。假设 owner 从没听说过它。

**为什么现在要决。** 什么被它挡住了；不决会怎样。

## 选项

### 1 · <选项一>
代价要具体：多少钱、多少时间、哪些用户受影响、哪些不可逆。

### 2 · <选项二>
同上。

**已经量过的事实**（带出处：`file:line`、命令输出、行数）。
区分「量过的」和「推断的」。
EOF
```

已经在做的节点做着做着遇到问题，不要另开一条，把它本身变成待决策：

```sh
nod ask W312 -o 1="继续用现在的 CDN" 2="换一家" --default 1 <<'EOF'
压测到第三轮发现静态资源在亚太的延迟翻了一倍……
EOF
```

正文里自己写了 `## 选项` / `### 1 · …`（带各自代价）的，那就是选项：不给 `-o` 直接用它
（标 `（默认）` 的是默认），给了 `-o` 就必须和它一致。

一条里有好几个小问题的，用子问题，不要让 owner 在答复里写自由文本：

```sh
nod add "定价页的 2 个待定" \
    --question Q1 "年付折扣" -o Q1:A="8 折" Q1:B="85 折" --default Q1:A \
    --question Q2 "免费档上限" -o Q2:1="3 个项目" Q2:2="5 个项目" --default Q2:1
nod add "5 条回复草稿" --review-item R1 "回复 Alice" --review-item R2 "回复 Bob"
```

每个子问题都要有默认。owner 在 bench 里按 1 就是全部按默认，按 2 逐条答；
`nod get <id> --json` 的 `answers` 是 `{Q1: "B", Q2: "1"}`，审阅项选「改」时
改法在 `answer_notes`。

规矩：

- `--author` 必填（退到 `$NODDIT_AUTHOR`，再退到 git 分支名；`DECS_AUTHOR` 这个老名字也还认）。
  session id 从 `CLAUDE_SESSION_ID` / `NODDIT_SESSION`（或老名字 `DECS_SESSION`）自动记下。
- 要 owner 权衡的事，选项和各自的代价都写出来。只有一个选项的是验收（不给 `-o`
  就自动带一个 `1 · 验收通过`）：写清在哪看、该看到什么、已经自动测过什么。
  截图用 `nod attach <id> <path>`。
- 只是告诉一声、不用回的，用 `--fyi`：直接记成已完成，不进「等你决定」的列表。
- `--urgency high|low`、`--due 4h`、`--if-no-answer`、`--reversible yes|no` 都是字段，
  bench 直接显示，high 排在最前。`--notify` 只在设了 `NODDIT_NOTIFY_CMD`（老名字 `DECS_NOTIFY_CMD` 也认）时推送。

### 你替 owner 记答复（`nod push`）

owner 在对话里说了「发吧」「选 2」，你可以用 `nod push <id> 2` 记下来：答复照样落盘、
照样进队列、照样能 `nod read`。但在 agent 的 shell 里（设了 `CLAUDECODE` 或
`NODDIT_ROLE=agent`，老名字 `DECS_ROLE=agent` 也认），push 默认记成 **agent** 的答复，**不批准任何 `--approval-content`
内容**。

⚠️ **绝不要为了让内容通过批准去加 `--human`。** 要发出去的东西必须由 owner 自己在
nod 里批（bench 里按数字，或 owner 自己的终端）；`--human` 只给 owner 本人用。转述的答复
没有批准内容，`nod approved --check` 不过，就等 owner 批，不要绕。

### 等答复

装了 Claude Code 插件的话，插件在每个 session 开始时自动启动 `nod monitor --here`：只盯当前目录所在的项目，
整个 session 有效，主 session 不用自己挂。每一行就是一件要处理的事：

- owner 的答复/回复 → `nod read` 取走，然后在节点上回一句要做什么（简单记一笔，或一步到位用
  `nod read <id> --ack "…"`）——owner 看得到的回复本身就是会触发通知的事件，不要只在心里想；
- `DECS-UNCLAIMED` → 有答复 5 分钟没人取走，lead 去取；
- `DECS-BRIEF` → owner 新派了活（或派的活 5 分钟没人接），按下面「owner 派活」接走；
- 外部来源新条目 → 处理后 `nod source ack`；
- `NODDIT-CHECKIN` → 执行中的节点过了 check-in 的时限还没更新，马上在那个节点上回：
  `nod progress` / `nod note` / `nod beat <id>`（没有新内容时用，等于「我还在做」）；
- `NODDIT-STALE` → 有节点既不待决策、也没人在做，放太久了，`nod start` / `nod defer` /
  `nod close` 或重新规划；
- `NODDIT-TIDY` → 这个会话自己的树跟状态对不上，或者只是有一阵子没查了——`nod tidy` 看看
  哪里对不上，然后 `nod done` / `nod close` / `nod move` 或重新规划；没问题就在节点上记
  一句为什么；`nod tidy` 本身就是回应这条提醒的方式（会记一次 ack，清零下次提醒的计时）；
- `DECS-ERROR` → 看一眼，monitor 会继续；
- `DECS-IDLE` → 连续 2 小时（`--idle-exit`，0 = 不下线）没有事件，monitor 自己下线了。

裸的 `nod monitor`（不带 `--here`）只盯 cwd 所在的项目，跟 `--here` 一样，只是没项目时不退出；
要盯所有登记过的项目得显式加 `--all-projects`，别图省事随手加上。`nod whoami` 看监听用来匹配
的身份（`NODDIT_IDENTITY`，没设就是署名的名字加 session id）——这个身份会看不见地打在每一笔
写入上，转记 owner 的原话不会反过来推给自己。

monitor 下线之后又有要等 owner 回复的事，或者你是子 agent（插件的 monitor 不一定在子 agent 里跑），
用 Monitor 工具自己挂：

```
Monitor({ command: "nod monitor", description: "nod", timeout_ms: 1800000 })        # lead / 主 session
Monitor({ command: "nod monitor --mine", description: "nod", timeout_ms: 1800000 }) # 子 agent（lane）
```

- **到期（30 分钟）或退出后，原样再挂同一条**，不带任何参数——它记得这个 session 上次看到哪，中间的会先补出来。
- **lead / 主 session 不加 `--mine`。** 你替子 agent 提的节点署的是子 agent 的名字，加了就收不到。
- 不要用后台 shell 跑 `nod wait`、不要自己写轮询脚本、不要用 `nod watch`（那是给人看的）。

为什么是 monitor：`nod wait` 有东西就退出、只唤醒一次，忘了重起就漏；`--mine` 会让 lead
漏掉替 lane 提的节点；手带 `since=` 重挂容易带错。monitor 自己记位置，答复 5 分钟没人取走
会报 `DECS-UNCLAIMED`。`nod wait` 只留给没有 Monitor 的环境。

```sh
nod queue --mine         # 看有哪些
nod read W305            # 取走：已决策 → 执行中（排在没完成的节点后面的，→ 待开始）
nod done W305            # 活真干完了
nod read W305 --done     # 读完当场就办完了的，一步到位
```

- 不要轮询，也不要在对话里问「决定了吗」。session 断了、monitor 没了，回来先用
  最后一个 `since=` 补齐：

  ```sh
  nod changes --since <它打印的值> --mine --json
  ```

  这之后所有的答复、追问、补充、完成、关闭都在里面，外部来源（`nod source`）的新条目、
  变化、消失也在（JSON 里是 `source_events`，`--mine` 按来源的 owner_agent 筛），不会漏
  （同一秒的事件可能重复一次）。
- `nod queue --stale 1h` 列出答了一小时还没人取走的。
- `--timeout <秒>` 超时退出（退出码 2），并打印默认动作和「你不回的话」。那正是
  该照默认执行的时刻。

### 追加记录：你写的是 agent，owner 写的是 human

```sh
nod note W305 "照办了，部署在 10:40"          # agent 的 shell 里默认 agent：不进队列，不唤醒任何人
nod note W305 --human "……"                   # 只有 owner 本人才用
```

每段追加的标题都带角色、署名和时间：`## 补充（agent · lead · 2026-03-14 10:51:30）`、
`## 追问（human · owner · …）`。只有 human 的话会进队列、会把已完成的节点拉回
「已决策待 AI 取走」。不要用 `--human` 冒充 owner——那会让你自己写的补充显示成 owner 的追问。

例外：owner 在对话里对某个节点说的话，由你转记，这时用
`nod note <id> --human --by "owner（对话里说，<你> 转记）" "<原话>"`——话是 owner 的，
署名写清是你转记的。

### 编号

显示成「项目字母 + 数字」：`web` 项目设了 `W`，305 就是 `W305`；没设字母的项目是 `X305`。
引用时 `305`、`W305`、`web:305` 都认，老的 `D305` 也认（意思是「这个项目的 305」，
除非真有项目的字母是 D）。几个项目一起开时，只写数字而几个项目都有这个号会被拒绝。
设字母：`nod config letter W`。正文里写 `W301` 会被识别成引用，`nod get` 显示
「被 W301 引用」（字母形式要两位数以上，`F1`、`Q2` 这种小标题不算）。

⚠️ **在 git worktree 里干活也照常用 `nod`。** `decisions/` 进 git，你的 worktree
里也有一份副本，但 `nod` 永远解析到**主仓**。不要手动去改 worktree 里的 `decisions/`。

编号靠 `decisions/.ids/` 里的 `O_EXCL` 文件分配；每次写都在这个节点的锁里重新读一遍
再改，多个 lane 同时 note 同一个节点不会丢；新文件和改写都是先写临时文件再改名。

---

## 外部来源（`nod source`）：owner 问「清了没」不用再问 agent

一个项目如果接了 issue 跟踪、邮箱、反馈表单之类的外部系统，**lead 负责注册 source，
并让一个适配器在后台一直跑着**，而不是等 owner 来问「issues/邮箱/反馈是不是都清了」
才去手动查一遍。

```sh
nod source register <name> --title "..." --kind github \
    --adapter "python3 adapters/xxx_sync.py --name <name>" --stale-after 15m
```

适配器只同步**引用**——id + title（可选 url/state/from）——绝不同步正文，
凭证留在项目自己的代码/环境变量里，nod 从不直接访问外部系统。模板和规矩在
`adapters/README.md` + `adapters/example_sync.py`。Azure DevOps 工作项有现成的
`adapters/azure_devops_sync.py`。

- **只在有会话开着时同步**：适配器支持单次同步（如 `--once`）时，登记成来源的同步命令，
  主控的 `nod monitor` 活着时按间隔跑它，失败报成 `DECS-ERROR`，不中断监听：

  ```sh
  nod source register <name> --sync-cmd "python3 adapters/xxx_sync.py --once" --every 10m
  ```

  这条命令只存在本机（`~/.decs/source-sync.json`，按项目路径），不进 `decisions/`——
  克隆来的仓库不会让任何人的 monitor 执行命令；换一台机器要在那台机器上重新登记一次。

- **新条目从 `nod monitor` 来**（见上）。没有 Monitor 的环境用 `nod source wait <name>`：
  阻塞到有未处理的新/变化条目，打印后退出；去看 `nod source items <name> --unhandled`，
  处理完 `nod source ack`，再重新 wait。

- **`ack` 的时候说清楚卡在谁手上**：

  ```sh
  nod source ack <name> 12345 --note "已经在 PR #42 里修了"     # 真的处理完了
  nod source ack <name> 12346 --waiting-on Bob                # 转给人，不算挂着
  nod source ack <name> 12347 --waiting-on owner              # 为它建了个决策，等 owner
  ```

  `nod source list` 的 cleared 就是靠这个算的——没有未处理的条目，也没有条目
  卡在 `owner`/`us`/一个还开着的节点（如 `W304`）上，才算清空。卡在一个人名下算
  交出去了，不算挡着。

- **心跳是免费的**——`sync`/`push` 自动带，适配器挂了会在 `nod source list`
  里显示「可能挂了」。别写一个异常就不心跳的循环。

## 附件：版本、对比图、批准

- **附件跟着它所附的那条消息，不是堆在最后一块**：`nod attach <id> file` 不给 `--to`
  时，默认落在你自己最新的一条追问/回复里，没有就落正文；要显式指定用
  `nod attach <id> file --to body|last|<n>|<文字>`（正文 / 最新的那条，不分作者 /
  第 n 条，从 1 数 / 匹配某条标题或时间的文字）。`nod note <id> "…" --attach a.png
  --attach b.png` 把回复和证据写进同一段——写评论时顺手带图，不用先回复再 attach 两步。
  旧节点那种一个全局 `## 附件` 块，用 `nod migrate --attachments` 拆回各自的段落
  （见下面「迁移」）。
- **同名文件重新 attach 用 `--replace`**：`nod attach <id> file.html --replace`
  直接覆盖最新版，旧的挪进 `.history/`，正文里的链接永远指向最新版。不给这个
  flag，同名文件会变成 `file-2.html`——两份都留着，但谁也不知道该看哪份。
  `--replace` 是你明确要「这是同一份东西的新版本」时才加的。
- **对比图用 `--label`**：`nod attach <id> --label "选项 1" a.png --label "选项 2" b.png`，
  每个 `--label` 配紧跟着的那一个文件，在 bench 大图里用 `←`/`→` 切换对比；
  `--caption "…"` 同样按位置配文件，显示在图下方。
- **发出去之前要 owner 批准的内容，用 `--approval-content`**：
  `nod attach <id> draft.html --approval-content --approve-on 1` 记下这份文件当前的
  sha256，以及**哪个答复算批准**（`--approve-on 1,3`，子问题写 `Q2:1`）。只有一个选项的
  验收节点默认就是那个选项；有多个选项或子问题时不给 `--approve-on` 会被拒绝。
  owner 本人在 bench 或自己的终端里选了算批准的那个选项，才批准当时的哈希；选了别的
  （比如「2 · 先别发」），就不算，而且会撤掉之前的批准。
  **发送前必须跑一次** `nod approved <id> --check <path>`——退出码非 0 就不要发，
  原因会打出来（从没批准过 / 答复不是批准的那个选项 / 内容变了）。内容改了用 `--replace`
  重新 attach 后，旧的批准对不上新的哈希，这是故意的：要等 owner 再答一次这个节点才算
  重新批准，不要绕过去直接发。

---

## 迁移

老项目里还有手写的 `DECISIONS.md` / `DECISIONS.old.md` 的：

```sh
nod migrate --dir <项目根> --dry-run   # 先看它打算写什么
nod migrate --dir <项目根>
```

早期格式的 nod 目录（`D305-….md`、`status: open/answered`）不迁也能照常读。
要把磁盘上的格式也升上来：

```sh
nod migrate --strip-prefix --upgrade --dry-run   # 先看
nod migrate --strip-prefix --upgrade
```

`--strip-prefix` 把 `D305-….md`、子节点文件夹、`attachments/D305/` 去掉 D，并改正文里
的附件链接；同一个编号两种名字都有时拒绝。`--upgrade` 把老的 open/answered 写成新的
节点状态。两个都可以重复跑。

`--attachments [--dry-run]` 把旧的一个全局 `## 附件` 块拆回每条记录真正该在的段落：
先看正文或某条追问里有没有直接提到这个文件，没有就看附件文件的时间离哪条追问最近，
还是看不出来就留在正文下面——不会瞎猜。拿不准的（比如同一个文件名在两条追问里都提过）
会在输出里单独列出来，位置不动，等人看一眼再决定。

---

## 进度：`nod progress` / `nod steps`（MUST FOLLOW）

owner 看不到你在干什么，只能看 `decisions/` 里写了什么——一次测试跑一个小时，中间
没有任何更新，owner 就只能在对话里问「现在到哪了」。下面这几条是为了让你不变成
一个需要被追问的黑箱。

**lane/任务开始时：**

```sh
nod add "跑全量测试" --task --author "<lane> · 在做什么"   # 打印它的 <id>
nod start <上面打印的 id>                                     # 它成为本会话的当前节点：后面的 nod progress / note / beat 不用再写 id
```

当前节点存在本机（`$NODDIT_HOME/session-nodes.json`），按会话区分（`NODDIT_IDENTITY`，没有就按
智能体程序自己的会话）。同一个会话里的几个子 agent 会互相覆盖，各自写明 id 或者设 `NODDIT_IDENTITY`。
`NODDIT_NODE` 仍然可用，设了就以它为准。

一个节点一次只代表一件正在做的事——不要把整条 lane 的所有工作塞进一个节点的
`progress`，一个阶段性任务换一个节点，用 `--after <上一个 id>` 接上，bench 才能
按顺序显示「接下来是什么」。`DECS_NODE` 是这个变量的老名字，`nod progress` 仍然
认它；`DECS_TASK` 是更老的别名，也一样认。

**跑测试这种有输出的，直接管道进去——不要自己解析进度再手动调用：**

```sh
pytest ... | nod progress --parse pytest        # 识别 "[ 37%]"，同时把 pytest 的输出原样传到 stdout
nod progress --from-file run.log --regex '(\d+)/(\d+)'   # 跟着文件增长，按 N/M 换算
nod progress --from-file run.log --until-exit $PID        # 跟到那个进程退出为止
nod progress --count-lines run.log --total 23              # 逐节重算：读一次当前行数
```

内置解析器：`pytest`（`[ NN%]`）、`percent`（任意 `NN%`）、`fraction`（任意
`N/M`）；不给 `--parse`/`--regex` 时三个都试一遍。节流到最多每 5 秒写一次文件，
但管道结束/文件读完时最后一次值一定落地。**没给 `--node`、没设 `NODDIT_NODE`/`DECS_NODE`、本会话也没 `nod start` 过，
这条命令直接报错退出，不会静默地什么都不做。**

**`--from-file` 会自动识别 noddit 的 JSONL 事件文件**（Python 包 `noddit`
的 `progress_events` / pytest 插件写的格式，`python/docs/progress-events.md`），
不用加 `--parse jsonl`：有 `total` 就按 `done/total` 算百分比，`"3823/10011 ·
2 failed"` 这样的短 msg 自动带上。

**跑测试/跑命令这种一条命令代劳更省事：**

```sh
nod run <id> -- pytest -q           # 标执行中、跟进度（自动设 NODDIT_EVENTS）、退出时收尾
nod run <id> --log run.log -- pytest -q    # 命令输出也追加写进 run.log
```

成功（退出码 0）自动 `nod done`，带计数/耗时/日志路径；失败自动留一条记录
（最后 20 行输出、失败的测试名）并 `nod hold --on "failing: …"`——「等待」是
现有状态里最贴切的失败标记，不是新开一种状态。退出码就是那条命令自己的。
跑在 Docker 里、事件文件挂在宿主机路径时，给 `--events <宿主机路径>`。

**多步骤的活（lead 的工作大多是这种），用 steps 而不是自己心算百分比：**

```sh
nod steps <id> "合并分支" "全量测试" "更新 changelog" "推送"
nod step <id> 2        # 第 1、2 步算完成，自动按 2/4 算成 50%，记一笔「step 2/4」
```

**收尾：** 做完 `nod done <id> [--note "..."]`；半路发现不用做了/被取代了用
`nod close <id> --reason superseded|obsolete|merged-into:W15`。活做着做着冒出
一个要 owner 拍板的问题，不用新开节点，`nod ask <id> -o 1="…" 2="…"` 把同一个
节点变成待决策，答复之后节点自己回到执行中。

**等外部。** 卡在同事、客户、供应商或某个服务上，`nod hold <id> --on "<谁/什么>"`：
状态变成「等待」，不算卡住；等到了 `nod start <id>`。

**延迟。** owner 可以把节点延迟（bench 里按 d / `nod defer`）：它从可用/活动/待决里消失，
状态不变；你收到「owner 延迟」就先停手，解除前别动它。

**owner 追问或反馈 = 轮到你了。** owner 在待决策的节点上追问、给反馈（在 bench 里，或在对话里
由你转记），节点就变成「待 AI 取走」，不再显示为「等你」。`nod read` 取走后它是执行中；
改好了要 owner 再看，用 `nod ask <id>`（不给 `-o` 就是把原来的问题再问一次）。

**没更新会被问，不需要你主动汇报。** 执行中的节点过了自己的 `stale_after`（没设就用
`checkin-after` 设置，默认 30 分钟；`nod add --stale-after 90m` 按节点自己改）还没更新，
monitor 会在下一行（或静默够久就单独）打一条 `NODDIT-CHECKIN`——收到就马上回：`nod progress`、
`nod note`，或没有新内容时 `nod beat <id>`（相当于「我还在做」，不留可见记录）。任何写入都算
回复，清零次数；连续问了 3 次没回，bench 才会标红。`nod show active --stale`（或 `--json`）
能自己查还有哪些过了阈值。

## owner 派活：接走 → 展开 → 确认（MUST FOLLOW）

owner 用几个字把活交给 AI：自己终端里的 `nod add "…"`（不带 -o / --task / --author 的裸 add 就是派活）、
bench 里按 `p`（选中节点下面）/ `P`（项目顶层）、app 的新建任务框。这个节点署名 owner，文件头 `intake: true`，
owner 的话原样放在 `## 原话（human · owner · …）` 下面，bench 里显示 ✎「你新派的」。

```sh
nod claim X120                     # 原子地接走；别人已经接了会说是谁（退出码 1），那就别碰
nod expand X120 --title "…" <<'EOF'
**做什么。** …
**为什么。** …
**做完的标准。** …（假设：…）
EOF
nod add --task "…" --parent X120 --after X121 --est 30m   # 拆子节点
nod ask X120 -o 1="按计划开始" 2="要改（回复里写怎么改）"   # 不设默认；答 1 之前不开工
```

- `nod expand` 只替换「原话」上面的描述；原话和下面的记录不动。没有「原话」段的节点（owner 手写的短节点，
  `nod claim` 之后）会先把旧描述挪进「原话」。
- `nod start` / `nod expand` 碰到没人接的派活也会先接走（同一个原子操作）。接走之后它就是你的：
  `--mine` 的 monitor 能收到 owner 在上面的答复，`nod ask` / `nod done` 不用 `--force`。
- owner 答 1 → `nod read`，照常执行；答 2 → 按意见再 expand、调整子节点，再 `nod ask`。
- 转述 owner 在对话里说的新活：`nod add --brief --author owner "<原话>"`。

谁在线：每个 `nod monitor` 在 `$NODDIT_HOME/sessions/`（老名字 `DECS_HOME` 也认）下维持心跳（pid、署名、终端程序、lead/teammate、
开始时间、最后心跳；30 秒一次，90 秒没更新或 pid 不在就不算）。`nod sessions [--json]` 列出来，
`nod bench --json` 每个项目有 `listening`，bench 标签下面一行 ● / ○。没人在线时 owner 派活，
终端里的 `nod add` 和 bench 会问要不要开一个会话：`nod session start [--agent claude|codex|kimi]`
开一个新的前台终端窗口（iTerm2 / Terminal / Windows Terminal / cmd / Linux 终端），在项目真实根目录里启动
agent，第一句话让它去接派活。已经有 lead 在线就不开。agent 自己不要 `nod session start`。

`$NODDIT_BRIEF_CMD`（老名字 `DECS_BRIEF_CMD` 也认）：没人在线时派活，会在后台跑这条命令（环境里有 `NODDIT_REF` / `NODDIT_TITLE` /
`NODDIT_PROJECT_ROOT` 等，老名字 `DECS_REF` / `DECS_TITLE` / `DECS_PROJECT_ROOT` 也设），由 owner 决定它做什么（通知、或者自己起一个 agent）。没设就什么都不做。
