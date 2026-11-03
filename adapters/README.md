# 适配器（adapter）怎么写

`nod source` 是一个通知系统，agent 接进来用的。适配器是你为自己项目写的一小段
后台进程（通常是 python，跑在后台 shell 里），负责把一个外部系统的「有什么」同步
进 `nod` —— 只有 id + title（可选 url/state/from），**绝不同步正文**，也**绝不
把凭证交给 nod**。凭证留在你项目自己的代码/环境变量里；nod 从来不直接访问 issue 跟踪、
邮箱或任何外部系统，它只看你喂给它的那几行 JSON。

拿 `example_sync.py` 当模板：复制到你项目里，把 `fetch_items()` 换成真的抓取逻辑，
其余不用动。

## 三步

1. **注册**（一次，或者让适配器每次启动时调用——`register` 是幂等的，不给的字段
   不会被清空）：

   ```sh
   nod source register github-issues --title "GitHub issues（v2.4 里程碑）" \
       --kind github --adapter "python3 adapters/github_sync.py --name github-issues" \
       --stale-after 15m
   ```

   `--stale-after` 是「心跳超过多久没来，就认为 adapter 可能挂了」——默认 15 分钟，
   轮询间隔比这个短得多，才不会一直显示「可能挂了」。

2. **同步**。两种方式，选一种：

   - **全量快照**（大多数情况用这个）：每次把你现在能看到的*全部*条目喂给
     `nod source sync <name>`，nod 自己 diff 出新增/变化/消失：

     ```sh
     nod source sync github-issues <<'EOF'
     {"id":"12345","title":"示例 issue 1","url":"https://example.com/issues/12345","state":"active"}
     {"id":"12346","title":"示例 issue 2","state":"new","from":"someone@example.com"}
     EOF
     ```

     JSON-lines 协议：一行一个对象，只有 `id`/`title` 必填，`url`/`state`/`from`
     可选。空行跳过。

   - **增量推送**：只知道一条变了，不想重新拉全量：

     ```sh
     nod source push github-issues --id 12345 --title "示例 issue 1（已解决）" --state resolved
     ```

   两个命令都会顺带更新心跳——不用再单独调 `nod source heartbeat`，除非你这轮
   确实没有新数据，只想证明自己还活着。

3. **后台跑起来**。轮询循环（`while True: sync(); sleep(interval)`），丢进后台
   shell。agent 这边另起一个后台 shell 跑 `nod source wait <name>`（和
   `nod wait` 一个哲学：不是常驻 watch，等到有未处理的 new/changed 条目就打印
   然后退出），退出就去处理，处理完 `nod source ack`，再重新 `nod source wait`。

## 处理掉一条

```sh
nod source items github-issues --unhandled     # 看有哪些还没处理
nod source ack github-issues 12345 --note "已经在 PR #42 里修了"
nod source ack github-issues 12346 --waiting-on Bob   # 转给人，不是挂起
nod source ack github-issues 12347 --waiting-on owner   # 建了个决策，等 owner
```

`--waiting-on` 的值原样存下来，nod 不解析也不改写：

- `owner` / `us`：还没真的了结，`nod source list` 的 cleared 会算上它们。
- 一个人的名字：交出去了，不算挡着 cleared。
- 一个节点编号（如 `W304`，nod 里决策和任务统一叫「节点」，共用一套编号，前缀
  是项目字母；裸的 `D304`/`304` 也认，当老格式）：说明这条外部通知催生了一个还
  开着的节点，同样算挡着 cleared。

## agent 怎么用它

```sh
nod source wait github-issues    # 放后台 shell；阻塞到有未处理的新/变化条目
nod source list                     # 心跳、未处理数、卡在谁手上，一眼看完
nod source events --since <ISO>     # wait 退出时会打印一个 since 游标，接着看
```

"清空"（cleared）= 这个来源没有未处理的条目，也没有条目卡在 `owner`/`us`/一个
还开着的节点上。owner 问「issues/邮箱/反馈是不是都清了」，`nod source list`
直接给答案，不用再问 agent。

## 规矩

- **只同步 id/title（+ 可选 url/state/from），不同步正文。** 外部系统的全文、
  邮件正文、反馈原文都不要喂给 `nod source sync`/`push` —— nod 的文件是一堆
  agent 和 owner 都能读的 markdown/JSON，正文该留在原系统里，需要时附一个 url。
- **凭证留在你项目的代码/环境变量里，绝不传给 nod。** `--adapter` 字段只是给人
  看的一行命令描述，不要把 token/密码写进去。
