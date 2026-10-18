# Candidate.10 生产部署证据

`LCB-C10-DEPLOY-38` 已将精确 candidate.10 安装到生产；新 daemon 的实际加载模块、完整本机与真实远程验收均通过。主控提供的 review37 verdict 为 `GO_FOR_SCOPED_CANDIDATE10_DEPLOYMENT`，没有独立 repo review37 文件；条件及来源记录在 `preflight.json`。最终生产接受由主控依据本目录证据裁决。

封存 SHA、包外 verifier、Node26.3.1、production baseline/HEAD/index、全部 host hashes、四个 bootstrap host 的 metadata 和 fresh daemon 在每次入口前核对。三个正式入口均使用原封存包外 runner。前两次没有生产写入或重启：attempt1 的 remoteBefore scratch 清理失败；attempt2 的隔离 regular suite 有一个 synthetic deadline scratch 清理失败，而同次后续 deploy+remote 56/56（包括同一 deadline 测试）通过。失败原始证据保留，未改源码、测试、timeout、接受值或任何封存资产。

attempt3 隔离 typecheck、shared240 PASS/2 skip、macOS5 PASS、overflow11 PASS、deploy+remote56 PASS；24个清洁 build dist 文件通过 sealed payload 比对。25条 manifest allowlist 文件替换与 dist 原子 exchange 后，只对 `gui/502/com.openai.tunnel-client.lcb-remote` kickstart 一次。原封存验收在61.8秒第9轮全门 PASS，逐轮结果见 `backups/deployment-8KkHp8/verification-attempts.json`。

最终 fresh 双 nonce 与 OS/socket/父子关系绑定证明：Tunnel34092 → Bridge34094，启动时间 `Thu Oct 1 10:12:24 2026`，instance `c7b63f566edb1a3c21b227580b1a011eec43be1a9c4bb52578b251901d352eba`。九个实际加载模块匹配 candidate.10，其中 version 模块摘要 `768e6de75a90afd0c23f85674e2c8fec122e54b1e23bfd4432f8c883ba3114a1`，生产 package 为 `2.1.3-local.1`。完整 proof 见 `final-validation.json` 和 `closeout.json`。

最终 healthz/readyz200、control-plane、wrapper initialize/8tools/models、短命 wrapper loaded proof 全 PASS。新31,590,165字节纯合成 fixture 的线程 `37860b5f-568e-46fb-a68f-08dc9d6810bb`，无界历史拒绝、有界 latest1、metadata-only observe 与 SHA不变全 PASS：`cebda1eefb4294abf4e386e5783dfdd94af21a6c813984895428f0cee836bb14`。未读真实 history 正文。

真实 `native app-server → codex_apps → local_codex_bridge.codex_models(limit=1)` PASS；没有模型 turn、mutation 或直接 Responses API。最终已观察48个后代退出，311条 scratch metadata 清单逐叶清理 PASS、lsof holders0、retained_paths=[]；RPC前后同一新daemon身份。库内部使用既有登录，未人工读取、输出或记录凭据正文。

完整 allowlisted旧文件/dist备份及raw validation/result已归档在 `backups/`，生产回滚实际来源仍为 `/Users/ZGH/Codex/Local-Codex-Bridge/deployment-backups/candidate10-deploy38/deployment-8KkHp8`。其 `baseline.json` 冻结摘要 `da68c12350e47245117e5672fd7c123404faa4921fb9b7dd5809d2a2fc946f65`。外置 `rollback-contract.json` 摘要 `12e1d7e5a7982213e066363c5d6a173925216aff99ecc0a69e8221b5d5e4142f`；合约绑定该完整备份与 sealed candidate expected_current，显式回滚未执行，自动回滚分支未触发。最终 production Git HEAD/index保持冻结身份；源码repo仅新增本目录，不push。

`evidence-inventory.json` 对收集时的126个证据/备份文件给出bytes与SHA，不包含自身及随后补写的本README。`execution/` 是执行脚本归档，保留原工作目录路径语义，不是安装入口。合成 fixture仍在原隔离 `.validation` 目录供审计；没有把native scratch/auth/history DB或31MB fixture正文提交。

审计限制：attempt1 frozen CLI 只输出 `Native connector scratch cleanup failed`，没有传出scratch路径或细项；该次精确残留身份未知，未按前缀扫描、收养或删除，不与最终清理PASS合并。既有五次initialize清理审计限制、Sep29历史残留仍保留。Node路径API的同UID最终syscall竞态与100ms后代采样边界未提高为OS隔离保证。

LCB-C10-DEPLOY-38 | requested gpt-6-sol/high; effective unknown; usage unknown | 精确已复核生产部署单 writer | deploy3/diagnostic remote1/final acceptance1 | 最终各门PASS | 第一入口未定位scratch、历史残留审计边界；未执行显式rollback；无push
