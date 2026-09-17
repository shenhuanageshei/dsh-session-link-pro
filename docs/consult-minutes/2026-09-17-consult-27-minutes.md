# 会诊纪要 —— consult #27（原始层，机制落盘）

- 日期：2026-09-17
- 会诊 id：27
- 模型：deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, codex-cli:gpt-6-astra, kimi-api:kimi-k3
- 平台 job：consult-14
- 结果：3/4 交付（其中 3 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：true
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #27 finished — 3 of 4 replied (1 failed)]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #27 finished — 3 of 4 replied (1 failed)]
effective: 3 of 4 (1 failed · 0 without content)
models: deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, codex-cli:gpt-6-astra, kimi-api:kimi-k3
job: consult-14
minutes: docs/consult-minutes/2026-09-17-consult-27-minutes.md
requiresReport: true

--- replies (raw, unjudged — verify with your own tools) ---

[1] codex-cli:gpt-6-astra — failed
(consultation failed: codex-cli PROCESS_ERROR: codex 进程失败（非零退出且无有效输出）)

[2] zai-coding-cn:glm-5.3 — ok
核验完毕，证据链闭合。最后一轮还挖出一个主会话完全没提的关键约束（`dsh-tool-goal:303`：resume 需要顶层人类请求）。以下是我作为会诊方的独立交叉评审意见。

---

# 会诊意见：§7-7 心跳 × goal 轮次 + 设计文档核对

**核验方式**：我独立实读了 `dsh-goal`、`dsh-goal-round-driver`、`dsh-tool-goal`、`dsh-command-goal`、`dsh-schedule` 源码/文档、本插件 `lib/index.js` pairs 段、设计文档全文、profile `cordis.yml`。以下引用均为我本次读到的行号，非转述主会话。

## A. F1–F7 逐条核验

| # | 主会话结论 | 我的裁定 | 证据（我实读） |
|---|---|---|---|
| F1 | roundsStarted 只在 goal 轮 admit 时 +1 | ✅ 属实，另加一条 | `dsh-goal/lib/index.js:273-279`：goal 来源 user/message 且 `round === roundsStarted+1` 且 `round ≤ max` 才收；**revision 必须等于当前 revision，否则整个折叠抛错** |
| F2 | 竞态消息只 defer 不耗轮次 | ✅ 属实，但有两处主会话没说的分支 | defer 链确认：`driver:240-247`（竞态入 nextTurn → attempt.stale）、`:277-303`（stale → pre-step reject → 重排同号轮）、`:80`（`readyToDrive` 要求 `!competingQueued`，`:219` idle 时复位）。**但见 B-2/B-3：另有两类中断会把"defer"变成 pause/blocked** |
| F3 | max-tokens → disarm | ✅ 属实 | `driver:264-267`；disarm 后 durable phase 仍是 active，无任何持久痕迹 |
| F4 | 插件加载 → 全部 disarm | ✅ 属实，且比主会话说的更结构性 | `driver:344` 只是兜底；真正根因是 `dsh-goal:284`（注释："activation is deliberately absent"）+ `:601-602`（折叠恢复时 activation 默认 disarmed）。**activation 根本不持久化——任何重启后必然全 disarmed，这是构造性行为，不是偶发** |
| F5 | 轮次耗尽 → block；“已恢复（40/70）”⇒ 当时剩 30 轮 ⇒ 不可能耗尽 | ⚠️ 机制属实，**推论过强** | 机制确认：`dsh-goal:197`（`roundsStarted >= max` 时 resume 抛错）、`driver:125-131`（耗尽 → `blocked(round-limit)`，**有持久痕迹**）。但"恢复时剩 30 轮"推不出"00:31 时没耗尽"——16 小时里跑完 30 轮完全可能。正确表述：耗尽会留下 durable `blockedReason`，**可区分、可诊断**，结论应是"读状态"而非"排除" |
| F6 | steer 不触碰 goal 栅栏 | ✅ 无反证 | 取自平台运行时契约；未逐行核 runtime 源 |
| F7 | schedule 与心跳重档重合、未挂载 | ✅ 属实，但**重合度被高估**（见 B-6） | README 确认：idle-only 投递、不打断运行中回合、重复间隔 ≥5 分钟、重启存活；profile 根 `cordis.yml` 无 schedule 引用 |

