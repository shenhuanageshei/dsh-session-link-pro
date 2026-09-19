# Changelog

本文件记录 `dsh-team-link` 的变更史。版本号策略：`package.json` 的版本号**随发布统一 bump**——开发期累积的条目先记为「未发布」，发布时一次性收口（例如 0.3.1–0.3.6 的条目在 0.3.7 发布时一并落定）。

格式：每个版本按 **修了什么 → 为什么 → 怎么验证** 组织。凡涉及行为修复的条目都附**变异验证**证据（修复前必红 / 修复后全绿），这是本仓库的验收文化。

---

## 未发布 — 发送方可见性（设计 §10.1 A+D）

> 让**发送方自己**也看到自己发出的跨会话消息卡片（此前只有接收方有卡片，发送方只看到一行藏在可折叠工具树里的灰字）。设计与裁决记录：`docs/collab-enhancements-design-2026-09-19.md` §10.1、`docs/consult-minutes/2026-09-19-consult-37-minutes.md`。
>
> **未发布状态**：宿主半边需 DSH 重启才在真机生效，演练 8（真机验收）**尚未执行**。

### ✨ 新增
- **A：`tool.call.toolview`（key 逐字 `team_link_send`）**——发送方的工具行从通用灰行变成与接收方同款的出站卡片（逐目标 outcome / detail / busy）。
- **D：自有 conversation node definition（kind `team-link-send`）+ 顶层摘要卡**——在会话流**顶层**多一条「发给谁 / 正文 / 汇总计数 / 时间」。**不写任何日志事件、不动模型上下文**。
- **数据链：`output.presentationMeta` → `tool/result.meta`**——卡片读**结构化回执**，不再 regex 解析工具返回文本；持久化后可回放重建同一张卡。

### 🔧 修复（差异审计与代码评审发现）
- **F2（仓库自身良构红线）**：`targets[].sessionId` / `expr` / `senderSessionId` / 信封 `type|pri|ref` **未经 `wellFormed`**——会把孤立代理项写进会话日志。已全部过闸 + 6 条回归锁（此前代码注释与 README 的「永远良构」自述**不成立**，已改）。
- **F1**：A/D 两面曾逐字重复 head/body/summary/foot。已按「每块信息只准出现一次」分工（D = 标题+时间+正文+汇总；A = 标签+逐目标行）。
- **F3**：客户端**模块级** inject 新增 `uiConversation`，会把设计承诺的「只不渲染」放大成「整个客户端半边不加载」。已改回 3 项 + 动态注入。
- **B3 / 评审 #3**：四条客户端注册全部过 `guardedSlot`（一条抛错不影响其余）。
- **评审 #1**：文件头注释曾称空闲目标「queued without being woken (inject)」，实际是 `followup`；已改。
- **评审 #2**：客户端对 `targets` 行数设界（24）+ 显式截断标注（宿主侧同源缺口见下）。

### 🧱 宿主侧行数界（设计 §10.1.2 修正后补）
- `buildSendCard` 对 `targets` 封顶 **24 行**，并写入 `targetsTruncated: {shown,total}`；裁的是**呈现**——`summary` 计数与文本报告仍**全量**（卡是有界呈现，报告是全量档案）。
- 背景：输入侧的 ≤8 只约束**表达式**，而一个 `team:<n>/*` 会在宿主侧展开成**全队成员的行**——所以「持久化卡片必须有界」这条原设计**在宿主侧并不成立**，本轮补上。

### ⚠️ 遗留（未随本轮修复）
- **客户端尚未读 `targetsTruncated`**：宿主已先裁到 24 行后，客户端「自己数行数判超限」的路径对**自产卡永远不触发**——A 面因此看不到截断标注，标签显示的是**已画出的行数**而非真值总数（真值只在卡内 `targetsTruncated.total` 与 D 面汇总里）。已在 README 如实声明，待收尾轮补。

### 🧪 验证
- `node host-half.test.mjs` → `564 (failed: 0)`；`node client-half.test.mjs` → `130 (failed: 0)`（本轮前基线 506 / 46）。
- 变异证据（单点回退，修复前必红）：正文截断去掉 → 5 红；结构化 busy 去掉 → 3 红；槽位 key 改近形 → 3 红；不读回执 → 12 红；窗口截断回退去掉 → 2 红；**F2** 的 `sessionId` / `expr` 孤立代理项 → 各 1 红；**评审 #2** 渲染上限去掉 → 2 红；**评审 #3** header 注册去掉护栏 → 2 红；**宿主行数界**去掉 → 3 红。
- 真机未验证：宿主侧改动需 DSH 重启生效。

