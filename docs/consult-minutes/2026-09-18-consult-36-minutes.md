# 会诊纪要 —— consult #36（原始层，机制落盘）

- 日期：2026-09-18
- 会诊 id：36
- 模型：deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, codex-cli:gpt-6-astra, kimi-api:kimi-k3
- 平台 job：consult-2
- 结果：1/4 交付（其中 1 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：true
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #36 finished — 1 of 4 replied (3 failed)]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #36 finished — 1 of 4 replied (3 failed)]
effective: 1 of 4 (3 failed · 0 without content)
models: deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, codex-cli:gpt-6-astra, kimi-api:kimi-k3
job: consult-2
minutes: docs/consult-minutes/2026-09-18-consult-36-minutes.md
requiresReport: true

--- replies (raw, unjudged — verify with your own tools) ---

[1] zai-coding-cn:glm-5.3 — ok
核验完成。我独立读了 cordis 核心、dsh-settings / dsh-settings-file、dsh-base 组合、token-cost 对照实现、插件本体与测试，四个问题全部有源码级答案，无需猜测。

## 判定 1：本 fork 取 settings 的正确姿势

| 通道 | 语义（源码证据） | 适用 |
|---|---|---|
| `ctx.get("settings")` | cordis `lib/index.js:762-771`：**strict 默认 true**，仅当提供方 fiber `state === 2`（完全激活）才返回值，否则 `undefined`。文档明言 "without the inject requirement"——不需要 inject，但它是**时点快照** | 工具期 Opportunistic 读取（如 `:386` goals、`:1787` userQuestions 的用法是对的） |
| `ctx.settings`（属性） | `cordis:672-698` 代理 get 走 `fiber.store`，而 store 在 `provide()` 时即写入（`:814`）——**不等激活**就取得到 | 可用但无顺序/生命周期保证 |
| `inject: ["settings"]` | `Fiber._checkImpl`（`cordis:1305-1315`）用 **strict** `_getImpl` 判满足 → 注入的依赖要等提供方完成 `[Service.init]` 才算可用；依赖丢失时 fiber `_unload`（`:1316-1343`） | **apply 期取服务的唯一正确姿势**，生产插件全部如此（token-cost 等 12 个包） |

**关键时序事实**：`SettingsProvider[Service.init]`（`dsh-settings/lib/index.js:246-252`）先 `await this.load()`（读 settings.yaml）再 publish，完成前服务 fiber 不激活。而 `dsh-base/cordis.patch.yml:12-13` 明确写着 "**Row order carries no load semantics (activation is service-availability driven)**"——team-link 的四个依赖与 settings 提供方之间**没有任何顺序约束**。

**register vs installSection 是同一 seam**：`installSection` 内部第一行就是 `this.register(ns, schema, {base, validate})`（`dsh-settings:327-331`），多出的只是 `hooks.setSource/onChange` 组合条目回退——给在 cordis.patch.yml 里有自己配置行的消费者用的。team-link 没有配置行（base 就是注册进去的 DEFAULT_POLICY），**`register` 用法本身是对的，不需要换 installSection**。且 `describe()`（`dsh-settings:351-381`）列出全部 registrations → **register 一旦成功，设置 UI 的 team-link 段自动出现**——主会话清单里的 ⑤ 是 ③ 的纯下游。

## 判定 2：失败路径 = 路径 A（apply 时服务未激活），静默无日志

- **路径 A 成立**：`apply()`（`:3964-3965`）在四依赖满足即运行，此刻 settings-file 的异步 init 未完成 → `ctx.get("settings")` strict 返回 `undefined` → `:871` 守卫失败，**这个分支一行日志都没有**（`:879` 的 warn 只覆盖 register 抛错）。`createPolicyStore` 是一次性快照，永远锁死内存态。
- **路径 B 排除**：服务值就是 `FileSettingsProvider` 实例，`register` 是其原型方法（`dsh-settings:281`），traceable proxy 不改 `typeof`。
- **路径 C 排除**：register 抛错会 warn——`.log` 里没有；且无第二注册方。
- **`ctx.get("goals")` 能解析不能证伪 A**：那是工具期调用；policy store 是 apply 期快照。磁盘证据（mtime 不变、无 `team-link:` 键、UI 无该段 = register 从未成功）与 A 完全一致。

