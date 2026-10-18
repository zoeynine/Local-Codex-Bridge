# Find-wheel Phase 1

直接可用方案为既有上游 https://github.com/zoeynine/Local-Codex-Bridge 和已部署 safety 实现。
适用性：直接满足本机 native Codex → MCP 适配器，保留8工具与protocol；复用现有源码、测试和fail-closed部署，避免另建任务/history系统。
没有以stars选择大型平台；本任务是单用户维护fork，不需要商业MCP网关或新增云服务。
假设：保持冻结2.1.3协议，不隐式升级网页现有2.3.0；发布仅candidate，生产收敛属独立授权阶段。

| 阶段 | 成本判断 |
|---|---|
| 开发期 | 复用已确认上游与部署补丁，主要成本为provenance、参数化、隔离测试和运维文档 |
| 上线日 | 本地Node和外部Tunnel现有依赖，未新增付费服务；部署需独立复核与窗口 |
| 增长期 | 单用户维护fork需跟踪upstream差异，Native协议变更需独立兼容评估，无新供应商锁定 |

Phase1已找到直接匹配方案，停止，不进入学术Phase2。成本实际用量unknown，不声称已节省固定比例。

## Candidate.8 reseal (LCB-RESEAL-29)

Phase 1 复用本仓库 `package-release.mjs`、`release-trust.mjs` 和 `verify-package.mjs`；原有不可覆盖输出和包外冻结信任锚点直接适合当前 reseal。唯一适配是显式摘要绑定的 bootstrap receipt/contract 和四个 host 文件身份输入。没有新增包、服务或运行时功能。假设是独立 review28 的 BOOTSTRAP_ACCEPTED 只授权 reseal，生产部署另行裁决。开发期为小范围打包参数和证据读回；上线日没有新增费用；增长期沿用现有封存流程且无新增供应商锁定。实际用量 unknown，Phase 1 结束。

## Candidate.9 current index acceptance (LCB-C9-SEAL-31)

Phase 1 复用上述封存流程与 Git 官方 [index format](https://git-scm.com/docs/index-format) 的 DIRC v2、SHA-1 checksum 和 TREE extension。最小只读解析器输出 index-order entry 摘要（absent extendedFlags 为 null）及 TREE payload 摘要，Git 命令设置 GIT_OPTIONAL_LOCKS=0，保留部署端精确 index 字节摘要门。适合本机单用户封存，不新增依赖、服务或运行时能力。假设：主控明确接受当前 index 身份只允许新 candidate，漂移根因 unknown，旧 binary 不可用。开发期为小范围 receipt/parser 适配和验收；上线日无新增费用；增长期沿用 Git 格式与原有封存流程。用量 unknown，Phase 1 结束。

## Daemon attestation (LCB-DAEMON-13)

复用既有 `runtime-load-proof.mjs` 的捕获策略，抽出同步 `captureRuntimeLoads`。官方现成接口为 [Node registerHooks](https://nodejs.org/api/module.html#moduleregisterhooksoptions) 的 `nextLoad` 实际 source，以及 [Node net](https://nodejs.org/api/net.html) 的 Unix domain socket、超时与显式销毁。macOS 自带 ps/launchctl/lsof 提供独立进程关系与 socket 归属证据；没有增加第三方依赖、云服务或公共 MCP 工具。直接适合本机单用户环境；不将同一 UID 的恶意进程隔离作为该方案能力。开发期成本为固定小协议、进程绑定、隔离攻击测试；上线日无新增费用但需一次有备份的 wrapper bootstrap；增长期只跟踪 Node 与 macOS 接口，无供应商锁定。实际用量 unknown，Phase 1 结束。

## Stage E diagnostic repair (LCB-STAGEE-FIX-11)

复用既有 manifest-scoped deploy/verifyLive 和 Node 内置有界超时，无新增重试库、服务或持久任务系统。官方接口来源：[AbortSignal.timeout](https://nodejs.org/api/globals.html#static-method-abortsignaltimeoutdelay)、[spawnSync timeout/killSignal](https://nodejs.org/api/child_process.html#child_processspawnsynccommand-args-options)。仅对部署后的只读健康门重试，不重放 mutation 或 restart。开发期成本是小范围诊断投影和虚拟时钟测试；上线日无新增依赖或费用；增长期仍是单用户有界窗口，无新锁定。实际用量 unknown。

## Bootstrap method repair (LCB-BOOTSTRAP-FIX-19)

Phase 1 复用仓库现有 runtime proof、verifyLive、remoteModels、原子备份和 attempt17 执行方法，收敛为可独立复核的 repo executor；没有新增服务或第三方依赖。官方 [Node child_process](https://nodejs.org/api/child_process.html#event-close) 的 close 事件提供子进程退出且 stdio 关闭的生命周期边界；配合既有 fs 独占目录、lstat 身份和 SHA-256，显式绑定 receipt，替代 parent fs instrumentation。适合当前单用户 macOS 精确服务场景；并非面向大型平台或同 UID 恶意进程隔离。开发期成本为生命周期收敛、隔离测试和冻结契约；上线日仍需正式授权的备份/执行窗口；增长期跟踪 Node/macOS 接口，无新供应商锁定。实际用量 unknown，Phase 1 结束。

## Native scratch cleanup (LCB-SCRATCH-FIX-25)

Phase 1 复用现有独占 scratch、RPC/close 和 bootstrap 门，不新增服务或第三方依赖。直接适用接口为 [Node fs](https://nodejs.org/api/fs.html#file-system-flags) 的 mkdtemp、O_EXCL/O_NOFOLLOW、lstat、opendir 和逐叶 unlink/rmdir，[child_process close](https://nodejs.org/api/child_process.html#event-close) 与 macOS ps PID/start，以及 [lsof 官方手册](https://raw.githubusercontent.com/lsof-org/lsof/master/Lsof.8) 的固定路径查询；不用无界 +D 或递归 rm。Node 没有提供 fd-relative openat/unlinkat；路径身份复查只能发现观察到的漂移，不能消除同 UID 最后一次检查与 syscall 之间的替换竞态，不能宣称 OS 隔离。进程每100ms采样跟踪可识别后代，无法保证捕获采样间隙内生成且立即脱离的同UID进程；退出后再对固定清单做 lsof 无打开者检查。对当前单用户修复有用，不引入大型平台。开发期为有界清单、安全拒绝和独立结果传播测试；上线日无新增费用，仍需独立复核并冻结新契约；增长期跟踪 Node/macOS 接口，无新增锁定。实际用量 unknown，Phase 1 结束。