---

## 0.3.7 — 2026-09-18（当前版本）

> 收尾修复轮。修两个在**真实部署中实测到**的功能性阻塞，并收掉一轮代码评审的分歧。设计与裁决记录：`docs/team-upgrade-design-2026-09-17.md` §9、`docs/consult-minutes/2026-09-18-consult-36-minutes.md`。

### 🔴 ① settings 持久化静默失效：团队状态从不落盘

**症状**（真实部署实测）：`team_link_watch register` 返回成功、`list` 也能看到条目，但 `profile/settings.yaml` 的 mtime 与全文**毫无变化**；日志里也没有任何本插件的 warn。后果：teams / watchdogs / pairs / rotation **全部只活在进程内存里**，每次 DSH 重启清零。盘上从来没有 `team-link:` 段——也就是说**自 0.2.x 起信任数据从未落盘**，「改名迁移已完成」这个当时写进交付报告的结论是错的。

**根因**（源码链）：cordis 的 `ctx.get(name, strict = true)` 只返回**提供方 fiber 已 active** 的服务（`cordis/lib/index.js:762-771`：`if (strict && impl.fiber.state !== 2) return;`），而 settings provider 要先完成 `[Service.init]`（读盘 → publish）才 active。插件却在 `apply` 期**一次性**取服务，取不到就静默退回内存引擎——此后**无重试、无重绑定、无日志**（只有 `register` 抛错那条路径才 warn，而日志里从未出现该 warn，故该路径也被排除）。

**修法**（三件套）：

1. **快路**：立刻试一次 `ctx.get("settings")`——提供方已 active（或同步 stub）时零额外延迟挂载，既有测试语义不变；
2. **可选有序注入**：没拿到就留**一行 warn**，并登记 `ctx.inject(["settings"], cb)`——provider 转为 active 时回调 attach。它**不是硬依赖**（服务永远不出现时插件照常加载并降级）；`ctx.inject` 本身不可用时再留第二行 warn；
3. **运行期惰性重试**：`get()` / `update()` 每次发现未挂载就再试一次；成功即挂载并记一行 info（`policy store attached to settings namespace "team-link"`）。失败**不重复告警**——「未挂载告警」有**两条到达路径**（激活时未 active / active 但 `register()` 抛错），二者共用同一个一次性门，故**每个未挂载窗口有且仅有一行 warn**。

**同类第二处一并修**：`registerExportRoute` 原先同样在 apply 期取 `ctx.get("webServer")` 时点快照（它当时能用，只因 webServer 恰好先于本插件 active——日志里从未出现该处 warn 即为此反证）。改用同一「晚挂 + 重试」模式，**降级语义一字不变**：始终没有 webServer 就只有一行 warn、头部导出按钮不可用，而 `team_link_export` 工具照常工作。

**启动窗口的数据一致性**（防御性冗余）：attach 之前 `update()` 只能写进进程内存，而这个窗口理论上不可达。真发生时，attach 会把这些内存写入按与改名迁移同形的规则并入设置命名空间（**仅当**设置侧仍是默认值——settings 始终是事实源），并留一行 warn，不静默丢写；并入**先于**改名迁移执行，迁移的「当前命名空间已在用」判据因此看到最终状态。

**明确不采用**的做法：把 `settings` / `webServer` 加进 `inject` 数组：`inject` 是**硬依赖**，依赖缺失时 cordis 令整个插件 fiber 不激活，与「服务缺失时插件完整降级」这条红线相抵；而 `ctx.inject` 与 `inject` 在确定性上等价（同样等 provider 完成 `[Service.init]`），故取零功能回归者。

### 🔴 ② 建队引导死锁：团队建了却永远写不进首任协调者

**症状**：模型能成功 `upsert-team` 建出团队，但**永远**设不进首任协调者，团队到手即只读，M2–M4 全部功能不可达。