**一行确认日志**（加在守卫失败处，兼作永久观测）：
```js
ctx.logger?.warn?.(`${PLUGIN_LABEL}: settings service unavailable at activation (${settings === undefined ? "not yet active" : "no register()"}) — policy runs memory-only; no persistence, no settings-UI section`);
```

## 缺陷 ① 最小修法

1. `lib/index.js:56` → `inject = ["sessionReferenceResolver", "tools", "sessionQuery", "agents", "settings", "webServer"]`（**"webServer" 一并加**：`:3910` 是同类 apply 期竞态，头部导出按钮同样受害；token-cost 先例就是两个都注入）。副作用是良性的：settings 卸载时 team-link 随 fiber reload，状态从文档重建——语义更正确。
2. 同步改 `:51-55` 注释（settings/webServer 不再是“运行时降级”）；README:320 的降级声明仍真（守卫保留）。
3. `createPolicyStore` 守卫**保留**——测试直调 `apply(ctx)`（`host-half.test.mjs:202`）且 `setup()` 默认 `useSettings=false`（`:130`），内存路径仍被测试走；但补上上面的 warn。
4. **PolicyConfig schema 与迁移语义零改动**：inject 顺序保证 `migrateLegacyPolicy`（apply 期跑）看到的是已加载的文档，legacy `session-link-pro` 分支逻辑原样。
5. 测试不破：host-half 忽略 inject 元数据，stub 在 apply 前 `ctx.provide`（`:198`）。

## 缺陷 ② 修法：创建即认领（与 §3.3.2 自洽）

- **规则**：`upsert-team` 创建分支把 caller 播种为 coordinator 现任——仅创建时刻、一次性。此刻无在任者可侵犯、无信任数据可窃，且调用本就发生在用户自己的工具授权下；§3.3.1 的 schema 示例本来就是带 coordinator 行的。
- **落点**：`applyTeamUpsert`（`:1399`）加可选 `request.coordinator`，创建时 `roles: [roleRecord({ role: "coordinator", current: coordinator, history: [{ session, from: now, until: null }] })]`——`roleRecord`（`:1297-1307`）产出规范形状，`TeamRoleConfig`（`:564-588`）全字段有默认值，round-trip 安全，**PolicyConfig 零改动**。调用侧 `:1708` 传 caller（`:1705` 已保证非空）。
- **writerGate/retireGate 一行不动**：手写空缺行（设置 UI 写出的）仍然全拒并指向设置 UI——U4 语义保留，只是工具创建的团队不再产生空缺。
- **文案**：`:1717`/`:1722` 改为「coordinator 已由创建会话认领」，删「首任协调者需由用户经设置 UI 指定」。
- **同步项**：测试 1038（创建断言补 coordinator 行）、1053-1056（U4 改用手写空缺 fixture 表达）、1872 等 rotation 创建流；README:390 changelog 补一句；设计文档 §3.3.2 补 bootstrap 规则行。

## 收尾顺序建议

③（inject + warn）→ ④（创建认领 + 文案/测试/文档同步）→ 复跑 493 断言 → 真机验证：watch register 后看 settings.yaml mtime 与 `team-link:` 键、设置 UI 出现该段、建队即有协调者且 set-role/retire 可走。另注意 ③ 修好后 UI 面自动出现，主会话清单的 ⑤ 无需单独工项。

[2] deepseek-official:deepseek-v4-pro — failed
(consultation failed: consultation timed out after 20min (consultTimeoutMs))

[3] kimi-api:kimi-k3 — failed
(consultation failed: consultation timed out after 20min (consultTimeoutMs))

