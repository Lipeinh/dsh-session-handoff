# dsh-session-handoff

[English](README.en.md) | 中文

DSH 插件：上下文压力到阈值时，把当前工作**交接给一个新会话**。

长会话到后段会退化（作者自测：约 70% 上下文后开始出现「只思考不输出」）。DSH 原生的 compaction 是
**就地压缩**——用摘要替换原文，历史被改写。本插件走另一条路：**开一个新会话 + 一份可审阅的
交接包**，旧会话原样留着。

- 按**真实上下文压力**触发，或按**本会话已被压缩的次数**触发（不是猜轮数）
- 交接包**从会话自身机械提取**（改动过的文件、用过的工具、最近几轮用户+助手消息、停在哪儿），落盘可审阅
- 桌面端 `handoff_now` 工具（支持 `dryRun` 试跑）/ web 端与命令行走 HTTP 接口
- 新会话建好后**界面自动切过去**（走 harness 的 `uiWorkspace.openSession`；web / 桌面端）
- **交接完成后自动终止原会话**——原会话不再继续回复、不再继续调工具，不会跟新会话抢同一批文件
- 旧会话**只改名加 ` [已交接]`**，不归档不删除

## 运行环境

- 开发与验证环境：DSH 桌面端 **0.2.0-rc.2**
- 自动切会话依赖 harness 的 `uiWorkspace.openSession`；**没有该接口的较早版本不会切、也不报错**，
  原因会写进 `$DSH_HOME/handoff-client-report.json`（见「已知限制」）
- 不需要单独安装 Node —— 用的是 DSH 自带的运行时

## 安装

### 桌面端（profile `desktop`）

```cmd
"<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-session-handoff
```

- `desktop` 是 Electron 保留的 profile，**只能用它自己那套内置命令**。别处装的 npm CLI 会直接拒绝：
  `error: profile "desktop" is managed exclusively by the Electron application`
- 先**打开过一次桌面端**（profile 才会被初始化），执行前**完全退出**它 —— profile 有写锁，不退出会一直等
- 桌面端 `$DSH_HOME` 默认是 `%USERPROFILE%\.dsh`，profile 目录即 `%USERPROFILE%\.dsh\profiles\desktop`

### web 端（profile `web`）

```bash
dsh plugin --profile web add dsh-session-handoff
```

- `web` profile **首次使用时自动初始化**，不用手工建；目录是 `$DSH_HOME/profiles/web`
- web 端跑在独立 home 时（启动脚本里设了 `DSH_HOME`），要用**那一套**的 `dsh`/`dsh.cmd`，
  否则会装进另一个 home

### 两端都一样的地方

装完**重启对应的那一端**——bundle 列表只在启动时读一次。其余：

- npm 包名是 `dsh-session-handoff`（`dsh-handoff` 这个名字已被另一个插件占用）
- 一条命令会同时把包写进 profile 的 `dependencies` 和 `dsh.profile.bundles`，不用手动改文件
- 不走 npm 也行：`add github:easerlee/dsh-session-handoff`（同样的代码，只是每次装都拉仓库）

确认挂上了（web 端 / 命令行）：

```bash
curl "http://127.0.0.1:<端口>/api/handoff/status"
# {"ok":true,...,"tool":"registered"}   ← tool 为 registered 说明 handoff_now 工具也注册成功
```

## 卸载

```cmd
:: 桌面端 —— 同样：先完全退出桌面端，再用它自己那套内置命令
"<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove dsh-session-handoff
```

```bash
# web 端
dsh plugin --profile web remove dsh-session-handoff
```

不想卸也可以**先关掉**：在 profile 的 `cordis.patch.yml` 里把 `enabled` 设成 `false`
——插件还在，只是不再自动交接（`handoff_now` 工具与 HTTP 接口仍可用）。

卸完同样要**重启那一端**。卸载不会动你已经生成的交接包（`.dsh/handoff/` 下的文件仍留着，
要清自己删）。

## 用法

### 桌面端：`handoff_now` 工具（推荐）

> 你：「帮我交接一下，换个新会话」
> agent：调 `handoff_now` → 返回新会话 id / 标题 / 交接包路径，**同时原会话被终止**（不再继续回复）

第一次想先看交接包质量、不想真建会话：

```
handoff_now(dryRun: true)     # 只落盘，不建会话、不改旧会话名、不终止原会话
```

不想要「交接后停掉原会话」这个行为，把配置里的 `stopOldSession` 设成 `false`。