**根因**：`upsert-team` 的**创建**路径本就不该过写权限门（否则没人能建第一个团队），但 `set-role` **必然**过门——而门在「`writer=coordinator` 且现任空缺」时**拒绝一切会话路径**。于是创建路径与写权限门之间形成了一个死锁。工具文案当时把用户推向「设置 UI」，但插件并没有提供该设置段，人路径实际是手改 `settings.yaml`——而 ① 又让手改同样读不到。

**修法**：`upsert-team` 在**创建**路径把**调用会话**播种为该团队的 coordinator 现任（经 `roleRecord` 产出规范形状，`history` 记「创建者自举」）。已存在团队的 `roles` 一律不改（幂等契约与「非现任不能借 upsert-team 劫持」同时保住），**不新增任何工具参数**（种子只来自 `exec.agent.id`），`writerGate` / `retireGate` **一行未动**——**手写**的空缺行仍然全拒并指向设置 UI（那是用户显式表达的状态）。

### 配套修复

- **导出文件名安全不变式**：web 导出路由对 `sessionId` 有净化（`replace(/[^\w.-]/gu, "_")`），而 `exportSession` 把原始 id 直接拼进产物路径。抽成共享 helper `fileSafeSessionId()`，两条路径复用。
- **旧命名空间 register 失败必须留痕**：原先 `catch { legacyScope = null; }` 静默吞掉——best-effort ≠ 静默，现在留一行 warn 点名旧命名空间不可用、旧数据不会自动迁移。
- **两个记录项**：`host-half.test.mjs` 结尾输出断言总数（README 计数从此可对跑）；`team_link_list_sessions` 的 provisional 计数与投递侧口径对齐（过期记录不再计入「provisional 配对 N 条」——按投递侧判据它已不再是通道）。

### 代码评审加固（同日追加，仍属 0.3.7）

- **provider 生命周期归属**：晚挂拿到的 scope 与其**注入 fiber 同生共死**（`owner.effect(() => () => detach(), …)`，与 webServer 站点 `target.effect(…)` 同一条规则）。provider fiber 被 dispose 时 scope 归零并记一行 info，store 回到未挂载态、provider 回归时由惰性重试重挂。此前只有捕获没有归属：scope 非 null 却已死，`update()` 每次抛错、而 `get()` **静默改答陈旧内存**。
- **一次性门的单位是「窗口」**：`detach()` 同时**复位**该门——否则第二个未挂载窗口里的**拒绝**会零告警（与 ① 的原始缺陷同形）。窗口**内**的惰性重试仍被同一门挡住，不会成为告警风暴。
- **事后链留痕**：attach 之后的（内存窗口并入 → 改名迁移）两步各自返回结论，统一记一行 info（`post-attach policy chain finished — …`）；`migrateLegacyPolicy` 的早退分支不再一行日志都没有；`refused` 与「根本没有旧命名空间」从同形变为两个可区分取值。
- **内存窗口旗标**：结论记录后清零（避免后续窗口重复并入同一份已解决的内存态、重复记「该窗口理论不可达」warn）；只有 `fold failed` 保持置位——那些写入确实仍在内存里，下次挂载必须重试。
- **消除二次读**：激活分支的 warn 文案取自**第一次读**返回的理由码（`attached` / `refused` / `no-register` / `not-active`），不再第二次读服务（两次读之间服务可能出现，那样文案会描述一个已不成立的状态）；webServer 站点同样改理由码（`mounted` / `no-register` / `not-active`）。
- **死参数清理**：`attach()` 的第三参数 `unavailableDetail` 无人传，连同那条描述不存在路由的注释一并删除。

### 红线与不变量

`PolicyConfig` schema、投递门、`source` 三成员、`writerGate` / `retireGate`、`inject` 数组（仍 4 项）**全部零改动**；`goals.resume` 仍为**零调用**（换届只建议继任者自行 resume）。

### 验证

