# AI 代理：让真实密钥不再进浏览器

`index.html` 是公开静态站。把上游 API Key 直接填进页面的「AI 设置」，等于把密钥交给浏览器里任何可执行脚本（注入、恶意扩展、共享电脑），且泄露后无法感知、无法限制用途、只能整体作废。

`worker.js` 是一层薄代理：真实密钥留在服务端，浏览器只持有一个可轮换、可限流、可单独撤销的访问令牌。

## 部署（Cloudflare Workers，免费额度足够个人用）

```bash
cd proxy
npm i -g wrangler          # 已装可跳过
wrangler login
wrangler init --no-git     # 若本目录还没有 wrangler.toml；已有则跳过

# 写入密钥（会存到 Cloudflare，不进代码库）
wrangler secret put UPSTREAM_BASE   # 例如 https://api.openai.com/v1
wrangler secret put UPSTREAM_KEY    # 上游真实密钥 sk-...
wrangler secret put APP_TOKEN       # 自己生成一个：openssl rand -hex 32

wrangler deploy
```

`wrangler.toml` 最小可用配置：

```toml
name = "english-study-ai-proxy"
main = "worker.js"
compatibility_date = "2026-10-17"

[vars]
UPSTREAM_MODEL = "gpt-4o-mini"
ALLOW_ORIGIN = "https://ljjjc123.github.io"
DAILY_LIMIT = "200"
```

## 前端怎么填

| 设置项 | 填什么 |
|---|---|
| 接口地址 | `https://<你的 worker 域名>/v1` |
| API Key | 上面生成的 `APP_TOKEN` |
| 模型名 | 照旧（`gpt-4o-mini` 等）；留空则用 `UPSTREAM_MODEL` |

页面其余逻辑不用改——它本来就是按 OpenAI 兼容的 `/chat/completions` 协议调用的。

## 这一层额外做了什么

- **只暴露一个端点**：非 `POST /chat/completions` 一律 404，令牌泄露的攻击面也只有一条。
- **字段白名单转发**：客户端塞进来的多余字段不透传给上游。
- **日均限流**：默认 200 次/天，脚本刷量会撞 429（按 isolate 计数，跨机房精确限流可接 KV）。
- **错误不回显内部细节**：上游地址、原始报文不外泄。
- **CORS 可收紧**：设 `ALLOW_ORIGIN` 后只认你的站点来源。

## 还没做的（别当成已解决）

- 限流是单 isolate 内存计数，Worker 冷启动或多机房会重置；要硬配额请上 KV / Durable Object。
- 没有按用户身份区分，令牌是一把钥匙；多人共用请各自部署或加一层登录。
- 代理仍能看到完整对话内容——它只是把风险从"任何人都能拿到你的钱"收敛成"你自己的服务端能看到"，不是端到端加密。
