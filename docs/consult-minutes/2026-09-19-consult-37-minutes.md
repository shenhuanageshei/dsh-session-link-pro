# 会诊纪要 —— consult #37（原始层，机制落盘）

- 日期：2026-09-19
- 会诊 id：37
- 模型：deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, codex-cli:gpt-6-astra, kimi-api:kimi-k3
- 平台 job：consult-1
- 结果：2/4 交付（其中 2 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：true
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #37 finished — 2 of 4 replied (2 failed)]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #37 finished — 2 of 4 replied (2 failed)]
effective: 2 of 4 (2 failed · 0 without content)
models: deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, codex-cli:gpt-6-astra, kimi-api:kimi-k3
job: consult-1
minutes: docs/consult-minutes/2026-09-19-consult-37-minutes.md
requiresReport: true

--- replies (raw, unjudged — verify with your own tools) ---

[1] zai-coding-cn:glm-5.3 — ok
核查完毕。以下是我作为会诊方的独立只读评审——所有结论都基于本轮实读源码，标注 as-of 位置。

---

# ① 发送方可见性：判定与证据

## 总判定：A + D 组合最稳；C 今天有一个致呤断点，不可实施；B 否决

你们把 D 描述成「客户端侧升格、不写日志」——这条不只是备选，它是我判定里**唯一同时满足全部三个目标**（卡片 + 顶层可见 + 不进模型上下文）的路径，而且比想象的更具体：**注册一个 conversation node definition，match 发送方会话里既有的 `tool/call`/`tool/result` 事件**。

## 四问逐一回答

**Q1：A/B/C/D 哪条最稳？**

| 方案 | 判定 | 关键证据 |
|---|---|---|
| A（toolview 卡片） | ✅ 确定可行，零风险 | `tool.call.toolview` 键域开放、own tool 是 additive（slots.d.ts:9-21 原文 "registering is additive for your own tool"）。局限：仍在可折叠工具树内 |
| D（客户端升格） | ✅ **推荐的主路径** | 见下方论证 |
| B（顶层 inject） | ❌ 否决 | 自回环真实；且把审计混进模型上下文，违背插件自己「给 worker 省上下文」的哲学 |
| C（log-only 新事件） | ⚠️ 官方机制存在，但**写入面断掉** | 见 Q2/Q3 |

**D 为什么成立**：chat 包自己的 14 个 node definition 里，compaction、retry、turn-error、turn-max-tokens、turn-tail、turn-process **全部 match 的是 log-only 事件**（client.js:7304-7319 的注册清单）——def 的 `match(event)` 输入是全事件流，不限于 surface 事件。所以插件可以在自己会话上注册一个 def：`match` 命中 `name === "team_link_send"` 的 tool 事件，`buildLocationData` 在 turn 作用域挂节点，配一个 `conversation.chat.node` slot view 渲染与接收方同款卡片。数据已经在事件里（tool/call 的 arguments 含目标与正文、tool/result 的输出文本就是「已投递到…」），**零新增日志、零模型可见性变化、导出不受影响**。而 unknown fallback 只认 append-surface 事件（client.js:5958-5964 `isAppendSurfaceEvent` 过滤），不会跟你的 def 撞出重复节点。`uiConversation` 是声明在 Cordis Context 上的公开服务（dsh-client-ui-conversation/types/client/index.d.ts:29-36），`events.register` 是公开 registry（event-registry.d.ts:4-11，"uniquely named"——kind 记得带插件前缀）。

**Q2：有没有官方认可的扩展点承载自定义日志事件？**

**有，而且分三层——但第三层断了：**

1. **类型面**：`declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap {...} }` 接口合并，`dsh-session-log-deepseek/types.d.ts:73-85` 就是官方示范，`SessionEventType` 明文 "plugin-merged extensions included"（types.d.ts:411）。
2. **信封面**：`SessionEvent.ignorable: true` 是**官方为仓库外插件事件设计的兼容机制**——known-event-types.js:14-19 原文："Downstream (out-of-repo) plugin events are outside this list **by construction**. The persisted `SessionEvent.ignorable` marker is the compatibility mechanism; event-name registration **was rejected**…"。持久化**读**路径对 ignorable 未知事件是保留而非拒绝（dsh-session-persistence/lib/index.js:184 只拒「未知且未标 ignorable」；jsonl worker.cjs:8942-8943 `ignorableUnknown` 放行）。你们引用的「Unknown events, even ignorable ones … are refused」出自 `dsh-session-format-v2-to-v3/README.md:120`——那是**格式迁移**的封闭清单策略，不是普通 restore 路径。但这个尾部风险真实：未来 v3→v4 若沿用封闭清单，带插件事件的旧日志会卡在迁移。
3. **写入面（断点）**：`Session.append(type, data, opts)` 构造信封只放 type/seq/time/data/surfaceOp/sourceEventSeqs（dsh-session/lib/index.js:1249-1255），签名（types/index.d.ts:248）与实现**都没有任何途径打 `ignorable`**。检索全部 @deepseek-ai 包，`ignorable: true` 只出现在 restore/seed/wire 路径，没有任何公开 live-write API 能设置它。

**Q3：运行时 append 是否校验事件类型？**

**不校验词汇表成员资格——这是坑不是许可。** append 只查：数据 lossless-JSON（index.js:1243-1246）、个别已知类型的 payload 一致性（`validateSessionEventData`:1256）、surface 元数据（`surfaceOpOf`:275-289，对「未知+ignorable」直接放行）。成员资格只在**读路径**强制。所以插件今天 append 一个自定义 log-only 事件：活着没事 → 写盘没事（v3 `encodeEvent` 对未知类型只把 ignorable 当可选成员，worker.cjs:9985-9995）→ **下次重启 restore 时整份会话日志被拒**（"contains event type … unknown to this harness and not marked ignorable; refusing to interpret the log"，persistence/index.js:184）。这正是 `kind:"team-link"` 事故的变体，只是引爆点从迁移挪到了 restore。**结论：C 在 DSH 上游补上「append 可打 ignorable」之前不可安全实施**；那个 d.ts 合并声明救不了你——KNOWN 清单是 `gen-persistence-catalog` 从**仓库内**声明生成的，外部插件的合并不进清单。

**Q4：第五条路？**

就是上面具体化后的 D。再补两个附带发现：

- **官方先例存在但不可搭车**：`dsh-experimental-agent-team` 的 `team/member`/`team/task`/`team/message/queued`/`team/message/delivered` 正是「发送侧会话里的 log-only 协作记录」的第一方实现（README.md:146："log-only: they never enter the conversation surface"）。它证明 DSH 官方认可这个模式，但它是**仓库内包**——进了 KNOWN 清单 + v2/v3 迁移 disposition（worker.cjs:6503 锁死 payload 成员）+ `./invariant` 伴生插件在 append 前重放校验状态机。外部插件直接 append `team/*` 事件 = 伪造它的状态机输入，**不要做**。同理 `MessageSourceMap` 里的 `team-message` source 也是它的领地。
- **B 的一个受控事实**：发送方模型本来就看得见 tool/call 参数与 tool/result 返回（已在上下文里），所以「模型知道自己发过什么」不是新增暴露——B 的问题只在**额外注入一条会诱发回复的消息**。这反过来支持 D：可见性补在客户端，模型上下文维持现状即是最优。

