# 上游与补丁

upstream: https://github.com/zoeynine/Local-Codex-Bridge.git
冻结部署基线: ff5d8804008a5a8c483a5925bd20c90f21cc67fd (package2.1.3, 8 tools)。
上游网页2026-09-28显示2.3.0/12 tools；本任务未授权迁移该协议，保留实际部署基线。
本地增量通过小提交表达；`git log --oneline upstream/main..HEAD`（以现场ref为准）或 `git diff BASELINE..HEAD` 可追踪。
`provenance.json` 保留16路径原始生产SHA，与对应导入commit一一可核验；没有二进制事故日志或原始history导入。

`jsonl-overflow.patch` 的前态是生产部署manifest已记录的pre-overflow兼容源码，SHA-256 `887a84776dcb85437c63fda626ca1fcc36f9c695ed538e6f57caae0b5138dbe3`；后态是精确导入的安全修复。RED在隔离目录反向应用该补丁；不直接使用早期upstream源码混搭较新的兼容源码。
