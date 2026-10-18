# 2026-09-28 JSONL overflow

北京时间15:35出现 `app-server JSONL line exceeded 10 MiB`，随后内部 app-server 不可用，外层 Tunnel 可能仍返回200。
已确认机制：超过10 MiB的单行终止内部 child 并锁存不可用；退出事件可用 code=0 覆盖原始 fatal；无界大历史可能形成巨大响应。
具体原始 RPC/消息尚未证实，不能把 `thread/read(includeTurns=true)` 等候选推断写成已确认触发。

生产已修复：首个fatal保留、有界元数据诊断、清缓冲、历史分页或拒绝、安全读恢复一次且mutation不重放、部署失败文件回滚和旧实例证明。
本次16/16部署路径经现场哈希匹配后原样导入，再将正式维护/测试/发布参数化。
`provenance.json` 只记录版本、路径、哈希与源码关联，不含认证、日志或历史正文。
`acceptance-matrix.json` 记录本次隔离测试证据；历史生产回执只作为历史证据，本次未重启或部署。

预防：保持10 MiB上限；metadata-first与native pagination；健康证明分层；包外trust anchor；changed allowlist；回滚加载证明。
生产 package 2.1.3 与本地 candidate 2.1.3-local.1 是不同发行状态，不报告为生产已生效。