## B. 主会话遗漏的六个新发现（本次会诊的增量）

1. **activation 非持久化是根因级事实**（`dsh-goal:284, 601-602`）。`dsh-command-goal/README.md:40` 官方文档原话："/goal resume — …**or rearms an active goal after session resume or fork**"。即：DSH 官方已把"会话恢复后 goal 处于 active-but-disarmed、需显式 resume"定义为正常生命周期。00:31 静默的最可能解释就是这个，且它有官方文档背书。
2. **goal 轮被下游门拒绝 → 整个 goal 直接 blocked**（`driver:317-324`，code `prompt-rejected`）。跨会话消息若触发其他 pre-step 策略拒掉 goal 轮，结果是可见的 blocked——会被误读为轮次问题。心跳设计必须把 `blockedReason` 一起暴露。
3. **idle 时 attempt 仍处 queued/claimed/cancelled → goal 被 pause**（`driver:218-231`）。典型触发：用户在 goal 轮运行中按停（aborted）。中断后的停止是 paused（有痕迹），与 disarm（无痕迹）不同——三种停态（paused / blocked / disarmed）都该进看门狗的状态面。
4. **模型不能自行 resume**：`dsh-tool-goal/lib/index.js:303` 工具描述明确 "edit, pause, and resume **require a direct top-level human request**"。主会话设想的"看门狗 nudge 模型去 resume"会被工具自身的人类请求门挡住。干净的做法是：**tick 只告知状态（"你的 goal 自 X 起 disarmed，原因 max-tokens/重启"），让模型转告用户、用户回复后模型再 resume**——这条回路完全走在现有门内。插件直接调 `ctx.goals.resume` 技术上可行（driver 就在用 ctx.goals），但那是机器绕过人类门 re-arm 自动驾驶，恰好踩 §7-3 自己划的红线，不建议。
5. **`session.create` 与 `session.fork` 都在客户端契约里**：`dsh-api-session-controller/.../manager.d.ts:171-184`（create：空白会话，可指定 workspace/cwd，同步可寻址）、`:185-199`（fork：继承全history、可 `atSeq` 截断）。换届应明确选 **create + 交接文档**（轻上下文），fork 会背上 16 小时协调会话的全量历史。
6. **schedule 和本插件 relay 都叫不醒关闭的会话**。schedule README 明说 "delivery requires a live root agent: closed sessions keep reminders overdue"；本插件 `lib/index.js:662` 也只投递存活代理。心跳重档的真实覆盖 = **活会话的节奏维持**，不是失联恢复；"夜间断联"场景两条路都无效，唯一诚实答案是"提醒用户"。这点应写进 §5.2 的非目标，避免交付后被当 bug。

## C. 对各立场的表态