- `node host-half.test.mjs` → **506 项全绿**；`node client-half.test.mjs` → **46 项全绿**（基线 447 + 46 = 493）。
- **变异验证**：把 lib 的三处修复逐条回退 → `506 (failed: 4)`；把 `createPolicyStore` 换回真正的修复前形状（0.3.6 版：静默内存回退 + apply 当场跑迁移）→ `506 (failed: 16)`。还原即全绿（每次都按 sha256 校验还原）。
- **真机验证（重启后）**：`team_link_watch register` 后 `profile/settings.yaml` **首次出现 `team-link:` 段**（mtime 变化、10498 → 10838 字节），修复前同样操作 mtime 一动不动——这同时把根因链中原本标注为「推断」的一环变成实证；零手工建队 `drill-verify` → 返回「coordinator 已由创建会话认领」→ **紧接着 `set-role` 成功**（修复前这一步必被写权限门拒绝）。
- **独立复核**：一轮差异审计（explore 子代理，只读）独立复现了上述计数与红绿证据，并逐项核对了 inject 恰 4 项、`migrateLegacyPolicy` 唯一调用点在 attach 内、两个门一行未动、越界改动为零；三轮代码评审全部 PASS。

### 未验证 / 显式推迟（如实标注）

- **provider 在本插件 fiber 存活期间消失、而 scope 取自本插件自身 ctx 时不释放**——与 webServer 站点同形，不属红线，记为已知残留；
- **外部手改 `settings.yaml` 是否触发 watcher**：README 曾标为未验证，**2026-09-18 已实测**（外部删除 `team-link:` 段后 `roster get` 立刻回到 0 团队）；
- 两个 🔵 卫生项显式推迟并留档（store 返回对象里的死导出 `migrateLegacyPolicy`；webServer 站点的一次性门是进程寿命级），见设计 §9.6 ⑪；
- §7-4 的夜班日志历史取证（复核一次静默事件的具体触发器）未做——设计里本就标为可选取证。

---

## 0.3.6 — 2026-09-18（发布前收口于 0.3.7）

修两个真实使用缺陷。背景是一次协调者实测：把目标 id 打错一位（`75ae9099` → `75ae9095`），发送返回「没有活动代理」，于是 ① 调用方没有任何可核对的线索；② 该失败被当成普通回执、继续向上汇报「已发送」——而目标会话其实活着。

- **修 1 · no-agent 文案自愈化**（单目标 / fan-out / 插件内部通知三条路径共用 `deliverToTarget`）：拒绝文案首前缀改为 **`❌ 未投递`**（失败不许被读成已排队），保留原句「目标会话 `<id>` 没有活动代理」，并**新增同工作区存活会话列表**（`ctx.agents.list()` 纯注册表读取——零 surface 读取、无性能代价；过滤 = 根代理 + `origin !== "subagent"` + `cwd === 调用者 agentCwd` + 非自身；每行 `id（运行中/空闲）`，上限 **10** 个，超出时注明「共 N 个，仅列前 10 个」；无匹配输出「当前工作区无其他存活会话。」）与**核对提示行**（对照 id / 刚重启 DSH 时在侧边栏打开目标会话一次 / 先调 `team_link_list_sessions`）。执行上下文无会话身份时跳过 cwd 过滤、只排除自身。
- **修 2 · fan-out 失败领先**：只要存在任一目标 outcome ≠ `delivered`，返回文案**第一行**即为 `❌ N 个目标未投递（M 个已投递）`；**全部投递成功时文案形状一字不变**。no-holder 计入该行但汇总里仍保持独立桶、用词只说「未投递」不说「失败」。
- **行为面改动如实标注**：插件内部通知（rotation-freeze / -done / -cancelled / -expired）当收件人已无活动代理时同一行也会带 ❌ 前缀；`deliverToTarget` 是三条路径的共同出口，**未改动任何投递门与投递语义**。
- **验证**：`host-half` 431 → **447** 项（新增 16 项，当次实测），`client-half` 46 项不变（合计 477 → **493**）；既有断言仅 1 项随文案更新（no-agent 行前缀），其余 430 项零回归。

## 0.3.5 — 2026-09-18（发布前收口于 0.3.7）

修 `team_link_list_sessions` 在真实工作区的超时（生产实测：26 个会话的工作区里该工具超过 60s 工具预算；roster / watch 等其他工具正常）。

