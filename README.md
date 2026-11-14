# Express 5 · 分层 API 与 DEX 交易 Demo

以“学习任务”作为独立演示领域，讲解 **HTTP → 中间件 → 路由 → 服务 → 仓库**。旧 EJS/MySQL 启动写入逻辑已移除，不需要数据库账号，也不会在启动时写入业务数据库。

<!-- BEGIN project-discovery -->
## 项目定位与实践入口

Express 5 + Node.js REST API tutorial with layered architecture, validation, error handling and JSON persistence. 后端教学 Demo：任务 CRUD、分页与 Supertest 测试。

适合从以下入口阅读实现与接入条件：

- [HTTP 应用装配](src/app.js)
- [业务服务](src/services/task-service.js)
- [存储适配](src/repositories/)
<!-- END project-discovery -->

## DEX 交易实验室

新增完整的本地模拟项目：双池报价、BigInt 金额、订单幂等、签名/广播/确认、RPC 退避、回执丢失恢复、行情断线补数、策略灰度与回滚、监控审计，以及 PC/H5 管理页面。默认关闭，原任务 API 继续可用。

```sh
npm ci
DEX_DEMO_ENABLED=true npm start
# 浏览器打开 http://127.0.0.1:3000/dex-demo/
```

```sh
npm run demo:dex  # 一键执行正常与故障场景，无需钱包或真实链
npm run check    # 测试与服务入口语法检查
```

**详细说明：[DEX 实现与演练手册](docs/dex-demo.md)**，含需求映射、代码职责、金额公式、状态机、curl、故障注入、配置和排障。模块入口：[src/dex](src/dex)。这是本地教学模拟，不发送真实交易。

## 原任务 API 启动

Node.js 22.12+，推荐 24。

```sh
npm ci
npm start
```

访问 http://127.0.0.1:3000 或 `/health`。默认内存存储，重启后清空。启动时可选择本地文件持久化：

```sh
DATA_FILE=./data/tasks.json PORT=3001 npm start
```

服务只监听回环地址，面向本地学习。环境变量不从 .env 自动加载。所有演示数据都由你主动通过接口创建，没有自动插入数据。

## 请求示例

```sh
curl -i http://127.0.0.1:3000/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"学习 Express 中间件"}'

curl 'http://127.0.0.1:3000/api/tasks?completed=false&limit=20&offset=0'

# 将 TASK_ID 替换为创建接口返回的 id
curl -X PATCH http://127.0.0.1:3000/api/tasks/TASK_ID \
  -H 'Content-Type: application/json' -d '{"completed":true}'

curl -X DELETE http://127.0.0.1:3000/api/tasks/TASK_ID
```

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | /health | 健康状态 |
| GET | /api | 接口导航 |
| GET | /api/tasks | 过滤和分页查询 |
| GET | /api/tasks/:id | 单条任务 |
| POST | /api/tasks | 创建，返回 201 与 Location |
| PATCH | /api/tasks/:id | 修改 title/completed |
| DELETE | /api/tasks/:id | 删除，返回 204 |

输入拒绝未知字段、空标题、非布尔 completed、非法分页及超过 16KB 的请求。任务最多 1000 条；title 为 1–100 个字符。

## 分层

```text
src/app.js                    Express 装配、路由和统一错误处理
src/server.js                 监听配置、生命周期和优雅关闭
src/domain/task.js            错误类型、请求与查询校验
src/services/task-service.js  业务流程，不负责监听端口
src/repositories/             内存/JSON 文件存储契约
tests/                        HTTP 行为和存储测试
```

Express 5 会把异步路由抛出的异常转交错误中间件。公开错误形如 `{ "error": { "code", "message", "requestId" } }`；内部异常不向客户端回传堆栈或数据库内容。

## 开发验证

```sh
npm run dev       # Node 内置 watch
npm test          # Supertest + node:test
npm run check     # 语法检查 + 自动化测试
```

测试覆盖 CRUD、校验、分页、统一错误、Express 5 异步失败、并发文件写入、重启读取、损坏保护和文件锁。Supertest 使用独立内存或临时目录，不使用真实数据库。

## 教学边界

文件仓库通过串行写队列、同目录临时文件和 rename 避免丢失并发更新。独占 `.lock` 防止多进程写同一文件；正常退出释放锁，崩溃后的锁需确认无运行实例后手动清理。损坏文件不会被自动重置。仅适合小规模、单进程 Demo，不是生产数据库。

原任务 API 没有登录、鉴权、用户隔离或幂等键；DEX 模块有本地演示 token 和订单幂等，但同样没有生产身份系统或分布式锁，不能直接暴露为生产服务。分页按插入顺序，每次写入全量保存 JSON。生产持久化可替换 Repository，接口和业务层不需要重新设计。

阅读：[架构与接口](docs/architecture.md) · [五节实践课](docs/learning-path.md)。旧源码可能仍存在 Git 历史中，教学版发布未改写旧 Git 历史。
