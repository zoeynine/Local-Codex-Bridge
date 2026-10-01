# 运维

本次仅形成 candidate；生产安装仍运行事故修复版本（package 2.1.3）。已有备份路径在 provenance 所指事故源的 `deployment-backups/deployment-gBp147`，仅作追溯，不作为本项目运行依赖。

## 配置与安装

唯一正式首入口是独立保存且已复核哈希的包外runner：`NODE EXTERNAL_VERIFIER PACKAGE_ROOT OPERATION`。
OPERATION 为 `--verify`、`--check`、`--deploy` 或 `--rollback CONTRACT.json`。runner先校验整个sealed包，再按固定名称执行包内模块，并绑定其自身为外部trust verifier。
不要执行包内 `deploy.sh`、`scripts/install`、`scripts/rollback` 或包内JS作为可信首入口；包内shell默认拒绝运行，即使它被篡改为exit0，正式包外入口仍先拒绝sealed hash不匹配。
部署需显式配置 `LCB_PRODUCTION_ROOT`、`LCB_LAUNCH_AGENT`、`LCB_BACKUP_ROOT`。Node必须24+，包外runner路径和哈希应在可信渠道独立复核。
`LCB_LAUNCH_AGENT` 仅接受 `gui/<uid>/com.openai.tunnel-client.lcb-remote`。
验证配置还需 `CODEX_EXE`、`LCB_HEALTH_URL_FILE`、`LCB_TUNNEL_CLIENT`、`LCB_PID_FILE`、`LCB_STDIO_WRAPPER`；这些路径应在部署前 live-read，并与 manifest 的 host_code_hashes 相符。
不要把 profile、URL 文件内容或凭据复制到仓库。模板不包含健康 URL 或实际认证配置。

先运行包外runner的 `--verify` 或 `--check`。前者只校验发布封存，后者另核对生产/host 基线，均不重启。
部署前独立复核、用户授权、活动任务确认、包外 verifier 哈希确认缺一不可。
确认授权后包外runner的 `--deploy` 执行隔离测试/构建、备份、manifest 文件替换、dist 原子交换、精确 kickstart。
运行证明必须包含实际模块 SHA-256、wrapper 子进程身份、Tunnel PID变化、MCP initialize/8 tools/codex_models 和真实远程路由。`probe_loaded_runtime` 仅证明验证器启动的短命 wrapper 所加载字节，不能提升为 Tunnel 长驻 Bridge 的 loaded-instance claim；后者须独立 `daemon_loaded_runtime` 证明。
自动安装的额外历史验证目前需要显式 `LCB_ALLOW_HISTORY_VERIFICATION=1`、`LCB_TEST_HISTORY_ID`、`LCB_TEST_HISTORY_FILE`，且先批准专用隔离 fixture；没有配置会 fail-closed 并回滚。

## 只读健康与正常启动

正常启动依外部 LaunchAgent；本项目不安装、替换或修改现有 Tunnel profile。
healthz/readyz、control-plane poll、wrapper initialize、tools/list、models 与实际模块加载是不同证据。
只有 native app-server → codex_apps → local_codex_bridge.codex_models(limit=1) 成功才确认真实远程路由；不会以直接 Responses API 替代。

## 安全重启与故障

重启仅对已核对身份的精确 domain/label 执行 `launchctl kickstart -k TARGET`。记录重启前后 PID/运行次数并证明模块已加载。
JSONL overflow 时首个 fatal 是事实；code=0 的退出不能覆盖它。保持10 MiB上限，停止无界读取；不要记录协议正文。
Bridge unavailable 时区分外层 Tunnel 与内部 child；安全读取最多一次显式恢复，mutation/response 永不自动重放。
未获许可不能终止 Desktop、其他任务或所有 Codex 进程。

## 显式回滚

自动部署失败会恢复文件与 dist，并重新定向启动旧实例；不确定 kickstart 仍触发恢复后的再次定向重启。
显式包外runner `PACKAGE_ROOT --rollback CONTRACT.json` 需要包外冻结的 `LCB_ROLLBACK_CONTRACT_SHA256`；合约字段为 `production`、`backup`、`backup_baseline_sha256`、`changed`、`expected_current`、`agent`、`host_code_hashes`。
合约须依据上次 JSON receipt 与完整备份生成、独立复核；expected_current 是当前部署文件哈希，backup/files 与 baseline.json 是旧版本来源。
`backup_baseline_sha256` 必须在冻结合约时绑定已复核的backup/baseline.json字节，旧文件哈希由该冻结baseline授权；不能在回滚时按现有备份重新接受新hash。同步篡改备份文件和baseline将被拒绝。
回滚先核对 current 和备份哈希，按 allowlist 恢复文件和原子交换 dist，然后精确重启并验证旧模块实际加载与真实远程只读调用。
契约变化或 current mismatch 必须停止，不通过重新计算 current 哈希来绕过冻结基线。

