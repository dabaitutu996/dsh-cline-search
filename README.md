# dsh-cline-search

**简体中文** | [English](./README.en.md)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）提供 **Cline Pass** 网页搜索后端。

装好之后，dsh 原生的 `web_search` 工具就能用你的 Cline Pass 订阅 key 工作，**走订阅额度，而不是 Cline Credits（按量付费）**。

## 要解决的问题

dsh 自带 `@deepseek-ai/dsh-web-search-deepseek`，它说的是 **Anthropic Messages** 协议：

```
POST {baseURL}/messages     + 工具类型: web_search_20250305
```

而 Cline Pass 网关只提供 **OpenAI 兼容**的 `POST {baseURL}/chat/completions`。把自带 provider 指向 Cline Pass 会直接返回 **404**（该路由不存在），所以 `web_search` 完全用不了。

> 注意：这不是"地址填错"，而是**两家协议不同**。自带 provider 的协议是写死在代码里的，改配置改不了。

## 本插件做了什么

它在 dsh 的 web 接缝（seam）上注册**第二个 provider**，用网关自己的协议通信，并把结果映射回接缝的标准结构：

```
ctx.web.registerSearchProvider({ id: 'cline-pass', available, search })
```

说白了就是加了一个**协议翻译层**。装好后你感觉不到它的存在，用起来和自带的一模一样。

## 处理了三个网关特性

以下三点都是**实测线上接口得出**（并非来自官方文档），踩过才知道：

### 1. 必须用订阅模型 id

模型必须取自网关推荐模型目录里的 `cline-pass/*` 命名空间。
像 `deepseek/deepseek-v4.1-flash` 这样的上游 id 会按 **Cline Credits 计费**，订阅制账号会报 `insufficient_credits`（余额不足）。

```
GET https://api.cline.bot/api/v1/ai/cline/recommended-models
```

### 2. 搜索工具类型是供应商专属的

网关会转发给 **Vercel**，而 Vercel 不认裸的 `{"type":"web_search"}`：

```json
{
  "error": {
    "message": "Invalid discriminator value. Expected 'function' | 'custom' | 'vercel:browserbase_search' | 'vercel:exa_search' | 'vercel:parallel_search' | 'vercel:perplexity_search' | 'vercel:tako_search'",
    "param": "tools.0.type"
  }
}
```

本插件依次尝试 `vercel:exa_search` → `vercel:parallel_search` → `web_search`。

### 3. 来源是以正文形式返回的

与 Anthropic 路由不同，这条路由**不返回**结构化的 `url_citation` 注解。
因此插件会让模型在回答结尾输出一个可机器解析的 `SOURCES:` 区块并解析它；
同时兜底扫描正文里的所有 URL —— 这样即使模型没按格式输出，也不会变成"零来源"。

```
SOURCES:
- https://github.com/deepseek-ai/deepseek-harness | DeepSeek Harness: Everything is a Plugin.
- https://www.deepseek.com/harness/en/ | DeepSeek Harness developer preview
```

## 性能说明

搜索是**一次完整的模型调用，同时包含检索过程**，因此约需 **8–25 秒**，并会消耗模型 token —— 它不是廉价的元数据查询。

模型选择很重要：在作者账号上 `cline-pass/deepseek-v4.1-flash` 工作良好，而其他若干订阅模型目前上游会返回 HTTP 500。

## 环境要求

- dsh（DeepSeek Harness）
- `CLINE_PASS_API_KEY` 凭据中存放的 Cline Pass API key

## 安装

本插件**零依赖** —— 不 import 任何 `@deepseek-ai/*`，一切都通过 `ctx` 获取。
这是刻意的：profile 插件的 peer 依赖**无法从自身位置解析**，所以零依赖是唯一能可靠加载的形态。

**1.** 把包拷进 profile 的 `node_modules`：

```sh
cp -r dsh-cline-search "$DSH_HOME/profiles/web/node_modules/"
```

**2.** 在 `$DSH_HOME/profiles/web/package.json` 的 bundle 列表中加入它：

```json
{
  "dependencies": { "dsh-cline-search": "0.1.0" },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-cline-search"
      ]
    }
  }
}
```

**3.** 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中选中它：

```yaml
- id: web
  config:
    searchProvider: cline-pass
    fetchProvider: http
```

**4.** 重启 dsh。bundle 与选择只在启动时读取一次。

> 提示：`web_fetch` 与 `web_search` 是两个独立问题。
> 如果你的系统把域名解析到保留地址（例如 Clash 的 fake-ip 模式返回 `198.18.x.x`），
> `web_fetch` 会因为 SSRF 防护拒绝抓取而报错。
> 解法是在 `$DSH_HOME/.env`（注意是 home 层，项目目录的 `.env` 会被拒绝）中设置代理：

```sh
HTTPS_PROXY=http://127.0.0.1:7897
HTTP_PROXY=http://127.0.0.1:7897
NO_PROXY=api.cline.bot
```

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: cline-search
  config:
    apiKeyEnv: CLINE_PASS_API_KEY
    baseURL: https://api.cline.bot/api/v1
    models:
      - cline-pass/deepseek-v4.1-flash
    maxTokens: 2500
    timeoutMs: 150000
```

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `apiKeyEnv` | `CLINE_PASS_API_KEY` | 凭据引用名，每次搜索时解析 |
| `baseURL` | `https://api.cline.bot/api/v1` | 网关地址 |
| `models` | `[cline-pass/deepseek-v4.1-flash]` | 订阅模型 id 列表，按顺序尝试 |
| `model` | — | 单模型简写；其余默认值跟随其后 |
| `maxTokens` | `2500` | 回答预算；太小会截断 `SOURCES:` 区块 |
| `timeoutMs` | `150000` | 单次请求超时 |

API key **绝不**写入配置。它每次搜索都通过 dsh 凭据接缝实时解析，因此**轮换 key 无需改动任何配置**。

## 卸载

从 `package.json` 移除该 bundle；或仅删掉 `cordis.patch.yml` 里的 `- id: web` 覆盖段，即可回退到自带 provider。

## 兼容性

在 dsh 的 `web` profile 上构建并验证。它只注册到 web 接缝（`inject: ['web']`），不触碰其他服务。

## 许可证

MIT
