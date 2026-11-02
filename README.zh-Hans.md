[English](README.md) · **简体中文** · [繁體中文](README.zh-Hant.md) · [Français](README.fr.md) · [العربية](README.ar.md)

# Noddit

你把一件两小时的活交给一个智能体——或者五个智能体，各管一块——然后就不去管了。
一小时后，其中三个卡在一个问题上，等在你没盯着的对话窗口里，你连哪个还在跑都
分不清。

**Noddit 给你的智能体一个地方放工作和问题，给你一个屏幕看着全部。智能体发问，
你按一个键答复，智能体当场收到，接着往下做。**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/WeCarbon/noddit/main/docs/app.zh-Hans.dark.png">
  <img alt="Noddit 桌面 app：「可用」视图，打开一个待决策问题，两个选项是卡片，还有进度条和一条等 AI 来接的新任务" src="https://raw.githubusercontent.com/WeCarbon/noddit/main/docs/app.zh-Hans.png">
</picture>

<sub>桌面 app——<a href="https://github.com/WeCarbon/noddit/releases/latest">下载 macOS、Windows、Linux 版</a></sub>

![演示：nod 看板打开就是一棵正在进行的任务树；读一个待决策问题，按一个键答复，然后 agent 用 nod read 取走答复](https://raw.githubusercontent.com/WeCarbon/noddit/main/docs/demo.gif)

<sub>在终端里</sub>

## 为什么

| 没有 Noddit | 有了 Noddit |
|---|---|
| 智能体在对话里问"A 还是 B？"，你没看到，它就等一个小时。 | 所有待决问题都在一个屏幕上，卡住智能体的排在最前面。 |
| 你答了，答案滚走了，下一个会话根本没看到。 | 问题和你的答复是 git 里的一个 markdown 文件，永久留着。 |
| "你在干什么？到哪了？"——你只能问，还得打断它。 | 每个任务都带进度条；不动了先变灰，再变红。 |
| 五个智能体共用一个 `TODO.md`，挑中同一个编号，互相覆盖。 | 每个任务是自己的文件、自己的编号；多少个智能体同时写都行。 |
| 你一走开，一切就停了。 | 每个问题都带默认值，写清楚不答会怎样；智能体照常做别的事。 |

它不是用来排计划的任务板。它是一条线，连着在跑的智能体和你：它的问题传到
你这里，你的答复传回它那里，两边都留得住。

## 看起来是这样

1. 智能体碰到一个选择。它不在对话里问，而是跑：

   ```sh
   nod ask W4 -o 1="Keep current CDN" 2="Switch to Fastly" --default 1
   ```

2. 你在任意终端跑 `nod`。W4 排在最上面，标着 ◆ 待决，带着两个选项和各自的
   代价。

3. 你按 `2`。

4. 智能体立刻收到通知，读到 "Switch to Fastly"，接着往下做。问题和你的答复
   都留在 `decisions/active/4-pick-cdn.md` 里，进了 git。

## 快速开始（Claude Code）

```sh
npm i -g @wecarbon/noddit
cd your-project && nod init
```

然后，在 Claude Code 里：

```
/plugin marketplace add wecarbon/noddit
/plugin install decs@decisions-md
```

就这样。照常给智能体派任务。它会自己用 nod 记录工作、提出问题。在另一个
终端跑 `nod` 看着就行。

用别的智能体？把 [`AGENTS.md`](AGENTS.md) 贴进它的指令——这些规则都是普通的
CLI 调用，任何能跑终端的智能体都能照着做。

## 三个词

- **节点** —— 智能体正在做的一件事。一个 markdown 文件。
- **待决** —— 一个需要你答复的节点。它带着选项出现；按一个数字就行。
- **看板** —— 跑 `nod` 看到的那个屏幕。全部内容，实时的。

这就是开始要知道的全部。剩下的内容讲的是它底层怎么运作。

---

## 思路

一种东西——**节点**——一个编号空间。

节点是 AI 要做的一件事。智能体自己知道怎么做，就直接做。需要先问负责人的，
节点就变成**待决策**，带着选项、默认值，以及没人回答会怎样。一个在跑的节点碰到
问题，不会另开一条新记录，它自己就变成一个问题，答复之后再变回执行中。

```
decisions/
  decs.json                                  # {"letter": "W"} → refs 读作 W12
  active/12-ship-v2-4.md                     # 一个还在进行的根节点
  active/12-ship-v2-4/13-run-test-suite.md   # 子节点住在父节点的文件夹里
  archived/9-rotate-api-keys.md              # 完成或关闭的，永久保留
  attachments/12/after.png
  .ids/12                                    # 零字节的占位（O_EXCL）
```

每个节点都是独立文件，编号用 `O_EXCL` 占位，所以任意数量的智能体都能同时写，
不会撞车。因为都是 git 里的 markdown，历史、diff、review、grep 全部免费拥有。

## 你能得到什么

**给人用的——看板。** `nod bench` 是一个覆盖你注册过的所有项目的实时终端 UI。
五个标签：

| 标签 | 看到什么 |
|---|---|
| **可用** | 现在能动的：在跑、在等人、可以开始、要你决定、已经答了 |
| **活动** | 正在发生的：只有在跑的和待决策的 |
| **待决** | 只看要你决定的问题，按项目分，先列卡住智能体的那些 |
| **全部** | 全部节点，完成的折进一行 `✓ 已完成 N` |
| **等待** | 卡在外部的：同事、客户、某个服务，等得最久的排最前 |

左边是带进度条和"多久没动"标记的节点树（超过 30 分钟不更新变灰，超过一小时变红）。
右边是选中节点的详情：状态、紧急程度、*"你不回的话会怎样"*、父节点、依赖、正文、
附件。按 `1`–`9` 答复，`Enter` 取默认值。截图在终端里直接渲染（iTerm2、kitty、
Ghostty、WezTerm）。

**给智能体用的——一套 CLI 和一份约定。** 智能体建节点、拆成子节点、报进度、问问题，
也会收到你答复的通知：

```sh
nod add "Ship v2.4" --task --author "lead · release"          # → W12
nod add "Run full test suite" --task --parent W12 --after W14
nod start W13
pytest | nod progress --parse pytest                           # 进度条自己走
nod ask W15 -o 1="Short & playful" 2="Plain & direct" --default 2 <<'EOF'
**What.** The first screen new users see after sign-up …
EOF
```

**不用轮询的通知。** `nod monitor` 每行打印一件智能体要处理的事——负责人的答复、
一条回复、外部来源来的新条目、五分钟没人取走的答案——并且记得每个会话看到
哪里了。Claude Code 插件会在整个会话期间自动起一个（`nod monitor --here`，
只盯当前项目）；连续两小时没事件会自己下线，打一行 `DECS-IDLE`。子智能体，或者
`DECS-IDLE` 之后的会话，用 Claude Code 的 Monitor 工具自己挂一个：

```
Monitor({ command: "nod monitor --mine", description: "nod", timeout_ms: 1800000 })
```

**依赖与顺序。** `--after W13` 会把一个节点拦住，直到 W13 完成。你仍然可以提前
答复问题；节点会以**待开始**的状态等着，轮到它再开始。

**外部来源。** 把一个很薄的适配器接到 GitHub issue、客服邮箱或反馈表单上。
它只同步*引用*（编号 + 标题，可选 url/状态/来源），绝不同步正文，绝不同步凭证。
看板的标题栏会按来源告诉你清了没、卡在谁手上：

```
外部来源 github-issues ✗ 未处理 2 等 W7 1   support-inbox ✓清了
```

**给任何要发出去的东西加审批关。** 用 `--approval-content` 附一份草稿，nod 会
记下它的 sha256。发送前，智能体跑 `nod approved W20 --check draft.html`——除非
*你*专门为*这份内容*选过批准项，否则就不通过。智能体把对话里的"发吧"当成你的
批准是行不通的。

**延迟。** 在任何东西上按 `d` 让它从眼前消失。它会离开各个工作视图，但状态不变；
正在做它的智能体会收到「负责人延迟」，解除之前就先停手。

## 安装

需要 Node 22.18+（TypeScript 直接运行，没有构建步骤）。

```sh
git clone https://github.com/wecarbon/noddit.git
cd noddit && npm install
export PATH="$PWD/bin:$PATH"          # add to your shell profile

cd ~/code/your-project
nod init --letter W                  # creates decisions/, registers the project
nod add "Try nod" --task --author "me · kicking the tyres"
nod                                  # the bench (same as nod bench); q to quit
```

### 配合 Claude Code

这个仓库同时是一个 Claude Code 插件市场。插件会在每个会话开头注入使用
规则（外加项目里还开着的节点，让恢复的会话能接着自己的活往下做），为整个
会话起一个 `nod monitor`，让你的答复不用轮询就能传到智能体，还会提醒智能体
在回复之前先把你在对话里说的话记到对应节点上。

```
/plugin marketplace add wecarbon/noddit
/plugin install decs@decisions-md
```

(`/plugin marketplace add /path/to/noddit` 对本地克隆也适用。)

完整的智能体用法在 [`AGENTS.md`](AGENTS.md)——如果你用别的智能体框架，直接把它
贴进你自己的 `AGENTS.md` / `CLAUDE.md`。这些规则都是 CLI 调用，任何能跑终端的
智能体都能照着做。

## 语言

`nod` 按下面的顺序选界面语言：

1. 任何命令上的 `--lang <code>`，比如 `nod bench --lang fr`
2. `NODDIT_LANG` 环境变量（老名字 `DECS_LANG` 也还认）
3. `nod config lang <code>`——按用户存在 `~/.decs/config.json`（即
   `$NODDIT_HOME/config.json`）。单独跑 `nod config lang` 会显示当前语言和它
   从哪来；`nod config lang --off` 会删掉这项设置。
4. 系统语言设置（`LC_ALL` / `LC_MESSAGES` / `LANG`，忽略 `C` / `POSIX`）：
   `zh_CN` → `zh-Hans`，`zh_TW` / `zh_HK` → `zh-Hant`，`fr_*` → `fr`，
   `ar_*` → `ar`
5. 这些环境变量都没设的时候，用操作系统的显示语言——纯 Windows 终端（cmd、
   PowerShell）就没有这些变量，nod 会按 Node 的 `Intl` 读到的结果来定
6. 否则就是英语——nod 没有对应翻译的语言，也会落到英语



可用代码：`en`、`zh-Hans`、`zh-Hant`、`fr`、`ar`。插件的会话开头
规则和提示提醒遵循同一套解析逻辑（`plugin/rules.<code>.md`）。

阿拉伯语是从右往左排的。`NODDIT_BIDI=visual|terminal`（老名字 `DECS_BIDI`
也还认，或者 `nod config bidi visual|terminal`，`--off` 取消）决定怎么排：`visual`
（默认）是 nod 自己用 Unicode 双向算法重排每一行，给那些只会严格从左往右画的
终端用（比如 macOS 自带的 Terminal）；`terminal` 是 nod 按逻辑顺序写，把嵌在
里面的从左到右片段（W12 这样的引用、数字、命令、英文标题）包进 Unicode
隔离符，给自己处理双向排版的终端用（开了 bidi 的 iTerm2、kitty、基于 VTE
的终端）。阿拉伯语下看板本身也会镜像：列表在右边，详情在左边。输出到管道和
`--json` 永远是逻辑顺序，脚本和智能体读到的不受影响。相对时间（"3 天前"这种）
也跟着语言走。

磁盘上的文件格式不会跟着语言变：nod 永远写同一批标题和词（`## 选项`、
`### 1 · …`、`## 已答（…）`、`## 回复（…）`、`## 补充（…）`、`## 附件`、
`## 子问题`、`验收通过`……），这样不管团队里每个人的 CLI 说什么语言，仓库都能
读。手写文件时，解析器也认 `## Options`、`## Attachments`、`## Questions`
这几个英文写法。见下面的[文件格式](#文件格式)。

## 一次会话是怎样的

1. 你给主控会话一个目标。它跑 `nod add "Ship v2.4" --task`，启动它，再拆成
   带 `--after` 依赖关系的子节点。
2. 它把各条工作线（子智能体）分出去，各带自己的节点。每条工作线把长命令接进
   `nod progress`，看板上的进度条自己走。
3. 一条工作线走到分岔口。它跑 `nod ask <id> -o …`，带着选项、代价和默认值。
   节点在你的看板上变成黄色的 `◆`。
4. 你按 `2`。`nod monitor` 叫醒那条工作线，它跑 `nod read`，接着干，最后
   `nod done <id> --note "412/412 passing"`。
5. 你从来不用问"现在到哪了"——下周，整个故事还在 `decisions/archived/` 里。

## CLI 速查表

| | |
|---|---|
| `nod init [--letter W]` | 在这里建 `decisions/` 并注册项目 |
| `nod add <title> [--task] [-o 1=… 2=…]` | 新建节点；带选项就是待决策。正文来自 stdin |
| `nod add <title> --parent W12 --after W13` | 子节点，排在另一个之后 |
| `nod start / done / close <id>` | 待开始 → 执行中 → 已完成 / 已关闭（`--reason obsolete\|superseded\|merged-into:W15`） |
| `nod ask <id> -o 1=… 2=…` | 在跑的节点需要负责人拍板 |
| `nod hold <id> --on "Carol: icon set"` | 卡在外部某人身上；不算卡住 |
| `nod progress <pct> "msg"` · `… \| nod progress --parse pytest` | 报进度（或者让一个管道自己报） |
| `nod steps <id> "a" "b" "c"` · `nod step <id> 2` | 多步骤的活，百分比帮你算好 |
| `nod note <id> "…"` | 追加一条记录（默认是智能体；`--human` 给负责人用） |
| `nod push <id> 2 [--note …]` | 记一条答复 |
| `nod monitor [--mine] [--here] [--idle-exit 2h]` | 智能体的通知流 |
| `nod read <id>` · `nod queue` | 取走答复 / 看还有哪些没取 |
| `nod attach <id> file [--approval-content --approve-on 1]` | 附一个文件；可以挂上批准关 |
| `nod approved <id> --check <file>` | 只有这份内容被批准过才退出 0 |
| `nod defer <id>` · `nod undefer <id>` | 延迟 / 解除延迟 |
| `nod show [open\|active\|deferred\|…] [--stale]` · `nod tree` · `nod get <id>` | 读这个存储 |
| `nod search <words> [--all]` | 标题、正文、记录、附件名 |
| `nod source register/sync/push/list/items/ack` | 外部来源 |
| `nod changes --since <t>` | 游标之后的一切，方便接上进度 |
| `nod bench [.\|<dir>…] [--view decide]` | 实时屏幕 |
| `nod` | 在终端里等于 `nod bench`；接管道或在脚本里时打印用法 |
| `nod config [<设置> [<值>\|--off]]` | 你的设置：lang、bidi、view、images、mouse、idle-exit、unclaimed-after（看板里按 `,` 也能改） |

编号可以写成 `305`、`W305`（项目字母）、`web:305`（项目名），或者老式的 `D305`。
`nod <command> --help` 有剩下的细节。

## 看板按键

| 键 | |
|---|---|
| `↑` `↓` | 移动 |
| `←` `→` · `-` `+` | 折叠 / 展开（跨会话记住） |
| `Tab` `Shift-Tab` | 切换视图 |
| `1`–`9` · `Enter` | 答复 · 取默认值 |
| `w` | 跳到下一个卡住智能体的节点 |
| `g` 或 `:` | 跳到一个编号 |
| `N` | 回复但不决定（节点回到智能体手上） |
| `d` | 延迟 / 解除延迟 |
| `X` · `A` | 带理由关闭 · 标记看过并归档 |
| `M` | 挪动模式：↑/↓ 在同一个上级下面（列表里是同一组）挪，⏎ 结束；app 里直接拖 |
| `i` · `o` | 挑选并查看图片 · 打开一个附件 |
| `j` `k` `Ctrl-F` `Ctrl-B` | 滚动详情面板 |
| `Z` · `?` · `q` | 简略正文 · 所有快捷键 · 退出 |
| `,` | 设置（语言、从右到左文字、鼠标等） |

鼠标也能用：点标签、节点、选项或附件；滚轮滚动鼠标所在的那个面板。

## 文件格式

节点是带 YAML 文件头的 markdown。人可以在任何编辑器里读它；智能体和
看板都走 CLI，由它来处理加锁和历史。

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

这些标题——`## 选项`、`## 补充（…）`，以及其他几个——都是固定的词，不会被翻译：
为什么，以及每个人怎么选自己的语言，见上面的[语言](#语言)。

状态：`not_started` 待开始 · `in_progress` 执行中 · `waiting` 等待 ·
`needs_decision` 待决策 · `decided` 已决策待 AI 取走 · `completed` 已完成 ·
`closed` 已关闭。子节点住在一个和父节点文件同名的文件夹里；编号是扁平的，
所以挪动一个节点只是改个文件名，所有引用照样成立。

## 设计原则

- **是文件，不是服务。** 一切都在 `decisions/` 里，跟你的代码一起进版本控制，
  不装 nod 也能读。
- **文件系统就是锁。** 编号来自 `O_EXCL` 文件；每次写都在自己的锁下重新读节点，
  通过先写后改名落地。二十多个并发写者拿到连续的编号，谁都不丢——这点有测试
  保证。
- **只有一种东西。** 任务和决策是同一个节点。概念更少，一个编号空间，一棵树。
- **人从来不用问。** 状态、进度、多久没动、卡在谁手上——全在看板上，不在
  对话里。
- **角色写清楚。** 每一段追加的内容都说明是人还是智能体写的、谁写的、什么
  时候写的。只有人的答复才能批准要发出去的内容。
- **从外面来的是引用，不是内容。** 外部来源只同步编号和标题；正文和凭证留在
  它们原来的地方。

## 常见问题

**这只是给 Claude Code 用的吗？**
不是。CLI 跟智能体无关——任何能跑终端的东西都能调用它。Claude Code 插件
加了会话开头的规则，并用 `CLAUDECODE` / `CLAUDE_SESSION_ID` 来区分智能体
的终端和你自己的，顺便标记是谁写的。其他地方，自己设 `NODDIT_ROLE=agent` 和
`NODDIT_SESSION`（老名字 `DECS_ROLE` / `DECS_SESSION` 也还认）。

**能用 git worktree 吗？**
能。`nod` 总是解析到主工作区的 `decisions/`，所以各条工作线的 worktree
共享同一个存储。

**同时管几个仓库？**
`nod init` 给每个项目注册一下；不带参数的 `nod bench` 会按项目字母分组，
打开全部项目。

**没人回答怎么办？**
每个问题都带一个默认值和一个 `--if-no-answer`。`nod wait --timeout` 会以
退出码 2 结束并打印默认值——这就是该照它继续的时候。

**能手动改文件吗？**
读是自由的。要写，用 CLI：它负责保持编号、锁、答复队列和附件历史的一致性。

**我有一份老的 `DECISIONS.md`。**
`nod migrate --dir <project> --dry-run`，确认没问题后去掉 `--dry-run` 再跑一次。

## Python SDK

Noddit 另有一个小小的 Python 包：[PyPI 上的 `noddit`](https://pypi.org/project/noddit/)（只用标准库，Python 3.10 以上）。它让 Python 里的长任务把进度报到节点上——测试或脚本跑在装不了 `nod` 的地方（比如 Docker 容器）时尤其有用。pytest 插件每跑完一条测试写一行 JSON；`progress_events` 让任何脚本也这样写。宿主机上用 `nod progress --from-file` 或 `nod run` 读这个文件，节点的进度条就跟着走。

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

事件格式见 [`python/docs/progress-events.md`](python/docs/progress-events.md)。

## 开发

```sh
npm test            # node --test
npm run typecheck   # tsc --noEmit
node scripts/render-screenshot.ts --out docs/screenshot.zh-Hans   # regenerate docs/screenshot.<lng>.svg/.png (mock data)
```

## 许可

[MIT](LICENSE) © 2026 WeCarbon
