# LCB-BOOTSTRAP-27 execution receipt

结果为 `bootstrapped_runtime_gates_passed_pending_independent_review`。按 review26 GO 的 exact HEAD / contract / executor 执行一次新的 prepare 与一次 execute，主控在 execute 前外部冻结新 manifest digest `19051ce5588cebdd5b52170032416e4a108c62c8500a5c4fce51a4ff64af90d0`。执行过程中 repo 保持 reviewed HEAD `f333491c0b08ee1955428c5a8408c90ccde94bdb` 与 clean；本目录仅在运行完成后新增。

仅一个精确 `gui/502/com.openai.tunnel-client.lcb-remote` apply kickstart，exit0；没有 rollback。前七次只读验收等待 control-plane ready，第八次在同一 90 秒窗口内通过 health / wrapper / establish_remote / exact_tunnel / daemon / remote / daemon_after / final_identity。真实 Tunnel PID4204，直接 Bridge PID4206，parent4204，start `Tue Sep 29 01:03:44 2026`；daemon 与远程调用后 daemon 的 instance 和九个实际 loaded module hashes 一致。真实远程 `codex_models limit1` 返回一项，prepare 与 execute 写前 native RPC / descendants exit / exact-path lsof / bounded owned cleanup 均通过。

`closeout.json` 固定真实 wrapper 与三个 hook 的新 hash、inode、mode、owner，daemon 证据、远程路由与清理证据、完整生产基线与 candidate7 锚点。外部原始 `manifest.json`、`native-preflight.json`、`result.json`、`verification-attempts.jsonl`、`owned-targets.jsonl` 保留在该 receipt 的 `backup` 路径，准确 SHA256 见 `evidence_sha256`；本目录是精简收据，不冒充这些原文件的 exact-byte 副本。冻结 executor 的原始 result task_id 仍为 LCB-BOOTSTRAP-21，本 invocation 身份由 closeout task_id 明确。

生产源码、dist、Git/index、candidate7 与 LaunchAgent 配置未写；旧 attempt23 和首次 synthetic 残留原样保留。没有 candidate 部署或 push。当前结论仅覆盖原生产 2.1.3 的 daemon bootstrap 与 runtime gates；独立复核待主控裁决，之后需使用新 host hashes reseal candidate 才能推进候选部署。

执行模型请求 gpt-6-sol / high，选择理由为单写者完成一个 exact reviewed invocation；effective model、用量、成本 unknown。prepare1 次、execute1 次、apply verification8 次；same-UID final syscall race 仍是声明的限制。
