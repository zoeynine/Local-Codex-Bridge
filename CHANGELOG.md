# 更新日志

当前本地候选版本为 **V2.3.4-local.1**。源码整合 upstream V2.3.4 / `edfb3a584cc1dc6ee9faea3016b93510f2913542`；已安装且验收的 candidate.10 保持 V2.1.3-local.1，本次不部署或重启生产。

## V2.3.4-local.1（2026-10-01 source candidate）

- 普通三方合并 upstream V2.3.4，保留 12 工具、独立 History / Goal / Queue / Search、compact observation、structuredContent 与上游版本历史。
- 保留本地 JSONL fatal/10 MiB 上限、无 mutation 重放、metadata identity 校验、latest_messages 有界兼容视图及独立运维/信任锚点工具；保留全部历史 release、事故与 candidate.10 验收证据。
- 同步 package/lock/source/README 版本锚点至源码候选；签名 launcher 保留上游 V2.3.4 字节。本次未创建新 sealed release、未运行生产验收。

## V2.1.3-local.1（2026-09-28 candidate）

- 精确导入生产 manifest 的 16 个已部署路径和两项既有兼容验证脚本，导入 SHA-256 见事故 provenance。
- 保留首个 JSONL fatal、限制诊断、释放缓冲；上限保持 10 MiB，mutation 不自动重放。
- 历史读取改为 metadata + 原生分页，拒绝无界读取；不存储历史正文。
- 信任锚点置于包外，部署与回滚保留 fail-closed、定向 kickstart 和旧运行实例加载证明；参数化 host/fixture 路径。
- 独立复核修正：包外runner成为唯一首入口，校验全部包字节后才执行固定操作；冻结rollback合约绑定backup baseline digest；大历史fixture实际向两页native-shaped读取供数。
- 隔离 tamper、rollback、overflow、remote 只读协议测试；增加版本化封存包和文档。未部署生产。
- 兼容边界：Node.js 24+、macOS 当前验收；Windows 测试本机未运行。8 个工具保持不变。可选签名 launcher 未重编译，版本仍为 upstream 2.1.3。

版本章节记录公共仓库的工程变更；提交与 push 不等于已创建 tag、GitHub Release 或完成部署。当前公开版本为 **V2.3.4**；公共历史中没有单独的 V2.1.0 发布记录。

## V2.3.4（2026-09-29）

- 压缩公开 MCP 工具发现描述并提供中英文 README；在 `codex_respond.method` 描述中保留四个 stable 与两个 legacy 支持方法的完整名称，补齐 tools/list 发现回归。运行时响应行为与拒绝边界不变。

## V2.3.3（2026-09-29）

- 修复 compact 终态完整性元数据早于正文交付的问题：尚未读到正文交付游标时返回 `terminal.final_result_pending:true` 并省略 `final_result_meta`；短 final、淘汰补发与旧 cursor 回放保持既有边界。
- 修复新的 agentMessage 仅有开始通知或空 delta 时清空上一条答复的问题；实际新文本或明确完成的正文才切换累积器，保留消息身份隔离和一次交付。
- 同步消费者说明与确定性回归，并在最终 V2.3.3 plist 下重建、ad-hoc 签名 macOS Finder bundle。

## V2.3.2（2026-09-29）

- 将 History / Goal / Queue / Search 的精确交付判定与 observe 有损投影预算解耦；History / Search 提供默认 protected 与单次显式 exact 内容选择。Goal / Queue 原值往返，并在 mutation 前检查已知回显的字节预算；保留 acknowledged-but-undeliverable 与 UNKNOWN 的区别。
- 隔离可选 UX projection 的 I/O 失败，后续自然发布可恢复；不污染已接受 mutation、不触发 app-server fatal。
- 修复 compact 长 final 的终态补全，记录 live 文本是否完整/被裁剪，消除双重截断和跨消息流式拼接；保留普通 compact drainage 预算。
- 保留最初 app-server fatal 原因，补齐 runtime-loss 未知字段，统一退出 final 脱敏及 UTF-16 截断保护，校验 README release 锚点。

## V2.3.1（2026-09-28）

- 在最终版本 plist 状态下重新构建并 ad-hoc 签名 macOS Finder bundle，使 plist 与 bundle 签名一致，修复 GitHub macOS CI packaging check；Bridge runtime、MCP 工具与协议语义均未改变。

