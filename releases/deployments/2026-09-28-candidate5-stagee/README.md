阶段 E 结果：candidate.5 安装尝试失败，已自动回滚，生产继续运行 package 2.1.3 事故修复基线。

唯一入口为包外可信 runner；archive、runner、package root、生产 95 文件、5 个宿主程序和 Git 索引在部署前均匹配。安装前独立复核由主控提供 LCB-REVIEW-06 PASS 结果，既存仓库没有单独复核记录；receipt 如实标记其来源。

隔离构建、typecheck、regular tests（201+5 PASS、2 skipped）、overflow 11/11、deployment/remote 44/44 通过。新的 31,582,986 字节纯合成 native history fixture 通过分页有界读取、无界拒绝及 metadata-only observe，冻结 SHA-256 在安装尝试前后保持一致。

唯一部署尝试 exit 1，失败为组合 health/wrapper/history 验收门；封存脚本没有保存各轮失败子门，因此不能宣称具体根因。候选期间 46 份模块加载 hook 记录均加载 9 模块且字节匹配，但这不提高到生产验收通过。

LaunchAgent PID/runs：14831/3 → 43704/4 → 44988/5。回滚后 healthz/readyz 200、控制面轮询、MCP initialize、8 tools、1 model、旧 9 模块 SHA 和真实远程 codex_models(limit=1) 全部通过；再次包外 --check 确认 95 个生产文件及宿主/Git 基线恢复。

备份：`/Users/ZGH/Codex/Local-Codex-Bridge/deployment-backups/deployment-IprfCN`。`rollback-contract.json` 冻结的是自动回滚后的 current 基线；合约 digest 见 `anchors.json`，不能通过重算 current 来绕过漂移。当前已恢复旧版本，无需再次执行 rollback。

重启前唯一 active 线程属于 TimeFlowAI；仅更换精确 Bridge 服务连接，没有发 turn/interrupt 或其它 mutation。回滚后列表未报告 active；Bridge 的 live state 在重启中丢失，不能据此证明 native turn 中断。没有开启 model turn 或请求/写入 API Key。真实远程只读 helper 使用既有 ChatGPT OAuth；未把凭据或历史正文保存到 Git。

下一步：定位具体失败子门，若需修改，另制封存候选并独立复核；不修改 candidate.5。