| 议题 | 主会话立场 | 我的意见 |
|---|---|---|
| 5.2 心跳 | 重档≈重造 schedule，插件只做跨会话看门狗 | **同意，修正一点**：既然谁都唤不醒死会话，"跨会话看门狗"应降格为"活会话活性信号 + 死会话向用户告警"。自 tick 若做，必须复制 idle-only 规则并**先读 goal 状态**：armed-active 不 tick；disarmed/paused/blocked 才 tick 且正文带诊断 |
| 5.3 广播 | v1 砍群总线 | **同意**。与 §5.7 非目标 #2 自洽；roster fan-out 循环足够 |
| 5.4 换届 | 令牌 + 整批确认；半自动兜底 | **同意，且 B-4/B-5 强化了它**：create 契约已证实（插件侧调用仍未证），半自动是对的默认；TTL 回滚不应是"或"选项而是默认叠加。**补：继任者首个动作应是 `/goal resume` 或建新 goal**——不 resume 的话新协调者一重启就重蹈 00:31 |
| 5.5 回执 | busy 优先 | **同意**，零争议 |
| §7-3 pairs | 自动迁移 pairs = 零交互预授权注入 | **双门绕过亲验属实**：`lib/index.js:681,686`（paired 时连确认服务都不需要）、`:691`（gate 1 跳过）、`:729`（gate 2 跳过）、`:751`（一次接收方确认"配对：双向免确认"即建双向通道）。`:682-685` 的注释表明 unpaired fail-closed 是有意设计——自动迁移 pairs 恰好反转这个设计意图。**建议**：换届永不静默迁移 pairs，改为"一个换届对话框列出全部待迁移对，逐项勾选 + 单击整批确认；未确认项回落到正常首问门"。另注意 `:755`：pair 确认弹在**目标会话**侧，单用户多窗操作没问题，但整批确认 UX 应收拢到换届对话框一处，别弹 N 个窗 |
| §7-8 反驳 §4 | 两行为假 | **同意但别扩大化**：我以平台自身契约为证（subagent 默认后台 + 完成通知回注；consult/escalate 可指定模型）——"阻塞父会话""同模型同配置"两行在 0.1.5 确实为假。但"进程内近零成本通信、共享 scratchpad、单一 trace"三行仍成立，反驳打掉 2/9 行，不打掉整张表 |
| 优先序 | heartbeat轻档+busy → roster → … | **同意起点，插一项**：轻档里必须含 **goal 状态面**（phase/activation/roundsStarted/max/blockedReason 进 `list_sessions`）——纯只读、直接诊断 §7-7、且是任何 tick 逻辑的安全前提。序：**轻档活性+goal状态+busy → roster → 广播/换届 → 信封/黑板 → 回执全量** |

## D. 结论

主会话的 F1–F7 六条属实、一条推论过强（F5）；对 00:31 的归因方向（无 armed-active goal）我背书，且找到了更硬的根因证据（**activation 不持久化 + 工具门禁止模型自 resume**，B-1/B-4）。设计立场我全部同意或同意加修正；最需要主会话改口的三点：①F5 改为"三种停态可区分、应读不应猜"；②心跳重档明确"唤不醒死会话"的诚实边界；③看门狗对 goal 的干预止于"状态告知 → 用户授权 resume"，不做插件侧自动 re-arm。

**局限声明**：「00:31」「40/70」出自主会话引述的运行史，事件本身无法从源码复验（"（40/70）"字串未在任何包中找到，应为模型转述，但与 `dsh-tool-goal:163,229` 暴露的 roundsStarted/maxGoalRounds 字段语义一致）；steer 语义取自平台契约未逐行核源；插件能否调 `session.create` 未验证（客户端契约已证）。

[3] deepseek-official:deepseek-v4-pro — ok
全部核验完成。以下是交叉评审报告。

---

# 交叉评审报告（独立复核，全部结论已逐一对照源码）

## A. F1–F7 逐条核验

| # | 判定 | 核验结果 |
|---|---|---|
| F1 | ✅ | `dsh-goal/lib/index.js:273-279` 原文一致：goal 来源的 user/message 且 `source.round === roundsStarted+1` 才递增，且 > maxGoalRounds 会抛错 |
| F2 | ⚠️ 基本成立，两处精度修正 + 漏了一个分支 | stale 只在 `attempt.phase === "queued"` 时打标（driver :246），claimed/admitted 不受影响；竞态消息确实先跑（pre-step reject :294-302 → restoreOtherClaimed → idle 后重排同号轮 :231）。**但漏了 pause 分支**（driver :220-230）：idle 时若 attempt 仍为 queued/claimed/cancelled（如回合被 abort，:270 打 cancelled）→ 不是重排，而是 `ctx.goals.pause`——**goal 被停用**。心跳设计需注意：竞态路径安全，但"被取消的 goal 轮 → 静默停用"是另一种静默根因。另：竞态消息占用一整回合（token/延迟），"defer 不消耗轮次"≠零成本 |
| F3 | ✅ | driver :264-267 原文一致：turn/end reason=max-tokens → disarm（:87-93 保留 durable phase 只摘 activation） |
| F4 | ✅ | driver :344 在 effect 启动时对全部存活 agent 执行 disarm |
| F5 | ✅ | driver :125-131 block(code:round-limit)；`dsh-goal:197` resume 时 `roundsStarted >= maxGoalRounds` 抛错。推论成立**前提**：晨间"已恢复（40/70）"与夜班是同一 goal——日志是 zstd 压缩的，本环境只读工具无法解压复核，此前提是残余验证缺口（下 D） |
| F6 | ✅ | runtime-types.d.ts:194-197：steer 只投递最近步边界。补充：对 idle agent 的 steer 会以"竞态消息"身份走 F2 机制，但那是通用竞态路径而非 steer 特有 |
| F7 | ✅ | README 原文：idle 后才以 followup 投递、绝不打断运行回合、repeat ≥5 分钟、重启存活但需 live root agent、**仅会话内投递无冷会话调度**。本 profile 未挂载 ✓（cordis.yml 为 `[]`、patch 无 schedule 行、package.json bundles 无此项） |

