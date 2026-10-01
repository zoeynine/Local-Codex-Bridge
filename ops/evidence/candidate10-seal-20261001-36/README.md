# Candidate.10 封存证据

`candidate.10` 已封存并经 Node26 清洁解包验证；包外 live `--check` 返回 `deployment_ready=true`。当前结论仅覆盖候选与只读 readiness；独立复核、部署、安装效果及生产接受尚未执行。

当前 ChatGPT 为 26.928.21956/build12404，嵌套 CLI 为 0.159.2。两套 bundle 的 strict/deep 签名验证通过，TeamIdentifier 为 OpenAI 的 `2DC432GLL2`，签名时间均为 9 月 30 日，notarization ticket 为 stapled。当前二进制 SHA-256 为 `50ac633af64851511f9bbc71032cdae7f1ba20b3234c189687d61ba846c354c5`；旧值 `3e11ccc743e8198a5ef84fb57c89941d845b0ea0302485ed1fbac2f0821aca5a` 保留于 candidate9 与历史 provenance。唯一 host hash 漂移是此 CLI。官方签名应用更新与这些事实一致，但具体更新机制未经证明；旧二进制/签名/版本不可得。

canonical `current-host-acceptance.json` 绑定 controller 本次接受范围、当前签名/version/metadata、候选9 manifest/release、既有 index 与 bootstrap27 接受、基础 initialize 证据及恢复清理证据。packager 只接受这个 Codex 路径的精确 hash 变化，仍逐项验证其它 host/hash 与四个 bootstrap 文件完整 metadata。新增资产复用现有封存、canonical receipt 与 owned scratch 方法，find-wheel Phase1 记录内置于接受凭据。

基础 `app-server --listen stdio://` 只发送 initialize/initialized；没有模型 turn、凭据消费、持久 thread 或真实 history。五次 probe 的初始化通过，立即清理遇到 CLI 短命 git/helper 的 cwd 或观察到的后代尚未退出，因此原清理门保持 FAIL closed。之后只对本次五个精确 root 重新建立无正文清单，516 条 metadata、精确 lsof holders0、逐叶身份复核后清除；没有保留路径。历史 Sep29 residual 不触碰。Node 路径 API 的同 UID 最终 syscall 竞态边界仍保留。原 shared scratch 清理代码未修改。

随后现有 remoteModels 内部消费既有登录，真实调用 `codex_apps -> local_codex_bridge.codex_models(limit=1)` 通过。未人工读取/输出/记录凭据正文；没有模型 turn。38 个观察到的后代退出，311 条专属目录清理 PASS、holders0。调用前后 fresh daemon 双 nonce 证明原 Tunnel4204/Bridge4206、instance 与九个已加载模块相同。

source 与清洁解包 Node26.3.1 的 npm ci --ignore-scripts、typecheck、npm test 均通过：shared240 PASS/2 skip，macOS5 PASS；bootstrap/executor/index/current-host72 PASS；overflow11 PASS 和 deploy/remote56 PASS 是额外重复检查。24 个清洁 build dist 文件匹配 sealed payload。日志位于 `.validation/candidate10-source` 与 `.validation/candidate10-clean`；额外72测试实际 stdout 汇总被记录，raw stdout 未持久化。清洁解包目录保留供复核。

最终读回 production 仍为2.1.3；HEAD/index、manifest baseline、四 bootstrap host 与其它 host metadata 均匹配。candidate9、bootstrap27 receipt/contract、current-index acceptance 和 provenance 未改写。没有生产写入、服务重启、candidate部署或push。

LCB-C10-SEAL-36 | requested gpt-6-sol/high; effective unknown; usage unknown | 单 writer 宿主接受和封存 | initialize5/recovery1/seal1/check1/remote1 | closeout 各门实际证据 | 独立复核、具体更新机制、部署与生产验收