## V2.3.0（2026-09-28）

- 新增 `codex_history`、`codex_goal`、`codex_queue`、`codex_search`，公开 MCP 工具由 8 个扩展为 12 个。持久 History、Goal、Queue、Search 与执行生命周期仍由 native Codex 持有，Bridge 不创建平行存储、调度器或索引。
- History 区分 paginated turn 索引 / items 分页与 legacy 完整 turn 分页，保留原生 cursor 与可交付的长文本。成功页须无损通过结构、脱敏与字节预算检查；失败不返回部分 data / cursor，也不自动 full-read。线程元数据读取不再加载 turns，恢复持久内容统一走 History，线程续接使用 `excludeTurns:true`。
- 所有成功工具结果统一放在 `structuredContent`，text content 只保留简短标记。旧客户端需迁移成功结果解析；`codex_threads(include_turns:true)` 返回迁移提示，Bridge runtime 丢失后的 observe 明确返回 live 状态未知，不从 History 重建。
- `codex_observe` 默认提供 compact typed supervision facts，并保留 raw 窄读；支持一次最长 120 秒的固定截止、事件驱动等待。compact 对保留的流式活动做有界计数，未知或不兼容事件保留为诊断事实；沿 `next_cursor` 续读，不自行判断 stalled。
- 有界 runtime ring 分开保护监督事实与流式活动，并通过 `stream_lost` / `facts_lost` 标明丢失。pending requests 与 latest terminal 独立于 ring 保留；compact 在 live runtime 可用且 pending 集合为空时省略该字段，缺省不代表沿用旧列表。
- Goal set 要求显式 `preserve` / `unlimited` / `fixed` 预算意图；Queue 映射原生 follow-up 的 list / add / update / delete / reorder；Search 返回原生线程或 occurrence locator，并可用同一 thread 的 `turnCursor` 窄读 History。这些调用不隐式 resume / start，不自动重试；原生 active Goal 仍可能执行，Goal clear 与 Queue delete 均不等于 turn interruption。
- `codex_threads` 保留原生 capability / lineage 字段及其 null / 缺省语义，支持显式 parent / ancestor / source 筛选。spawned lineage 与 fork lineage 分开，筛选和 capability 不构成访问控制、writer lease 或 Bridge 接管权限。
- 补齐命令审批的 session decision、exec-policy amendment 与 network-policy amendment 映射及冲突校验；保留原始 typed request ID 和准确 scope，校验失败不消费 pending request，未知 response contract 继续保持可观察。
- 兼容 Tunnel 在同一 stdio 子进程内转发的独立 initialize：每次合法握手单独协商，保留已有 live state。回归覆盖 active observe 的取消 / 继续接收事件、pending request 保留与准确回答；不扩大为跨客户端多 writer 保证。
- 增加 `interrupted + error` compatibility canary，锁定现有 status-first 终态语义：final 文本与 error 可同时存在，raw / compact 保持 interrupted，History 原样交付。该测试不将 upstream main / prerelease 的新形态升格为稳定依赖。
- 增加当前安装版本的 compact notification shape / method / item 检查，容忍跨平台 CRLF，修正 History 测试的 cwd 平台夹具。更新人读 README 与 Agent 工程说明，并同步 V2.3.0 版本锚点；现有 `smoke:live` 标为尚未适配当前契约的历史辅助脚本。

## V2.1.3（2026-08-24）

- 新增第 8 个公开工具 `codex_models`：按需读取有界的原生 `model/list` 页面；显式 model/effort override 使用新鲜、有界且防游标循环的 catalog 校验，不建立 Bridge 模型缓存或当前模型状态。
- 将公共运行与测试基线扩展为 Windows 和 macOS、Node.js 24+，保留各平台原生路径与精确子进程生命周期边界；CI 在 Windows 与 macOS 上执行等价验证。
- 对显式 sandbox 与 approval policy 使用 `thread/start` / `thread/resume` 返回的原生有效 policy 做失败关闭核验；省略 override 时保持原生默认，不增加 Bridge 状态或额外读取。
- 将缺失有效 status 的 `turn/completed` 保守投影为 `unknown`，并把流式 agent 文本保留改为有界尾部，避免丢失最终结论。
- 补充原生 app-server 硬依赖清单与版本锚点校验；V2.1.3 必须存在对应的 CHANGELOG 版本章节。

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
