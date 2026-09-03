# E2E Auto 隔离全流程测试报告
- 时间: 2026-09-01T16:08:17.258Z
- 目标: http://localhost:3000
- 隔离前缀: auto
- 总步数: 2，成功 1，失败 1
- 备注: variable 'roles' is declared as '[String!]!', but used where 'jsonb' is expected
| 阶段 | 步骤 | 结果 | 说明 |
|---|---|---|---|
| 阶段0 管理员登录 | admin 登录 | ✅ | OK |
| 阶段1 隔离账号与网格 | 创建网格长 auto_mgr | ❌ | 【阻断】variable 'roles' is declared as '[String!]!', but used where 'jsonb' is expected |