[4] codex-cli:gpt-6-astra — failed
(consultation failed: consultation timed out after 20min (consultTimeoutMs))
```

## §2 逐问裁定（**主代理写**）

> 每条意见**恰一条处置**——采纳 / 不采纳（**必附理由**）/ 待定。failed 的模型无内容，不构成 pending。

| 编号 | 意见（来源） | 处置 | 理由 / 落点 |
|---|---|---|---|
| O1 | 判定 1：`ctx.get` 是 strict 时点快照（仅 active provider 才返回），`inject` 才是 apply 期取服务的正确姿势 | **采纳** | 我独立复验 cordis/lib/index.js:1305-1314（`_checkImpl` 用 `_getImpl(name, true)`）；与 §9.1.2 根因链一致。落点：设计 §9.1.2 / §9.1.3 |
| O2 | 判定 2：失败路径 = A（apply 时服务未激活），路径 B / C 排除 | **采纳** | 与主会话证据链独立一致；主会话另补一条反证：日志中**从未**出现 `:3912` 的 webServer warn ⇒ webServer 在 apply 期已 active ⇒ `ctx.get` 对 active 服务可用、仅 settings 未及 ⇒ 强化 A。落点：设计 §9.1.2 |
| O3 | `register` 与 `installSection` 是同一 seam，`register` 用法正确，无需改用 installSection | **采纳** | 复验 dsh-settings/lib/index.js:327-331（`installSection` 首行即 `this.register(...)`）。落点：设计 §9.2.3（显式「不引入 installSection」） |
| O4 | ③ 修好后 `describe()` 会列出该注册 ⇒ 设置面自动出现 team-link 段，⑤ 是 ③ 的纯下游 | **采纳** | 复验 dsh-settings:351-381（`describe()` 遍历全部 registrations）。**但保留 README 的 YAML 粘贴片段作兜底**——真机是否渲染全部命名空间属实现面未知（列入 §5）。落点：设计 §9.2.3 / §9.6 ⑤ |
| O5 | 修法：把 `"settings"` 与 `"webServer"` **加进 `inject` 数组** | **不采纳（机制层）** | 采纳其**实质**（必须按激活时序取服务、不得用 apply 期时点快照），不采纳该**手段**：`inject` 是硬依赖，依赖缺失时 cordis 令整个插件 fiber 不激活（`Fiber._refresh` → INACTIVE），与本插件 `:3912` 已声明的「webServer 缺失时导出按钮降级、其余照常」直接相抵。改用 `ctx.inject(["settings"], cb)`（可选 + 有序）+ 惰性重试 + 留痕，确定性等价且零功能回归。理由与伪代码见设计 §9.1.3；判决可逆（改回 inject 为一行改动） |
| O6 | `webServer`（`:3910`）是同类 apply 期竞态，头部导出按钮同样受害 | **采纳** | 独立复验 lib/index.js:3909-3913（守卫 + warn 存在，但仍是时点快照）；同一「晚挂 + 重试」模式一并覆盖。落点：设计 §9.1.3 / §5.1 U9 |
| O7 | 测试不破：host-half 忽略 inject 元数据，stub 在 apply 前 `provide` | **采纳（并补缺口）** | 复验 host-half.test.mjs:188 / :198 / :202。但「不破」恰暴露真缺口：stub 在 apply **前** 提供，故永远复现不出生产条件——新增 U9 时序回归锁（先 apply、后注入）。落点：设计 §9.1.4 / §5.1 U9 |
| O8 | ④：`upsert-team` **创建分支无条件**把 caller 播种为 coordinator（优于主会话原设计的 opt-in 参数） | **采纳** | 比 opt-in 更简（无新 API 面），且结构性消除「建了却无人可写」的死队；创建路径本就不过 `writerGate`、此刻无在任者可侵犯。主会话 §9.2.2 已据此由 opt-in 改写为无条件认领 |
| O9 | ④ 落点：`applyTeamUpsert`(:1399) + `roleRecord`(:1297) 产出规范形状、PolicyConfig 零改动、`writerGate`/`retireGate` 一行不动 | **采纳** | 与 §3.3.2 写权限模型的自洽性论证一致。落点：设计 §9.2.2；eng_coder 任务书须携带这些行号指针 |
| O10 | 同步项：host 测试 1038 / 1053-1056 / 1872、README:390、设计 §3.3.2 需同步 | **采纳** | 精确落点对实施有直接价值；写入设计 §9.2.2 与 eng_coder 任务书 |
| O11 | 收尾顺序：③（含 warn）→ ④ → 复跑断言 → 真机验证 | **采纳** | 与主会话计划一致；真机验证即 §5.2 演练 7 |
| O12 | deepseek-v4-pro / kimi-k3 / codex-cli:gpt-6-astra | **failed（无内容可处置）** | 三条均因 20min 预算超时（`consultTimeoutMs`），非意见、不构成 pending。见 §4 教训 1 |

## §3 分歧与父侧裁定（**主代理写**）

- **唯一实质分歧 = O5（注入机制）**。会诊推荐「加进 `inject` 数组」；父侧裁定采用「`ctx.inject` 可选有序注入 + 惰性重试 + 留痕」。**裁定依据：红线优先**——§5.3 要求服务缺失时插件完整降级，而 `inject` 是硬依赖，会让整个插件在无 webServer 的宿主上**不激活**（连深链与导出工具一起消失）；两者在**确定性**上等价（`ctx.inject` 同样等 provider 完成 `[Service.init]`），故取无功能回归者。**决策可逆**：若设计评审判定应改为 `inject` 一行，回退成本为一行改动（设计 §9.1.3 已注明）。
- **一处父侧修正（对会诊）**：glm 以「UI 无该段」作为「register 从未成功」的证据——UI 渲染属父侧无法观测面，不作为证据采信；磁盘（mtime 未变 / 无 `team-link:` 键）与日志（无 warn）已足以定案。
- **一处未采信（并标注）**：glm 称 `ctx.settings` 属性通道「不等激活即可取」。本设计**不使用**该通道，故未验证该断言——列入 §5。

## §4 教训（**主代理写**）

1. **会诊有效率与产出不成正比**：4 模型仅 1 条交付（另 3 条同因 20min 超时），但该 1 条是源码级完整答案——印证「**交付数 ≠ 有效数**」，判据是内容而非计数。下次同类 brief 可把预算提到 30min，或拆为单问以缩短单模型耗时。
2. **apply 期取服务是本插件的系统性风险点**：同一个 `apply` 内 `settings`(:868) 与 `webServer`(:3910) 两处**同类**竞态，应作为一类检查项进评审清单，而不是当作单点 bug 修。
3. **静默失败是最贵的缺陷**：本次 bug 本体只是一次时点快照，但因为它一行日志都不留，导致「改名迁移已完成」这一**错误结论**被写进交付报告与 README 整整一天。任何降级都必须留痕——已升为红线（设计 §5.3）。

## §5 不可验清单（**主代理写**）

- 「apply 那一刻 `ctx.get("settings")` 返回 undefined」的**直接**观测：现有推断链（strict 语义 + 日志无 warn + webServer 恰好 active 的反证）已足够，但直接观测需修复后新增的日志行（§9.1.3 留痕）才可得。
- 设置 UI 是否**自动**渲染全部已注册命名空间（决定 ⑤ 能否免单独工项）：需真机，见演练 7。
- `ctx.settings` 属性通道的激活 / 生命周期语义：本设计不采用该通道，未验证（§3 未采信项）。
- 3/4 会诊模型的意见：超时无内容，**永不可得**。

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-09-18 | 机制落盘（§0 汇总 + §1 原始层）；裁定层待主代理补写 |
| 2026-09-18 | 父代理补写裁定层 §2–§5（12 条处置：10 采纳 / 1 不采纳附理由 / 1 failed）；纪要随项目落位至 `dsh-team-link/docs/consult-minutes/` |