- **根因**：surface 读取对**列表每一行**（`LIST_LIMIT` = 50）逐个串行执行，而每个冷会话 = 一次 zstd 日志解压 + 一次表面投影。stub 实测（每次读 250ms）：26 会话串行 **6655ms**、修复后 **256ms**。
- **修法三件**：**有界**（恢复只读前 `PREVIEW_SESSIONS` = **12** 行，第 13 行起活性行降级为「未读（超出快照窗口 12）」，行本身照旧列出并经如实标注）；**并行**（这 12 次读取改 `Promise.allSettled`，一行不可读只降级该行）；**回归锁**（新增 7 项断言：调用次数恰为 12、12 次在首次 resolve 前已全部在飞、降级文案形状、窗口外行仍保留无 surface 的面等）。
- **代价（如实标注）**：窗口外的行不再给出 verdict——其中 `dead` 仍可从行首的「✕ 未运行」读出（运行状态来自 agent 注册表，不经日志），而 `goal-disarmed` 在窗口外不可得，需要时单读该会话（`team_link_export`）。
- **验证**：把 lib 改回串行无界的旧形状后 7 项中 3 项当场变红，还原即全绿；活性信号的计算逻辑（verdict 判定表）逐字未动。`host-half` 424 → **431** 项。

## 0.3.4 — 2026-09-18（发布前收口于 0.3.7）

两阶段换届 rotation（设计 §3.6 全节 + §3.6.1 四原则 + §4.1 + §5.1 U6 + §5.3 红线）。

- **`prepare`（Phase A，仅该角色现任会话）**：10 分钟速率限制防换届风暴；生成一次性令牌（`randomUUID()`，绑定 `(team, role, successor)`，30 分钟 TTL，成功认领即作废）；把 `pairs` / `trustedSenders` / `rememberTargets` / roster 全量快照进 `rotationBackup`；向全部在任成员广播 `[rotation-freeze]` 固定冻结清单；返回一次性明文令牌 + 掩码 + 交接指引。
- **`claim`（Phase B，仅 pending 指定的继任者凭令牌）**：单个多选对话框列出全部「退役者↔同 team 成员」候选 pairs 逐项勾选（对端在团队外的不进候选但点名）；在场确认 = ratified → 正式迁移；超时 / 无确认服务 / 失败 = 无人值守 → 全部域内候选以 provisional 迁移并开 **24h** 回退窗口；迁移 = 删旧 pair + 新建 `{a: 新任, b: 对端, provisional, expiresAt}`；**对称撤销** = 退役者持有的 pairs / trustedSenders / rememberTargets 同步清除；落定与迁移在**同一笔写入**，随后才清 pending——崩溃在两者之间时同一令牌重放只补收尾、不重复迁移。
- **到期清扫**（挂看门狗同一巡逻定时器 + 每次 roster / rotate / team_read 惰性检查）：30 分钟未认领 → 清 pending + `[rotation-cancelled]`（旧任仍为 current）；24h 未批准 → 删迁移出的 pairs + 版本史记 `provisional 未批准过期` + `[rotation-expired]`（新任保持 current，信任回退为过门）。
- **内部广播路径**：四种通知正文是**插件常量**（只插值团队/角色/会话 id/读数/状态词，且先过单行清洗）；免发送方审批但**照走接收方 inbound 策略与 `blockedSenders`**；一律不弹确认框。
- **令牌掩码**：镜像与 `roster get` 的 pending 一律渲染 `tok-<前4>…<后4>`，明文只在 prepare 的一次性返回里出现。
- **provisional 可见面**：send 返回文案后缀、`rotation-done` 状态词、roster get 的 pending/provisional 行、`list_sessions` 的「provisional 配对 N 条」标记；banner 与 `source`（仍恰好三成员）都不加字段。
- **补批准入口 = 设置 UI**：24h 内把该 pair 的 `provisional` 置 `false` 即转正式。
- **评审修复轮（7 项）**：**#1**（🔴）幂等判据从「迁移清单非空」改为 `current === pending.session`——域内无候选时标记本为空数组，旧判据会把已落定 roster 当未认领令牌，重放会走完整迁移、把继任者自己当退役者吊销其正式 pairs；**#2** 补批准后窗口静默关闭；**#3** 内部通知的 ask 分支改为逐目标 refused 行（不再 await 3 分钟确认）；**#4** claim 的镜像改用清 pending 后的数组渲染；**#5** 域内无候选时启用独立状态词 `无待迁移对`；**#6** `rotation-done` / `-cancelled` 的收件人并集加入 `rotationBackup.roster` 里的旧任；**#7** README 清扫措辞改条件表述 + `team_read` 加惰性 sweep。
- **第二修复轮（3 项）**：**#8**（🟡）过期 provisional pair 的 TTL 执行缺口——投递侧守门（`pairRecordBetween` 视过期记录为无 pair）+ 清扫侧把 doomed pairs 的计算与删除提到角色记账判据之前；**#9**（🟡）`set-role` 把角色交给 pending 继任者时清 pending（令牌随身份显式变更失效）；**#10**（🔵）`rotationStatus` 显式记状态词供重放直读；**R8** 顺带修掉一处既有墙钟竞态断言。
- **验证**：净增 74 项（311 → 385）→ 修复轮 +20（405）→ 第二修复轮 +19（424）；`client-half` 42 → 46。三轮修复共 22 项断言做过变异验证（挖洞后分别红 16 / 10 / 10 项，还原即全绿）。