## Candidate.8 reseal（LCB-RESEAL-29）

bootstrap27 已由独立 review28 接受，四个外置 host 文件在 `ops/runbooks/candidate8-reseal-input.json` 绑定完整 hash、dev/ino、mode、uid/gid 和长度；其中 receipt/contract 引用也有冻结 SHA-256。复核结论来源为主控 handoff，没有独立 repo review 文件。

封存入口为 `NODE scripts/package-release.mjs NEW_RELEASE_DIR NEW_EXTERNAL_TRUST_DIR RESEAL_INPUT RESEAL_INPUT_SHA256`。封存前核对输入摘要、bootstrap 全门与 scratch cleanup、receipt/contract 摘要、四个 host 的实际身份和其他 host 不变哈希。新 manifest 保留事故的 production 基线，增补新 host 基线和 bootstrap acceptance；candidate.7 和历史 provenance 不改。candidate.8 的包外 `--check` 必须真实 daemon 基线通过并返回 `deployment_ready=true`。该 readiness 只证明只读部署前条件，不代表已经部署或生产接受。

native scratch preflight 的有界元数据清单、RPC/cleanup 分别记账，以及 attempt23/合成旧残留 `preserved_not_adopted` 边界继续有效；reseal 不启动 bootstrap，也不操作旧残留。

## MANUAL_RECOVERY_REQUIRED

保留 receipt、backup 与 displaced runtime，停止扩大修改。先核对精确文件/进程身份和旧文件哈希。
只有明确目标、有效备份、回滚和验证路径后才进行授权恢复。不能证明旧实例加载时，文件恢复不能报告为服务恢复。

## Stage E candidate.6 诊断修复

来源：LCB-STAGEE-REVIEW-10 的主控提供脱敏结论（无单独复核文件）。其 P1 是逐轮子门未持久化；P2 是短命 wrapper probe 被误称为长驻 loaded instance。复核指出日志中候选 poller 于 13:41:21.745Z 启动，13:41:56.750Z 超时，13:42:05.286Z 开始回滚；35 秒 timeout 是控制面线索，历史失败子门仍未知，不能追认单一根因。

部署后只读健康窗口为90秒、最多18轮、轮间最多5秒，容纳两次35秒控制面请求及恢复间隔；每轮操作共享剩余截止预算，owned child 清理最多额外6秒。仅重试验证，不重试 kickstart 或 mutation。每轮将 phase、attempt、elapsed_ms、healthz/readyz/control-plane/wrapper/history/probe/daemon/remote 门的 passed/failed/not_run 和固定错误分类即时写入 backup/verification-attempts.json，并带入 result.json；两阶段总记录最多36轮。没有协议正文、历史正文、凭据或完整远程响应。

当前实现没有安全绑定真实长驻 Bridge 子进程的模块加载字节，`daemon_loaded_runtime` 明确未证明。探针、Tunnel PID变化及真实远程只读调用不能替代这个门；自动恢复文件后若仍缺实例证明，继续报告 MANUAL_RECOVERY_REQUIRED，不能称服务恢复。candidate.6 只声明 local validation/check，不声明 installed/runtime effective/production accepted。

由于缺少真正 daemon attestation，正式 `--check` 可以通过字节/host 基线检查，但同时输出 `deployment_ready=false`、`blocker=daemon_attestation_unavailable`。正式 `--deploy` 与 `--rollback` 在生产写入、dist 交换和 kickstart 之前拒绝；生产基线仍已恢复，当前不需要回滚。另一个候选切片必须先实现长驻 daemon attestation，不能仅修改 readiness 常量来绕过该门。

## Candidate.7 daemon attestation（LCB-DAEMON-13）

复核入口来自主控提供的 LCB-C6-REVIEW-12 PASS 与 daemon acceptance 交接。新增私有 socket 证明与 wrapper probe/remote gate 独立；8 个公共工具和 MCP stdout 未变。`node --import TRUSTED_HOOK ROOT/dist/src/index.js` 在 entry 前注册同步捕获，每个 nextLoad 的实际 source SHA-256 存内存；固定9模块清单完整匹配 frozen baseline/payload。磁盘后来变化不重写已加载内存表。

socket 只在 canonical、当前 UID、0700 目录创建，固定名称 `bridge-PID.sock`、0600、请求仅 version/nonce。最大响应32KiB；最多4个连接，每个最多256字节请求与1秒idle timeout。无路径、命令、历史或凭据操作。固定响应携带 instance_id、PID/UID/initial PPID、ps lstart、root、hook_version 与9模块哈希。nonce 只接受64位hex，新鲜 challenge 两次绑定同一 instance_id；单进程去重缓存上限256，不作跨实例历史存储。

