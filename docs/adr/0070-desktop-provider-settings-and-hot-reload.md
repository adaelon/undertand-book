# ADR-0070 Desktop provider settings and hot reload
Status: Accepted, 2026-07-11.

**决策**:桌面设置持久化 Provider 配置,确定性校验通过后原子替换当前 Reader adapter。

**否决**:
- 保存时自动请求模型:产生不可见费用且把网络可用性混入配置写入。
- 只支持 `.env`:安装版用户缺少可操作的配置入口。
- 保存后重启:adapter 可在进程内安全替换,重启没有必要。

**命门**:API Key 暂按用户确认明文写入用户级 `settings.json`,不得写日志、安装包或回传前端;空白 Key 只允许保留既有值。配置写入失败时继续使用旧 adapter。

**何时回头**:接入系统凭据库,或 provider 需要 OAuth、刷新令牌与多账户切换。
