# Local Codex Bridge

[English](README.md) · [简体中文](README.zh-CN.md)

*A thin supervisory MCP bridge between external AI supervisors and native Codex.*

**Current release: V2.3.4-local.1**（源码候选；上游 release V2.3.4，已安装 candidate.10 仍为 V2.1.3-local.1）

本次只整合源码与 PR，未部署或重启生产。封存 release、事故与 candidate.10 验收证据保持原版本与摘要；运维边界见 [运维手册](ops/runbooks/operations.md)。本地 `codex_threads(thread_id, latest_messages:1..100)` 保留为有界、可降级的兼容视图；`include_turns:true` 单独使用拒绝无界读取，带 `latest_messages` 时只返回 metadata + recent messages。独立持久 History 使用 `codex_history`，此兼容视图不重建 live state。

Local Codex Bridge 是一个面向 Windows 与 macOS 的轻量 MCP stdio 适配器：

```text
ChatGPT / external AI supervisor
              ↕
        Local Codex Bridge
              ↕
      native Codex app-server
              ↕
   native Codex threads / turns
```

它解决的不是“再造一个 Codex”，而是让擅长对话、规划与持续监督的 AI，可以直接监督本机原生 Codex 完成真实工程任务。

**监督者负责目标、资源、边界、风险、审批与验收；Codex 保留原生的编码与执行自主性。**

Bridge 始终保持薄层：

- 不创建第二套 job / task 系统；
- 不复制 Codex 对话历史；
- 不维护平行线程数据库；
- 不缓存“当前模型”状态；
- 不重建 Goal、Queue 或 Search；
- 不替代 Codex 自己的 session / thread / turn 语义。

**原生 Codex thread/session 始终是执行事实源。**

[版本历史](CHANGELOG.md) · [协议与兼容假设](PROTOCOL-ASSUMPTIONS.md)

---

## V2.3.0 有什么

V2.3.0 把 Bridge 的公开监督面扩展为 **12 个 MCP 工具**，同时继续保持“只暴露监督真正需要的 native surface”这一边界。

本版主要增加和完善：

- 独立的原生持久 History 分页；
- Native Goal：读取、设置与清除持久目标；
- Native Queue：管理 active workflow 后续待执行输入；
- Native Search：跨线程搜索与线程内 occurrence locator；
- capability / lineage metadata 的按需读取；
- compact observation 的 typed projection、drainage 与 loss 语义；
- 单次最长 120 秒的事件驱动 observe wait；
- 所有成功工具结果统一通过 `structuredContent` 交付；
- Windows / macOS 共用同一核心 Bridge，只在平台原生边界保留差异。

V2.3.0 不把这些能力重新实现一遍：History、Goal、Queue、Search 与 thread lifecycle 仍由 native Codex 持有，Bridge 只做受限映射与监督。

---

## 谁负责什么

### External supervisor / ChatGPT

适合负责：

- 理解用户目标；
- 拆解任务；
- 决定工作范围、资源与风险边界；
- 选择何时继续观察、纠正、审批或中断；
- 判断结果是否满足验收条件；
- 在 Codex 无法自行安全决定时提供监督。

### Native Codex

继续负责：

- 原生 thread / turn 生命周期；
- 工作区文件与命令执行；
- Codex 自己的上下文与持久历史；
- sandbox 与 approval-policy 行为；
- 模型和 reasoning effort 的真实运行状态；
- 持久化的执行结果；
- 原生 Goal、Queue、Search 与 lineage。

### Local Codex Bridge

只负责把两者接起来：

- MCP stdio ↔ Codex app-server JSONL；
- 有界地暴露监督所需状态；
- 转发明确的控制意图；
- 对高风险、歧义或协议边界 fail closed；
- 不把自己升级成第二个 orchestration runtime。

---

## 12 个 MCP 工具

