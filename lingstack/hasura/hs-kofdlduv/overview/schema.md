# Schema 鸟瞰图

> 最后更新：2026-08-27 21:58  
> Hasura CLI：v2.49.5  
> 数据源：`default`（Postgres `public`）  
> 状态：已 track 25 张业务表；关系均来自 FK（`foreign_key_constraint_on`）

请对照 Console http://localhost:9695 与本图：漏表、关系反了请立刻说。

## 已 track 表

`users` `sites` `site_members` `devices` `inspection_templates` `import_batches` `service_cases` `case_assignments` `case_work_units` `inspection_tasks` `inspection_records` `vision_jobs` `ai_hard_rules` `case_expense_claims` `po_orders` `po_items` `price_library` `item_price_mappings` `case_performances` `case_perf_shares` `assessments` `assessment_events` `assessment_score_rules` `monthly_settlements` `change_logs`

## JWT 角色

| 角色 | 含义 |
|---|---|
| `super_admin` | 全表 |
| `site_manager` | 本网格及成员范围 |
| `inspector` | 本人任务 / 派单 / 报销 |
| 无 Token | `anonymous`，无业务权限 |

`users.password` 仅 insert/update，select 不可见。登录由 Next 服务端用 Admin Secret 查哈希后签发 JWT。

## ER 图（核心闭环 + 财务）

关系名与 metadata 中 `object_relationships` / `array_relationships` 一致。指向 `users` 的多条 FK 使用列名去 `_id` 后的关系名（如 `created_by`、`inspector`、`manager`）。

```mermaid
erDiagram
  users ||--o{ sites : manager
  users ||--o{ site_members : user
  sites ||--o{ site_members : site
  sites ||--o{ devices : site
  sites ||--o{ inspection_templates : site
  sites ||--o{ service_cases : site
  sites ||--o{ inspection_tasks : site

  users ||--o{ service_cases : inspector
  inspection_templates ||--o{ service_cases : task_template
  import_batches ||--o{ service_cases : import_batch

  service_cases ||--o{ case_assignments : case_assignments
  users ||--o{ case_assignments : inspector
  service_cases ||--o{ case_work_units : case_work_units
  case_work_units }o--o| inspection_tasks : inspection_task

  service_cases ||--o{ inspection_tasks : inspection_tasks
  users ||--o{ inspection_tasks : inspector
  devices ||--o{ inspection_tasks : device
  inspection_tasks ||--o{ inspection_records : inspection_records
  inspection_records ||--o{ vision_jobs : vision_jobs

  service_cases ||--o| case_performances : case_performance
  service_cases ||--o{ case_perf_shares : case_perf_shares
  service_cases ||--o{ case_expense_claims : case_expense_claims
  service_cases ||--o{ po_orders : po_orders
  po_orders ||--o{ po_items : po_items
  import_batches ||--o{ po_orders : import_batch

  users ||--o{ monthly_settlements : user
  users ||--o{ assessments : user
  users ||--o{ assessment_events : user
  service_cases ||--o{ assessment_events : service_case

  users {
    uuid id PK
    text username UK "登录名"
    text password "bcrypt，GraphQL 不可读"
    text real_name "姓名"
    text role "主角色"
    jsonb roles "多角色"
  }
  sites {
    uuid id PK
    text name "网格名"
    text code UK
    uuid manager_id FK
  }
  site_members {
    uuid id PK
    uuid site_id FK
    uuid user_id FK
    text member_role "副网格长/工程师"
  }
  service_cases {
    uuid id PK
    varchar gsp_case_no UK "GSP 案例号"
    uuid site_id FK
    uuid task_template_id FK
    varchar status "待派单到月结"
  }
  inspection_tasks {
    uuid id PK
    uuid site_id FK
    uuid inspector_id FK
    uuid service_case_id FK
    text status
  }
  inspection_records {
    uuid id PK
    uuid task_id FK
    jsonb entries "拍照与 AI 结论"
    text status
  }
  vision_jobs {
    uuid id PK
    uuid inspection_record_id FK
    text status "验图队列"
  }
  po_orders {
    uuid id PK
    varchar po_no UK
    uuid service_case_id FK
  }
  case_performances {
    uuid id PK
    uuid service_case_id UK "一对一"
  }
```

## GraphQL

- `https://hs-kofdlduv.jzsdqp.weweknow.com/v1/graphql`
- 浏览器：`Authorization: Bearer <jwt>`
- 默认复数：`service_cases` / `insert_service_cases_one`