**A+D 的风险面**：① 卡片正文要截断（tool arguments 里可能是长文）；② def 的 kind 名要带插件前缀（registry 要求 unique named）；③ 同一消息在发送方会话出现两次（工具树行 + 顶层卡片）——设计上明说这是刻意的对称体验；④ 客户端 def/registry 是较新的公开面，DSH 升级有跟随成本（但这比会话格式风险低一个数量级——坏了只是不渲染，不炸日志）。

---

# ② /team_session 自动建队：判定与证据

## 1. 根级会话怎么建：全部省略即根

```text
ctx.agents.create({
  sessionId: 自造唯一id,
  meta: { cwd: <绝对路径> },        // ← 只有 cwd；origin/parentSession/delegationDepth 全省略
  agentOptions: { model, ... },
  setup,
})                                   // ← 无 parentAgent
```

证据链：`meta.origin` 类型就是 `'subagent' | undefined`（dsh-agent/types/index.d.ts:68）；header 运行时校验 `origin !== undefined && origin !== 'subagent'` 抛错（dsh-session/lib/index.js:846）——**undefined 是唯一且合法的「非子代理」取值**；`parentAgent` 注释 "omit for a root Agent"（index.d.ts:51-52）。侧边栏与通用路由只在 `origin === 'subagent'` 时交给 subagent 路由（api-session-controller/lib/index.js:125），无 origin = 普通顶层会话；lineage.d.ts:19-20 明说 origin 只是 "navigation filtering; not a continuation capability"。

**要泼的冷水**：「只听从主会话指挥」**不是 header 能表达的语义**——那属于 roster/policy 层（你们已有的 `policy.writer` 机制），别试图用 delegationDepth 或 origin 编码指挥关系。worker 的「服从」来自启动 prompt + roster 写权限，不是来自会话血统。

## 2. 启动任务怎么送：create resolve 之后 followup，复用现有 relay 形态

"Setup composes, it never drives — drive the agent only after creation resolves"（index.d.ts:100-102）字面执行：`const handle = await ctx.agents.create(...)` 之后 `handle.agent.followup(msg)`。新会话必 idle，followup 即首回合；**不要用 `inject`**（那是「投递不唤醒」的上下文注入，启动任务需要驱动）。消息形态复用你们已验证合规的三成员 relay source `{kind:"agent-message", form:"relay", senderSessionId: 主会话id}`——senderSessionId 填主会话，worker 天然知道往哪回。首条启动任务建议豁免接收确认门（worker 是用户指令直接创建的，同意权由命令确认框一次性授予），后续消息照常过双门。

## 3. 侧边栏可见/可打开：是，但有一个待实测点

createAgent 走 `persistence.create(header)` 先落持久身份再发布（dsh-agent-loop README:115），`session/created` 公告 → 会话列表快照收录 → 无 origin → 顶层列表项。**待实测**：web 壳点击一个已有 live agent 的会话时是否复用 agents store 里的实例（应该是——session controller 从 store 解析）；若壳层试图另行 resume，`persistence.open(id,'write')` 的单写者语义会拒并发。这个要在真机点一次。

## 4. 数量上限与确认框：三层放置

- **确认框在命令 handler 层**：`CommandInvocation` 带确切 `agent`（dsh-commands/types/index.d.ts:19-36），用你们已在 send 工具里用的同一 `ctx.get("userQuestions").ask({..., agent: invocation.agent})`。内容：N、每 worker 模型/预设、cwd、成本口径（N × 完整首回合的保守估算，并声明后续每条 followup 都是完整回合）。命令本身是人类指令，gate 1 天然满足，框补的是批量爆炸半径知情。
- **上限三层**：命令语法硬顶（建议 N≤8，对齐你们 fan-out ≤8 的既有约定）→ settings 可调（默认 8、硬顶 16）→ roster 层每 team 成员总数上限（防「多次命令 + 手动加人」累计超限）。

## 5. 坑（按严重度排序）

1. **所有权/生命周期（最大）**：create 的 transaction 挂在**调用者 ctx 的 fiber**（dsh-agent/types/index.d.ts:165-168）。从命令 handler 的临时 ctx 创建 = handler 结束可能连带拆 agent。必须从**插件根 ctx** 创建、插件持有全部 `AgentHandle`。诚实的代价：**插件卸载/重载 = 全队 teardown**（会话已持久化在盘、agent 不在）。设计要内建恢复路径：roster 把「盘上无活代理」标 dead（对齐公理 A4），插件重载后提供收编/resume 引导。
2. **部分失败语义**：第 k 个 create 失败时前 k-1 个已发布。建议失败即停、已建者保留 + 报告清单，命令设计成幂等（同 role 已存在则跳过）。并发建议串行或 ≤2——N 个 agent 同时 followup = 成本峰值 N 个首回合同时打模型。
3. **孤儿会话**：命令中断/崩溃时「已 create 未进 roster」= 孤儿。缓解：先写 roster pending-create 意图（带 TTL），成功后回填；插件启动时清扫过期 pending 并报告可收编清单。
4. **id 冲突**：同 id 已注册会抛（dsh-agent/lib/index.js:480）——id 自造时用 team 前缀 + 随机尾。
5. **cwd**：`meta.cwd` 必须绝对路径（SessionStore.create 校验），默认主会话 cwd。

**文档修正项**：team-link 代码里那句「本插件不能编程创建会话（V9 未验证）」（约 :3131）现在可证伪——`agents.create` 公开可用（dsh-agent/lib/index.js:417-422、types/index.d.ts:279），§3.6.4 半自动兜底可升级为全自动，但 ownership 语义必须同批写清。

---

## 建议验收（对应上述判定）

- ①A：注册 toolview 后，发送方工具树内该行呈卡片（含目标/状态/时间）；
- ①D：发送方顶层出现一条回执卡片，**导出 md/JSON 内容不变**（证明零日志改动）；发送方模型下一回合上下文无任何新增消息（可用 export 的 JSON 核对）;
- ②：`/team_session` 建出的会话在侧边栏顶层可见、可打开、可被 team_link_send 寻址；插件重载后 roster 正确标 dead 且盘上会话可手动恢复；命令中断后无未登记孤儿。

一句话收束：**① 走 A+D（纯客户端，模型上下文零扰动）；C 留作给 DSH 上游的 feature request（append 支持 ignorable），不作为本插件的实施路径；② 用「全省略 meta 血统字段」拿根会话，用「create resolve 后 followup relay 消息」送任务，把确认框放命令层、上限做三层，并把插件所有权导致的 teardown 写成显式生命周期而不是事故。**