## B. 逐议题裁定

**① §7-8 反驳——最重发现，2/3 过伸，需改稿再提交会诊。**
- "子代理通常阻塞父会话"：对 DSH 通用 subagent 工具为假（dsh-subagent one-shot 后台走 Jobs + continuable child，harness schema 后台默认）✓；**但你们自己的工作流主力工具 eng_coder / escalate 的 `background` 参数 `default: false`**（eng.mjs:957、index.mjs:1002），默认前台阻塞。consult_start 才是不阻塞。
- "通常同模型同配置"：escalate 有 `model` 参数（index.mjs:1000）、consult_start 有 `models` 参数 ✓；**但 eng_coder 工具 schema 没有 model 参数**——`agentOpts = agent.options`（eng.mjs:742），provider/model 直接继承父代理（:928/973/1070-1071），配置面只有 `engCoderMaxTokens/engCoderEffort`（config-store.mjs:23 的清单只列了这三项）。**实施子代理恰恰是"同模型同配置"**。
- 裁定：§4 两行不该被整体判假。正确写法是按工具分列：通用 subagent（后台默认、可 fork 续跑）vs thincoder 系（eng_coder 前台默认+继承父模型；escalate/consult 可选模型）。§4 表格对你们实际工作流的描述基本仍成立。

**② 5.2 心跳——方向同意，补一条根因级增强。** 轻档=schedule 做不了的跨会话看门狗，重档≈schedule，都对；但要诚实声明：schedule 是 durable-event 折叠（可重放），插件侧心跳定时器是 settings 背书的（重启后需自行重建 timer），不能当 schedule 等价物宣传。**最强的一条没写**：看门狗应读 `ctx.goals.get`（goal-round-driver 证明该服务插件可注入），把"goal durable-active 但 activation=disarmed/paused"作为一级信号——这正是 00:31 的机制态（F3/F4 的产物）。"armed-active 不 tick"✓；互补规则是"active 但未 armed → tick/告警"。这样心跳从症状补救（nudge）升级为根因检测（检测 disarm 静默死亡）。

**③ 5.3 广播——结论可留，理由要改。** "群总线与策展自相矛盾"只在"总线注入模型上下文"的读法下成立；doc §5.3 的"经群总线只读可见"语义含糊——若总线是 UI/黑板级人类可读 feed（不进 LLM 上下文），与策展不冲突，且顺手解 P6 观测性。建议：v1 砍掉总线→保留，但把理由从"自相矛盾"改为"必须声明消费端：模型上下文禁入，人类 feed 可留"。roster fan-out 循环作为 v1 实现无误。

