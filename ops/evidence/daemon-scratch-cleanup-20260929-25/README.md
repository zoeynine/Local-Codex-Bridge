# LCB-SCRATCH-FIX-25

本切片完成 repo 修复与真实 native preflight，仍等待独立复核；未执行 host bootstrap prepare/execute、重启、candidate7 部署或 push。当前生产版本仍为2.1.3，wrapper inode346748007，Tunnel/Bridge61878/61886，runs9。冻结源码、契约和依赖见 `freeze.json`；最终执行 HEAD 必须由复核后的完整 commit 从外部提供，不能将 source commit 当成执行授权。

专属 CODEX_HOME 由排他 mkdtemp 分配，记录 canonical path、dev/ino/uid/gid/mode、invocation、child PID/PPID/UID/start。根先为空，再独占创建0600 auth；子进程可正常生成 DB/cache/skills/plugin 树并轮换 auth。清理先确认 close、可识别后代退出和 lsof 无打开者，再在固定 depth12、entries1024、bytes128MiB、path-bytes128KiB、deadline5000ms 范围内做无正文清单。拒绝 symlink、cross-device、regular nlink!=1、特殊类型、owner/group 漂移、group/other writable、setid 及 root/ancestor 身份漂移；任何准入失败/超限发生于首次删除前则整树保留。全部清单复核后，逐项复查 ancestry/identity，再逐叶 unlink/rmdir；中途漂移则停止并传播 partial/residual。RPC PASS 与 cleanup FAIL 分别记录，cleanup FAIL 阻止整体接受和 bootstrap 目标写入。prepare 在创建 invocation 备份前运行真实 native 门，证据在备份内固定 `native-preflight.json`、scratch 根外保存；manifest 绑定身份/hash并在 execute 前再次复核。prepared ledger 保持恰好两条合法初始记录。

`native-preflight.json` 证明一次真实 OAuth connector 远程 `local_codex_bridge.codex_models(limit=1)` RPC PASS，child81275 code0、31个观察到的后代退出、329个条目/11,404,037bytes、lsof holders0、cleanup PASS且无残留。只为认证运行程序消费既有 OAuth；没有在工具输出或证据中检查/记录凭据正文、真实 history 或协议正文，没有模型 turn。`validation.json` 记录 Node26.3.1 typecheck/build 与共享240 PASS/2平台条件skip、macOS5 PASS、方法/执行器57 PASS，共302 PASS；最后一次方法/执行器测试包含 preflight 证据篡改拒绝。

Node 路径 API 不提供真正 fd-relative unlink；这些复查能发现观察到的替换，无法消除同 UID 在最后一次检查与 syscall 间替换 ancestry 的竞态。100ms ps 采样只能跟踪可识别后代，不能保证捕获采样间隙内生成并立即脱离的进程；退出后的精确固定路径 lsof 还会拒绝任何观察到的打开者。因此不是 OS 隔离方案，也不作 hostile same-UID 安全承诺。

历史 attempt23 的两个目录 `/private/tmp/lcb-remote-acceptance-kOeSWF` 和 `/private/tmp/lcb-remote-acceptance-OtZqlB` 严格保留，不采用、不删除；candidate7、attempt17/23历史证据未改。首次 remote synthetic 测试因 macOS ps 的 UID=-2 解析过严，10个新 synthetic scratch fail-closed 留存；修复为 signed UID 后11个 remote 测试全过，后续 scratch 全纳入各测试专属 fixture 根并精确回收。`test-residuals.json` 记录该事实：3个完整目录身份已回读，7个路径/身份未捕获、当前存在性未验证，不作 prefix 扫描或 ownership 推断，不删除。

执行记录：difficult | requested gpt-6-sol/high | ownership-sensitive 单写者修复 | 2个实现验证轮次（初轮 remote 失败后定向纠正） | local tests + native scratch 门通过，独立复核待定 | effective model/usage unknown；host bootstrap/new daemon acceptance未验证。下一步是独立复核最终 clean HEAD、executor/contract/全部依赖和上述边界；后续若获准 bootstrap，使用新契约、新 invocation、新 manifest，不能重放 attempt23。
