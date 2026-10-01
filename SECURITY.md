# 安全边界

Bridge 是用户权限下的 MCP stdio 适配器，不能作为 hostile multi-tenant sandbox。
原生 Codex 持有 threads、turns、历史和权限；Bridge 只保留有界临时监督状态。

凭据由现有登录与外部 Tunnel 管理，不写入源码、发布、fixture、命令行或报告。
真实远程验收 helper 只在明确授权时读取现有 ChatGPT OAuth，临时 home 权限为0700、auth 文件0600、结束销毁；本次阶段B–D不执行它。
合成测试中的 fake OAuth/API sentinel 不是真实密钥，测试验证子环境不传播 API Key。
TLS 校验保持开启，不使用 `NODE_TLS_REJECT_UNAUTHORIZED=0` 连接或接受证书不匹配；相关测试仅验证不安全环境值被删除。

用户 history 不删除、不迁移、不改写。常规自动测试只用合成数据；真实历史验证须显式 fixture 授权，记录 metadata/hash，不记录正文。
超限错误只包含上限、已观察字节与有界待处理请求方法/ID；日志不得保留巨大消息内容。
stdout 专用于 MCP 协议。敏感日志、health URL、Tunnel profile、访问令牌禁止进入 Git。

sealed manifest 的 SHA-256 必须由包外独立冻结 verifier 校验；包内自重算哈希无法授予信任。
包外runner是唯一可信首入口，验证所有包字节后才执行固定deploy/rollback模块；不先执行待验证包内shell。
回滚冻结合约同时绑定backup baseline字节摘要，旧文件哈希不能由未经信任的备份manifest自行重新授予。
攻击者同时控制 trusted anchor 与 release 的情形不在该校验边界内，锚点需独立保管。
部署 changed 路径采用精确 allowlist，拒绝绝对路径、`..`、奇异规范化和 symlink parent/leaf 逃逸。
生产基线变化时 fail-closed；不扩大进程控制、不读取其他项目数据、不自动开启模型 turn。