## 0.3.3 — 2026-09-18（发布前收口于 0.3.7）

广播 fan-out + 结构化信封 banner + busy 预判（设计 §3.4 / §3.5 / §4.1 / §5.1 U5、U7）。

- **`targets`**（与 `targetSessionId` 互斥）：寻址优先级「会话 id 直达 > `team:<name>/<role>` > `team:<name>/*`」。`team:<name>/*` **仅该团队现任协调者可发**（策展理由）；角色空缺 → 类型化 `no-holder`（不算投递也不算失败）；团队不在 roster 或形状非法 → 整次调用拒绝（不做「半发」）；fan-out **不放宽任何门**；单次 ≤**8** 目标；重复 id 去重。
- **`meta` 信封**：`{type?, pri?, ref?}` 渲染进 banner 首行紧凑字段；`ref` 超 16 字符按码点截断并注明；枚举外的值 / 未定义字段 / 非对象 / 空 ref / 含换行 ref 一律明确参数错误；**`source` 仍是恰好三成员**。
- **busy 预判**：投递后追加目标忙碌状态（运行中 → 「目标回合已运行 N 分钟（steer 注入当前回合）；需新回合语义请等其空闲」，`N` 读不到时只给 steer 语义）。
- **顺带 4 项 M2 评审质量修复**：**R1** retire 信任清理改为对话框确认后**重新读再按最新视图过滤写回**（读-改-写窗口缩到毫秒级）；**R2** TTL 断言不再依赖墙钟；**R3** 补 `applyRetire` 两条错误分支断言；**R4** `team_read` 的 `decisions` baseHash 标注为「仅供参考/审计」。
- **验证**：`host-half` 净增 76 项（235 → 311），`client-half` 42 项不变（合计 353）。

## 0.3.2 — 2026-09-18（发布前收口于 0.3.7）

roster（团队身份注册表）+ 团队黑板（设计 §3.3 全节 + §4.1 + §5.1 U4）。

- 新增 `team_link_roster`（get / upsert-team / set-role / retire）、`team_link_team_read`、`team_link_team_append`；设置命名空间新增 `teams` 键。
- **写权限**：`writer=coordinator`（默认）时只有该团队 coordinator 现任会话可写，现任空缺时会话路径一律拒绝；`writer=any` 时任何会话可写；读永远开放。
- **`retire`**：current 置空 + 版本史记退役；随后可选**一个**确认对话框列出全部指向退役会话的 `pairs` / `trustedSenders` / `rememberTargets`，确认才清理（无确认服务则跳过清理、仅退役并说明）。
- **镜像**：每次 roster 变更在同一调用内 best-effort 写 `<workspace>/team/<name>/roster.md`（失败只告警——settings 始终是事实源）。
- **黑板**：`decisions.md` 只追加（`seq | ISO 时间 | author-session-id | 正文`，seq 单调递增）、`discipline.md` 整文件替换（必须携带 `baseHash`），两者单行上限 **500** 字符（按码点）；黑板**无写权限门**，写入者记在行内 author。团队名 `[a-z0-9-]+` 白名单 + file 枚举白名单（一律 `path.join`，防路径穿越）。
- **验证**：净增 67 项（168 → 235），`client-half` 42 项不变（合计 277）；变异验证：把写权限门与 baseHash 乐观锁各打一个洞后红 8 项，还原即全绿。

## 0.3.1 — 2026-09-18（发布前收口于 0.3.7）

活性面 + 跨会话看门狗最小版（设计 §3.1 / §3.2 / §3.7）。

