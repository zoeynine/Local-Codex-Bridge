# Local Codex Bridge — macOS

*A thin MCP control bridge from ChatGPT to native Codex sessions.*

这是 Local Codex Bridge 的长期 macOS 实现。它让 ChatGPT（或其他 MCP 客户端）通过 7 个 MCP 工具监督本机原生 Codex 会话，同时把线程、回合、历史记录、最终输出和执行能力继续交给官方 Codex app-server 管理。

当前功能版本为 **V2.1.2**，正式平台分支为 **`macos`**。[查看更新日志](CHANGELOG.md)

本分支与 `origin/main` 上的 Windows 实现属于同一个 GitHub 项目，并对齐相同的功能版本、MCP tool contract 与核心控制语义；两者的源码、测试、launcher 和 runtime 实现彼此独立。版本号表示功能语义已经对齐，不表示两个分支的源码或提交 hash 相同。后续同步以功能为单位：先分析 `main` 的合同变化，再在 `macos` 上按 macOS 原生方式适配和验收。

## 架构

```text
ChatGPT / 其他 MCP 客户端
        │
        │ MCP JSON-RPC（stdio；远程场景可由 Secure MCP Tunnel 接入）
        ▼
Local Codex Bridge
        │
        │ Codex app-server JSONL（stdio）
        ▼
官方 Codex：codex app-server --listen stdio://
        │
        └── 本机原生线程、回合、历史记录与执行权限
```

Bridge 是一层薄控制面，不是第二套任务系统。它不会创建 job ID、维护队列、复制转录或自动重试，也不会在 app-server 意外退出后自动重启。Bridge 只保留有界的实时监督状态、pending request、终态快照和可选 checkpoint；原生 Codex 会话始终是持久事实来源。

## 7 个 MCP 工具

| 工具 | 用途 | 重要边界 |
| --- | --- | --- |
| `codex_threads` | 列出、搜索或读取原生 Codex 持久线程 | `cwd` 和搜索词只是筛选条件，不是权限边界；不会重建已经丢失的 Bridge 实时事件 |
| `codex_turn` | 新建或恢复线程，并启动一个回合 | 新线程必须提供绝对 POSIX `cwd`；返回“已接受”不等于任务完成 |
| `codex_observe` | 读取有界的实时事件、待处理请求、终态和游标 | `wait_ms` 最长 10 秒，只做一次事件驱动等待；安静不代表卡死 |
| `codex_steer` | 向同一个活动回合追加纠正或新意图 | 必须匹配准确的 `thread_id` 和 `expected_turn_id`；不会新建回合 |
| `codex_respond` | 回答真实的审批、用户输入、权限或 elicitation 请求 | 必须使用原始 request ID 及准确的线程、方法和回合范围；不能虚构请求 |
| `codex_interrupt` | 中断准确的活动线程与回合 | 只发送原生 `turn/interrupt`；不会停止或重启 Bridge / app-server |
| `codex_checkpoint` | 保存可选、精简且有界的监督锚点 | 不是转录、日志、任务 ID 或 Codex 历史；原始目标、约束和验收条件初始化后不可变 |

所有工具都公开对象输入 schema，以及 MCP 的只读、破坏性、幂等和 open-world 提示。完整字段和限制以 [`src/tools.ts`](src/tools.ts) 为准。

## 环境要求

- macOS；本分支使用绝对 POSIX 路径语义，不声明其他操作系统运行支持。
- Node.js 24 或更高版本。
- 官方 Codex 可执行文件，并支持 `codex app-server --listen stdio://`。Bridge 不捆绑、也不依赖 `@openai/codex` npm 包。

本轮实机验收环境为 macOS 26.5、Node.js 26.0.0 和 `codex-cli 0.147.0-alpha.6.5`。这只记录已经验证的组合，不据此虚构更早 macOS 或其他 Codex 版本的最低支持边界。

