# Express + EJS + MySQL 示例

使用 Express 4、EJS、cookie-parser 与 Morgan 的 Node.js 服务示例。当前包含首页模板、用户示例路由及 MySQL 操作演示，适合作为阅读中间件、路由和数据库调用流程的基础工程。

## 结构与请求流程

| 路径 | 职责 |
|---|---|
| [bin/www](bin/www) | 创建 HTTP 服务、读取 PORT、处理监听错误 |
| [app.js](app.js) | 中间件、静态资源、路由挂载及错误页面 |
| [routes/index.js](routes/index.js) | 首页与启动时执行的数据库示例 |
| [routes/users.js](routes/users.js) | GET /users 示例响应 |
| `views/` | EJS页面与错误模板 |
| `public/` | 静态资源 |

请求依次经过日志、JSON/表单解析、Cookie和静态资源中间件，再进入路由；未匹配请求转为404并通过EJS错误页返回。当前错误响应并非统一JSON API格式。

## 启动前置条件

需要 Node.js、npm 与可访问的 MySQL 实例。工程未声明 Node engines，历史依赖兼容性需在实际环境确认。

**当前 `routes/index.js` 在模块加载时连接MySQL、插入示例记录并查询 `userlist`，不是收到首页请求后才执行。** 启动前应检查其中的数据库连接配置，准备独立测试数据库和表，避免重复启动向业务数据库写入数据。查询示例的错误处理也不完整，数据库异常可能阻止应用正常运行。

代码依赖的 `userlist` 字段包括 `username`、`password`、`country`；目录没有提供数据库迁移或完整建表脚本。文档不补写未经核实的生产表结构。

## 安装与运行

在项目目录执行：

```bash
npm ci
npm start
```

默认地址为 `http://localhost:3000`。覆盖端口示例：

```bash
PORT=3001 npm start
```

| 方法 | 路径 | 当前行为 |
|---|---|---|
| GET | `/` | 渲染首页EJS模板 |
| GET | `/users` | 返回固定示例文本 |
| GET | 未注册路径 | 返回404错误页面 |

## 接入与维护

业务扩展应把数据库初始化、请求处理和资源关闭分开维护，真实连接参数由宿主环境管理。当前依赖列表有MySQL驱动，但没有完整账户认证、数据库迁移或业务API测试框架。

`package.json` 只有 start 脚本，没有 build、lint 或 test 命令。可在独立测试数据库中人工检查首页、用户路由、404、端口和连接错误；本轮只做静态核对，未启动数据库或执行写操作。
