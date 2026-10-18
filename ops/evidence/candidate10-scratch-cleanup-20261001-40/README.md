# LCB-C10-SCRATCH-40

唯一目标 `/private/tmp/lcb-remote-acceptance-AMOFm4` 已完成精确安全清理：root dev16777233 / ino348749538 / uid502 / gid20 / mode0700，完整 metadata inventory 311 条、12,023,077 bytes，SHA256 `26793905c3ae0682d95f512d6f9d4d2e95c20ebd8ffbaa8f597260c244421c08` 精确匹配 review39。逐叶 unlink/rmdir 共311项，无 partial，root lstat 明确返回 ENOENT。

`freeze.json` 冻结完整 metadata 清单及本次恢复时实时祖先。digest 定义为 UTF-8 `JSON.stringify(inventory)`，DFS readdirSync 先父后子顺序，无排序、无换行，键顺序保持 review39 定义。所有对象通过 depth/entries/bytes/path-bytes bounds、type、uid/gid、mode、device、regular nlink、symlink/special、group/other-writable 与 setid 检查。首次删除前复核全清单身份与目录成员，每个叶子 syscall 前再核对 root、外层/内层祖先与该条目身份；目录要求为空才 rmdir。

`review39-input.json` 来自主控补证。child46659 和28已知后代的所有29个 PID 均在本次 ps 表中无条件不存在，因而也不存在任何匹配 PID/UID/start 身份。补证只有 start 范围、无逐个精确 start 字符串；无条件 PID 不存在检查更保守，不推断 PID 重用。`precheck.json` 中精确311条 inventory paths 的 lsof holders=0。创建时祖先未持久化，本次祖先仅属于 recovery-time freeze，不能冒充原 receipt。

`production-before.json` 与 `production-after.json` 的完整对象相同：生产受保护文件 metadata/digest、host代码文件 metadata/digest、生产 HEAD/index/tree、Tunnel34092 与 Bridge34094 的 PID/PPID/UID/start 未漂移。没有生产/host写入、服务重启、kill、prefix扫描、递归rm、读取 scratch 文件正文/凭据/history、模型 turn 或 push。其他 scratch roots 完全不在本次收养和删除范围。

Phase 1 复用 `ops/find-wheel.md` 的 Native scratch cleanup 与 candidate10 已审 `bootstrap-method.mjs`，只添加一次性运维执行记录和 metadata/digest 证据，不增加运行能力、依赖或服务。开发成本为精确收养 guard 与证据封存；上线无新增费用；增长无新增 runtime/供应商锁定；实际用量 unknown。静态 Node syntax / Git diff whitespace 检查通过，本次一次执行在既有5秒预算内完成。

TaskStore CLI 已按目标 repo common-dir 做只读查询，返回 `state database does not exist; initialize/create first`。本次没有初始化其他 TaskStore、迁移或冒充持久任务完成状态；本目录是独立运维证据，由主控和非执行者复核最终裁决。

限制：沿用已审 Node 路径复查语义；没有 fd-relative unlink，不能消除同 UID 最终检查到 syscall 的竞态。只证明已知29进程退出与精确已冻结路径无观察到的 holders，不声称捕获所有未采样后代或提供 OS 隔离。

执行记录：scratch40 | difficult / requested gpt-6.1-sol / high | 身份敏感、单 writer 的精确 root 恢复 | 1次执行 | 清理311项、ENOENT、生产基线一致；独立复核待主控派发 | effective identity/usage unknown，历史残留未纳入本次范围，same-UID syscall race保留。
