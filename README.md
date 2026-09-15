# dsh-session-link-pro

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai) 的会话互联插件——[dsh-session-link](https://github.com/PwnKY/dsh-session-link) 的增强 fork。

在一个 DSH 实例里开多个会话干活时，会话之间是隔离的：看不到别的会话在干嘛、没法把 A 会话的结论交给 B 会话继续、想归档一个会话只能翻 UI。本插件补上这三块：

| 能力 | 说明 | 入口 |
| --- | --- | --- |
| 🔗 会话深链 | 复制 `dsh://session/<id>`，粘贴到任意会话即注入该会话只读快照（上游功能） | 会话头部按钮 / 粘贴链接 |
| 📋 会话列表 | 列出同工作区其他会话：主题、运行状态、最近消息摘要 | `session_link_pro_list_sessions` |
| ⬇ 会话导出 | 全量事件导出为 markdown（可读）+ JSON（无损） | `session_link_pro_export` / 会话头部 ⬇ 按钮 |
| 📨 跨会话消息 | 向另一会话投递消息，空闲目标自动唤醒并作为新回合响应 | `session_link_pro_send` |
| 🔁 配对通道 | 双方各批准一次后，两个会话互发消息免确认（自动联调） | 接收确认时选「配对」 |

## 跨会话消息语义

- 目标**运行中** → `steer`：消息在步边界注入其当前回合
- 目标**空闲** → `followup`：唤醒目标会话，消息作为**新回合**处理（立即显示消息并触发 LLM 响应，不会静默排队）
- 投递的消息 `source = { kind: "agent-message", form: "relay", senderSessionId }`——**恰好这三个成员**，这是 DSH 0.1.5 会话日志迁移唯一接受的跨会话中继形状（见下「会话格式兼容」）。发送方/时间/插件名都写在正文 banner 里（`📨 [跨会话消息 · 来自会话 <id> · <本地时间>]`），接收方模型可直接看到并可用同一工具回发。消息 id 固定为 `slp-<uuid>`，UI 卡片靠它把自己的中继与上游相邻代理消息区分开。

### 批准门与配对

未配对时每次发送过两道门：

1. **发送方确认**：发送 / 记住该目标免确认 / 取消
2. **接收方策略**（`receiveMode: ask` 时）：接收 / 总是接收该发送方 / **配对：双向免确认** / 拒绝并屏蔽（超时约 3 分钟按取消处理）

接收方选择「配对」即在设置中写入 `pairs: [{a, b, createdAt}]`，此后这两个会话**双向免确认**直接投递；「拒绝并屏蔽」写入 `blockedSenders` 并自动解除配对——屏蔽始终优先于配对。

### 消息卡片

接收方 UI 把跨会话消息渲染为醒目的 📡 卡片（📡 标题行 + 高亮左边条 + 发送会话 + 时间）：通过 `conversation.chat.node` keyed slot 以 `priority: -100` 影子替换 chat 包默认的折叠灰字行；非本插件消息（其他插件的 context 注入）经 `slots.entries()` 委托回原渲染器，显示不受影响。

判定条件不是「kind/form 命中」而是**本插件自己的消息**：`agent-message + relay` 正是上游相邻代理消息（`send_message`）用的形状，只按 kind/form 判断会把它们也渲染成卡片。因此卡片还要求命中本插件自己的两个特征之一——消息 id（在 chat node 上是 `node.id`，context 的 `data` 里没有 id）以 `slp-` 开头，或正文以 `📨 [跨会话消息` 开头；历史日志里的旧 `kind: "session-link-pro"` 继续识别。卡片时间优先取旧日志的 `sentAt`，其次取 context node 自带的事件时间 `data.time`，最后才从正文 banner 里解析。

## 会话格式兼容（DSH 0.1.5）

0.1.5 的会话日志迁移（V0→V3）逐条校验每条 message 的 `source`：白名单外的 `kind`、或成员多一个少一个，都会让**整份会话日志**拒绝迁移（`SessionFormatUnsupportedMigrationError`，表现为「这个对话打不开」），且拒绝时不会破坏原始日志。旧版本的插件写的是 `kind: "session-link-pro"`，正是这种会被拒的形状——所以 0.2.3 起改用上游自己的中继形状 `{ kind: "agent-message", form: "relay", senderSessionId }`（白名单见 `@deepseek-ai/dsh-session-format-v2-to-v3` 的 `SOURCE_KINDS`，`agent-message` 的成员集合被 `keys()` 锁死为恰好三项，多余信息只能进正文）。

已经在旧日志里的 `kind: "session-link-pro"` 事件改不回来（`kind` 已烙在已发布的事件流里），需要外部工具改写原始日志或在导出前修复——修复方向即把 source 替换成上述三项形状，替换后迁移即可通过。

## 字符串安全：孤立代理项（0.2.4）

半截 emoji（孤立代理项，例如单独的 `U+D83D`）不是显示瑕疵。DSH 把工具结果**逐字**放进下一次模型请求的 JSON 体，非法 UTF-16 会让那次请求直接以 `400 INVALID_REQUEST` 失败；而这段文本已经写进调用方会话历史，于是**该会话此后每一条消息都以同一个 400 失败**（连 4 字符的 `test` 也一样），`INVALID_REQUEST` 又不在重试白名单里——会话永久不可恢复。

本地扫描 882 份会话日志，只有 5 份含真正的孤立代理项：走 deepseek-official 的 4 份**全部在下一次请求当场死亡**（0 条成功回复），走 qax 的 1 份存活。诚实交代：没有做重放实验（没有构造含孤立代理项的请求去打 API），这是观测相关性；但机制无争议，且「按码点截断」本来就是这两个函数应有的写法。

- **根因**：`preview()` / `truncate()` 用 `slice()` 按 **UTF-16 code unit** 截断，切割点落在代理对中间时只留下一半。凶器是列表工具的主题预览 `preview(topic, 90)`：emoji 恰好压在第 89 个 code unit 上。
- **修法一（不再制造）**：两个 helper 改为**按码点截断**（`[...str]` 按码点迭代），90 / 120 / 200 / 300 等限额与纯 BMP 文本的渲染结果完全不变；`truncate()` 的「已截断 N 字符」计数口径随之从 code unit 变成**码点**（更正确：原来一个 astral 字符被算作 2 个「字符」，却只输出一半）。
- **修法二（纵深防御）**：新增 `wellFormed()`（当前运行时用 `String.prototype.toWellFormed`，Node < 20 走等价正则）消毒**所有对外字符串**——列表工具正文、export 的 md 与 JSON、`session_link_pro_send` 的两处批准提问正文、投递到目标会话的 banner（否则毒的是**接收方**会话）、拒绝文本里回显的目标 id（工具参数回显）、深链注入的会话快照（`agent/pre-step`，最直接进入调用方下一次请求的通道），以及三个工具 `output.render` 这最后一道模型可见出口（`dsh-tools` 正是用它把返回值变成工具结果内容块）。
- **客户端同理**：`shortSessionId()` 的 `slice(0, 14)` / `slice(-8)` 改为按码点切（`Array.from`），卡片正文、发送方 id、以及非本插件上下文文本的委托回退渲染都先过一遍 `wellFormed()`。这条路径只是显示——浏览器 DOM 的 USVString 转换本就会把孤立代理项变成 `U+FFFD`，且它不会再进入模型请求——属于显示层加固，不是会打死会话的那条链。
- **验收不变量**：本插件返回的字符串里**永远不出现孤立代理项**；把 emoji 摆在任意切割位置上，输出要么完整包含它、要么完整丢弃它。

## 策略配置

设置命名空间 `session-link-pro`（设置 UI 可直接编辑；settings 服务不可用时降级为进程内记忆）：

| 键 | 类型 | 说明 |
| --- | --- | --- |
| `receiveMode` | `ask` / `accept` / `reject` | 默认 `ask`：逐条确认 |
| `trustedSenders` | `string[]` | 免确认接收的发送方会话 |
| `blockedSenders` | `string[]` | 拒收并屏蔽（优先级最高） |
| `rememberTargets` | `string[]` | 发送方免确认的目标会话 |
| `pairs` | `{a, b, createdAt}[]` | 双向免确认配对通道 |

## 安装

### 方式一：本地目录 + 热装配（开发常用）

依赖通过 junction 复用 DSH 检出目录的 node_modules（免下载）：

```powershell
$dir = "<克隆目标目录>"              # 换成你自己的路径，例如 D:\dsh-plugins\dsh-session-link-pro
git clone https://github.com/shenhuanageshei/dsh-session-link-pro.git $dir
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
dev_install_package { dir: "<你的目录>/dsh-session-link-pro", profile: "web" }
```

或手动装配：profile `package.json` 的 `dependencies` 写 `"dsh-session-link-pro": "link:<本目录>"`，`dsh.profile.bundles` 数组加入 `"dsh-session-link-pro"`，重启 shell 生效。

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
npm test                  # host 75 项 + client 42 项（合计 117 项）
node host-half.test.mjs   # 上游深链 9 例 + 工具注册/列表/导出/发送/配对全流程（含拒绝/取消/自发送/死目标守卫）+ 孤立代理项安全（121 个偏移的属性测试、生产边界、预污染源、导出切点、提问与 banner）
node client-half.test.mjs # 浏览器端：卡片判定（旧 kind / 新形状 / 上游同形消息不得误判 / node.id 与 banner 双信号）+ 头部按钮 + 孤立代理项安全（astral id 截断、旧日志正文修复）
```

`host-half.test.mjs` 里那组 `AUDITED_SOURCE_KINDS` 断言是**迁移契约的回归锁**：它按 `@deepseek-ai/dsh-session-format-v2-to-v3` 的白名单与「恰好三成员」规则检查投递出去的 `source`，改坏了会立刻红。`client-half.test.mjs` 则锁定「上游相邻代理消息不得被误判成本插件卡片」这条容易复发的边界。两边新增的孤立代理项断言是**字符串安全的回归锁**：host 侧把 emoji 走遍 0..120 每一个切割偏移（其中恰好一个偏移在生产代码上留下半截 emoji），另加生产边界、预污染源、导出切点、两处批准提问、投递 banner、深链快照注入、poisoned targetId 回显与「快照缺失不得塞进 undefined」（最后一项同时锁 resolver 契约里 `additionalContext` 可选这条）；client 侧覆盖 astral id 的两个半截方向、旧日志正文、未截断的短 id 与委托回退文本。

## Changelog

- **0.2.4** — 修「孤立代理项」截断 bug（详见「字符串安全：孤立代理项」）：`preview()` / `truncate()` 改为按码点截断（原 `slice()` 按 UTF-16 code unit 切，emoji 落在刀口上只剩一半，毒死调用方会话），「已截断 N 字符」计数口径随之变为码点；新增 `wellFormed()` 并消毒列表正文、export 的 md+JSON、send 的两处批准提问正文、投递到目标会话的 banner、拒绝文本里回显的 `targetId`、深链注入的会话快照与三个工具的 `output.render` 出口；顺带修「resolver 省略可选 `additionalContext` 时把 `undefined` 塞进消息数组」；客户端 `shortSessionId()` 改码点截断、卡片正文/发送方 id/委托回退文本渲染前消毒；`host-half.test.mjs` 新增 20 项、`client-half.test.mjs` 新增 11 项（本次修复实测：把两个 `lib` 文件换回 0.2.3 时 host 红 13 项、client 红 5 项，换回修复版即 117 项全绿）
- **0.2.3** — 适配 DSH 0.1.5 会话格式迁移：投递消息 `source` 改为受审计的 `{ kind: "agent-message", form: "relay", senderSessionId }`（旧 `kind: "session-link-pro"` 会让整份会话日志无法迁移/打不开）；卡片判定改从 chat node 的 `node.id` 读消息 id（context 的 `data` 里没有 id），叠加 `slp-` 与正文 banner 双信号，避免把上游相邻代理消息误渲染成本插件卡片；时间改为优先用 context node 的事件时间、正文 banner 承载投递时间兜底；宿主包从 `dependencies` 移到 `peerDependencies`，区间补上 `^0.1.5-rc.1` 分支（`^0.1.0-rc.6` 按 semver 预发布规则匹配不到 `0.1.5-rc.1`）；新增 `client-half.test.mjs`，`host-half.test.mjs` 增加迁移契约回归断言；导出路由文件名净化、策略写入去重
- **0.2.2** — 配对通道（双向免确认）；醒目 📡 消息卡片（keyed slot 影子渲染 + 委托回退）；消息 `source` 补 `form: relay` + `senderSessionId` 元数据
- **0.2.1** — 空闲目标投递改用 `followup` 唤醒（原 `inject` 只排队不唤醒，用户确认后目标无反应）
- **0.2.0** — 初版 fork：会话深链 + 会话列表/导出 + 批准式跨会话消息

## Credits

Fork 自 [PwnKY/dsh-session-link](https://github.com/PwnKY/dsh-session-link)（深链复制 / `/s/<id>` 打开器 / 深链上下文注入均保留自上游），感谢上游工作。

## License

MIT