[2] deepseek-official:deepseek-v4-pro — ok
评审完成。我把所有论断都落到了源码行级证据上（本轮补查了 `dsh-session`/`dsh-session-persistence` 的 append 与读路径、`dsh-client-ui-conversation` 的节点注册引擎、`dsh-webhook` 与 `dsh-api-session-controller` 的建会话先例、`dsh-agent` 的 `Agent` 驱动面、`dsh-tools` 的 presentation 链，以及插件自身的 `lib/index.js`/`lib/client.js`）。以下是完整评审报告。

---

# ① 发送方可见性 — 判定

**结论：A（toolview 卡片）必做、最稳；「再有一条顶层可见记录」走 D（客户端升格）最稳。C 技术上可行但没有收益，B 直接违背你的硬约束。推荐组合 = A + D。**

## 证据链（每条均为本轮实测）

1. **发送方看不到卡片的根因**：插件客户端只注册了一个 `conversation.chat.node` 槽位，`key: "context"`（[client.js:352-359](D:\DSH-Portable\plugins\dsh-team-link\lib\client.js)），它只接管**接收方**日志里的 relay 上下文消息（`source.kind==="agent-message" && form==="relay"`，[client.js:284-297](D:\DSH-Portable\plugins\dsh-team-link\lib\client.js)）。发送方自己的 `team_link_send` 在发送方日志里只是一对 `tool/call`+`tool/result`，插件**没有注册任何 `tool.call.toolview` 键** → 落回通用工具行（灰 ✦）。这就是根因，不是渲染 bug。
2. **A 的官方槽位**：[slots.d.ts:22-26](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-client-ui-tool\lib\types\client\contract\slots.d.ts) 写明 `tool.call.toolview` 按线上工具名键控、键域开放、「对自己工具是叠加」。渲染数据来自 `block: ToolCallBlock`（[records.d.ts:151-176](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\types\client\contract\records.d.ts)，含 `call.name/argsRaw/content` 和 `meta?: unknown`）。
3. **卡片数据的官方耐久载体**：`tool/result.meta`（[types.d.ts:341-352](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-session\lib\types\types.d.ts)）——「对核心不透明、产生工具自持形状、JSON 校验、**durable log 回放时复现同一张卡**」；写入端是 `defineTool` 的 `output.presentationMeta(args, value): JsonValue`（[dsh-tools types/index.d.ts:98-109](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-host-apiproxy\node_modules\@deepseek-ai\dsh-tools\lib\types\index.d.ts)）。目前 `team_link_send` 用的是 `output: textOutput()`（[index.js:4117](D:\DSH-Portable\plugins\dsh-team-link\lib\index.js)），加一个 `presentationMeta` 把逐目标投递回执结构化即可。
4. **D 的可行性**：chat 包自己的 `toolDefinition`（[dsh-client-ui-chat lib/client.js:6510-6551](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-client-ui-chat\lib\client.js)）就是「match 所有 `tool/call`/`tool/result` → 顶层 `tool-call` 节点」。注册引擎（[event-registry.d.ts:5-17](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\types\client\conversation\event-registry.d.ts) + [definition-registry.d.ts:22-29](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\types\client\conversation\definition-registry.d.ts)）按 **kind 唯一**注册、允许多个 definition 各自 match 同一事件、各自发布自己的 location key（只有**同 key** 才拒绝，[conversation.d.ts:190-201](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\types\client\contract\conversation.d.ts)）。因此插件再注册一个 kind（如 `team-link-send`）的 definition，match `tool/call` 且 `data.name==="team_link_send"`、`tool/result` 按 `callId` 配对 update，再用 `chatNode(context, kind, anchorSeq, data)`（[common.d.ts:21-34](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-client-ui-chat\lib\types\client\conversation-nodes\common.d.ts)，location 自动从 context 解析）产出一个**顶层节点**。零新日志写入。
5. **B 为什么会自回环**：`followup`/`steer`/`inject` 三者投递的都是 `user/message`（[runtime-types.d.ts:187-209](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-agent\lib\types\runtime-types.d.ts)），而 `user/message` 是 surface 事件、必然投影进模型上下文（[types.d.ts:274-281](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-session\lib\types\types.d.ts)）。没有「顶层可见但这条不进模型」的 B。
6. **C 的代价，比你说的更微妙**：运行时 `Session.append` **完全不校验词表**——只校验 JSON 可序列化、已知类型的语义规则、surface 资格、防重入（[dsh-session lib/index.js:1237-1277](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-session\lib\index.js)）。**词表检查推迟到持久化读路径**：[dsh-session-persistence lib/index.js:184](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-session-persistence\lib\index.js) 对「未知类型且非 ignorable」直接抛「refusing to interpret the log」。也就是说 C 的失败**不会在 append 现场暴露**，而是推迟到下次加载/迁移——这正是历史 `kind:"team-link"` 事故的失败形态。
7. **对你已验事实的一处修正**：你记的「Unknown events, **even ignorable ones** … are refused」与实际相反——未知但**标了 `ignorable:true` 的事件是被保留并跳过的**（[dsh-session lib/index.js:278](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-session\lib\index.js)、客户端同逻辑 [dsh-api-session-controller lib/client.js:257](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-api-session-controller\lib\client.js)）；被拒绝的只是**未知且未标**的事件。官方明确把 `ignorable` 标记定为**仓外插件事件的兼容机制**，并明确「事件名注册」被否决（[known-event-types.d.ts:7-20](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-session\lib\types\known-event-types.d.ts)，理由归档在 `2026-08-30-retain-ignorable-external-session-events.md`）。所以 C **有官方承载点**，但它是「永久义务」：每个事件都要标标记，丢一次 = 整本会话日志不可读。

## 你三个问题的直接答案

| 问题 | 答案 |
|---|---|
| A/B/C/D 哪条最稳 | **A 最稳**（纯槽位，小改）；顶层记录 **D 最稳**（复用已存在的 `tool/call`+`tool/result` 事件，零新词汇、零模型影响、零迁移风险） |
| 官方认可的自定义日志事件扩展点 | **有**：`SessionEventMap` merge 增广 + 信封 `ignorable: true` 标记（不是事件名注册）。但每条事件都必须带标记，且客户端投影会静默跳过它——渲染仍要靠插件自己的节点 definition，等于 C 的客户端工作量与 D 完全相同 |
| 运行时 append 是否校验事件类型 | **否**。append 只查 JSON/语义/surface 资格；词表检查在**持久化读路径**才发生（`dsh-session-persistence:184`）。失败模式是延迟的、灾难性的 |
| 第五条路 | **有，而且正好给 ② 用**：slash 命令的生命周期事件 `command/run` + `command/done` 是**已知 log-only 类型**（[dsh-commands types/index.d.ts:117-121](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-commands\lib\types\index.d.ts)），客户端有**原生 CommandNode 顶层行**渲染——`/team_session` 一条命令就免费获得顶层可见记录。另两条补充：把发送回执追加进 team 黑板 `decisions.md`（插件已有机制，审计留痕但不进日志不进模型）；`presentResult` 的 generic 卡片（官方词汇但封闭 union，定制度不如 toolview） |

## A + D 组合的风险清单