- `list_sessions` 每个会话行新增 `活性：` 信号行（verdict 五态、goal phase/activation/轮次与 blockedReason、静默时长、读数时间戳）；goal 状态经 `ctx.get("goals")` **可选注入**（服务缺失显示 `?`，插件功能完整降级）。
- 新增 `team_link_watch`（register / list / clear）：只能给自己注册、拒绝自指、单会话 ≤3 个、`silentMinutes>=10` / `intervalMinutes>=5` / `ttlHours<=24`（默认 12，到点自清）。
- **四态巡逻**：观察者运行中或自身 armed-active 不 tick；目标 armed-active 不 tick；目标 active-but-disarmed **立即** tick 且载荷带诊断与合规 resume 回路；paused/blocked/complete 不 tick；无 goal 且静默超阈才 tick。
- tick 的 `source` 仍是恰好三成员（id 前缀 `slp-wd-`），正文是**插件常量模板**；去抖与「观察者=dead」为进程内状态、不持久化；巡逻定时器随 dispose 清理。
- **验证**：净增 93 项（75 → 168），`client-half` 42 项不变（合计 210）。

## 0.3.0 — 2026-09-17

**更名** `dsh-team-link`（原 `dsh-session-link-pro`）：包名 / cordis 名 / client bundle id / 工具名（`team_link_list_sessions` / `team_link_export` / `team_link_send`）/ 设置命名空间（`team-link`，含旧数据一次性迁移）/ 导出路由（`/team-link/export`）。

**不变量**：`slp-` 消息 id 前缀、`dsh://` 深链协议、上游深链解析行为、双门投递语义——一律保持。

**GitHub 仓库名**于 2026-09-18 一并改为 `dsh-team-link`（旧地址自动重定向）。

## 0.2.4 — 2026-09-17

修「孤立代理项」截断 bug（详见 README 第八节）：

- `preview()` / `truncate()` 改为**按码点截断**（原 `slice()` 按 UTF-16 code unit 切，emoji 落在刀口上只剩一半，会**永久毒死**调用方会话）；「已截断 N 字符」计数口径随之变为码点；
- 新增 `wellFormed()` 并消毒列表正文、export 的 md+JSON、send 的两处批准提问正文、投递到目标会话的 banner、拒绝文本里回显的 `targetId`、深链注入的会话快照与三个工具的 `output.render` 出口；
- 顺带修「resolver 省略可选 `additionalContext` 时把 `undefined` 塞进消息数组」；
- 客户端 `shortSessionId()` 改码点截断，卡片正文 / 发送方 id / 委托回退文本渲染前消毒。
- **验证**：`host-half` 新增 20 项、`client-half` 新增 11 项；把两个 lib 文件换回 0.2.3 时 host 红 13 项、client 红 5 项，换回修复版即 117 项全绿。

## 0.2.3 — 2026-09-17

适配 DSH 0.1.5 会话格式迁移：

- 投递消息 `source` 改为受审计的 `{ kind: "agent-message", form: "relay", senderSessionId }`（旧 `kind: "team-link"` 会让整份会话日志无法迁移/打不开）；
- 卡片判定改从 chat node 的 `node.id` 读消息 id（context 的 `data` 里没有 id），叠加 `slp-` 与正文 banner 双信号，避免把上游相邻代理消息误渲染成本插件卡片；
- 时间改为优先用 context node 的事件时间，正文 banner 承载投递时间兜底；
- 宿主包从 `dependencies` 移到 `peerDependencies`，区间补上 `^0.1.5-rc.1` 分支（`^0.1.0-rc.6` 按 semver 预发布规则匹配不到 `0.1.5-rc.1`）；
- 新增 `client-half.test.mjs`；导出路由文件名净化、策略写入去重。

## 0.2.2 — 2026-09-17

配对通道（双向免确认）；醒目 📡 消息卡片（keyed slot 影子渲染 + 委托回退）；消息 `source` 补 `form: relay` + `senderSessionId` 元数据。

## 0.2.1 — 2026-09-17

空闲目标投递改用 `followup` 唤醒（原 `inject` 只排队不唤醒，用户确认后目标无反应）。

## 0.2.0 — 2026-09-16

初版 fork：会话深链 + 会话列表 / 导出 + 批准式跨会话消息。