- **适配器挂了要看得出来。** 心跳是免费的（sync/push 自动带），别写一个
  「静默失败就不心跳」的循环——catch 住异常、打一行 stderr、照常进入下一轮
  sleep，让 `nod source list` 的 stale 检测能抓到「进程直接死了」。

## 只在有会话开着时同步：交给 nod monitor 跑

适配器如果能「同步一次就退出」（比如 `--once`），就不用自己在后台循环了：把这条单次
命令登记成来源的同步命令，主控会话的 `nod monitor`（plugin 每个会话自动起的那个）
活着时按间隔跑它，会话结束它也就不跑了。

```sh
nod source register github-issues \
    --sync-cmd "python3 adapters/github_sync.py --name github-issues --once" --every 10m
```

- 同一个来源同一时间只跑一份：上一次还没跑完，到点也不会再起一个，本机上几个主控
  monitor 也只有一个在跑。
- 命令退出码非 0 时，monitor 打一行 `DECS-ERROR`（带 stderr 最后一行），接着盯，
  下一轮照常跑；`nod source list` 会显示上次失败的原因。
- 只有主控的 monitor 跑；`--mine`（lane）和 `--updates`（窗口重画）的 monitor 不跑，
  `--no-sync` 关掉。monitor 因为空闲下线（`DECS-IDLE`）后，重新挂上才会接着跑。
- **命令只存在本机**（`~/.decs/source-sync.json`，按项目路径），不写进 `decisions/`。
  `decisions/` 可能被提交、被别人克隆，克隆一个仓库不能让谁的 monitor 去执行命令——
  在这台机器上用 `--sync-cmd` 登记一次，就是「我信任这条命令」的那一步。换一台机器要
  重新登记。`--no-sync-cmd` 删掉，`--every` 单独给就是只改间隔。

## Azure DevOps 工作项：`azure_devops_sync.py`

`adapters/azure_devops_sync.py` 是现成可用的适配器：按条件查 Azure DevOps 工作项，
同步成一个 nod 来源。每条只有 id、标题、url、state（可选 `from`），不读正文——
请求里根本不要 `System.Description`。

```sh
python3 adapters/azure_devops_sync.py --org contoso --project web \
    --type Issue --area web --tag feedback --name ado-feedback --once
```

| 参数 | 作用 |
|---|---|
| `--org` / `--project` | 组织和项目（必填） |
| `--type` | 工作项类型，如 `Issue`、`Bug` |
| `--area` | 区域路径，这个路径下面的都算，如 `web` 或 `web\Checkout` |
| `--tag` | 必须带的标签，可以写多次 |
| `--from-tag` | 哪些标签当成条目的 `from`，可用通配符，如 `--from-tag 'region-*'` |
| `--name` | nod 来源名（默认 `ado`）；第一次跑会自动 `nod source register` |
| `--azure-config-dir` | 用哪个 az 登录（就是 `AZURE_CONFIG_DIR`） |
| `--once` | 同步一次就退出，失败时退出码非 0；不加就每 `--interval` 秒轮询一次 |

认证用调用方自己的 az CLI 登录（`az account get-access-token`，资源是 Azure DevOps），
nod 不存 token，也不需要 PAT。一台机器上有几个 Azure 身份时，用 `--azure-config-dir`
指到对的那个 config 目录。

几个容易踩的点，适配器已经处理了：

- 响应开头带 UTF-8 BOM，按 `utf-8-sig` 解码。
- **登错租户时 Azure DevOps 回的是一整页 HTML**（常见标题「Identity has not been
  materialized」，有时是 HTTP 403，有时是 200），看着像「没登录」。适配器把它报成明确的
  错误、退出码非 0，并且**这一轮什么都不同步**——不会当成「0 条」把已有条目都标成消失。
  遇到了先看 `az account show` 里登的是谁，别急着重新登录。
- 一次最多读 200 条（`workitemsbatch` 的上限），多了分批。
- 输出按 id 排序，同样的数据重跑结果一字不差，nod 不会误报变化。

交给 nod monitor 在会话开着时跑：

```sh
nod source register ado-feedback --every 10m --sync-cmd \
    "python3 adapters/azure_devops_sync.py --org contoso --project web --type Issue \
     --area web --tag feedback --name ado-feedback --azure-config-dir ~/.azure-contoso --once"
```

脚本路径按你项目里放的位置写；用 npm 装的 nod，适配器在包里的 `adapters/` 下面。