Bridge 会先使用显式的 `CODEX_EXE`，否则从进程 `PATH` 查找 `codex`。GUI 或 Tunnel 进程未必继承交互式 shell 的 `PATH`，部署前应在目标 Mac 上解析实际的 Node 与 Codex 路径，不要照抄维护者机器的路径。

## 安装、构建与测试

克隆正式 macOS 分支：

```sh
git clone --branch macos https://github.com/zoeynine/Local-Codex-Bridge.git
cd Local-Codex-Bridge
npm ci
npm run typecheck
npm run build
npm test
```

`npm test` 会重新构建并运行 macOS 的 runtime、app-server、tools、MCP、checkpoint 和 EOF / SIGINT 子进程回收自动化测试。

## 启动

在终端交互式启动时，可以使用：

```sh
export CODEX_EXE="/absolute/path/to/codex" # codex 已在 PATH 时可省略
npm start
```

`npm start` 适合人工终端使用。严格的 MCP stdio 客户端必须直接执行构建产物，避免 npm lifecycle 输出污染 stdout：

```text
command: /absolute/path/to/node
args:    /absolute/path/to/Local-Codex-Bridge/dist/src/index.js
env:     CODEX_EXE=/absolute/path/to/codex   # 可选
```

Bridge 的 stdout 专用于 MCP JSON-RPC；诊断信息只能写入经过清理的 stderr。

## Secure MCP Tunnel 生产入口

Secure MCP Tunnel 是仓库外部的传输层。Tunnel 的认证、profile、端口、ready endpoint 和进程生命周期都不由 Bridge 创建或管理。Bridge 本身只实现 stdio MCP，不提供 HTTP MCP endpoint。

从既有 V2 生产环境切换本分支时，应保留现有 Tunnel 的远端身份、canonical profile 和 ChatGPT 已连接的入口，只原地替换本机 MCP command 与最小环境；不要为了 macOS 实现新建第二 Tunnel 或要求 ChatGPT 重新添加连接。允许刷新 ChatGPT App 以重新发现当前功能合同；切换后的验收必须从原有 ChatGPT 入口直接完成 initialize，并枚举该功能版本声明的工具。

完成 `npm run build` 后，Tunnel 的 production target 必须是构建入口：

```text
/absolute/path/to/Local-Codex-Bridge/dist/src/index.js
```

推荐 Tunnel 的 command 先从 Bridge 进程环境移除仅属于控制面的凭据，再直接启动 Node：

```sh
env -u CONTROL_PLANE_API_KEY \
  CODEX_EXE="/absolute/path/to/codex" \
  /absolute/path/to/node \
  /absolute/path/to/Local-Codex-Bridge/dist/src/index.js
```

`CONTROL_PLANE_API_KEY` 不应进入 Bridge，更不应进入 Codex。即使上游没有先清理，Bridge 在启动官方 app-server 子进程时也会防御性删除这个环境变量。不要把任何 secret 值写入仓库、profile 示例、日志或命令行参数；也不要把某台机器的 Tunnel profile、端口或 PID 当作通用配置。

旧 macOS 实现中的 Finder 双击入口和 Keychain 凭据流程尚未作为本分支 V2.1.2 的生产能力恢复。它们属于切换到当前架构前需要重新适配并验收的便利功能，当前不要把它们视为仓库已提供的启动方式。

## 如何监督一个回合

`codex_turn` 只确认原生 `turn/start` 已被接受。需要持续监督时，应使用有界的 `codex_observe` 等待终态，并在每次返回后检查新事件、pending request 和当前状态，再决定是否继续观察、`codex_steer`、`codex_respond` 或 `codex_interrupt`。

- 长时间没有新命令或输出，不足以证明 Codex 卡住了。
- 只有新证据或用户意图发生变化时才应 steer。
- 只有确实存在的 pending request 才能 respond。
- 只有明确需要停止当前回合时才应 interrupt。
- 是否复用线程取决于任务连续性和上下文价值；`thread_id` 不是永久任务编号。

