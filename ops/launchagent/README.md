# LaunchAgent 模板边界

目标 label 固定为 `com.openai.tunnel-client.lcb-remote`，domain 是现场确认的 `gui/<uid>`。
生产 plist 归外部运维所有；本项目只记录其 SHA-256，不导入包含 host/profile 的实际 plist。
配置应设置 Node24+、wrapper 绝对路径以及0600私有 profile；不在模板填入凭据/URL。