### web 端 / 命令行：HTTP 接口

```bash
# 手动触发（不传 sessionId 就取最近一个活跃会话）
curl -X POST http://127.0.0.1:<端口>/api/handoff/run \
  -H "content-type: application/json" \
  -d '{"reason":"手动换会话"}'

# 状态与上次结果
curl http://127.0.0.1:<端口>/api/handoff/status
```

`dsh web` 地址栏里的 `?token=` 是凭证（先访问一次 `/` 让 cookie 落下来，之后 API 才认）；桌面端
没有地址栏，手动触发走上面的工具。

### 自动触发

满足任一条件、且距上次交接超过 `cooldownMs` 就自动交接：

- 压力到 `thresholdRatio`
- **本会话已被压缩 `maxCompactions` 次**（默认 2）

第二个条件是必需的：compaction 每次都会把压力压回它自己的阈值以下，只看压力的话交接等不到触发点。
两边怎么配合，见下。

## 配置

在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: dsh-session-handoff
  config:
    enabled: true
    thresholdRatio: 0.85     # 出厂默认 0.6；与 compaction 一起用时调高
    maxCompactions: 2        # 本会话被 compaction 压过几次就交接（0 = 只看压力）
    cooldownMs: 300000
    handoffDir: .dsh/handoff
    recentMessages: 14
    maxChars: 24000
    renameOldSuffix: " [已交接]"
    dryRun: false
    stopOldSession: true
    stopDelayMs: 300
