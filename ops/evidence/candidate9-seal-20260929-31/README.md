# Candidate.9 seal evidence

candidate.9 已封存，source commit `766f7e05d553b0a85e5175d7b0936f146eb24ed0`。`current-index-acceptance.json` 和 `candidate9-reseal-input.json` 使用递归对象键排序、紧凑 UTF-8 JSON 加一个 LF；摘要见 closeout。来源为主控交接的独立 review30 和明确当前 index acceptance，没有虚构 repository review 文件。

生产 index 当前字节 SHA-256 为 `3f5f4b407274a4634499b0346d0de4260a5b847f3796a1de1e2c4d24409bf7f8`；59 个 entry 与 14 个 TREE 节点匹配 HEAD。旧 index binary 不可用，漂移根因 unknown，stat/cache refresh 仅为假设。历史 provenance、bootstrap27 receipt/contract 与 candidate.8 不改写。

封存前、external --check 前和最终读回均复算五个接受身份字段。四个 host 文件按 bootstrap27 全 metadata 验证；两次 fresh socket nonce 绑定原 daemon 的九个 loaded modules、OS PID/parent/start 与 socket ownership。seal receipt 的 deployment_ready 表示封存时 live daemon 门；纯 --verify 只证明封存字节；最终 live --check 独立返回 deployment_ready=true。

Node26 clean unpack 的 npm ci --ignore-scripts、typecheck、npm test、bootstrap/index、overflow 和 deploy/remote 检查通过。24 个 clean build dist 文件逐项匹配封存 payload；常规 suite 的两个跳过保持独立报告。raw bootstrap/index stdout 未持久化，只记录实际输出汇总；其它生成日志位于 `.validation/candidate9-clean`。

生产版本仍为 2.1.3，daemon4204/4206、instance、23 个原 dist、95 个存在的 baseline 文件及7个 absent baseline、精确 index 和四 host metadata 均通过最终读回或只读 external check。没有生产写入、重启、凭据或真实 history 正文读取。候选部署/运行效果/production acceptance 未执行。

切片 | 请求模型/effort | 选择理由 | 尝试次数 | 验收证据 | 未验证项
---|---|---|---|---|---
LCB-C9-SEAL-31 | gpt-6-sol/high; effective unknown; usage unknown | 单 writer 封存与清洁验证 | seal1/check1; fixture development2 | closeout 的各独立门 | 独立 candidate9 review、部署/生产验收
