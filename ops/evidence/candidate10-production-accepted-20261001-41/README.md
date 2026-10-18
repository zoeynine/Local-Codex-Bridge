# Candidate.10 独立生产接受证据

`LCB-C10-PROD-REVIEW-41` 对已安装的 `2.1.3-local.1` / candidate.10 给出 `production accepted`。这是只复制既有脱敏 review41 JSON 的证据收尾记录；没有重新运行生产验证，也没有进行任何生产操作。源证据来自 `.validation/candidate10-review41-4JQH6g`，以下文件按字节原样复制。

review41 记录源码 HEAD `deec0010b4d7195f394f5034db17735977e35264`、源码工作树干净、production version `2.1.3-local.1`，production/host mismatch 均为空。生产 Git index 与 HEAD/tree 匹配、cached diff 为空。审查记录 `production_modified=false`；before/after daemon identity 相同，instance `c7b63f566edb1a3c21b227580b1a011eec43be1a9c4bb52578b251901d352eba`，九个加载模块 SHA 与 candidate.10 相符。

审查记录 healthz/readyz 200、control plane、wrapper initialize/8 tools/models 通过，及真实远程 `native app-server → codex_apps → local_codex_bridge.codex_models(limit=1)` 通过。报告明确没有请求或写入 API key、记录正文、模型 turn 或 mutation。scratch recovery 核对 8 个证据文件的 metadata digest、311 条逆序删除清单、root ENOENT 与 production before/after 一致。

审计边界：这些结论是 review41 证据所支持的最高 claim。历史真实 history 正文未读。Node path identity recheck 不消除同 UID 最终检查至 syscall 的竞态；进程后代采样不构成 OS 隔离保证。部署记录中 attempt1 未定位的 scratch 残留与既有历史残留审计限制仍保留。回滚备份与合同已留存，但显式 rollback 未执行，自动回滚分支未触发。

## 证据文件 SHA-256

| 文件 | Bytes | SHA-256 |
| --- | ---: | --- |
| `current-before.json` | 999 | `c6cee2fa063d522879b0b67a099246209fc7a9245529b353d2aa0742950586c3` |
| `current-after.json` | 999 | `c6cee2fa063d522879b0b67a099246209fc7a9245529b353d2aa0742950586c3` |
| `daemon-before.json` | 1274 | `ffdec457ddd4d8adc1091d49210904d42bafcf71342c92a86c1ef54b9610bb30` |
| `daemon-after.json` | 1274 | `ffdec457ddd4d8adc1091d49210904d42bafcf71342c92a86c1ef54b9610bb30` |
| `live.json` | 3432 | `615364038fc1b4b9956276e6aca81a7bb8f8bb8e989af228e9c61afb0df72033` |
| `remote-ledger.json` | 274956 | `54c9016915a2749bf93ef1b1beeb358a15c99fad22fd970493838d9c2ba963ef` |
| `remote.json` | 272399 | `4a67077943b429d3d00b803d9f86db7f697a2212f28debfa82d809083b48fab4` |
| `result.json` | 2613 | `56a65f02558b02a8b5478e700059e8b32796c32304ed6e0684bd3054c12e4c94` |

Source and copied JSON SHA-256 values match. Hash inventory excludes this README. No credentials, native history database, or raw history正文 was copied.

TaskStore: this repository's Git common-dir is `.git`; no TaskStore state database or CLI was present/discoverable in this checkout during closeout. No TaskStore was initialized and no task completion state is claimed. Git commit and this committed evidence are the available readback for this closeout.

LCB-C10-CLOSEOUT-42 | documentation/evidence only | 1 closeout | production untouched | rollback not exercised | TaskStore readback unavailable