| Tool | 用途 | 主要边界 |
| --- | --- | --- |
| `codex_threads` | 列出、筛选、读取原生持久线程元数据 | metadata only；筛选不是 ACL |
| `codex_history` | 分页读取原生持久历史 | 不建 Bridge history store；不自动 full-read |
| `codex_search` | 原生跨线程搜索与线程内 occurrence 定位 | 返回 locator；不建索引或 relevance 层 |
| `codex_models` | 按需读取一页原生 `model/list` | 不缓存 catalog，不维护 current-model registry |
| `codex_goal` | 读取、设置或清除原生 thread goal | 不隐式 resume / turn-start；不等同 checkpoint |
| `codex_queue` | 管理原生 queued follow-up | 不建 Bridge scheduler；入队不等于执行完成 |
| `codex_turn` | 创建或恢复 thread，并启动一个 turn | accepted 不等于 completed |
| `codex_observe` | 有界读取 live events、pending、terminal 与 cursor | live state 丢失后不重建历史 |
| `codex_steer` | 对当前 active turn 追加语义纠正 | 不是 timer、polling 或 retry |
| `codex_respond` | 回答真实 pending approval / user-input / permission request | 必须匹配原始 request id 与准确 scope |
| `codex_interrupt` | 中断准确的 active thread / turn | 不是进程控制 |
| `codex_checkpoint` | 保存可选、精简、有界的 supervisor anchor | 不是 transcript、job id 或 Codex history |

完整 schema 与运行时校验以 [`src/tools.ts`](src/tools.ts) 为准。

### 内容交付与读取选择

History / Search 默认使用 `content_policy:"protected"`：秘密形状检测可能拒绝整页，包括误匹配普通代码。调用方可显式使用 `content_policy:"exact"` 将本次 native 原文交给 MCP caller；它可能暴露敏感内容，不会保存为会话偏好，也没有自动回退。protected 提供默认检测与显式选择记录，不是阻止监督者最终取得原文的权限边界。

Goal / Queue 的成功读取和响应直接保留 native 原值，不做正文秘密形状过滤。已知回显内容过大时在写入前拒绝；native 后加字段等仍可能造成“已确认接受，但响应无法交付”，不能据此重发 mutation。多项页超限可以缩小 limit；单项仍超限时应从 native 侧检查，不能靠反复调用同一个 Bridge 读取恢复。错误与运行诊断继续脱敏。

