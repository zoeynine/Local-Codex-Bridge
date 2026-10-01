# LCB-BOOTSTRAP-23 execution evidence

本次新 invocation 按 review22 GO 条件执行一次 prepare / execute。外部冻结 manifest digest 为 `ae1bec0c25c6d681d7ee3935001b56d7baa7de7f44c2bf555f666100e862b898`，执行 HEAD 为 `c527f6b24109ff52ee1196fee08b3837b6aad29f`；执行期间保持 reviewed repo clean/HEAD。

结果为 `blocked_old_service_restored_cleanup_incomplete`：原 wrapper 已原子恢复，旧生产 2.1.3 的精确服务、health、wrapper、真实远程模型与最终身份 gates 全部通过。apply / rollback 各执行一次精确 kickstart。3 个 hook 与 3 个 bootstrap runtime 目录均恢复 absent；生产 dist/Git、candidate7、attempt17 与预存 backup root 保留。

apply 前七次 health 等待 control-plane；第八次 health、wrapper 与真实 remote establishment 通过，但官方 app-server 在本次独立 CODEX_HOME 内生成额外数据库与缓存，超出 remote-model-probe 的只允许 auth.json 清理规则。探针 child 已 close code0；两个未知内容目录原样保留，凭据或生成内容未人工读取。失败 gate 的后续 daemon / remote / final identity 均 not_run，不能据此认定 daemon 已验收。rollback 在第七次证明原服务恢复；其 remote gate 通过，但同类 scratch 清理仍失败，所以 `old_service_restored=true`、`cleanup_incomplete=true`、`rolled_back=false`。

`result.json`、`manifest.json`、`verification-attempts.jsonl`、`owned-targets.jsonl` 是本次 backup 原文件的 exact-byte 副本，digest/readback 在 `readback.json`。冻结执行器原始 receipt 保留内部 `task_id=LCB-BOOTSTRAP-21`；本次运行身份和结论由 `closeout.json` 明确为 LCB-BOOTSTRAP-23。没有更换 digest、再次执行、fallback restart、宽泛删除、candidate 部署或 push。

下一步是独立复核这些证据，再修复 native connector scratch 的创建归属与安全清理方法，重新冻结与复核后才允许新的 bootstrap。当前原 wrapper inode 已因合法回滚变更，旧 contract 的 exact-inode currentness 已失效。

执行模型请求 gpt-6-sol / high，选择理由为边界明确的一次冻结执行；effective model 与用量 unknown。prepare 1 次、execute 1 次，apply gate attempts 8 次、rollback gate attempts 7 次；新 daemon bytes 证明、完整 scratch cleanup、candidate 部署未验证。