**④ 5.4 换届——同意缺"继任者主张权"，补三条。** (a) 令牌须一次性 + 绑 team/target-session + TTL + 幂等（崩溃重试）；(b) **撤销与授予必须对称**：退役协调者会话仍存活数天（W2 账龄 9 天可见会话寿命），§5.1 只写了"清理指向 retired 会话的 pairs"——还必须吊销 retired 会话**持有**的 pairs/trustedSenders，否则旧协调者永久保送权；(c) "TTL 未批准即回滚"要诚实声明：回滚只能停未来发送，已注入 worker 上下文的消息不可回收。插件侧可编程建会话我复检仍无果（sessions 服务面在 shell/persistence types 中未见 create），与你的"未验证"一致。

**⑤ 5.5 回执——同意降级，补一个精确化。** "已投递"≠"将进哪个回合"：投进运行中目标=steer 进当前回合，P3 风险依旧。busy 可见性让发送方**选择** steer vs followup 才是正解。且 last-outgoing-timestamp + busy + 心跳轻档是同一块只读面，一个 PR 全收——与你的优先序主张自洽。

**⑥ 7-3 pairs——双门绕过已实锤**（lib/index.js:680-681 配对跳过 userQuestions、:691 跳发送门、:729 跳接收门）。令牌+roster 域限+整批确认成立；补：域限挡不住"已配对但退役"的会话，撤销（④b）是唯一解法。

## C. 优先序裁定

同意 **heartbeat轻档+busy（同一只读 PR）→ roster → 广播+换届 → 信封/黑板 → 回执全量**。roster 不必最先：轻档只用 session id（现有能力即可），无返工风险；roster 只要赶在重档/广播/换届之前。唯一加项：轻档并入 goal 状态位（armed/disarmed/paused），per live agent 一次 `ctx.goals.get`，成本趋零，收益是把 P1 的根因检测做进 v1。

## D. 残余验证缺口（如实上报）

1. 00:31 静默的具体 disarm 触发器（F3 max-tokens / F4 重启 / pause / 压根无 goal）需解压 `session.v3.jsonl.zstd` 复核——本环境无法解 zstd，机制链已证但触发路径未证。夜班协调者是 "reasoning max" 长回合，F3 是概率最高的候选。
2. §7-8 反驳需按 B① 改稿后方可进会诊（否则会在 §4/§7-8 上被会诊模型反抓）。
3. 晨间 "已恢复（40/70）" 与夜班 goal 的同一性假设（F5 推论前提）。

**总评**：F1–F7 的源码事实链全部成立（F2 需补 pause 分支），§5 与八议题立场大体站得住；必须改的是 §7-8（两处过伸）与 5.3 的理由表述；值得加入的是 disarm/pause 检测进轻档心跳、以及换届的撤销对称性。

[4] kimi-api:kimi-k3 — ok
所有关键验证完成。整理交叉评审结论。

---

# 会诊交叉评审意见（独立复核）

**评审人立场**：我未参与主代理的调研，独立重读了 `dsh-goal-round-driver`、`dsh-goal`、`dsh-schedule` 源码与本插件 `lib/index.js` 配对门实现，逐条复核主代理的 F1–F7 与 §5/§7 各立场。结论：**主代理的源码事实全部成立，行号引用全部命中**；但静默路径枚举不全，心跳策略二分法有一个实质性漏洞，另有三条增量事实改变部分设计细节。

## 一、F1–F7 逐条复核（全部 ✅，附独立出处）

| # | 主代理结论 | 复核 | 备注 |
|---|---|---|---|
| F1 | roundsStarted 仅在 goal 轮消息按序 admit 进日志时递增 | ✅ | `dsh-goal/lib/index.js:273-279`；且乱序 goal 轮是 fold 硬错误而非静默跳过 |
| F2 | 竞态消息使 goal 轮 stale→reject→重排，不耗轮次 | ✅ | round-driver `:240-247`（inbox/inserted→competingQueued+stale）、`:294-303`（pre-step reject+requestDrive）；reject 不产生 session event → 轮号复用 |
| F3 | max-tokens 回合结束 → disarm（静默停止） | ✅ | `:264-267` 一字不差 |
| F4 | 插件加载 → 全部 disarm | ✅ | `:344`；另 teardown `:345-349` 同样全量 disarm |
| F5 | 轮尽 → block(round-limit)；resume 校验预算；40/70 ≠ 轮尽 | ✅ | `:125-131` + `dsh-goal:191-198`（resume 要求 `roundsStarted < maxGoalRounds`） |
| F6 | steer 不触碰 goal 竞态栅栏 | ✅ | 栅栏只检查 nextTurn 成员（`:241`）；steer 走 steering lane（runtime-types.d.ts:194-200） |
| F7 | dsh-schedule 存在、idle-only 投递、≥5 分钟、重启存活、本 profile 未挂载 | ✅ | README:12/48/56；且本 profile `package.json` dependencies 无 dsh-schedule，bundles 无此行——**双重确认未挂载** |

