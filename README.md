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
- 投递的消息带来源标注（`source.kind=session-link-pro`、`form=relay`、`senderSessionId`），接收方模型可直接看到并可用同一工具回发

### 批准门与配对

未配对时每次发送过两道门：

1. **发送方确认**：发送 / 记住该目标免确认 / 取消
2. **接收方策略**（`receiveMode: ask` 时）：接收 / 总是接收该发送方 / **配对：双向免确认** / 拒绝并屏蔽（超时约 3 分钟按取消处理）

接收方选择「配对」即在设置中写入 `pairs: [{a, b, createdAt}]`，此后这两个会话**双向免确认**直接投递；「拒绝并屏蔽」写入 `blockedSenders` 并自动解除配对——屏蔽始终优先于配对。

### 消息卡片

接收方 UI 把跨会话消息渲染为醒目的 📡 卡片（📡 标题行 + 高亮左边条 + 发送会话 + 时间）：通过 `conversation.chat.node` keyed slot 以 `priority: -100` 影子替换 chat 包默认的折叠灰字行；非本插件消息（其他插件的 context 注入）经 `slots.entries()` 委托回原渲染器，显示不受影响。

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

### 依赖的宿主服务

`session-reference`（深链解析）、`user-questions`（批准门）、`settings`（策略持久化）、`session-query`（列表/导出）、`webServer`（导出下载路由）。DSH 默认装配均有。

## 测试

```
node host-half.test.mjs   # 54 项：上游深链 9 例 + 工具注册/列表/导出/发送/配对全流程（含拒绝/取消/自发送/死目标守卫）
```

## Changelog

- **0.2.2** — 配对通道（双向免确认）；醒目 📡 消息卡片（keyed slot 影子渲染 + 委托回退）；消息 `source` 补 `form: relay` + `senderSessionId` 元数据
- **0.2.1** — 空闲目标投递改用 `followup` 唤醒（原 `inject` 只排队不唤醒，用户确认后目标无反应）
- **0.2.0** — 初版 fork：会话深链 + 会话列表/导出 + 批准式跨会话消息

## Credits

Fork 自 [PwnKY/dsh-session-link](https://github.com/PwnKY/dsh-session-link)（深链复制 / `/s/<id>` 打开器 / 深链上下文注入均保留自上游），感谢上游工作。

## License

MIT