这些精确响应不继承 observe 的短文本、内部数组和字段数量预算，仍受真实字节限制、必要字段校验及防御性序列化检查约束；失败不返回部分页或伪造 cursor。具体边界见 [协议说明](PROTOCOL-ASSUMPTIONS.md#exact-content-delivery)。

compact 的 `terminal.final_result_pending: true` 表示最终文本尚待后续页交付，此时省略 `final_result_meta`；即使 status 已是终态，也要继续沿 `next_cursor` 读取。正文交付到位后再检查 `final_result_meta.complete`：false 表示源文本未完整收到或 live 保留发生裁剪。raw 和 terminal 同样有 48k 上限，需要更多内容时按该 thread / terminal turn 窄读 History，或从 native 侧检查；普通 compact 事件的预算保持不变。


---

## 典型监督方式

### 1. 启动或继续一个 turn

`codex_turn` 的成功返回只表示 native `turn/start` 已被接受，不代表任务已经完成。

长任务通常应继续通过 `codex_observe` 监督。

```text
codex_turn
    ↓
codex_observe
    ↓
 ┌───────────────┬────────────────┬─────────────────┐
 │ continue      │ steer          │ respond         │
 │ observing     │ same turn      │ real pending    │
 │               │                │ request         │
 └───────────────┴────────────────┴─────────────────┘
    ↓
terminal state / acceptance
```

几个原则：

- 长时间没有新命令输出，不足以证明 Codex 卡住；
- `codex_steer` 应代表新的语义信息或纠正，而不是定时催促；
- `codex_respond` 只能回答真实存在的 pending request；
- `codex_interrupt` 只在确实需要停止当前 turn 时使用；
- `thread_id` 是 native Codex thread identity，不是 Bridge 发明的永久 task ID。

### 2. Live 与持久历史分开

`codex_observe` 面向当前 live supervision；`codex_history` 面向 native 已持久化的 turns / items。

Bridge 重启、runtime ring 丢失或 live cursor 不再可用时，不会从历史里伪造一份“看起来还活着”的 runtime。需要恢复持久内容时，直接读 `codex_history`。

`codex_search` 负责定位，History 负责读取内容。Occurrence 返回的 `turnCursor` 可以用于同一 thread 的窄 History 读取，但 Search 不替代 History。

### 3. Goal、Queue 与 Steer 不同

- **Goal**：原生 thread 的持续目标；
- **Queue**：当前 active workflow 之后由 native 执行的 follow-up；
- **Steer**：对当前 active turn 的即时语义纠正。

它们不是三种写法不同的“下一条 prompt”，也不由 Bridge 合并成自己的任务模型。

`codex_goal(action:"set")` 必须显式选择预算意图：

| `budget_mode` | native `tokenBudget` | 参数要求 |
| --- | --- | --- |
| `preserve` | 省略，保留既有预算 | 不得传 `token_budget` |
| `unlimited` | `null`，移除预算上限 | 不得传 `token_budget` |
| `fixed` | 指定额度 | 必须传正的 safe-integer `token_budget` |

Bridge 本身不会因为 Goal set / get / clear 额外发送 resume 或 turn-start；但 **active Goal 仍可能由 native Codex 自主继续执行**。Goal clear 不等于 interrupt，也不是已经排定执行的 barrier。需要停止当前 turn 时仍应使用准确的 `codex_interrupt`。

Queue delete 同样不会中断已经开始的 turn。

---

## `codex_observe`

默认 `view:"compact"` 交付有界的 typed supervision facts；`view:"raw"` 用于需要核验原生保留事件时的窄下钻。

可选 `wait_ms` 是一次固定截止的 event-driven wait，最大 `120000` ms。Bridge 不做后台 polling，也不自行判断 stalled。

需要记住：

- 两种 view 都沿 `next_cursor` 继续；
- `stream_lost` 表示流式 delta 有淘汰；
- `facts_lost` 表示其他监督事实有淘汰；
- `cursor_lost` 只是两者的总括，不意味着应跳到 `cursor_floor`；
- `runtime_available:false` 时，live pending / terminal / cursor 等字段可能只是 unavailable placeholder，不能据此推断“没有发生”。

当 `runtime_available:true` 时，compact 的 `pending_requests` 是当前完整 snapshot；集合为空时字段会省略，缺省表示当前没有 pending request，而不是“这一页没更新”。

compact 的 `terminal.final_result` 还受 final item / terminal cursor 的投递窗口约束：final 文本可能已经作为 message fact 交付，因此某一页的 compact terminal 可以只有 `status` / `error` 而省略 `final_result`。**字段缺席不表示 raw terminal snapshot 或 persisted History 中不存在最终文本。** 不要为了让三个字段始终同页出现而跳过 `next_cursor` 或反推终态。

---

## Terminal：以 `status` 为准

**终态判断始终以 native `terminal.status` 为准。**

不要从其他字段反推终态：

- 有 `final_result` 不代表 turn 成功完成；
- 有 `terminal.error` 也不等价于 `status:"failed"`；
- `status:"interrupted"` 的 turn 也可能携带结构化 error；
- Bridge 不依赖额外的独立 error notification 才识别终态原因。

消费者应先看 `terminal.status`，再把 `final_result` 与 `error` 作为该终态下的附加事实解释。

---

## 成功结果使用 `structuredContent`

V2.3.0 中，所有成功 `tools/call` 的完整结果都位于：

```text
result.structuredContent
```

`result.content` 只保留 tiny text marker，不再承载可解析的成功 JSON。

旧 client 如果仍从 text content 解析成功结果，需要迁移到 `structuredContent`。

错误仍使用显式 `isError` / text error 路径，不伪装成成功结果。

---

## 不要因 timeout 直接重试写操作

以下原生 mutating request 如果已经写入 app-server、但 acknowledgement 超时，Bridge 会把结果视为：

**UNKNOWN / possibly accepted**

这不等于失败。

典型请求包括：

- `thread/start`
- `thread/resume`
- `turn/start`
- `turn/steer`
- `turn/interrupt`
- `thread/goal/set` / `thread/goal/clear`
- `thread/queue/add` / `update` / `delete` / `reorder`

此时应先观察或读取 native state，再决定后续动作。

**不要因为 timeout 直接重发 mutating request。**

Bridge 不自动 retry、补偿或猜测结果。

---

## History 与 Search

`codex_history` 按 native history mode 读取：

- paginated thread：可分页读取 turn 索引，再窄读指定 turn 的 items；
- legacy thread：按完整 turn 分页。

Bridge 不创建自己的 item/chunk cursor，也不在失败时偷偷 full-read 整段历史。

History 成功页要求无损交付；如果页面超出传输字节边界、触发当前内容策略或无法通过防御性 JSON 序列化检查，会整页失败，而不是返回部分 data + cursor。

`codex_search` 只映射 native Search：

- `kind:"threads"`：跨线程 locator；
- `kind:"occurrences"`：指定 paginated thread 内的 occurrence locator。

Search 不建 Bridge semantic index、不做 relevance scoring、不隐式限制 workspace，也不以完整 History 读取兜底。

精确分页、cursor 与 transport contract 见 [`PROTOCOL-ASSUMPTIONS.md`](PROTOCOL-ASSUMPTIONS.md)。

---

## Capability 与 lineage

`codex_threads` 可以按需保留 native capability / lineage metadata，例如：

- `canAcceptDirectInput`
- `sessionId`
- `forkedFromId`
- `parentThreadId`
- source information

这些字段是 native metadata，不是 Bridge 自己的 writer lease、权限模型或生命周期数据库。

`parent_thread_id` / `ancestor_thread_id` 可用于筛选 spawned descendants；它们与 fork lineage 是不同概念。Bridge 不递归构建关系图，也不通过 lineage 自动 resume 或接管 thread。

---

## Model 与 reasoning effort

Bridge 不接管 Codex 的“当前模型状态”。

如果 `codex_turn` 不显式传 `model` / `effort`：

- Bridge 不调用 `model/list`；
- 不推断当前模型；
- 不发送新的 model / effort override。

如果 supervisor 显式指定 model，Bridge 会用当前原生 catalog 做一次有界验证，但不会缓存 catalog 或形成 current-model registry。

当 upstream 没有足够 metadata 证明某个 model + effort 组合不兼容时，Bridge 不猜测，最终决定留给 native Codex。

---

## Elicitation 当前不受支持

`mcpServer/elicitation/request` 目前不在 `codex_respond` 的 supported response surface。

如果 native Codex 发出这类 request：

- Bridge 会保留并暴露它；
- 不会静默吞掉；
- 不会猜测 response schema；
- 不会构造一个泛化回答。

只有未来存在明确、稳定并经过验证的上游 contract 时，才会考虑加入。

---

## 快速开始

### 环境要求

- Windows 或 macOS
- Node.js 24+
- 官方 Codex executable
  - 可直接通过 `codex` 找到；
  - 或使用 `CODEX_EXE` 显式指定。

本项目不捆绑、也不依赖 `@openai/codex` npm package。

### Clone、构建与测试

```bash
git clone https://github.com/zoeynine/Local-Codex-Bridge.git
cd Local-Codex-Bridge
npm ci
npm run typecheck
npm run build
npm test
```

### 直接启动

Windows PowerShell：

```powershell
$env:CODEX_EXE = 'C:\path\to\codex.exe' # codex 已在 PATH 时可省略
npm start
```

macOS / POSIX shell：

```bash
CODEX_EXE=/path/to/codex npm start
```

如果 `codex` 已在 `PATH`，`CODEX_EXE` 可以省略。

### 配置 MCP client

严格的 MCP stdio client 应直接启动构建后的 Node entry：

```text
command: node
args:    <absolute-path-to-repository>/dist/src/index.js
env:     CODEX_EXE=<optional-path-to-codex>
```

不同 MCP client 的配置格式可能不同，但最终应直接运行：

```text
node <repository>/dist/src/index.js
```

**不要**在 Secure MCP Tunnel 或其他严格 JSON-RPC stdio transport 后使用 `npm start`，因为 npm lifecycle output 可能污染 stdout 协议流。

Bridge tool set 发生变化后，已经连接的 MCP client 通常需要重新连接或重启，才能刷新自己的 tool catalog。

---

## 可选：Secure MCP Tunnel

远程 MCP 场景可以在 Bridge 前面使用 Secure MCP Tunnel：

```text
remote MCP client
        ↕
Secure MCP Tunnel
        ↕
node <repository>/dist/src/index.js
        ↕
native Codex
```

Tunnel 的认证、profile、port、ready endpoint 与进程生命周期属于外部配置。

本仓库：

- 不创建 Tunnel profile；
- 不保存生产凭据；
- 不内置生产端口；
- 不把 Tunnel control plane 变成 Bridge 自己的 HTTP API。

---

## Windows

`windows/` 中的 Optional Tray 是已安装 Tunnel client 的轻量启动与状态层，不是 Bridge 核心运行时的必需组件。

Canonical launcher 为 `LocalCodexBridgeTray.*`。

Local settings 模板：

[`windows/local-settings.example.json`](windows/local-settings.example.json)

实际 `windows/local-settings.json` 保持 ignored，不进入 Git。

配置优先级：

1. 显式命令行参数；
2. `LOCAL_CODEX_BRIDGE_*` 环境变量；
3. legacy `LUMEN_CODEX_V2_*` 环境变量；
4. ignored local settings。

Tray 不自动重启 Tunnel，并且只会在 process identity、profile、PID 等信息重新核验一致后，停止由当前 Tray 实例启动的进程。

---

## macOS

`Start Mac Codex Bridge.app`、`launcher/` 与 `bin/start-production-tunnel` 提供 macOS Finder / Tunnel 平台集成。

它们只是平台外层；真正的 Bridge 仍然运行同一个：

```text
dist/src/index.js
```

修改 launcher 或 Finder bundle 后，应在 macOS 12+ 上重新构建并验证：

```bash
launcher/build-launcher.sh
npm run test:macos
```

Windows 与 macOS 是同一 Bridge 的两个平台入口，不是两套独立实现。

---

## 安全与信任边界

Local Codex Bridge **不会创建新的操作系统 sandbox**。

真正的文件、命令、网络与进程能力仍由 native Codex 的配置，以及每个 turn 的：

- `sandbox`
- `approval_policy`

决定。

例如：

- `danger-full-access` 会扩大 sandbox 允许的文件、命令和进程访问范围；
- `approval_policy=never` 不会自行扩大 OS sandbox，但会移除交互式审批这一确认层。

两者是不同的风险维度。

还需要注意：

- `codex_turn` / `codex_steer` 的自然语言指令可能促使 Codex 使用它已有的文件与命令能力；
- “Bridge 没有 generic shell MCP tool”不意味着 native Codex 不会执行命令；
- `codex_threads` 可以看到同一 OS user / Codex runtime 可见的持久线程，筛选条件不能充当访问隔离；
- Bridge 启动 app-server 时会继承自己的环境，但会移除 Tunnel 使用的 `CONTROL_PLANE_API_KEY`；
- 其他环境变量仍属于可信启动边界，不应放入不必要的 secrets；
- Bridge 有 transport sanitization 与有界 projection，但不是 hostile multi-tenant gateway；
- checkpoint 应保持短小，不保存完整 prompt、transcript、原始事件、命令输出或最终回答。

远程使用时，应由经过认证并正确配置的 Tunnel 提供连接边界。

---

## 持久化

Native Codex 负责持久化：

- threads；
- turns；
- conversation history；
- native execution results；
- thread goals；
- queued follow-ups。

Bridge 的 live event ring、active-turn runtime state 与 pending requests 主要存在于内存中，而且保持有界。

ring 丢失时，Bridge 不从 History 重建一份伪 live state。`stream_lost` / `facts_lost` / `cursor_lost` 用于明确表达 live supervision evidence 的缺失。

### Checkpoint

`codex_checkpoint` 是唯一刻意保存的 Bridge-side supervisory state，而且保持精简、有界。

Windows 默认：

```text
%LOCALAPPDATA%\LocalCodexBridge\checkpoints\<sha256(thread_id)>.json
```

macOS 默认：

```text
~/Library/Application Support/LocalCodexBridge/checkpoints/<sha256(thread_id)>.json
```

可以通过：

```text
LOCAL_CODEX_BRIDGE_CHECKPOINT_DIR
```

覆盖。

legacy `LUMEN_CODEX_V2_CHECKPOINT_DIR` 目前仍保留兼容；Bridge 不自动迁移旧 checkpoint。

---

## Deliberate non-goals

Local Codex Bridge 当前刻意不做：

- browser UI；
- HTTP control plane / HTTP MCP server；
- 第二套 task queue 或 job database；
- transcript duplication；
- semantic index；
- model cache / current-model registry；
- queued-message facade；
- automatic mutating-request retry；
- automatic app-server restart；
- generic shell / `command/exec` MCP surface；
- 自动暴露每个存在于 app-server 的 experimental API。

Bridge 的目标不是把 Codex app-server 全量搬进 MCP，而是只暴露监督真正需要、且经过验证的最小 surface。

---

## Upgrading Codex

Bridge 必然依赖少量 native app-server protocol assumptions。

当前依赖、验证状态、对应代码位置，以及 upstream 改变后需要重新检查的内容，都集中记录在：

[`PROTOCOL-ASSUMPTIONS.md`](PROTOCOL-ASSUMPTIONS.md)

升级 Codex runtime、修改 protocol-facing behavior，或者相关 regression test 开始失败时，应优先重新核对这份 checklist，而不是凭旧实现经验直接修改 Bridge。

---

## 开发与测试

常用检查：

```bash
npm run typecheck
npm run build
npm test
```

`npm test` 会运行共享 runtime / compact / History / Goal / Queue / Search / app-server / MCP / checkpoint / platform / shutdown / UX 等测试，并继续执行当前平台对应的测试。

协议 / compact schema 检查需要显式把 `CODEX_EXE` 指向要核验的官方 Codex executable；这个脚本不会使用 Bridge 正常启动路径中的 PATH fallback。

Windows PowerShell：

```powershell
$env:CODEX_EXE = 'C:\path\to\codex.exe'
npm run check:compact-schema
```

macOS / POSIX shell：

```bash
CODEX_EXE=/path/to/codex npm run check:compact-schema
```

仓库仍保留 `npm run smoke:live` 历史辅助入口，但**当前脚本尚未适配 V2.3.0 的 `structuredContent`、独立 History 与 runtime-loss contract，不能作为本版有效 smoke 或跨平台验收命令**。不要为了发布验收直接运行它；如果未来需要恢复 live smoke，应先单独更新脚本并重新审查其持久 thread 副作用。

主要实现位置：

- `src/mcp.ts` — MCP stdio / JSON-RPC boundary
- `src/app-server.ts` — native Codex app-server process / protocol adapter
- `src/tools.ts` — 12 tools、schema 与 supervisory semantics
- `src/runtime.ts` — bounded live runtime / events / pending requests
- `src/observe-compact.ts` — compact typed supervision projection
- `src/history.ts` — lossless History delivery checks
- `src/goal.ts` — Native Goal validation / delivery
- `src/queue.ts` — Native Queue validation / delivery
- `src/search.ts` — Native Search validation / delivery
- `src/checkpoint.ts` — optional supervisory checkpoint
- `src/platform.ts` — Windows / macOS platform boundary
- `src/version.ts` — canonical Bridge version
- `windows/` — optional Windows Tray
- `launcher/`, `bin/`, `Start Mac Codex Bridge.app` — optional macOS integration

---

## License

MIT License — see [`LICENSE`](LICENSE).

## 协作贡献者与致谢

协作贡献者：**小年（ChatGPT）**、**行简（codex）**。

谢谢一起把“让外部 AI 真正监督 native Codex”从一个小想法，一点点压成了一层足够薄、边界足够清楚、也愿意公开给别人继续折腾的 Bridge。`(*╹▽╹*)`

以及谢谢**予安**，没有你我也不会试着去做些什么ღ( ´･ᴗ･` )