## 路径、checkpoint 与持久化

- 新线程的 `cwd` 必须是绝对 POSIX 路径。相对路径、`~` 缩写和包含 NUL 的路径会被拒绝。
- checkpoint 默认目录为 `~/Library/Application Support/LocalCodexBridge/checkpoints`，文件名使用 `thread_id` 的 SHA-256 摘要。
- `LOCAL_CODEX_BRIDGE_CHECKPOINT_DIR` 可以显式指定另一个绝对目录；旧别名 `LUMEN_CODEX_V2_CHECKPOINT_DIR` 仍可显式使用。优先级依次为 canonical 环境变量、legacy 环境变量、macOS 默认目录。
- Bridge 不会自动探测其他默认目录，也不会隐式迁移或删除 checkpoint 数据。
- 原生线程、回合、历史和最终输出由官方 Codex 持久化。Bridge 的事件 ring、活动回合状态和 pending request 只存在于内存中；进程重启后，`codex_observe` 可以明确降级为读取持久历史，但无法重建实时状态。

checkpoint 只适合简短、无敏感信息的监督认知元数据。不要保存 prompt、逐字记录、原始事件、命令输出或最终回答。

## 安全与信任边界

Local Codex Bridge 不会创建新的操作系统沙箱。真正的文件、命令、网络和进程权限来自官方 Codex 的配置，以及回合请求的 `sandbox` 与 `approval_policy`。prompt 只能约束意图，不能降低原生进程能力。

- `codex_turn` / `codex_steer` 的文本可能促使 Codex 使用已配置的命令和文件能力；没有直接暴露 shell 工具不等于不会执行本机操作。
- `codex_threads` 能看到同一 macOS 用户和同一 Codex app-server 可见的持久线程；筛选条件不能隔离访问。
- app-server 子进程继承经过明确清理后的 Bridge 环境。启动环境、线程可见性和本机用户都属于信任边界。
- 实时事件与 pending request 会被限量，并对明显的敏感内容做清理；这不能把 Bridge 变成敌对多租户网关或跨用户隔离层。
- `codex_respond` 只能回答真实存在、ID 和作用域完全匹配且已支持的 pending request；未知方法保持可观察和 pending，不应猜测响应格式。
- 远程使用时，应由经过认证且配置正确的 Tunnel 提供连接边界；不要把本地 stdio 控制面直接暴露给不可信来源。

Bridge 不是任务队列、后台监控器、HTTP MCP Server、通用 shell endpoint、Codex 运行时安装器或 Tunnel profile 管理器。

## 开发与真实 smoke

常用确定性检查：

```sh
npm run typecheck
npm run build
npm test
```

`npm run smoke:live` 与自动化测试刻意分开：它会调用真实 Codex，以只读任务验证 start/observe、重启后的原生历史与 checkpoint 恢复、同回合 steer、严格匹配的真实审批响应、interrupt，以及 EOF / SIGINT 后无孤儿进程，并留下持久原生测试线程。先完成 build，并且只在明确接受这些副作用时运行：

```sh
CODEX_EXE="/absolute/path/to/codex" npm run smoke:live
```

`SMOKE_CWD` 可指定另一个绝对 POSIX 工作目录，缺省为仓库根目录。

主要实现位置：

- `src/mcp.ts`：MCP stdio / JSON-RPC 边界
- `src/app-server.ts`：官方 Codex app-server 子进程与协议适配
- `src/tools.ts`：7 个工具的 schema、校验和语义
- `src/runtime.ts`：有界实时状态、事件与 pending request
- `src/checkpoint.ts`：可选监督 checkpoint

## 许可证

本项目采用 MIT License，详见 [`LICENSE`](LICENSE)。

## 协作贡献者与致谢

协作贡献者：**小年（ChatGPT）**、**Codex**。谢谢两位一起把想法、边界和实现认真地走到了可以公开分享的版本，也谢谢这段彼此配合、反复打磨的过程。`(*╹▽╹*)`