- **A**：toolview 键必须精确等于线上工具名 `team_link_send`（[index.js:4109](D:\DSH-Portable\plugins\dsh-team-link\lib\index.js)），typo 静默回退通用行；fan-out（≤8 目标）时一张卡要承载逐目标结果 → 卡内做逐目标列表。
- **D**：插件客户端 bundle 需新增 inject `"uiConversation"`（服务名已确认，[dsh-client-ui-conversation lib/client.js:2644](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\client.js)）；definition kind 全局唯一，取名带前缀防撞；`ChatNodeDataMap` 需类型增广 + 注册同 kind 的 `conversation.chat.node` 槽位（与现有 `key:"context"` 并存无冲突）；**窗口截断回退**：`tool/call` 滚出历史窗口时只剩 `tool/result`，需照 chat 包 `fallbackState$2` 的模式用 `context.matches` 回退（[client.js:6497-6507](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-client-ui-chat\lib\client.js)）；`chatNode`/`contextLocation` 两个 helper 形状公开（[common.d.ts:21-34](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-client-ui-chat\lib\types\client\conversation-nodes\common.d.ts)），实现时确认能否从客户端模块系统 require 到 chat 包（其 bundle 本身就是模块工厂，有先例），不能就按公开形状手工构造节点字面量。
- **重复渲染**：D 的顶层卡与工具树行并存（树行被 A 接管成卡）→ 设计上顶层放「已发送摘要卡」，树行放完整明细，避免同一信息出现两次。
- **自回环**：A/D 均不写任何消息事件，模型上下文零变化，硬约束天然满足。

---

# ② /team_session 自动建队 — 判定

**结论：全部可行，且仓库里有两个一字不差的官方先例。根会话 = 省略 `origin`（和 `delegationDepth`/`parentAgent`）。启动任务 = `create` resolves 后 `followup`。侧边栏可见、可打开。上限放 host 命令层，确认框复用插件已有的 `userQuestions` 对话框机制。**

## 1. 根级会话怎么建

官方模板是 [dsh-webhook lib/index.js:90-134](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-webhook\lib\index.js) `createWebhookSession`：

- `sessionId`：调用方自造（`brandString(\`webhook-${randomUUID()}\`)`；类型层用 `SessionId()` 品牌函数，[dsh-session types.d.ts:11](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-session\lib\types\types.d.ts)）；
- `meta: { cwd, agentPreset }` —— **没有 `origin`、没有 `delegationDepth`、没有 `parentAgent`** → 普通根会话；
- 创建后 **handle 可以丢弃**：「the Agent remains lifecycle-owned by `ctx` and follows normal Session behavior」（[同文件 79-82 行](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-webhook\lib\index.js)）。