另双重确认：goal/goal-round-driver/tool-goal 经 dsh-base bundle 挂载（`dsh-base/cordis.patch.yml:292-299,408-409`）——§7-7 的前提（goal 驱动在本 profile 生效）成立。

## 二、增量发现（主代理未覆盖，按重要性排序）

**N1（最重要）：心跳策略的二分法有漏洞，应三分。** 主代理提议「armed-active 不 tick，其他 tick」。但 paused/blocked 状态的 goal 是在**等人工决策**（round-driver `:222-229` 显示被 abort 的 goal 轮会自动 pause，这是 durable 的、跨重启存活），对它 tick 会打扰用户并浪费回合。正确策略：
- **armed-active** → 不 tick（有自己的续跑节拍）
- **durable-active + disarmed**（F3/F4/热重载的静默态）→ **必须 tick，且 tick 载荷应写明「goal 需 resume」**——因为裸 tick 不会 re-arm（`drive()` 在 `:124` 直接 return），模型收到 tick 后必须显式 resume 才能恢复续跑（resume 才 re-arm，`dsh-goal:696-698`）
- **paused / blocked / complete** → 不 tick

**N2：静默路径枚举不全。** 主代理只列了 F3/F4/pause/未建。源码里还有四条：(a) `agent/error` → disarm（`:201-203`）；(b) 持久化 checkpoint 失败 → disarm（`:109-114`）；(c) turn abort 且轮次未 claimed → disarm（`:271`）；(d) 轮次已 claimed/admitted 后被 abort → 下一 idle 自动 **pause**（`:222-229`）——durable pause，比 disarm 更「硬」。(e) **假说级**：effect teardown（`:345-349`）意味着任何触发 dsh-base 重载的配置热更都会团灭所有 goal 的驱动权——夜间改配置 = 团队静默，这是 00:31 事件的一个具体候选根因，值得用户回忆当晚是否动过配置。

**N3：F4 的完整因果链是两段而非一段。** `:344` 只 disarm 加载时存活的 agent；重启后**重开**的会话走另一条路——foldGoal 不含 activation（`:284`）、runtime 初值即 disarmed（`:782`）。结论相同（重启后必无自动续跑，直到 resume），但机制写精确对设计文档很重要。

**N4：心跳感知 goal 状态的实现成本比主代理预期的低。** goal-round-driver 的 `inject = ["agents","goals","sessions"]`（`:26-30`）证明 `goals` 是可注入服务；`ctx.agents.get(sessionId)` 可按会话 id 取 agent（`:257` 正是这么用的）。本插件 inject 加上 `"goals"` 后，轻档心跳信号 = `agents.get(id).status` + `goals.get(agent).activation` + 最近消息时间，**纯服务调用，无需解析日志**。activation 本身就是最强的活性信号，应进 `list_sessions`。

**N5：§7-3 的权重应再加码——pairs 连 receiver 的显式 reject 策略都绕过。** 主代理说「绕过两道门」，实际更严：`lib/index.js:729` 的 `!paired` 短路在 `receiveMode === "reject"` 检查（`:731`）**之前**——已配对通道无视接收方的全部拒绝策略。唯一压过 pair 的是 block（`:669-678` 显式屏蔽会顺带清理 pair）。所以「自动迁移 pairs」= 连各 worker 的 reject 策略一起替继任者覆盖掉，安全论证必须以这条为基线。

