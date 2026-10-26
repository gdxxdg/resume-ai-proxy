# 开发者文档

面向要**修改代码、部署服务或排查问题**的人。普通使用者请回到 [README](../README.md)。

## 目录结构

```
resume-ai-proxy/
├── 简历填写主页面.html   前端（单文件，无构建步骤）
├── server.js            解析服务（零依赖，Node 18+）
├── start.bat            Windows 双击启动
├── package.json         启动配置
├── test.js              单元测试（56 项，零依赖）
├── .env.example         环境变量模板（复制为 .env 使用）
├── .gitignore           已排除 .env、配置导出与 PDF
├── preview/             界面预览截图
├── docs/                开发文档
└── README.md            使用者说明
```

## 技术说明

**前端**是一个约 3800 行的单文件 HTML，没有构建步骤，直接用浏览器打开。内部按 4 段内联
`<script>` 组织：

| 段 | 职责 |
|---|---|
| ① | 主逻辑：模板切换、照片裁剪、撤销栈、导出、A4 溢出防护 |
| ② | 本地规则解析引擎 `window.ResumeAIEngine`（离线兜底，能力有限） |
| ③ | 解析服务客户端 `window.ResumeAIService` |
| ④ | 智能填写面板与回填 `window.ResumeAIFill` |

段与段之间通过 `window.RW` 桥接（`snap` / `pushHistory` / `finalizeEdit` / `save` /
`initWiring` / `elText` / `updatePageGuard` / `fitToOnePage` / `TEMPLATES` / `sanitizeHTML`）。

**后端** `server.js` 只使用 Node 内置模块（`http`、`fs`、`path`），不引入任何 npm 依赖。
它负责三件事：转发请求到 DeepSeek、把模型输出经 `normalize()` 规整成固定结构、按 IP 限流。

## 接口

### `POST /api/parse`

请求：

```json
{ "text": "用户输入的自由文本", "model": "deepseek-v4-flash" }
```

> `model` 可省略。省略时由服务端按上游选择：官方 `api.deepseek.com` 用 `deepseek-v4-flash`，
> 自建 / 中转网关用 `deepseek-flash`。可用 `DEFAULT_MODEL` 覆盖。

成功：

```json
{
  "ok": true,
  "data": {
    "personal": { "name": "", "phone": "", "email": "", "gender": "", "age": "",
                  "nation": "", "hometown": "", "political": "", "gradYear": null },
    "intention": { "position": "", "city": "" },
    "edu": [], "work": [], "project": [],
    "skills": [], "awards": [], "unmatched": []
  },
  "usage": { "total_tokens": 1220 },
  "remaining": 28
}
```

失败（HTTP 状态码同时具有语义）：

```json
{ "error": "中文错误说明" }
```

### `GET /health`

返回服务状态、密钥是否配置、可用模型：

```json
{ "ok": true, "service": "resume-ai-proxy", "keyConfigured": true,
  "models": ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro"] }
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 绑定地址（只想本机访问填 `127.0.0.1`） |
| `DEEPSEEK_API_KEY` | 无 | 模型密钥，**必须配置**，否则 `/api/parse` 返回 500 |
| `DEEPSEEK_ENDPOINT` | `https://api.deepseek.com/chat/completions` | 上游地址，可换成兼容 OpenAI 协议的中转网关 |
| `DEFAULT_MODEL` | 随上游自动 | 请求未指定模型时使用：官方用 `deepseek-v4-flash`，网关用 `deepseek-flash` |
| `RATE_LIMIT_PER_HOUR` | `30` | 每 IP 每小时调用上限 |
| `MAX_TEXT_CHARS` | `8000` | 单次提交文本长度上限 |
| `UPSTREAM_TIMEOUT_MS` | `90000` | 上游超时时间 |

优先级：**真实环境变量 > `.env` 文件 > 内置默认值**。

`.env` 由 `server.js` 内的一个约 20 行的零依赖解析器读取（支持 `#` 注释、引号、
`export KEY=value` 写法），不依赖 dotenv。

## 测试

```bash
npm test
```

56 项断言，零依赖，覆盖字段别名映射、类型容错、日期归一化、JSON 提取、提示词合规性与默认模型自适应。
修改 `normalize()` 或提示词后建议跑一遍。

仓库里还带了一组基于 jsdom 与无头浏览器的回归脚本（回填语义、A4 溢出、个人简介、
快照稳定性、HTML 清洗），运行方式见这些脚本头部的注释。

## 结构适配层

模型输出不可信，所有响应都会经过 `normalize()` 规整后才返回：

- **字段别名映射**：`title|name|company|school|project`、`sub|position|role|major|degree`、
  `date|period|time|duration`、`notes|details|descriptions|highlights`
- **类型容错**：字符串自动包装为数组；单个对象包装为单元素数组；无效项过滤
- **日期归一化**：`2022年9月-2026年6月`、`2022/9~2026/6`、`2025.07至2025.09`
  统一为 `2022.09 - 2026.06`；进行中统一为 `2025.07 - 至今`

这意味着模型换版本、提示词微调，都不会冲击前端回填逻辑。

## 部署到公网

服务会监听 `PORT` 环境变量并绑定 `0.0.0.0`，任何支持 Node 的平台都能跑：

```bash
DEEPSEEK_API_KEY=sk-xxx PORT=3000 node server.js
```

建议用 `pm2` / `systemd` 守护进程，前面加一层 Nginx 反代并配置 HTTPS。

部署到 Vercel、Cloudflare Workers 等 Serverless 平台时，逻辑一致（转发请求 + 规整结构），
但需要把 `server.js` 改写成对应平台的函数签名，并把密钥配置为平台的 Secret 环境变量。

部署后，让前端指向你的地址：修改 HTML 里「解析服务客户端」脚本块开头的常量。

```js
var DEFAULT_ENDPOINT = 'https://你的服务域名';
```

也可以不改代码，用设置面板（连点标题 5 次 / `Ctrl+Shift+,`）在本地改，但那样只对当前浏览器生效。

## 维护者注意事项

这一节是给**维护这个仓库的人**看的，普通使用者可以跳过。

### 密钥

- 源码里**不允许出现任何 `sk-` 开头的字面量**。密钥只从环境变量 / `.env` 读取，
  `.env` 已被 `.gitignore` 排除。
- 提交前自查：

  ```bash
  grep -rn "sk-[A-Za-z0-9]\{20,\}" . --exclude-dir=node_modules
  git add -n .            # 清单里不能出现 .env
  ```

- 如果密钥曾经被提交过，**只删文件不够** —— 它会留在 git 历史里。必须到服务商后台吊销重发。

### 隐私

- 导出的 `简历配置_*.json` 含完整简历数据（含证件照），**不要提交**（已被 `.gitignore` 排除）。
- `*.pdf` 同理，默认为不提交。
- 接收他人的配置前请注意：导入流程已做 HTML 清洗（`sanitizeHTML()`），会过滤脚本标签、
  `on*` 事件属性与 `javascript:` 链接，保留 `contenteditable`、`data-ph` 与 base64 证件照。

### 其他

- **CORS 开放为 `*`**：因为前端可能是以 `file://` 方式打开。如果只服务域名下的用户，
  建议在 `setCors()` 里收紧来源白名单。
- **按 IP 限流**：默认 30 次/小时，降低服务地址外泄后额度被刷的风险。
  限流依据 `X-Forwarded-For` 首段，在未加可信代理的情况下可被伪造。
- `/api/parse` 目前**没有鉴权**。如果部署到公网且不希望陌生人使用，需要自行加大门（如
  Cloudflare Access、Nginx Basic Auth 或自建 token 校验）。
