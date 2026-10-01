# 本地候选发布

当前发布指针：`2.1.3-local.1-candidate.10`，版本 `2.1.3-local.1`，源码 commit `deec0010b4d7195f394f5034db17735977e35264`。Candidate.10 已安装到生产，review41 独立生产接受结果为 `production accepted`；审查证据记录其 runtime 已加载 candidate.10 对应模块，health/readiness、Bridge control plane、wrapper initialize/8 tools/models 与真实远程 `codex_models(limit=1)` 检查通过。完整复核记录见 [candidate10-production-accepted-20261001-41](../ops/evidence/candidate10-production-accepted-20261001-41/README.md)，部署与安装证据见 [candidate10-deploy-20261001-38](../ops/evidence/candidate10-deploy-20261001-38/README.md)。

Candidate.1 至 candidate.9 均为 superseded 历史候选，仅用于审计和过程溯源，不是当前发布指针。Candidate.10 是当前 production-accepted release。

review41 的 before/after 读回显示生产文件、host 文件、production Git HEAD/index/tree 及 daemon identity 未漂移。审查报告声明没有读取或记录凭据正文、没有读取真实 history 正文、没有启动模型 turn 或发送 mutation。其隔离 scratch 清理证据与限制见 review41 原始 JSON 及 candidate10 部署记录。

回滚合同和完整备份已留存，但显式 rollback 未执行，自动回滚分支未触发；不得将其描述为已演练。审查还保留 attempt1 scratch 路径未定位、历史残留审计限制，以及 Node 同 UID 最终 syscall 竞态和进程采样边界。production acceptance 不提升这些限制，也不代表 OS 隔离保证。

发布状态按证据分层记录：candidate.10 已封存、已安装、runtime effective，并由 review41 标为 production accepted。包外可信 verifier、部署备份和操作约束见对应封存及部署证据；源码仓库没有 push。