verifier 用 exact `gui/<当前uid>/com.openai.tunnel-client.lcb-remote` launchctl、ps 真实 UID/PPID/start、精确 Node --import/entry argv、lsof Bridge socket归属、socket inode/owner/mode 前后三次检查。hook外置三文件必须0500、同UID、非symlink、匹配sealed源哈希；hook目录也必须0700。PID/父子关系/start/root/nonce/instance、清单缺失/额外/hash、socket symlink/owner/mode、超限、timeout、途中换代均拒绝。该证明适用于同一UID可信边界，不提供对同UID恶意进程的OS隔离。

baseline预检在任何备份/生产写入之前执行。候选部署和rollback后先通过真实 daemon gate，再运行只读remote gate，并再次绑定 daemon实例。IPC接受共享deadline/AbortSignal，超时或取消立即销毁连接，不增加独立长窗口。wrapper probe采用显式import，hook读完proof配置即从环境删除；不使用NODE_OPTIONS污染app-server。

host未bootstrap时 `--check` 返回 `deployment_ready=false, blocker=daemon_bootstrap_required` 和失败daemon门；deploy/rollback继续在生产写入之前拒绝。bootstrap不能由普通deploy自行启动。

`NODE scripts/daemon-bootstrap-plan.mjs ops/runbooks/daemon-bootstrap-input.json` 只生成精确契约，不写host、不重启。输入为本机候选，未来执行前live核对target与baseline。先独立核验候选与包外runner，再0700备份原wrapper bytes/mode/owner/hash、target缺省状态、production dist与精确实例；安装3个0500外置hook文件及0700私有runtime目录，原子替换wrapper，精确kickstart一次。用真实只读codex_models建立Bridge后验收旧baseline9模块、wrapper/control-plane/remote各门。失败原子恢复原wrapper，精确重启并验证旧服务，再仅删除本次拥有的hook/空目录。旧wrapper没有attestation，所以旧服务恢复证明与daemon证明分别报告；不能把旧服务健康提高为已加载字节证明。

本切片没有修改host或LaunchAgent。candidate.7封存仍绑定bootstrap前host hashes；bootstrap成功后，需独立冻结新wrapper和3个hook的host hashes并封存新candidate，再进入部署。禁止覆盖candidate.7、忽略host mismatch或重算旧基线后声称原契约仍有效。

## Bootstrap 方法修复（LCB-BOOTSTRAP-FIX-19）

新的执行入口为 `scripts/daemon-bootstrap-executor.mjs`，冻结契约为 `ops/runbooks/daemon-bootstrap-contract.current.json`；原 candidate 契约和 candidate.7 保留。`scripts/read-daemon-bootstrap-prestate.mjs CONTRACT` 只读核对 wrapper、备份根目录、production Git/dist/host 哈希及精确服务身份。执行器 import 无效果；本次没有运行 prepare/execute、host 写入或服务重启。

proof 显式记录目录与 config 身份/哈希、receipt 初始缺失、child PID/close/exit 和 receipt 最终身份/哈希；每次 child 退出后立即清理精确已知文件。missing/partial/truncated/failed receipt 独立分类；未知文件、symlink 或身份漂移保留并报告。远程 scratch 同样只删除精确已知 auth 文件和空目录。gate 只标记正在失败的门，之后保留 not_run；scratch cleanup 独立报告并进入 retained_paths，不能以已恢复服务掩盖未完成清理。

回滚先核对备份/manifest/wrapper/生产基线，再以精确 LaunchAgent/Tunnel 身份执行一次已授权的 rollback kickstart；新 Bridge 不存在不阻止这一步。恢复验收仍要求旧 Bridge 的父子关系、health/control-plane/wrapper/真实 remote 和最终身份稳定。保留已有 mode0700/uid502/gid20 备份根目录；下一 invocation 只创建独占子目录，绝不复用或删除历史内容。

独立复核通过后，主控需冻结最终 reviewed commit 与外部 contract SHA-256；prepare 接口为 `NODE EXECUTOR prepare CONTRACT CONTRACT_SHA256 REVIEWED_HEAD`，它会写 host 备份证据。仅在相应执行授权下，execute 接口为 `NODE EXECUTOR execute CONTRACT CONTRACT_SHA256 SAME_REVIEWED_HEAD BACKUP_DIR MANIFEST_SHA256`。两阶段都严格核对外部 digest、clean repo/HEAD 和完整 source/currentness；任何漂移停止，不自动重放或重新接受旧 digest。