**N6：「直接用 schedule overlay 做自 tick」有两个采用约束。** (a) overlay 必须在**会话创建前**启用，存量会话无工具（README:44/70）；(b) reminder 跟随会话不跟随 roster——fork/换届不继承（README:101）。所以主代理「换届时注册随 roster 迁移」仍须插件侧补做，schedule 本身不提供；对存量协调会话，schedule 路径也不可用，插件侧定时器仍有存在价值。

**N7：§5.4 可编程创建多一条具体线索。** `dsh-sdk-protocol` 类型载明「未知 session id 惰性创建 agent+session 对」（types.d.ts:36）——SDK JSON-RPC 面是编程创建会话的候选路径；但 sdk-app bundle 未在本 profile 挂载，仍属未验证。主代理「半自动兜底为主」的结论不变。

## 三、对主代理立场的处置

| 立场 | 处置 | 理由 |
|---|---|---|
| §5.2 心跳=重造 schedule，插件只做跨会话看门狗 | **同意，修正** | 自 tick 复制 idle-only 规则对，但按 N6 补采用约束；按 N1 改三分策略 |
| §5.3 v1 砍群总线 | **同意** | 「策展」与「全员只读可见」确自相矛盾 |
| §5.4 缺继任者主张权问题 | **同意，强化** | 补 N5：令牌 + roster 域限的论证基线应包含「pairs 覆盖 reject」 |
| §5.5 回执第二级降优先级 | **同意** | 已独立核实 send 同步返回投递结果（`:662-678` 各失败分支均同步返回） |
| §7-3 反对自动迁移 pairs | **同意** | 双门绕过已核实（`:691`/`:729` 条件短路） |
| §7-8 反驳 §4 两行 | **同意** | 0.1.5 subagent 默认后台+通知回注；thincoder-suite 配置实证异构模型（consultModels/advisor 分档） |
| 优先序：轻档心跳+busy 先行 | **同意，补充** | 按 N4，轻档信号应含 goal activation——这使第一个 PR 直接覆盖议题 7 的「感知 goal 状态」 |

**主代理未表态的议题，我的独立意见**：议题 4（错峰 vs 全换）——维持错峰默认，18:03–18:25 实证流程本身就是错峰，全换把 P5 漏步风险最大化；议题 5（banner vs sidecar）——逐消息元数据用 banner（随正文走、跨导出存活、每条约 20–40 token 可接受），sidecar 只适合黑板级索引，逐消息 sidecar 在消息编辑/导出时失同步；议题 6（规模）——按 3–5 设计、roster 数据结构不封顶即可，8–10 的唯一实质影响是广播风暴，角色制寻址已将其压成 O(1)。

## 四、结论

