# 系统全流程测试报告（Composer / Auto 隔离）

- 时间：2026-09-01 ~ 2026-09-02（UTC+8）
- 目标：`http://localhost:3000`
- 策略：与并行测试员（Kimi）隔离，使用 `auto_*` 账号与独立网格，避免互相清库冲突
- 素材：`测试素材/`（与桌面「原始素材」同步）

## 种子与账号

| 角色 | 账号 | 密码 | 说明 |
|---|---|---|---|
| 超管 | `admin` | `admin123` | 系统已有，无需重新种子 |
| 网格长 | `auto_mgr` | `Test@2026` | 自动测试光伏电站（AUTO-HF-001） |
| 工程师甲 | `auto_eng1` | `Test@2026` | 单人派单 + 多人认领 |
| 工程师乙 | `auto_eng2` | `Test@2026` | 多人认领第二台 |

## 覆盖路径

1. 创建隔离网格 / 招募工程师  
2. 导入甲方结算价、内部绩效价、GSP、PO → 价格映射重算  
3. 未分配案例分配到隔离网格，配置服务类型  
4. **单人派单**（系统自动认领单元）→ 上传照片 / 序列号 OCR / 完工 → 报销 → 审核  
5. **多人派单** `assignMode=multi` + `plannedUnits=2` → 甲乙各自认领不同台  
6. 权限负向：未登录 401、工程师禁价格重算、工程师不可建用户  
7. PC UI：登录、网格管理、案例管理、结算审核（已通过列表）  
8. 移动端 UI：工程师登录、首页待办、作业详情、维护执行（序列号步骤）

## API E2E 结果（`scripts/e2e-auto-isolated.mts`）

- 共 46 步，成功 45，失败 1（已定位并修复脚本侧原因）
- 唯一失败：天翼云直传 PUT 未带签名要求的 `x-amz-acl` 头 → 已修测试脚本，服务端代传与带 headers 的直传均正常

## 已修复的业务 Bug

### 1. 结算审核通过不写绩效台账（严重）

**现象**：`POST /review/:id/approve` 只改案例 `status=settled`，不更新 `case_performances.review_status` / `inspector_id`；「我的收入」长期为空；「已通过」页签查不到记录。

**修复**（`apps/web/src/server/bff.ts` + `map.ts`）：
- `reviewApprove`：先 `recalculateLedgers`，再写入台账审核结论与工程师，最后改案例状态
- `pendingReviews`：按台账 `review_status` 正确筛选 pending/approved/rejected
- `finishMyCase` / 单元全部完成：状态改为 `settle_review` 并刷新台账
- `mapCase`：补充结算审核列表所需的绩效字段

**验证**：复审 `OT2608030002` 后，「已通过」列表可见；工程师 `my/income` 出现该案例（`reviewStatus=approved`）。

### 2. 单人派单后再次「认领」失败

**现象**：`assignMode=single && plannedUnits<=1` 时派单接口会自动认领单元；E2E/前端若再调 claim 会报「该台已被认领或不可认领」。

**处理**：测试脚本改为复用已有 `inspectionTaskId`；此为业务设计，不是回归缺陷。

### 3. 直传上传 403

PUT 预签名 SignedHeaders 含 `x-amz-acl`，客户端必须带 `tok.headers`（含 `x-amz-acl: public-read`）。已修正两份 E2E 脚本。

## UI 观察（非阻断）

- 移动端登录页在已有超管会话时提示可切换账号，体验合理  
- 同浏览器多标签共享登录态：工程师登录会覆盖 PC 超管会话（预期浏览器行为，测试时注意）  
- 维护模板检查项较精简（序列号 + 现场记录），「巡检」模板 entries 长度为 0，若要做完整 AI 验图需补齐模板条目  
- 部分维护案例 `perf_base=0` 但 `case_revenue>0`：绩效价映射仍有缺口，结算审核「计件绩效」可能为 ¥0.00  

## 测试账号与数据现状（截稿时）

- 网格：自动测试光伏电站 + 合肥阳光光伏电站（Kimi）  
- 案例：`OT2608030002` 已结算；`IN2608030005` 作业中（多人 2 台，甲已认领台#1）  
- 报销：E2E 提交的报销已批准，待审报销队列为空  

## 复现命令

```bash
cd apps/web
node node_modules/tsx/dist/cli.mjs scripts/e2e-auto-isolated.mts
```

报告文件：`e2e-auto测试报告.md`（脚本自动覆盖）
