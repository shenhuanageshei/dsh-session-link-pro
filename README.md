# dsh-team-link

> **更名通告（0.3.0）**：本插件原名 `dsh-session-link-pro`（0.2.4 及之前）。自团队升级（roster / 看门狗 / 广播 / 换届，见 `docs/team-upgrade-design-2026-09-17.md`）起，上游血统仅剩深链解析一段，故独立更名 `dsh-team-link`。历史日志中的 `session_link_pro_*` 工具名与 `slp-` 消息 id 前缀均为改名前记录，保持原样；`slp-` 前缀在改名后继续沿用（日志取证连续性）。首次加载 0.3.0 时自动把旧 `session-link-pro` 设置命名空间的信任数据（pairs / trustedSenders 等）迁移到 `team-link`。GitHub 仓库暂未改名，旧地址自动重定向。

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai) 的会话互联插件——[dsh-session-link](https://github.com/PwnKY/dsh-session-link) 的增强 fork。

在一个 DSH 实例里开多个会话干活时，会话之间是隔离的：看不到别的会话在干嘛、没法把 A 会话的结论交给 B 会话继续、想归档一个会话只能翻 UI。本插件补上这三块：

| 能力 | 说明 | 入口 |
| --- | --- | --- |
| 🔗 会话深链 | 复制 `dsh://session/<id>`，粘贴到任意会话即注入该会话只读快照（上游功能） | 会话头部按钮 / 粘贴链接 |
| 📋 会话列表 | 列出同工作区其他会话：主题、运行状态、最近消息摘要，以及**活性信号行**（verdict 五态 + goal 状态 + 静默时长 + 读数时效戳） | `team_link_list_sessions` |
| ⬇ 会话导出 | 全量事件导出为 markdown（可读）+ JSON（无损） | `team_link_export` / 会话头部 ⬇ 按钮 |
| 📨 跨会话消息 | 向另一会话投递消息，空闲目标自动唤醒并作为新回合响应；返回文案带 **busy 预判**（目标运行中时给出其当前回合已运行的分钟数与 steer 语义） | `team_link_send` |
| 📣 广播 fan-out | 一次投递给多个目标：会话 id / `team:<name>/<role>` / `team:<name>/*`（全队，仅该团队现任协调者）。逐目标独立过门、≤8 目标、逐目标结果行 + 汇总 | `team_link_send` 的 `targets` |
| 🏷 信封 banner | 可选 `meta`（type / pri / ref）渲染进投递 banner 首行，接收方与导出审计一眼看清消息性质；不扩 `source`（V10） | `team_link_send` 的 `meta` |
| 🔁 配对通道 | 双方各批准一次后，两个会话互发消息免确认（自动联调） | 接收确认时选「配对」 |
| 🐕 跨会话看门狗 | 给自己注册盯人：被盯会话出现失联征兆且你空闲时，插件向你自己的会话投递一条固定文案的 tick | `team_link_watch` |
| 🎭 团队 roster | 团队 → 角色 → 会话的身份注册表，含**版本史**（退役≠删除）与写入策略（默认只有现任协调者会话可写）；`<workspace>/team/<name>/roster.md` 是人可读镜像 | `team_link_roster` |
| 📋 团队黑板 | `<workspace>/team/<name>/` 下的 `decisions.md`（只追加的裁决账本，seq 由插件分配）与 `discipline.md`（整文件替换，baseHash 乐观锁）；任何会话可读可写，写入者记在行内 author | `team_link_team_read` / `team_link_team_append` |

## 跨会话消息语义

- 目标**运行中** → `steer`：消息在步边界注入其当前回合
- 目标**空闲** → `followup`：唤醒目标会话，消息作为**新回合**处理（立即显示消息并触发 LLM 响应，不会静默排队）
- 投递的消息 `source = { kind: "agent-message", form: "relay", senderSessionId }`——**恰好这三个成员**，这是 DSH 0.1.5 会话日志迁移唯一接受的跨会话中继形状（见下「会话格式兼容」）。发送方/时间/插件名都写在正文 banner 里（`📨 [跨会话消息 · 来自会话 <id> · <本地时间>]`；M3 起可选信封 `meta` 追加在同一行，见下「信封 banner」），接收方模型可直接看到并可用同一工具回发。消息 id 固定为 `slp-<uuid>`，UI 卡片靠它把自己的中继与上游相邻代理消息区分开。

### 批准门与配对

未配对时每次发送过两道门：

1. **发送方确认**：发送 / 记住该目标免确认 / 取消
2. **接收方策略**（`receiveMode: ask` 时）：接收 / 总是接收该发送方 / **配对：双向免确认** / 拒绝并屏蔽（超时约 3 分钟按取消处理）

接收方选择「配对」即在设置中写入 `pairs: [{a, b, createdAt}]`，此后这两个会话**双向免确认**直接投递；「拒绝并屏蔽」写入 `blockedSenders` 并自动解除配对——屏蔽始终优先于配对。

### 广播 fan-out（`targets`，M3）

`team_link_send` 一次可以发给多个目标。`targets` 与 `targetSessionId` **互斥**：两者都给是参数错误，两者都不给也是参数错误（单目标语义不变）。

| `targets` 项 | 解析优先级 | 谁能用 |
| --- | --- | --- |
| `session-xxx` | 直达该会话（最高优先级） | 任何会话 |
| `team:<name>/<role>` | 该角色的现任会话 | 任何会话；角色当前空缺（或该团队没有这个角色）→ **`no-holder` 结果**（不算投递也不算失败） |
| `team:<name>/*` | 全队：该团队全部**在任且存活**的角色（不含发起者自身） | **仅该团队现任协调者会话**，否则整次调用拒绝——理由见《调研》§5.3 论据 (a)：协调者的价值部分在于策展每个 worker 看到什么，而 flash worker 最稀缺的资源是上下文 |

- 单次最多 **8** 个目标（§4.1 防偏离），超出即拒绝；团队不在 roster 中或表达式形状非法 → **整次调用拒绝**（一条都不投，不做「半发」）；
- fan-out **不放宽任何门**：每个目标都照走完整的单目标路径（屏蔽检查 → 配对快路径 → 发送方确认 → 接收方策略 → steer/followup）。N 个未配对目标就是 N 次批准；确认服务不可用时逐目标 fail-closed；
- 返回逐目标结果行 `- <会话 id>[（via <表达式>）] → delivered | refused | no-agent | no-holder：<摘要>`，末行是汇总：

  `汇总：N 投递 / M 拒绝[ / A 无活动代理][ / K 空缺目标（no-holder，不计入投递与失败）][ / D 个重复目标已去重]。`

- 重复的会话 id（含不同表达式解析到同一会话）**去重后只投一次**，去重个数写在汇总里。

### 信封 banner（`meta`，M3）

可选 `meta: { type?: 'ruling'|'receipt'|'report'|'ask', pri?: 'P0'|'P1'|'P2', ref?: string }` 渲染进 banner **首行**的紧凑字段，只出现调用方给的键：

```
📨 [跨会话消息 · 来自会话「X」(session-x) · 2026-09-17 23:42:05 · type=ruling pri=P0 ref=slp-a1b2]
```

- `ref` 超过 **16 字符**按码点截断（不会切半 emoji），并在工具返回文案里明确注明截断前后；
- 枚举外的 `type`/`pri`、§3.4 未定义的字段、非对象 `meta`、空 `ref`、含换行的 `ref` → **明确参数错误、整次调用拒绝**（不静默丢弃、不部分采用）；
- fan-out 时所有目标共享同一 `meta`；
- **`source` 仍是恰好三成员**（V10 红线）：信封只走正文 banner，不扩 source、不做 sidecar 索引。

### busy 预判（M3）

投递成功的返回文案附带目标忙碌状态（fan-out 时逐目标独立）：

- 目标**运行中** → 追加 `目标回合已运行 N 分钟（steer 注入当前回合）；需新回合语义请等其空闲`。`N` 取自 M1 的 `turnStartedAt`（= `team_link_list_sessions` 活性行里的「回合始于」）；读不到该时间戳时只给 steer 语义、不给分钟数；
- 目标**空闲** → 保持原文案（已唤醒为目标新回合）。

### 消息卡片

接收方 UI 把跨会话消息渲染为醒目的 📡 卡片（📡 标题行 + 高亮左边条 + 发送会话 + 时间）：通过 `conversation.chat.node` keyed slot 以 `priority: -100` 影子替换 chat 包默认的折叠灰字行；非本插件消息（其他插件的 context 注入）经 `slots.entries()` 委托回原渲染器，显示不受影响。

判定条件不是「kind/form 命中」而是**本插件自己的消息**：`agent-message + relay` 正是上游相邻代理消息（`send_message`）用的形状，只按 kind/form 判断会把它们也渲染成卡片。因此卡片还要求命中本插件自己的两个特征之一——消息 id（在 chat node 上是 `node.id`，context 的 `data` 里没有 id）以 `slp-` 开头，或正文以 `📨 [跨会话消息` 开头；历史日志里的旧 `kind: "team-link"` 继续识别。卡片时间优先取旧日志的 `sentAt`，其次取 context node 自带的事件时间 `data.time`，最后才从正文 banner 里解析。

## 会话格式兼容（DSH 0.1.5）

0.1.5 的会话日志迁移（V0→V3）逐条校验每条 message 的 `source`：白名单外的 `kind`、或成员多一个少一个，都会让**整份会话日志**拒绝迁移（`SessionFormatUnsupportedMigrationError`，表现为「这个对话打不开」），且拒绝时不会破坏原始日志。旧版本的插件写的是 `kind: "team-link"`，正是这种会被拒的形状——所以 0.2.3 起改用上游自己的中继形状 `{ kind: "agent-message", form: "relay", senderSessionId }`（白名单见 `@deepseek-ai/dsh-session-format-v2-to-v3` 的 `SOURCE_KINDS`，`agent-message` 的成员集合被 `keys()` 锁死为恰好三项，多余信息只能进正文）。

已经在旧日志里的 `kind: "team-link"` 事件改不回来（`kind` 已烙在已发布的事件流里），需要外部工具改写原始日志或在导出前修复——修复方向即把 source 替换成上述三项形状，替换后迁移即可通过。

## 字符串安全：孤立代理项（0.2.4）

半截 emoji（孤立代理项，例如单独的 `U+D83D`）不是显示瑕疵。DSH 把工具结果**逐字**放进下一次模型请求的 JSON 体，非法 UTF-16 会让那次请求直接以 `400 INVALID_REQUEST` 失败；而这段文本已经写进调用方会话历史，于是**该会话此后每一条消息都以同一个 400 失败**（连 4 字符的 `test` 也一样），`INVALID_REQUEST` 又不在重试白名单里——会话永久不可恢复。

本地扫描 882 份会话日志，只有 5 份含真正的孤立代理项：走 deepseek-official 的 4 份**全部在下一次请求当场死亡**（0 条成功回复），走 qax 的 1 份存活。诚实交代：没有做重放实验（没有构造含孤立代理项的请求去打 API），这是观测相关性；但机制无争议，且「按码点截断」本来就是这两个函数应有的写法。

- **根因**：`preview()` / `truncate()` 用 `slice()` 按 **UTF-16 code unit** 截断，切割点落在代理对中间时只留下一半。凶器是列表工具的主题预览 `preview(topic, 90)`：emoji 恰好压在第 89 个 code unit 上。
- **修法一（不再制造）**：两个 helper 改为**按码点截断**（`[...str]` 按码点迭代），90 / 120 / 200 / 300 等限额与纯 BMP 文本的渲染结果完全不变；`truncate()` 的「已截断 N 字符」计数口径随之从 code unit 变成**码点**（更正确：原来一个 astral 字符被算作 2 个「字符」，却只输出一半）。
- **修法二（纵深防御）**：新增 `wellFormed()`（当前运行时用 `String.prototype.toWellFormed`，Node < 20 走等价正则）消毒**所有对外字符串**——列表工具正文、export 的 md 与 JSON、`team_link_send` 的两处批准提问正文、投递到目标会话的 banner（否则毒的是**接收方**会话）、拒绝文本里回显的目标 id（工具参数回显）、深链注入的会话快照（`agent/pre-step`，最直接进入调用方下一次请求的通道），以及三个工具 `output.render` 这最后一道模型可见出口（`dsh-tools` 正是用它把返回值变成工具结果内容块）。
- **客户端同理**：`shortSessionId()` 的 `slice(0, 14)` / `slice(-8)` 改为按码点切（`Array.from`），卡片正文、发送方 id、以及非本插件上下文文本的委托回退渲染都先过一遍 `wellFormed()`。这条路径只是显示——浏览器 DOM 的 USVString 转换本就会把孤立代理项变成 `U+FFFD`，且它不会再进入模型请求——属于显示层加固，不是会打死会话的那条链。
- **验收不变量**：本插件返回的字符串里**永远不出现孤立代理项**；把 emoji 摆在任意切割位置上，输出要么完整包含它、要么完整丢弃它。

## 活性信号与跨会话看门狗（M1）

### 活性信号（`team_link_list_sessions` 的 `活性：` 行）

每个会话行带一条活性信号（读一次 surface + 一次 agent 查询，纯服务调用，不解析日志）：

| 字段 | 含义 |
| --- | --- |
| `verdict` | 五态判定（见下表） |
| `代理` | `运行中` / `空闲` / `未运行`（`ctx.agents.get(id)`） |
| `goal` | `<phase>/<activation>(<已用轮次>/<上限>)`；blocked 另带 ` blocked=<code>: <message>`；`none` = 当前无 goal（或该会话没有存活代理可问）；**`?` = goals 服务缺失（降级运行，插件功能不受影响）** |
| `静默` | `now - max(末条 assistant, 末条入站)`，分钟；两侧时间戳都读不到时显示 `?` |
| 回合始于 / 末条助手 / 末条入站 | 绝对时间戳（本地时区） |

verdict 五态（阈值：静默 10 分钟、回合 30 分钟；`team_link_watch` 的 `silentMinutes` 只影响巡逻判定）：

| verdict | 条件 | 含义 |
| --- | --- | --- |
| `dead` | 无存活代理 | 会话已关闭：只有用户能处理（A4） |
| `long-running` | 运行中且当前回合已超 30 分钟 | 可能卡住，值得看一眼 |
| `goal-disarmed` | 空闲 + goal 为 `active` 但 disarmed | **根因级静默**：activation 不持久化，重启/回合 max-tokens 结束/agent error 都会落到这里，且不会自愈 |
| `silent-idle` | 空闲 + 无 goal + 静默超阈 | P1 场景（协调者等 worker 回报） |
| `ok` | 其余，含 `paused` / `blocked` / `complete` | 已被解释的静默（在等人类决策 / 已完结）或活跃 |

读数带时间戳：每行行尾是 `（读数 YYYY-MM-DD HH:mm:ss，>2min 作废）`——活性是快照，超过 2 分钟须重新读。

### 看门狗（`team_link_watch`）

`action: register` 只能**给自己注册**（`exec.agent.id` 即观察者，且 `targets` 不能含自己——自指等于变相的自 tick 定时器）。观察者空闲、且被盯目标出现 `silent-idle` / `goal-disarmed` / `dead` 时，插件向**观察者自己的会话**投递一条固定文案的 tick；观察者醒来后自己决定轮询、转派还是上报。

tick 策略（goal 状态决定，§3.7 四态）：

| 目标 goal 状态 | tick？ | 理由 |
| --- | --- | --- |
| `armed` + `active` | 永不 | 它有自己的续跑节拍，tick 只稀释节奏 |
| `active` + `disarmed` | **立即**（不等静默阈） | 根因级静默态；tick 文案带诊断与合规 resume 回路（转告用户 → 用户授权 → 模型自己 `update_goal(action:"resume")`；**插件绝不代调 resume**） |
| `paused` / `blocked` / `complete` | 不 tick | 在等人类决策 / 已完结，只在活性行展示 |
| 无 goal | 静默超阈才 tick | P1 场景 |

观察者侧：观察者**运行中**或自身 **armed-active** 时不 tick（绝不打断运行中的回合）；观察者代理不存在时不 tick、不改注册——该会话在 `list_sessions` 活性行里本来就是 `代理=未运行` / `verdict=dead`，`team_link_watch list` 另标 `观察者=dead（代理不存在，等待用户）`，注册保留到 TTL 到期自清（代理回来了就自然恢复投递）。

限制（防失控）：单会话最多 **3** 个注册；`silentMinutes >= 10`（默认 10）；`intervalMinutes >= 5`（默认 5，即巡逻间隔）；`ttlHours <= 24`（默认 12，到点自动清理）。`clear` 幂等（不存在的 id 返回「已清理 0 个」），只能清自己的注册。

tick 的实现约定：

- **source 三成员不变**：`{ kind: "agent-message", form: "relay", senderSessionId: <观察者自身> }`（V10 白名单；watchdog 自己没有会话身份，按 §3.2.3 取方案 (a)）；
- 消息 id 前缀 `slp-wd-`；
- **正文是插件常量模板**，只有状态字段插值（目标 id / 读数时间 / 静默时长），注册参数不进入正文——注册无法给观察者的下一回合夹带提示词；
- 去抖：同一目标「同一静默期最多一次 tick」（静默期以目标的末条活动水位为界，有新活动才算新静默期），且两次 tick 之间至少隔一个巡逻间隔（`intervalMinutes`）。去抖状态是进程内 Map，**不持久化**：重启即忘，宁可多一次 tick，也不留会误判的持久状态；
- 巡逻定时器随插件 dispose 一起清理（`ctx.effect`）。

诚实声明（A4）：看门狗只能提醒**活着**的观察者。观察者或目标任一方已关闭时，没有任何机制能唤醒它——插件只在信号面标 `dead` 等用户处理；「活会话节奏维持」是真实覆盖面，「失联恢复」不是。

## 团队 roster 与团队黑板（M2）

### roster（`team_link_roster`）

`teams` 键是身份层的事实源：团队 → 角色 → 会话，带版本史。

```yaml
teams:
  - name: night-shift            # [a-z0-9-]+，工作区内唯一（也是黑板目录名）
    createdAt: 1700000000000
    workspace: D:/work/night     # 首次创建团队时从该会话的 agentCwd 捕获，之后不再改写
    policy: { writer: coordinator }   # coordinator | any
    roles:
      - role: coordinator        # 约定角色名；自定义角色（reviewer 等）由 set-role 按需创建
        current: session-abc     # 现任；null = 空缺
        pending: null            # M4 rotation 的继任槽位，M2 只原样保留
        history:                 # 版本史：一段任期一条，`until: null` 表示仍在任
          - { session: session-old, from: 1700000000000, until: 1700009999999, note: 交班 }
```

| action | 效果 | 写权限 |
| --- | --- | --- |
| `get` | 全体团队概要；指定 `team` 时给出详情（含 pending 与整段版本史） | 任何会话可读，无门 |
| `upsert-team` | 创建（默认 `policy.writer=coordinator`、workspace 取调用会话的 `agentCwd`）或幂等更新 | 已存在的团队过写权限门；**重复调用不重置 roles / 版本史 / createdAt** |
| `set-role` | `current` 替换 + 版本史追加：旧任那条记 `until=now`（带 note），新任那条以 `until: null` 打开；角色不存在则本次指定即创建 | 过写权限门；**不迁移 pairs**——换届的信任迁移是 M4 rotation 的专属动作（§3.3.2） |
| `retire` | `current` 置空（vacant）+ 版本史记退役（`until=now`，带 note）。退役本身不动信任数据，随后弹**一个**确认对话框列出所有仍指向该会话的 `pairs`（双向）/ `trustedSenders` / `rememberTargets`，选「清理」才删除 | **仅现任协调者会话**或用户发起（§3.3.2 v1.3 逐字实现，与 `policy.writer` 无关） |

写权限（`policy.writer`）：

- `coordinator`（默认）：只有 `coordinator` 角色的**现任**会话（`exec.agent.id` 比对）可写；
- `any`：任何会话可写；
- `coordinator` 而现任空缺（`current: null`）：**一切会话调用都被拒绝**，提示改设置。这一条同时意味着团队的首任协调者、以及 coordinator 退役之后，都只能由用户经设置 UI 指派——`policy` 本身也只有用户能改（工具参数里没有 policy 槽位）。

### 黑板（`team_link_team_read` / `team_link_team_append`）

以 `team.workspace` 为根：

```
<workspace>/team/<name>/roster.md       # roster 镜像（插件在同一事务内 best-effort 写，失败只告警；settings 是事实源）
<workspace>/team/<name>/decisions.md    # 裁决账本：只追加，每行 `seq | ISO 时间 | author-session-id | 正文`，seq 由插件分配且单调递增
<workspace>/team/<name>/discipline.md   # 纪律条款：整文件替换，必须携带 team_read 返回的当前 baseHash（乐观锁）
```

- `team_link_team_read(team)` 一次读齐：roster 概要 + `decisions` 末 **20** 条 + `discipline` 全文 + 两个文件的 `baseHash`（sha256 前 16 位十六进制）。文件不存在按空处理并如实标注（含「空内容哈希」）。
- `team_link_team_append(team, file, line, baseHash?)`：`file=decisions` 只追加（无需 baseHash，正文必须单行）；`file=discipline` 整文件替换（baseHash 缺失或不匹配即拒绝并要求重新 `team_read`）。两者都受**单行 500 字符**上限（§4.1，按码点计）；`file` 是白名单枚举，任何路径形状都会被拒。
- 黑板**没有写权限门**（任何会话可写）：写入者身份记在 `decisions` 行的 author 字段里，透明可审计；`discipline` 的整文件替换靠 baseHash 串行化，最后的写入者记在工具返回里。

实现约定（设计未明说、按插件既有约定裁决的细节）：

- `workspace` 只在**团队首次由会话创建**时捕获；过后永不改写。用户经设置 UI 手工建的行若 `workspace` 为空，则第一次会话侧 `upsert-team` 会补记它（唯一一次例外，否则该团队的黑板永远没有根）。
- 版本史按**任期**记：一段任期一条记录，`until: null` 标在任；`set-role` / `retire` 关掉旧条目并写入 note。首次指派（无旧任）把 note 记在它打开的那条上，避免 note 丢失。
- 镜像里时间戳统一用本地 `YYYY-MM-DD HH:mm:ss`；`decisions` 行里的时间是 `toISOString()`（UTC，带毫秒），便于排序与外部工具消费。
- 没有会话身份（`exec.agent.id` 缺失）的写入仍被接受（黑板无门），author 记 `unknown`——不编造身份。
- `decisions` 写入是**读-算 seq-追加**（`appendFile`，不重写正文）：并发追加最坏只是两条同 seq，不会丢行——§3.3.3 只要求 `discipline` 带乐观锁。

## 策略配置

设置命名空间 `team-link`（设置 UI 可直接编辑；settings 服务不可用时降级为进程内记忆）：

| 键 | 类型 | 说明 |
| --- | --- | --- |
| `receiveMode` | `ask` / `accept` / `reject` | 默认 `ask`：逐条确认 |
| `trustedSenders` | `string[]` | 免确认接收的发送方会话 |
| `blockedSenders` | `string[]` | 拒收并屏蔽（优先级最高） |
| `rememberTargets` | `string[]` | 发送方免确认的目标会话 |
| `pairs` | `{a, b, createdAt}[]` | 双向免确认配对通道 |
| `watchdogs` | `{id, team, watcherSession, targets, silentMinutes, intervalMinutes, expiresAt, createdAt}[]` | 跨会话看门狗注册（由 `team_link_watch` 读写；到点自动清理。手改设置时缺字段的条目会被丢弃，不会让整个命名空间失效） |
| `teams` | `{name, createdAt, workspace, policy:{writer}, roles:[{role, current, pending, history}]}[]` | 团队 roster（M2，由 `team_link_roster` 读写；`policy` 只能由用户在此处改）。`name` 必须是 `[a-z0-9-]+`（它是黑板目录的路径段），`workspace` 是团队首次创建时捕获的会话工作目录、也是黑板 `team/<name>/` 的根；手改设置时非法团队名/无名角色会被丢弃 |

## 安装

### 方式一：本地目录 + 热装配（开发常用）

依赖通过 junction 复用 DSH 检出目录的 node_modules（免下载）：

```powershell
$dir = "<克隆目标目录>"              # 换成你自己的路径，例如 D:\dsh-plugins\dsh-team-link
git clone https://github.com/shenhuanageshei/dsh-team-link.git $dir
cd $dir
$nm = "$(Get-Location)\node_modules"
$dsh = "<DSH checkout 路径>\node_modules"   # DSH 检出目录下的 node_modules
New-Item -ItemType Directory -Force "$nm\@deepseek-ai" | Out-Null
foreach ($p in @('schemastery', '@deepseek-ai\cordis', '@deepseek-ai\dsh-session-reference', '@deepseek-ai\dsh-tools')) {
  New-Item -ItemType Junction -Path "$nm\$p" -Target "$dsh\$p" | Out-Null
}
```

然后用 dsh-super-injector 热装配进运行中的 shell：

```
dev_install_package { dir: "<你的目录>/dsh-team-link", profile: "web" }
```

或手动装配：profile `package.json` 的 `dependencies` 写 `"dsh-team-link": "link:<本目录>"`，`dsh.profile.bundles` 数组加入 `"dsh-team-link"`，重启 shell 生效。

### 方式二：npm/bundle 安装

`package.json` 声明了 `dsh.bundle.patch`（`cordis.patch.yml` 只插入本包自身一行），可按 DSH bundle 插件标准流程从包管理器安装。

> 注意：`cordis.patch.yml` 有意**不**插入 `session-reference` 行——DSH 已自带该服务（loader id 已存在），重复插入会导致 duplicate loader entry 启动崩溃。

### 依赖声明：宿主包一律走 peerDependencies

`@deepseek-ai/dsh-session-reference`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-ui-conversation`、`@deepseek-ai/cordis` 都由 shell 提供，因此声明为 **peerDependencies**（本仓库也是本地 junction 直接指向部署的那份）；只有与 shell 无身份耦合的纯库 `schemastery` 留在 `dependencies`。写成 `dependencies` 会在全新安装时拉进**第二份**同一个包（版本还可能落后于 shell），peer 则复用 shell 那一份。

版本区间写成 `^0.1.0-rc.6 || ^0.1.5-rc.1` 而不是单个 `^0.1.0-rc.6`：npm 的 semver 规定「预发布版本只有在区间里存在**同一 major.minor.patch** 的预发布比较符时才算满足」，所以 `^0.1.0-rc.6`（乃至 `*`）都匹配不到 `0.1.5-rc.1`——区间写窄了会在 0.1.5 上误报 unmet peer，甚至触发自动安装第二份。两个分支并列后，0.1.0-rc.6 / 0.1.4 / 0.1.5-rc.1 / 0.1.5 都满足。

### 依赖的宿主服务

`session-reference`（深链解析）、`user-questions`（批准门）、`settings`（策略持久化）、`session-query`（列表/导出）、`webServer`（导出下载路由）。DSH 默认装配均有。

## 测试

```
npm test                  # host 311 项 + client 42 项（合计 353 项）
node host-half.test.mjs   # 上游深链 9 例 + 工具注册/列表/导出/发送/配对全流程（含拒绝/取消/自发送/死目标守卫）+ 活性信号（verdict 五态判定表与两个阈值边界、goals 服务缺失降级、列表活性行与读数时效戳）+ 看门狗（注册校验全表、四态巡逻策略、tick source 三成员合规与正文常量化、去抖、TTL 自清、观察者 dead 分支、dispose 清理定时器）+ roster 与黑板（写权限三态与现任比对、upsert-team 幂等与 workspace 捕获、set-role 的版本史与「不迁移 pairs」、retire 的置空/版本史/两条清理对话框分支/无确认服务降级、镜像一致性与镜像失败降级、团队名与 file 白名单、decisions seq 与行格式与 500 字符上限、discipline baseHash 乐观锁的冲突与成功两路、末 20 条窗口）+ M3 广播（寻址解析与通配仅协调者、逐目标独立过门与无确认服务的 fail-closed、≤8 上限与整次拒绝、重复目标去重、no-holder 与团队不存在、单目标/广播互斥）+ 信封 banner（枚举校验全表、ref 按码点截断并注明、首行格式与部分键、source 仍三成员、fan-out 共享 meta）+ busy 预判（运行中分钟数 / 时间戳不可读回退 / 空闲原文案 / fan-out 逐目标）+ M2 评审跟进（R1 retire 清理竞态、R3 applyRetire 两条错误分支、R4 baseHash 语义断言）+ 孤立代理项安全（121 个偏移的属性测试、生产边界、预污染源、导出切点、提问与 banner）
node client-half.test.mjs # 浏览器端：卡片判定（旧 kind / 新形状 / 上游同形消息不得误判 / node.id 与 banner 双信号）+ 头部按钮 + 孤立代理项安全（astral id 截断、旧日志正文修复）
```

`host-half.test.mjs` 里那组 `AUDITED_SOURCE_KINDS` 断言是**迁移契约的回归锁**：它按 `@deepseek-ai/dsh-session-format-v2-to-v3` 的白名单与「恰好三成员」规则检查投递出去的 `source`，改坏了会立刻红。`client-half.test.mjs` 则锁定「上游相邻代理消息不得被误判成本插件卡片」这条容易复发的边界。两边新增的孤立代理项断言是**字符串安全的回归锁**：host 侧把 emoji 走遍 0..120 每一个切割偏移（其中恰好一个偏移在生产代码上留下半截 emoji），另加生产边界、预污染源、导出切点、两处批准提问、投递 banner、深链快照注入、poisoned targetId 回显与「快照缺失不得塞进 undefined」（最后一项同时锁 resolver 契约里 `additionalContext` 可选这条）；client 侧覆盖 astral id 的两个半截方向、旧日志正文、未截断的短 id 与委托回退文本。

## Changelog

- **0.3.3（M3，未发布；`package.json` 的版本号随发布统一 bump）** — 广播 fan-out + 结构化信封 banner + busy 预判（设计 `docs/team-upgrade-design-2026-09-17.md` §3.4 + §3.5 + §4.1 信封行 + §5.1 U5/U7）：`team_link_send` 新增可选 `targets: string[]`（与 `targetSessionId` 互斥；两者都给或都不给都是明确参数错误，单目标语义不变），按 §3.4 优先级解析「会话 id 直达 > `team:<name>/<role>` > `team:<name>/*`」；`team:<name>/*` 全队广播仅该团队**现任协调者会话**可发（否则整次调用拒绝，拒绝文案引用《调研》§5.3 论据 (a) 的策展理由），全队展开 = 该团队全部在任且存活的角色（不含发起者自身）；角色当前空缺或不存在 → 类型化 `no-holder` 结果（不算投递也不算失败），团队不在 roster 或表达式形状非法 → 整次调用拒绝（不做「半发」）；fan-out **不放宽任何门**——逐目标照走屏蔽检查/配对快路径/发送方确认/接收方策略，确认服务不可用时逐目标 fail-closed，N 个未配对目标就是 N 次批准；单次 ≤**8** 目标，逐目标返回 `delivered | refused | no-agent | no-holder` 结果行，末行 `汇总：N 投递 / M 拒绝[ / A 无活动代理][ / K 空缺目标][ / D 个重复目标已去重]`，重复会话 id 去重后只投一次并注明。新增可选 `meta: {type?, pri?, ref?}` 信封：渲染进 banner **首行**紧凑字段（只出现调用方给的键），`ref` 超 16 字符按码点截断并在返回文案注明截断前后，枚举外的值 / 未定义字段 / 非对象 / 空 ref / 含换行 ref 一律明确参数错误（不静默丢弃、不部分采用）；**`source` 仍是恰好三成员**（V10 红线不动，信封只走正文 banner），fan-out 时所有目标共享同一 meta。§3.5 busy 预判：投递后返回文案追加目标忙碌状态（运行中 → 「目标回合已运行 N 分钟（steer 注入当前回合）；需新回合语义请等其空闲」，N 取 M1 的 `turnStartedAt`，读不到该时间戳则只给 steer 语义；空闲 → 原文案不变）。顺带 4 项 M2 评审质量修复：**R1** retire 信任清理改为对话框确认后**重新 `policy.get()` 再按最新视图过滤写回**（读-改-写窗口从对话框时长缩到毫秒级；对话框期间新增的 pair/信任引用不再被回滚删除，对话框里列出的引用若已被别的变更删掉也不再计入）；**R2** `host-half.test.mjs` 的 TTL 断言不再依赖墙钟（注册前捕获时钟，断言 `expiresAt > createdAt` 且 `expiresAt > 捕获值`，断言语义不变）；**R3** 补 `__testing.applyRetire` 的两条错误分支断言（角色不存在、角色已空缺；纯函数 + 工具级各一组）；**R4** `team_link_team_read` 的 `decisions` baseHash 标注为「仅供参考/审计」（只有 `discipline` 的 hash 是乐观锁），工具 description 与返回文本同步修正。**本轮不含 M4（rotation / 令牌 / 迁移 / provisional）的任何实现**。`host-half.test.mjs` 净增 **76** 项断言（235 → 311，当次实测），既有 235 项不回归（client 42 项不变，合计 353）。
- **0.3.2（M2，未发布；`package.json` 的版本号随发布统一 bump）** — roster（团队身份注册表）+ 团队黑板（设计 `docs/team-upgrade-design-2026-09-17.md` §3.3 全节 + §4.1 黑板写边界 + §5.1 U4）：新增 `team_link_roster`（get / upsert-team / set-role / retire）、`team_link_team_read`、`team_link_team_append` 三个工具；设置命名空间 `team-link` 新增 `teams` 键（name `[a-z0-9-]+` 唯一、createdAt、workspace、policy.writer、roles[role/current/pending/history]）。写权限：`writer=coordinator`（默认）时只有该团队 `coordinator` 角色的**现任**会话可写，现任空缺时会话路径一律拒绝（提示走设置 UI），`writer=any` 时任何会话可写，读永远开放；`retire` 按 §3.3.2 v1.3 逐字实现为「仅现任协调者会话或用户发起」，效果是 current 置空 + 版本史记退役，之后可选**一个**用户确认对话框列出全部指向退役会话的 `pairs`（双向）/`trustedSenders`/`rememberTargets`，确认才清理（无确认服务则跳过清理、仅退役并在返回里说明）；`set-role` **不迁移 pairs**（信任迁移保留给 M4 rotation）。镜像：每次 roster 变更在同一调用内 best-effort 写 `<workspace>/team/<name>/roster.md`（人可读，失败只告警——settings 始终是事实源）。黑板：`team/<name>/decisions.md` 只追加（`seq | ISO 时间 | author-session-id | 正文`，seq 由插件分配、单调递增）、`discipline.md` 整文件替换（必须携带 `team_read` 返回的 `baseHash`，不匹配即拒绝并要求重读），两者单行上限 **500** 字符（§4.1，按码点计）；黑板**无写权限门**（任何会话可写），写入者记在行内 author。团队名 `[a-z0-9-]+` 白名单 + file 枚举白名单（一律 `path.join`，防路径穿越）；所有新增模型可见输出仍过 `wellFormed`，文件读写异常一律转成可读文本而不穿透工具调用。**本轮不含 M3（broadcast/信封 banner）与 M4（rotation/pending/令牌）的任何实现**——`pending` 只在 schema 与归一化里原样保留。`host-half.test.mjs` 净增 **67** 项断言（168 → 235，当次实测），既有 168 项不回归（client 42 项不变，合计 277）；非空断言用变异验证：把 writer 门与 baseHash 乐观锁各打一个洞后 host 红 8 项，还原即全绿。
- **0.3.1（M1，未发布；`package.json` 的版本号随发布统一 bump）** — 活性面 + 跨会话看门狗最小版（设计 `docs/team-upgrade-design-2026-09-17.md` §3.1/§3.2/§3.7）：`team_link_list_sessions` 每个会话行新增 `活性：` 信号行（verdict 五态 ok / goal-disarmed / silent-idle / long-running / dead、goal phase/activation/轮次与 blockedReason、静默时长、读数时间戳），goal 状态经 `ctx.get("goals")` **可选注入**（服务缺失时显示 `?`，插件功能完整降级）；行尾统一附「（读数 <时间>，>2min 作废）」。新增 `team_link_watch`（register / list / clear）：只能给自己注册、拒绝 target 含自己的自指、单会话 ≤3 个、`silentMinutes>=10` / `intervalMinutes>=5`（默认 5）/ `ttlHours<=24`（默认 12，到点自清）；巡逻按 §3.7 四态表投递 tick（观察者运行中或 armed-active 不 tick；目标 armed-active 不 tick；目标 active-but-disarmed 立即 tick 且文案带诊断 + 合规 resume 回路；paused/blocked/complete 不 tick；无 goal 且静默超阈才 tick）；tick 的 `source` 仍是 `{kind: "agent-message", form: "relay", senderSessionId}` 恰好三成员（V10，id 前缀 `slp-wd-`），正文是插件常量模板（只插值目标 id / 读数时间 / 静默时长）；去抖与「观察者=dead」标记为进程内状态不持久化；巡逻定时器随插件 dispose 清理。设置命名空间 `team-link` 新增 `watchdogs` 键（见「策略配置」表）；`host-half.test.mjs` 净增 93 项断言（M1 交付 87 项：U1 判定表与降级、U2 巡逻四态与 dead 分支、U3 source 合规与正文常量化；审计修复轮追加 6 项：dead/running/armed-active 三分支下的过期注册自清——host 75 → 168，当次实测），既有 75 项不回归（client 42 项不变，合计 210）
- **0.3.0** — 更名 `dsh-team-link`（原 `dsh-session-link-pro`）：包名 / cordis 名 / client bundle id / 工具名（`team_link_list_sessions` / `team_link_export` / `team_link_send`）/ 设置命名空间（`team-link`，含旧数据一次性迁移）/ 导出路由（`/team-link/export`）。不变量：`slp-` 消息 id 前缀、`dsh://` 深链协议、上游深链解析行为、双门投递语义。
- **0.2.4** — 修「孤立代理项」截断 bug（详见「字符串安全：孤立代理项」）：`preview()` / `truncate()` 改为按码点截断（原 `slice()` 按 UTF-16 code unit 切，emoji 落在刀口上只剩一半，毒死调用方会话），「已截断 N 字符」计数口径随之变为码点；新增 `wellFormed()` 并消毒列表正文、export 的 md+JSON、send 的两处批准提问正文、投递到目标会话的 banner、拒绝文本里回显的 `targetId`、深链注入的会话快照与三个工具的 `output.render` 出口；顺带修「resolver 省略可选 `additionalContext` 时把 `undefined` 塞进消息数组」；客户端 `shortSessionId()` 改码点截断、卡片正文/发送方 id/委托回退文本渲染前消毒；`host-half.test.mjs` 新增 20 项、`client-half.test.mjs` 新增 11 项（本次修复实测：把两个 `lib` 文件换回 0.2.3 时 host 红 13 项、client 红 5 项，换回修复版即 117 项全绿）
- **0.2.3** — 适配 DSH 0.1.5 会话格式迁移：投递消息 `source` 改为受审计的 `{ kind: "agent-message", form: "relay", senderSessionId }`（旧 `kind: "team-link"` 会让整份会话日志无法迁移/打不开）；卡片判定改从 chat node 的 `node.id` 读消息 id（context 的 `data` 里没有 id），叠加 `slp-` 与正文 banner 双信号，避免把上游相邻代理消息误渲染成本插件卡片；时间改为优先用 context node 的事件时间、正文 banner 承载投递时间兜底；宿主包从 `dependencies` 移到 `peerDependencies`，区间补上 `^0.1.5-rc.1` 分支（`^0.1.0-rc.6` 按 semver 预发布规则匹配不到 `0.1.5-rc.1`）；新增 `client-half.test.mjs`，`host-half.test.mjs` 增加迁移契约回归断言；导出路由文件名净化、策略写入去重
- **0.2.2** — 配对通道（双向免确认）；醒目 📡 消息卡片（keyed slot 影子渲染 + 委托回退）；消息 `source` 补 `form: relay` + `senderSessionId` 元数据
- **0.2.1** — 空闲目标投递改用 `followup` 唤醒（原 `inject` 只排队不唤醒，用户确认后目标无反应）
- **0.2.0** — 初版 fork：会话深链 + 会话列表/导出 + 批准式跨会话消息

## Credits

Fork 自 [PwnKY/dsh-session-link](https://github.com/PwnKY/dsh-session-link)（深链复制 / `/s/<id>` 打开器 / 深链上下文注入均保留自上游），感谢上游工作。

## License

MIT