主代理的 §7-7 论证（00:31 静默 ≠ 轮次耗尽，真因是无 armed-active goal）**成立，采纳**；心跳 × goal 交互设计按 N1/N2/N4 修正后采纳；其余立场全部同意。无任何一条主代理结论被源码证伪。
```

## §2 逐问裁定（**主代理写**）

完整处置表（25 行：24 adopted / 1 pending / 1 failed）落盘于设计文档 `docs/team-upgrade-design-2026-09-17.md` §8.1，此处按来源归纳：

- **glm-5.3**：B-1~B-6、F5 修正、§7-3 勾选式整批确认、优先序补充——**全部采纳**。理由：每项都有独立行号证据且直接改写正文（activation 非持久化重构 V5；resume 人类请求门约束 tick 文案与插件边界；create≠fork 收敛 V9；死会话诚实边界成非目标 #6；F5 修正把 V6 改为「读状态不猜」）。
- **deepseek-v4-pro**：5.2 goal-disarmed 一级信号、5.3 总线理由修正、5.4a 令牌绑定/幂等、5.4b 对称撤销、5.4c TTL 诚实声明、5.5 已有保留、优先序——**全部采纳**；§7-8 过伸修正——**采纳并修正主代理自身立场**（详见 §3）。
- **kimi-k3**：N1 三分法（展开为四态）、N2 四条额外静默路径+teardown 假说、N3 两段因果链、N4 goals 可注入、N5 pairs 覆盖 reject、N6 schedule 采用约束、N7 SDK 惰性创建线索、议题 4/5/6 独立意见——**全部采纳**（teardown 项按其自我标注列为假说级）。
- **待定（1 项）**：夜班日志解压取证（00:31 触发器 + 晨间 goal 同一性）——三家一致指出属残余验证缺口；机制链已闭环，取证不阻塞实施，记入设计文档 §7-4 可选项。
- **不采纳（0 项）**：无——三家意见均通过主代理对源码/草稿的复核后落正文。
- **失败（1 项）**：codex-cli:gpt-6-astra PROCESS_ERROR 无输出，无内容可处置；不重试（其余三家交叉一致已充分覆盖）。

## §3 分歧与父侧裁定（**主代理写**）

唯一一处**会诊方之间**的实质分歧：主代理对《调研》§4 的反驳（「子代理阻塞父会话」「同模型同配置」两行为假）——kimi **同意**该反驳（证据：subagent 默认后台+通知回注；consultModels/advisor 分档），deepseek **反驳**（证据：eng.mjs:957、index.mjs:1002 的 background 默认 false；eng_coder 无 model 参数、继承父代理）。

**父侧裁定：deepseek 正确，主代理原反驳 2/3 过伸。** 理由：kimi 的证据覆盖 consult/advisor（评审路径），但未覆盖**实施主力** eng_coder——而 §4 表格说的正是实施场景；deepseek 查的是工具 schema 的实际默认值（比主代理依赖的平台自描述工具表更硬）。修正后的表述按工具分列：通用 subagent 后台默认可续跑（该行为假）；eng_coder 前台默认+父模型、escalate/consult 可选模型（该行对本工作流基本仍成立）。已写入纪要 §2 与设计文档 §8.1。

另两处对主代理推论的修正（glm F5「推论过强」、deepseek D-1「同一性假设」）不构成会诊方间分歧，属主代理自查补强，均采纳。

## §4 教训（**主代理写**）

1. **转述性证据要标定时点**：「Goal 已恢复（40/70）」是日志转述，恢复时刻的状态不能回推事故时刻——推论必须写明前提窗口（F5 教训）。
2. **平台自描述 ≠ schema 实测**：主代理以系统提示里的工具表论证 §7-8，deepseek 以插件源码 default 值反驳成功——反驳类主张先查实现默认值再开口。
3. **会诊前自查「反驳类」主张**：对《调研》§4 的反驳是最弱的一环（对方文档的对比表），会诊果然在此被抓——下次先于会诊做反方自辩。

## §5 不可验清单（**主代理写**）

1. 00:31 静默的具体触发器（max-tokens / 重启 / 配置热更 / pause / 未建 goal）——夜班日志 zstd 未解压，三家均无法复验（设计文档 §7-4 可选取证）。
2. 晨间「已恢复（40/70）」goal 与夜班 goal 的同一性——形式上存在「先耗尽再 edit 提额」的复杂路径，概率低但未排除。
3. 「（40/70）」字串本身为模型转述，未在任何包源码中找到（glm 核验）；与 dsh-tool-goal 暴露的 roundsStarted/maxGoalRounds 语义一致故采信。
4. steer 语义取自平台运行时契约文档，未逐行核 runtime 实现（glm 自我声明）。
5. 插件侧能否调用 session.create / SDK 惰性创建路径——客户端契约已证，插件侧调用未验证（设计文档 §7-1）。
6. teardown 假说（配置热更团灭 goal 驱动权，kimi N2-e）——机制推演成立，未经实验复现。

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-09-17 | 机制落盘（§0 汇总 + §1 原始层）；裁定层待主代理补写 |
| 2026-09-17 | 主代理补写 §2-§6：24 adopted / 1 pending / 1 failed；§3 记录 kimi↔deepseek 的 §7-8 分歧及父侧裁定（deepseek 胜）；处置落点=设计文档 §8.1/§8.2，文档同步定稿 v1.1 |