```

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉就只留 HTTP 接口与工具，不做自动交接 |
| `thresholdRatio` | `0.6` | 压力到多少比例触发（0.6 = 60%）。与 compaction 一起用时调高，见下 |
| `maxCompactions` | `2` | 本会话被 compaction 压过几次就触发交接（`0` = 只看压力） |
| `cooldownMs` | `300000` | 同一会话两次交接的最小间隔 |
| `handoffDir` | `.dsh/handoff` | 交接包落盘目录（相对工作区；写绝对路径也行） |
| `recentMessages` | `14` | 用户消息段最多带多少条（每条截 400 字） |
| `maxChars` | `24000` | 交接包字数上限；余量按预算分给两个消息窗口，塞不下先丢更早的 |
| `renameOldSuffix` | ` [已交接]` | 旧会话改名时加的后缀 |
| `dryRun` | `false` | **true = 只生成交接包，不建新会话**（首次验证用） |
| `stopOldSession` | `true` | 交接成功后**终止原会话的进行中回合**，让它彻底停手 |
| `stopDelayMs` | `300` | 终止前的让出时间（毫秒），等本次工具结果先落盘；`0` = 立刻终止 |

⚠️ patch 的 `config` 是**整段替换**，覆盖时必须把不想改的键一起写上。

## 交接后原会话会被终止

这是默认行为（`stopOldSession: true`）。没有它，交接只是「又开了一个会话」——原会话那一边仍在
回话、仍在调工具、仍在烧 token，两边同时改同一批文件。

终止走的是 harness 自己的停止原语 `agent.cancel({ kind: 'user' }, { keepInbox: false })`，
也就是界面上「停止」按钮的同一套语义：

- 当前回合的 `AbortSignal` 立即 abort，回合以 `turn/end { kind: 'aborted', reason: { kind: 'user' } }` 收尾
- `keepInbox: false` 会**同时清掉排队的下一条输入**；这一条是关键——保留队列的话，
  回合中止后循环会拿残留队列**再开一回合**，等于没停
- 会话日志、界面状态都按正常路径落盘，旧会话不会被删、不会被归档，随时可以回去翻

时序上有一个刻意的让出：终止是**从原会话自己的 `handoff_now` 工具调用里发起的**，而这个工具的
结果（新会话 id、交接包路径）要等 `execute` 返回后才提交进日志。若在返回前就 abort，工具结果会被
打断管线改写成「已取消」，交接回执就看不见了。因此先让出 `stopDelayMs`（默认 300ms），
再按下停止键——结果是：**交接回执完整，原会话停手**。

副作用是有意为之：这 300ms 里原会话若已发出下一个模型请求，那个请求也会被一起掐掉。

`stopOldSession: false` 可以关掉这个行为（回到旧版：只交接、不停原会话）。

终止状态会出现在三处：`handoff_now` 的返回值、`GET /api/handoff/status` 的 `lastResult.stopped`、
以及宿主日志。取值含义：

| `stopped` | 含义 |
|---|---|
| `canceled` | 已按下停止（含延后执行中的） |
| `idle` | 原会话本来就空闲、队列也空，无需终止 |
| `not-live` | 该会话不在本进程活跃表里（冷会话，没有在跑的东西） |
| `disabled` | `stopOldSession: false` |
| `failed` | 取会话或调用取消时出错，原因在 `stopped.error`（`handoff_now` 工具里是 `stopError`） |

助手消息段没有单独的条数配置：它吃用户消息段之后剩下的预算，**从最新往回填**，每条最多 600 字；
预算不够时丢掉的永远是更早的消息，最新的那条一定在（它就是「停在哪儿」）。

## 交接包里有什么

落盘文件是 Markdown，四块内容，全部从会话自身**机械提取**，不经过模型：

| 块 | 内容 |
|---|---|
| 改动过的文件 | 本会话动过的路径（最多 120 条） |
| 用过的工具（次数） | 按调用次数排序的前 12 个工具 |
| 最近几轮消息 | 用户消息段 + 助手消息段，各按预算从新往旧填，塞不下先丢更早的 |
| 停在哪儿 | 最后一条助手消息（截 2000 字）——接手方从这里开始 |

## 与 compaction 的关系

两个都开着时，**阈值不同**：

| | 阈值 | 行为 |
|---|---|---|
| `compaction-basic` | `0.6`（默认） | 就地压缩，会话继续用 |
| `dsh-session-handoff` | `0.85`（建议值，高于 compaction） | 开新会话交接 |

插件出厂默认也是 `0.6`，和 compaction 的默认阈值相同。两个都开着时，compaction 每次都会先把压力压回
自己的阈值以下，所以只看压力的话**交接等不到触发点**。交接因此还看压缩次数：本会话被压过
`maxCompactions` 次（默认 2）就换班——compaction 管日常，压够了就交出去。

想让 handoff 当主力（不看压缩次数、纯按压力交接）：把 `compaction-basic` 设回 `disabled: true`，
`maxCompactions` 设 `0`，`thresholdRatio` 保持默认的 `0.6`。

## 已知限制

1. **自动切会话需要 harness 提供导航接口**——走 `uiWorkspace.openSession`；该接口不存在时
   （较老的 harness）就不切，也不报错，`$DSH_HOME/handoff-client-report.json` 里会写明原因
2. **交接包是机械提取的原文摘录，不做模型总结**——四块内容：动过的文件、用过的工具（含次数）、
   近几轮用户/助手消息、停在哪。助手消息里的决策句就是原始决策记录，但「哪条才是关键」要接手方自己判断
3. 旧会话只改名不归档（有意）
4. HTTP 接口只作用于**该宿主进程里活跃的会话**：刚起来、还没开过会话的实例会返回
   `没有可用会话（session 缺失）`
5. **终止原会话只对活跃会话有效**：原会话已被卸载/进程重启过时返回 `not-live`，
   此时也没有在跑的东西需要停
6. **另有一个同名插件**：同样叫 `dsh-session-handoff`，走源码/tarball 分发，靠 `/handoff` 手动触发、
   总结由模型生成；npm 上的这个名字是这份（带自动触发）

## 开发与测试

零运行时依赖（`@deepseek-ai/*` 是 DSH 自带的 peer，不需要安装）。回归测试自包含，
不需要先装好 DSH：

```bash
node test/handoff-stop.test.mjs
# ALL PASS（36 项断言）
```

测试会临时搭一个沙箱：把本仓库的 `lib/index.js` 复制进去，配上
`@deepseek-ai/dsh-llm` / `dsh-tools` 的最小替身（真实模块打包在 DSH 的 `app.asar` 内，
普通 Node 解析不到），然后跑三层检查——单元分支、HTTP 端到端、工具输出契约。
`test/.sandbox/` 用完即删，已在 `.gitignore` 里忽略。

## 版本历史

见 [CHANGELOG.md](CHANGELOG.md)。

## 仓库

源码：<https://github.com/Lipeinh/dsh-session-handoff>

问题与建议请开 issue。

## License

MIT。本项目基于 [easerlee](https://github.com/easerlee) 的
[dsh-session-handoff](https://github.com/easerlee/dsh-session-handoff) 修改，
保留原作者版权；`0.2.0` 起新增的「交接后终止原会话」等改动见 CHANGELOG。
