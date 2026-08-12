# 更新日志

本文件记录 Local Codex Bridge 的功能版本历史，以及长期 `macos` 分支中可以核验的平台适配事实。当前 macOS 功能版本为 **V2.1.2**；公共历史中没有单独的 V2.1.0 发布记录。

## 未发布（`macos` 分支收束）

- 将 `macos` 建立为同一 GitHub 项目中的长期 macOS 平台实现：功能版本、七工具合同和核心监督语义与 `origin/main` 对齐，但源码、测试、launcher 和 runtime 由各平台独立维护。
- 将新线程路径合同收束为绝对 POSIX `cwd`，并保留平台无关的类型、长度、NUL、请求身份和作用域校验。
- 将 checkpoint 默认目录收束为 `~/Library/Application Support/LocalCodexBridge/checkpoints`；保留 `LOCAL_CODEX_BRIDGE_CHECKPOINT_DIR` 和显式 legacy alias 的优先级，不再自动探测或迁移其他默认目录。
- 从 `macos` 分支删除 Windows-only 源码、启动资源、runtime helper、fixtures 和测试资产；常规测试入口只运行 macOS 应承担的 runtime、app-server、tools、MCP 与 checkpoint suite。
- 将真实 smoke 收束为 macOS 只读命令，并继续与确定性测试分离；真实验证仍会留下原生持久线程。
- 新增 macOS EOF / SIGINT 关停回归，核验 Bridge 精确回收其 app-server 子进程且不留下孤儿。
- 明确 Secure MCP Tunnel 的 production target 为直接执行 `dist/src/index.js`，建议在启动 Bridge 前移除 `CONTROL_PLANE_API_KEY`，并在 Bridge 启动 Codex 子进程时再次防御性剥离。
- 明确后续生产切换应保留现有 Tunnel 远端身份、canonical profile 与 ChatGPT 入口，只原地替换本机 command/env，不新建第二 Tunnel；允许刷新 ChatGPT App 重新发现当前功能合同。
- 旧 macOS 快照中的 Finder launcher 与 Keychain 流程尚未恢复为当前 V2.1.2 能力；启用前需要针对现架构重新适配和验收。

## V2.1.2（2026-08-12）

- 对已经发送但确认超时的原生变更请求保留有界的晚到响应上下文；晚到成功或错误会成为已清理、可观察的运行时证据，并以保守规则对账，不自动重试，也不覆盖更新的活动回合或终态。
- 在 app-server 入站边界拒绝重复的未决请求 ID，并以 claim / release / complete 生命周期保护真实 pending request，避免并发响应、身份替换或误清理。
- 当调用者显式请求 sandbox 时，先核验 `thread/start` / `thread/resume` 返回的原生 policy，再把同一 policy 传给 `turn/start`；缺失、类型不符或模式不匹配时在启动回合前失败关闭。
- 将公开工具 schema 中的线程、回合、工作目录、游标和方法字符串上限与既有运行时校验对齐，并把独立 tools 回归测试纳入完整测试套件。
- 将包元数据、Bridge 上游 `clientInfo`、MCP `serverInfo` 与公开文档统一为 `2.1.2`，并补录 V2.1.1 版本化与后续 canonical convergence 提交。
- 保持 7 个工具及既有薄桥边界不变；`codex_observe.wait_ms` 仍默认 `0`、上限 10 秒，仍是一次事件驱动等待，不增加轮询、自动重试、自动重启或进程控制。

## V2.1.1（2026-08-11）

- 完成监督与控制边界加固：会改变原生状态的请求若在发送后等待确认超时，会明确报告结果为 `UNKNOWN`，Bridge 不会自动重试、取消或推断结果。
- 在 MCP 客户端→Bridge 入站边界拒绝仍在处理中的重复活动请求 ID，同时不干扰原请求的取消、清理及后续 ID 复用。
- 收紧 `codex_respond` 的前向兼容边界：只响应具有明确原生契约的已支持方法；未知方法保持已清理、可观察和 pending 状态，并且不发送响应。
- 加强 app-server 与 MCP 回归测试，覆盖变更请求确认超时、原生写入仍 pending、未知请求、已知用户输入响应和 MCP 入站重复活动请求 ID 等边界。
- 将项目包版本、Bridge 上游 `clientInfo`、MCP `serverInfo` 与公开文档统一为 `2.1.1`。

## 可核验的公共历史

- `53e97f6`：将 self-use 与 public 工作树收敛为同一 canonical repository。
- `8991e70`：将 Bridge 收敛到 public-safe canonical tree。
- `53536f2`：回填已接受的 V2.1.1 重复请求加固。
- `9a8b8f3`：归档已接受的 V2.1.1 监督加固状态。
- `0a99f39`：完成 V2.1.1 公共版本化，并由 `v2.1.1` 标记。
- `ccd98f2`：V2.1.1 公共监督边界加固。
- `c28fc37`：中文优先的 README 与 `AGENTS.md` 公共文档完善。
- `8996398`：Local Codex Bridge 初始公共基线。

上述 V2.1.1 发布及早期公共基线提交日期为 2026-08-11；后续加固归档、回填与 canonical convergence 提交日期为 2026-08-12。