第二个先例是 UI「新建会话」本身：[dsh-api-session-controller lib/index.js:410-457](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-api-session-controller\lib\index.js) `createOrAdopt`，meta 同样只放 `cwd`/`agentPreset`。插件已注入 `"agents"`（[index.js:62](D:\DSH-Portable\plugins\dsh-team-link\lib\index.js)），`ctx.agents.create` 直接可用；`CreateAgentOptions` 里 `origin` 本来就可选（[dsh-agent types/index.d.ts:64-
… [reply capped at 8000 chars — the uncapped text is in the minutes' §1.1]

[3] kimi-api:kimi-k3 — failed
(consultation failed: consultation timed out after 20min (consultTimeoutMs))

[4] codex-cli:gpt-6-astra — failed
(consultation failed: consultation timed out after 20min (consultTimeoutMs))
```

### §1.1 未截断全文（**仅当有回复超 8000 字软顶时出现**；机制写）

#### [2] deepseek-official:deepseek-v4-pro（12655 字）

```text
评审完成。我把所有论断都落到了源码行级证据上（本轮补查了 `dsh-session`/`dsh-session-persistence` 的 append 与读路径、`dsh-client-ui-conversation` 的节点注册引擎、`dsh-webhook` 与 `dsh-api-session-controller` 的建会话先例、`dsh-agent` 的 `Agent` 驱动面、`dsh-tools` 的 presentation 链，以及插件自身的 `lib/index.js`/`lib/client.js`）。以下是完整评审报告。

---

# ① 发送方可见性 — 判定

**结论：A（toolview 卡片）必做、最稳；「再有一条顶层可见记录」走 D（客户端升格）最稳。C 技术上可行但没有收益，B 直接违背你的硬约束。推荐组合 = A + D。**

## 证据链（每条均为本轮实测）

1. **发送方看不到卡片的根因**：插件客户端只注册了一个 `conversation.chat.node` 槽位，`key: "context"`（[client.js:352-359](D:\DSH-Portable\plugins\dsh-team-link\lib\client.js)），它只接管**接收方**日志里的 relay 上下文消息（`source.kind==="agent-message" && form==="relay"`，[client.js:284-297](D:\DSH-Portable\plugins\dsh-team-link\lib\client.js)）。发送方自己的 `team_link_send` 在发送方日志里只是一对 `tool/call`+`tool/result`，插件**没有注册任何 `tool.call.toolview` 键** → 落回通用工具行（灰 ✦）。这就是根因，不是渲染 bug。
2. **A 的官方槽位**：[slots.d.ts:22-26](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-client-ui-tool\lib\types\client\contract\slots.d.ts) 写明 `tool.call.toolview` 按线上工具名键控、键域开放、「对自己工具是叠加」。渲染数据来自 `block: ToolCallBlock`（[records.d.ts:151-176](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\types\client\contract\records.d.ts)，含 `call.name/argsRaw/content` 和 `meta?: unknown`）。
3. **卡片数据的官方耐久载体**：`tool/result.meta`（[types.d.ts:341-352](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-session\lib\types\types.d.ts)）——「对核心不透明、产生工具自持形状、JSON 校验、**durable log 回放时复现同一张卡**」；写入端是 `defineTool` 的 `output.presentationMeta(args, value): JsonValue`（[dsh-tools types/index.d.ts:98-109](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-host-apiproxy\node_modules\@deepseek-ai\dsh-tools\lib\types\index.d.ts)）。目前 `team_link_send` 用的是 `output: textOutput()`（[index.js:4117](D:\DSH-Portable\plugins\dsh-team-link\lib\index.js)），加一个 `presentationMeta` 把逐目标投递回执结构化即可。
4. **D 的可行性**：chat 包自己的 `toolDefinition`（[dsh-client-ui-chat lib/client.js:6510-6551](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-client-ui-chat\lib\client.js)）就是「match 所有 `tool/call`/`tool/result` → 顶层 `tool-call` 节点」。注册引擎（[event-registry.d.ts:5-17](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\types\client\conversation\event-registry.d.ts) + [definition-registry.d.ts:22-29](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\types\client\conversation\definition-registry.d.ts)）按 **kind 唯一**注册、允许多个 definition 各自 match 同一事件、各自发布自己的 location key（只有**同 key** 才拒绝，[conversation.d.ts:190-201](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\types\client\contract\conversation.d.ts)）。因此插件再注册一个 kind（如 `team-link-send`）的 definition，match `tool/call` 且 `data.name==="team_link_send"`、`tool/result` 按 `callId` 配对 update，再用 `chatNode(context, kind, anchorSeq, data)`（[common.d.ts:21-34](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-client-ui-chat\lib\types\client\conversation-nodes\common.d.ts)，location 自动从 context 解析）产出一个**顶层节点**。零新日志写入。
5. **B 为什么会自回环**：`followup`/`steer`/`inject` 三者投递的都是 `user/message`（[runtime-types.d.ts:187-209](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-agent\lib\types\runtime-types.d.ts)），而 `user/message` 是 surface 事件、必然投影进模型上下文（[types.d.ts:274-281](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-session\lib\types\types.d.ts)）。没有「顶层可见但这条不进模型」的 B。
6. **C 的代价，比你说的更微妙**：运行时 `Session.append` **完全不校验词表**——只校验 JSON 可序列化、已知类型的语义规则、surface 资格、防重入（[dsh-session lib/index.js:1237-1277](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-session\lib\index.js)）。**词表检查推迟到持久化读路径**：[dsh-session-persistence lib/index.js:184](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-session-persistence\lib\index.js) 对「未知类型且非 ignorable」直接抛「refusing to interpret the log」。也就是说 C 的失败**不会在 append 现场暴露**，而是推迟到下次加载/迁移——这正是历史 `kind:"team-link"` 事故的失败形态。
7. **对你已验事实的一处修正**：你记的「Unknown events, **even ignorable ones** … are refused」与实际相反——未知但**标了 `ignorable:true` 的事件是被保留并跳过的**（[dsh-session lib/index.js:278](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-session\lib\index.js)、客户端同逻辑 [dsh-api-session-controller lib/client.js:257](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-api-session-controller\lib\client.js)）；被拒绝的只是**未知且未标**的事件。官方明确把 `ignorable` 标记定为**仓外插件事件的兼容机制**，并明确「事件名注册」被否决（[known-event-types.d.ts:7-20](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-session\lib\types\known-event-types.d.ts)，理由归档在 `2026-08-30-retain-ignorable-external-session-events.md`）。所以 C **有官方承载点**，但它是「永久义务」：每个事件都要标标记，丢一次 = 整本会话日志不可读。

## 你三个问题的直接答案

| 问题 | 答案 |
|---|---|
| A/B/C/D 哪条最稳 | **A 最稳**（纯槽位，小改）；顶层记录 **D 最稳**（复用已存在的 `tool/call`+`tool/result` 事件，零新词汇、零模型影响、零迁移风险） |
| 官方认可的自定义日志事件扩展点 | **有**：`SessionEventMap` merge 增广 + 信封 `ignorable: true` 标记（不是事件名注册）。但每条事件都必须带标记，且客户端投影会静默跳过它——渲染仍要靠插件自己的节点 definition，等于 C 的客户端工作量与 D 完全相同 |
| 运行时 append 是否校验事件类型 | **否**。append 只查 JSON/语义/surface 资格；词表检查在**持久化读路径**才发生（`dsh-session-persistence:184`）。失败模式是延迟的、灾难性的 |
| 第五条路 | **有，而且正好给 ② 用**：slash 命令的生命周期事件 `command/run` + `command/done` 是**已知 log-only 类型**（[dsh-commands types/index.d.ts:117-121](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-commands\lib\types\index.d.ts)），客户端有**原生 CommandNode 顶层行**渲染——`/team_session` 一条命令就免费获得顶层可见记录。另两条补充：把发送回执追加进 team 黑板 `decisions.md`（插件已有机制，审计留痕但不进日志不进模型）；`presentResult` 的 generic 卡片（官方词汇但封闭 union，定制度不如 toolview） |

## A + D 组合的风险清单

- **A**：toolview 键必须精确等于线上工具名 `team_link_send`（[index.js:4109](D:\DSH-Portable\plugins\dsh-team-link\lib\index.js)），typo 静默回退通用行；fan-out（≤8 目标）时一张卡要承载逐目标结果 → 卡内做逐目标列表。
- **D**：插件客户端 bundle 需新增 inject `"uiConversation"`（服务名已确认，[dsh-client-ui-conversation lib/client.js:2644](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\client.js)）；definition kind 全局唯一，取名带前缀防撞；`ChatNodeDataMap` 需类型增广 + 注册同 kind 的 `conversation.chat.node` 槽位（与现有 `key:"context"` 并存无冲突）；**窗口截断回退**：`tool/call` 滚出历史窗口时只剩 `tool/result`，需照 chat 包 `fallbackState$2` 的模式用 `context.matches` 回退（[client.js:6497-6507](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-client-ui-chat\lib\client.js)）；`chatNode`/`contextLocation` 两个 helper 形状公开（[common.d.ts:21-34](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-client-ui-chat\lib\types\client\conversation-nodes\common.d.ts)），实现时确认能否从客户端模块系统 require 到 chat 包（其 bundle 本身就是模块工厂，有先例），不能就按公开形状手工构造节点字面量。
- **重复渲染**：D 的顶层卡与工具树行并存（树行被 A 接管成卡）→ 设计上顶层放「已发送摘要卡」，树行放完整明细，避免同一信息出现两次。
- **自回环**：A/D 均不写任何消息事件，模型上下文零变化，硬约束天然满足。

---

# ② /team_session 自动建队 — 判定

**结论：全部可行，且仓库里有两个一字不差的官方先例。根会话 = 省略 `origin`（和 `delegationDepth`/`parentAgent`）。启动任务 = `create` resolves 后 `followup`。侧边栏可见、可打开。上限放 host 命令层，确认框复用插件已有的 `userQuestions` 对话框机制。**

## 1. 根级会话怎么建

官方模板是 [dsh-webhook lib/index.js:90-134](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-webhook\lib\index.js) `createWebhookSession`：

- `sessionId`：调用方自造（`brandString(\`webhook-${randomUUID()}\`)`；类型层用 `SessionId()` 品牌函数，[dsh-session types.d.ts:11](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-session\lib\types\types.d.ts)）；
- `meta: { cwd, agentPreset }` —— **没有 `origin`、没有 `delegationDepth`、没有 `parentAgent`** → 普通根会话；
- 创建后 **handle 可以丢弃**：「the Agent remains lifecycle-owned by `ctx` and follows normal Session behavior」（[同文件 79-82 行](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-webhook\lib\index.js)）。

第二个先例是 UI「新建会话」本身：[dsh-api-session-controller lib/index.js:410-457](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-api-session-controller\lib\index.js) `createOrAdopt`，meta 同样只放 `cwd`/`agentPreset`。插件已注入 `"agents"`（[index.js:62](D:\DSH-Portable\plugins\dsh-team-link\lib\index.js)），`ctx.agents.create` 直接可用；`CreateAgentOptions` 里 `origin` 本来就可选（[dsh-agent types/index.d.ts:64-71](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-agent\lib\types\index.d.ts)）。

两个细节：`parentSession`（血缘）可以加但**建议不加**——客户端只按 `origin==="subagent"` 归类 catalog（[dsh-api-session-controller lib/client.js:2624-2632](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-api-session-controller\lib\client.js)），subagent 地址路由也只认 `origin`（[index.js:1546-1549](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-api-session-controller\lib\index.js)），加了也不误触——但最小化。`agentPreset`：建议从主会话 `header.agentPreset` 继承（[types.d.ts:94](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-session\lib\types\types.d.ts)），否则 worker 的工具体系可能和主会话不同。

## 2. 启动任务怎么送

**复用 followup 路径，完全合规**：`create` resolves 之后 `handle.agent.followup(startupMessage)`——与「**Setup composes, it never drives — drive the agent only after creation resolves**」（[dsh-agent types/index.d.ts:100-102](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-agent\lib\types\index.d.ts)）一字不差，webhook 先例就是 `handle.agent.followup(createUserMessage(...))`（[dsh-webhook:120-134](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-webhook\lib\index.js)）。消息 `source` 建议直接复用插件已有的三成员 relay 形状 `{kind:"agent-message", form:"relay", senderSessionId:主会话id}`——worker 界面自动渲染成现有跨会话卡片，且它是 surface 消息（**启动任务本来就该进 worker 模型上下文**，与 ① 的约束不冲突：那是「自己发给自己」的回环，这是「主会话发给 worker」的正常输入）。

**成本控制的替代**：`handle.agent.inject(brief)`（[runtime-types.d.ts:201-209](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-agent\lib\types\runtime-types.d.ts)）——注入常驻 brief 但**不唤醒**（零回合）；首任务到达时由现有 `deliverToTarget` 的 `steer/followup` 分流（[index.js:3047-3048](D:\DSH-Portable\plugins\dsh-team-link\lib\index.js)）自然唤醒。推荐：inject 常驻 brief + 每个 worker 一条 followup 首任务，或让协调者按需唤醒。

## 3. 侧边栏 / 打开

**会出现在侧边栏**：工厂对每次创建都会 announce `session/created` → `api-session/added`（[dsh-api-session-controller lib/index.js:2718-2720](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-api-session-controller\lib\index.js)），origin 缺席 → 普通顶层条目。**能打开**：与普通会话同一路径（live 直接返回；重启后 persisted → `resume`，[index.js:410-432](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-api-session-controller\lib\index.js)）。**一个必须写进文档的依赖**：若部署未配置会话持久化，重启后 worker 会话消失（与所有会话一致，非插件特有）；若配置了，resume 时 setup 必须幂等。

## 4. 上限与一次性确认放哪层

- **上限**：host 命令 handler 内常量校验。建议 = 现有 `FANOUT_MAX_TARGETS = 8`（[index.js:2536](D:\DSH-Portable\plugins\dsh-team-link\lib\index.js)），保持一致心智模型；dry-run 前还要数 roster 现有会话。
- **确认框**：复用插件已有机制 `ctx.get("userQuestions").ask(...)`（先例 `askRotationDialog`，[index.js:3472-3526](D:\DSH-Portable\plugins\dsh-team-link\lib\index.js)）。流程：**第一次调用 = dry-run**，返回计划（逐 worker：角色/任务摘要/cwd/预算提示，且明示「确认后立即产生 N 个并发回合」）→ 弹一次多选确认（勾选要创建的 worker）→ 确认后创建。**超时/无人 = 取消，绝不静默创建**——与 rotation 的无人值守兜底不同：provisional 迁移可回退，建 N 个会话不可回退。不做客户端模态框：插件 client 目前只有静态按钮/卡片，无表单交互先例，host 对话框机制现成且已被验证过。
- **免费红利**：`/team_session` 本身走 `CommandRuntime.register`（[dsh-commands types/index.d.ts:94](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-commands\lib\types\index.d.ts)），其 `command/run`/`command/done` 是已知 log-only 事件、客户端有原生顶层 CommandNode 行——**这条命令的「顶层可见记录」不花任何额外工作**。

## 5. 并发、成本、孤儿——坑清单

- **并发**：N 个 `create` 可并行（各自 rollback-covered），但每个都 await 串行的 `agent/created` listeners → 建议串行或 ≤4 并发；创建本身零模型成本，**成本尖峰在启动回合**（N 个 followup = N 个并发模型回合）。上限 8 + dry-run 明示 + 可选廉价模型（`agentOptions: {provider, model}`，照 webhook）。
- **孤儿会话（最大的坑）**：无 `parentAgent` → 主会话结束/重启**不回收** worker。插件必须：①**保留 handle**——`AgentHandle.dispose` 是能力，只有持有者可拆（[dsh-agent types/index.d.ts:130-147](D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\dsh-agent\lib\types\index.d.ts)），建议 ctx 级 `Map<sessionId, handle>`（照 `WATCHDOG_BY_CTX` 先例）；②roster 登记复用纯函数 `applyTeamUpsert`/`applySetRole`；③现有 watchdog patrol 收养（TTL 清扫机制已在）对无主/超龄 worker 调 `dispose` 或发告警；④**插件重载陷阱**：不要把 `dispose` 绑进插件 effect teardown——插件 HMR/配置变更会误杀全队。创建后所有权交给宿主生命周期（webhook 语义），插件只存 handle 供主动退役。
- **退役语义**：`team_link_roster action=retire` 已有（`applyRetire`），要明确「退役 = 注销 + dispose 该 worker 的代理」还是只注销——建议补一个显式 dispose 动作，否则退役后的会话仍占着 live agent。
- **批准策略隔离**：worker 后续工具调用走各自会话的批准门，与主会话隔离；默认独立、显式继承，避免全队共享免批。
- **goal 合规**：启动任务提示 worker 自建 goal，插件绝不代调 `goals.resume`（rotation 已有同一先例，[index.js:3572](D:\DSH-Portable\plugins\dsh-team-link\lib\index.js)）。
- **文档漂移**：[index.js:3574](D:\DSH-Portable\plugins\dsh-team-link\lib\index.js) 的「本插件不能编程创建会话（V9 未验证）」在 ② 落地后必须同步改为指向 `/team_session`（用户已确认的三条决定之一）。

---

**给父代理的汇总建议**：① 按 A+D 出设计（附上「官方扩展点 = ignorable 标记」「append 不校验词表、拒绝在持久化读路径」两处对用户已验事实的修正）；② 按 webhook 模板 + userQuestions 确认 + watchdog 收养出设计，并把 3574 文档漂移列为必改项。未发现需要再查的未知面——两个问题都有仓库内先例背书，可以直接进设计。
```

## §2 逐问裁定（**主代理写**）

> 每条意见**恰一条处置**。2/4 交付（glm-5.3、deepseek-v4-pro），两条均为源码级完整答案且**独立收敛**；另 2 条超时（failed，无内容，不构成 pending）。

| # | 来源 | 意见（要点） | 处置 | 理由 / 落点 |
|---|---|---|---|---|
| G1 | glm | A（toolview 卡片）确定可行、零风险（对自己工具是 additive） | **采纳** | 与 D2/D8 独立一致。落点：《协作增强设计》§10.1.1 |
| G2 | glm | **D（客户端升格）是最佳主路径**：注册 conversation node definition，match 发送方已有的 `tool/call`+`tool/result`；chat 自家 6 个 def 就是 match log-only 事件，说明 `match(event)` 面对全事件流；unknown fallback 只认 append-surface 事件，不会撞出重复节点；`uiConversation` 是公开服务、`events.register` 是公开 registry（kind 须全局唯一、带前缀） | **采纳（本轮关键发现——推翻我上轮的 C 倾向）** | 落点：《协作增强设计》§10.1.3 |
| G3 | glm | B 否决：自回环真实；且把审计混进模型上下文，违背本插件「给 worker 省上下文」的哲学 | **采纳** | 落点：《协作增强设计》§10.1 取舍表 |
| G4 | glm | C 的三层扩展点里**写入面是断的**：`Session.append` 的信封没有 `ignorable` 通道；KNOWN 清单由仓库内声明生成，外部插件的合并不进清单 ⇒ 现场写不报错、**下次 restore 整份日志被拒** | **采纳**（我逐行复核 `dsh-session/lib/index.js:1237-1255`：信封确为 `{type,seq,time,data,...surfaceMetadata}`，`surfaceMetadata` 只可能带 `sourceEventSeqs`/`surfaceOp`，**无 `ignorable`**） | 落点：《协作增强设计》§10.1 取舍表 + 给上游的 feature request |
| G5 | glm | 运行时 append **不校验**词表成员资格 ⇒ 失败被推迟到 restore（与 `kind:"team-link"` 事故同形） | **采纳** | 同上 |
| G6 | glm | 官方先例存在但**不可搭车**：`dsh-experimental-agent-team` 的 `team/*` 事件正是「发送侧 log-only 协作记录」的第一方实现；外部插件直接 append = 伪造其状态机输入 | **采纳（作为禁令）** | 落点：《协作增强设计》§10.1「不得伪造第一方事件」 |
| G7 | glm | B 的受控事实：发送方模型本来就看得见 tool 参数与结果，「模型知道自己发过什么」不是新增暴露 | **采纳** | 支撑 D：可见性补在客户端即最优 |
| G8 | glm | A+D 风险面：正文要截断；kind 带前缀；同一消息两处出现（刻意）；客户端 def/registry 是较新公开面、有升级跟随成本（但比日志格式风险低一个数量级——坏了只是不渲染） | **采纳** | 落点：《协作增强设计》§10.1 边界 |
| G9 | glm | ② 根会话 = **全省略** `origin`/`parentSession`/`delegationDepth` 且无 `parentAgent`；header 运行时校验 `origin !== undefined && !== 'subagent'` 抛错 ⇒ `undefined` 是唯一合法的非子代理取值 | **采纳**（我另用 `dsh-webhook` 先例复核，见 D11） | 落点：《协作增强设计》§10.2 |
| G10 | glm | 「只听从主会话指挥」**不是 header 能表达的语义**，属 roster/policy 层（已有 `policy.writer`）；别用 `delegationDepth`/`origin` 编码指挥关系 | **采纳（重要设计修正）** | 落点：《协作增强设计》§10.2「服从来自启动 prompt + roster，不来自会话血统」 |
| G11 | glm | 启动任务：`create` resolve 之后 `followup`（**不要 `inject`**——那是「投递不唤醒」）；复用三成员 relay source；首条建议豁免接收确认门（同意权由命令确认框一次性授予），后续照常过双门 | **采纳** | 落点：《协作增强设计》§10.2（豁免口径需在设计中写明） |
| G12 | glm | 侧边栏可见/可打开：无 origin ⇒ 顶层列表项；**但**「点开一个已有 live agent 的会话是否复用实例」需真机点一次 | **采纳（转为 §5 待验项）** | §5 |
| G13 | glm | 上限三层（命令硬顶 N≤8 对齐既有 fan-out ≤8／settings 默认 8 硬顶 16／roster 每队成员数上限）+ 确认框放**命令 handler 层**（复用 `userQuestions.ask` + `invocation.agent`） | **采纳** | 落点：《协作增强设计》§10.2 |
| G14 | glm | 坑（按严重度）：① **所有权/生命周期最大**——create 的事务挂在调用者 ctx 的 fiber，用命令 handler 的临时 ctx 会导致 handler 结束即拆 agent ⇒ 必须从**插件根 ctx** 创建并持有 handle；插件卸载=全队 teardown（会话在盘、agent 不在）⇒ 需恢复路径；② 部分失败：失败即停、已建者保留+报告、按 role 幂等；③ 孤儿：`pending-create` 意图 + TTL + 启动清扫；④ id 冲突；⑤ `cwd` 必须绝对 | **采纳**（①与 D12 的调和见 §3） | 落点：《协作增强设计》§10.2 生命周期节 |
| G15 | glm | 文档修正：代码里「本插件不能编程创建会话（V9 未验证）」现已可证伪 | **采纳** | 与 D11 合并落点 |
| D1 | deepseek | ① 根因：客户端只注册了 `key:"context"`，**没有注册任何 `tool.call.toolview` 键** ⇒ 落回通用工具行（灰 ✦）。这是根因，不是渲染 bug | **采纳** | 落点：《协作增强设计》§10.1 现状 |
| D2 | deepseek | A 的渲染数据来自 `block: ToolCallBlock`（`call.name/argsRaw/content`、`meta?`） | **采纳** | 落点：《协作增强设计》§10.1.1 |
| D3 | deepseek | **`tool/result.meta` 是官方耐久载体**（对核心不透明、工具自持形状、JSON 校验、durable 回放复现同一张卡），写入端是 `output.presentationMeta(args, value): JsonValue`；现在 `send` 用 `textOutput()`，应加 `presentationMeta` 输出**结构化逐目标回执** | **采纳**（我另复核 `dsh-tools/lib/types/schema.d.ts:192`、`presentation.d.ts:257`，以及第一方 `dsh-tool-fs-search` 的同类用法） | 落点：《协作增强设计》§10.1 数据链 |
| D4 | deepseek | D 可行：registry 按 **kind 唯一**、允许**多个 definition match 同一事件**各自发布自己的 location key（仅同 key 才拒）；chat 自家 `toolDefinition` 就是「match `tool/call`+`tool/result` → 顶层 `tool-call` 节点」 | **采纳** | 落点：《协作增强设计》§10.1.3 |
| D5 | deepseek | B 自回环机制：`followup`/`steer`/`inject` 投递的都是 `user/message`，而 `user/message` 是 surface 事件、必然进模型 ⇒ **不存在**「顶层可见但不进模型」的 B | **采纳** | 落点：取舍表 |
| D6 | deepseek | C 的失败不会在 append 现场暴露，而是推迟到持久化读路径 | **采纳**（与 G5 同源，独立复核一致） | 取舍表 |
| D7 | deepseek | **纠正父代理的事实**：「Unknown events, **even ignorable ones** … are refused」是**迁移**文档的封闭清单措辞；实际规则是**保留**「未知但标了 `ignorable`」的事件，`ignorable` 正是官方为仓外插件事件设计的兼容机制（事件名注册被明确否决） | **采纳**（并据此修正我上轮的表述；与 G4 叠加后结论不变：机制在，但 **live write 无法打标**） | 落点：《协作增强设计》§10.1 事实修正 |
| D8 | deepseek | 最终判定：A 最稳，顶层记录走 D 最稳 | **采纳** | 同 G1/G2 |
| D9 | deepseek | 第五条路（给②用）：slash 命令本身会产生 `command/run`+`command/done` **已知 log-only 事件**，客户端有**原生 CommandNode 顶层行** ⇒ `/team_session` 免费获得顶层可见记录；另：把回执追加进黑板 `decisions.md` 作为审计留痕（不进日志、不进模型）；`presentResult` 的 generic 卡片是**封闭 union**，定制度不如 toolview | **采纳** | 落点：《协作增强设计》§10.2（顶层可见的免费来源）+ 《协作增强设计》§10.1（审计替代路径） |
| D10 | deepseek | A+D 风险：toolview 键必须**精确等于**线上工具名；fan-out 一卡承载逐目标；D 需 client 新增 inject `"uiConversation"`；kind 全局唯一带前缀；`ChatNodeDataMap` 类型增广 + 同 kind 注册 `conversation.chat.node` 槽位（与 `key:"context"` 并存）；**窗口截断回退**（`tool/call` 滚出窗口只剩 `tool/result` 时按 `context.matches` 回退，照 chat 包 fallback 模式）；`chatNode`/`contextLocation` helper 形状公开但**需确认客户端模块系统能否 require 到 chat 包**；**重复渲染**（顶层摘要卡 + 树内明细卡，须让两者承载不同内容） | **采纳** | 落点：《协作增强设计》§10.1 边界与验收 |
| D11 | deepseek | ② 官方模板 = `dsh-webhook` 的 `createWebhookSession`；第二先例 = UI 自身的 `createOrAdopt`；`meta` 只放 `cwd`/`agentPreset` | **采纳**（我复核 `dsh-webhook/lib/index.js:90-134`：`sessionId` 自造带前缀、`meta` 无 origin、create resolve 后 `followup` 驱动首回合） | 落点：《协作增强设计》§10.2 |
| D12 | deepseek | webhook 文档原话「the Agent remains lifecycle-owned by `ctx` and follows normal Session behavior」⇒ 创建的 handle 可丢弃 | **采纳**（与 G14① 的调和见 §3） | 《协作增强设计》§10.2 |
| F1 | kimi-k3 / codex-cli | 超时无内容 | **failed（不构成 pending）** | — |

## §3 分歧与父侧裁定（**主代理写**）

**（a）C 的「ignorable」之争：两半都对，但分属不同层。** deepseek 正确指出 `ignorable` 是官方为**仓外插件事件**设计的兼容机制（restore/读路径保留带标记的未知事件；事件名注册被明确否决）；glm 正确指出**没有任何 live-write API 能打这个标记**（我逐行复核 `Session.append` 实现证实）。**父侧裁定**：机制存在、**写入面断** ⇒ C 在本轮**不可安全实施**；登记为给 DSH 上游的 feature request（`append` 暴露 `ignorable`），不作为本插件的实施路径。⚠ 两条并不矛盾——它们是同一条链的**读侧**与**写侧**，各自成立。

**（b）所有权/生命周期（G14① vs D12）：表述不同，结论一致。** agent 属于「创建它时用的那个 ctx」。glm 是**操作级**警告：不要用命令 handler 的**临时 ctx** 创建；deepseek/webhook 是**生命周期级**表述：从插件 ctx 创建后 agent 随正常会话行为存续。**父侧裁定**：一律从**插件根 ctx** 创建并持有全部 handle；并把「插件卸载/重载 = 全队 teardown（会话在盘、agent 不在）」写成**显式代价 + 恢复路径**，而不是留成事故。

**（c）对父代理自己上轮表述的修正（我错）。** 我把**迁移文档**的封闭清单措辞（"even ignorable ones … are refused"）当成了通用规则——deepseek 指出它在迁移语境成立、在 restore 语境不成立。已按 D7 修正，并写进 §4 教训 2。

**规模观察**：本轮 2 条 failed 均为 20 分钟 `consultTimeoutMs` 超时（与 #36 的 3 条同因）。本轮 brief 信息量偏大（两问、九个待判定点），可能是耗时主因——下次同类 brief 建议拆成单问。

## §4 教训（**主代理写**）

1. **架构上存在的能力 ≠ 能安全使用的能力。** 我上轮已经查到「log-only 事件是一等公民」就**差点推荐 C**；两条回复独立指出**写入面断点**（append 无法打 `ignorable` ⇒ restore 拒绝整份日志）。教训：判一条路必须查到**写入面与失败面**，而不是查到类型面就收工。
2. **引用规则必须标明适用域。** 我把迁移文档的封闭清单策略当成了通用规则（§3(c)）。同一个词在「迁移清单」「运行时 append」「持久化读路径」三处语义并不相同——引用时要写明它在哪个子系统成立。
3. **会诊的价值是补盲区，不是投票。** D3（`tool/result.meta` + `output.presentationMeta` 作为官方结构化卡片载体）与 D9（slash 命令自带原生顶层 CommandNode 行 ⇒ ② 免费获得顶层可见记录）都是我**没想到**的机制，且直接改变实现路径（不必再 regex 解析工具返回文本；② 的顶层可见不用额外造轮子）。
4. **有效数与交付数继续脱钩。** 2/4 交付，但两条都是源码级完整答案、且**独立收敛**到同一结论（A+D / 根会话全省略 / followup 驱动）。不能把「几个模型回了」当质量指标。

## §5 不可验清单（**主代理写**）

- 编程创建的会话在 web 壳里「点开是否复用既有 live agent 实例」（G12，涉及持久化单写者语义）——**需真机点一次**；
- 客户端 bundle 能否 `require` 到 chat 包的 `chatNode`/`contextLocation` helper（D10）——需实测；不行则退化为按公开形状手工构造节点字面量；
- `ctx.uiConversation.events.register` 对**外部 bundle** 的 definition 是否真被接受（两方都说接口公开，**均未跑过**）；
- `tool/result` 滚出历史窗口后 `context.matches` 回退路径在真实滚窗下的行为（D10）；
- 上游是否计划开放 `Session.append` 的 `ignorable` 选项（C 的唯一解锁条件）——不在本插件范围；
- kimi-k3 / codex-cli:gpt-6-astra：超时无内容，**永不可得**。

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-09-19 | 机制落盘（§0 汇总 + §1 原始层）；裁定层待主代理补写 |
| 2026-09-19 | 父代理补写裁定层 §2–§5（25 条处置：24 采纳 / 1 failed；另修正父代理上轮一处事实表述）；结论：① 走 A+D（C 因写入面断点被否决并转上游 feature request）· ② 用官省血统字段拿根会话 + followup 驱动 + 三层上限 + 命令层确认框 |
