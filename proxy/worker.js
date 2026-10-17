/**
 * 英语学习助手 · AI 代理（Cloudflare Worker）
 *
 * 为什么要有这一层：
 *   前端是公开的静态站，把真实的上游 API Key 填进浏览器 = 任何能执行脚本的人/扩展都能读走，
 *   且密钥泄露无法感知、无法限制用途。这一层把真实密钥留在服务端环境变量里，
 *   浏览器只持有一个「可随时轮换、可限流、可单独撤销」的访问令牌。
 *
 * 环境变量（wrangler secret，不要写进代码）：
 *   UPSTREAM_BASE   上游接口根地址，如 https://api.openai.com/v1
 *   UPSTREAM_KEY    上游真实密钥（sk-...）
 *   APP_TOKEN       浏览器侧使用的访问令牌（自己生成一个长随机串）
 *   UPSTREAM_MODEL  可选，客户端未指定模型时兜底
 *   ALLOW_ORIGIN    可选，如 https://ljjjc123.github.io；不填则回显请求来源
 *   DAILY_LIMIT     可选，默认 200；单令牌每日请求上限（尽力而为，按 isolate 计数）
 *
 * 前端填法：接口地址 = https://<你的 worker 域名>/v1 ，API Key = APP_TOKEN ，模型名照旧。
 */
const DAILY_LIMIT_DEFAULT = 200;

function withCORS(res, origin) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', origin || '*');
  h.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  h.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  h.set('Access-Control-Max-Age', '86400');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
const json = (obj, status) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

/** 按 isolate 尽力计数：够挡住误用与脚本刷量，跨机房精确限流请接 KV / Durable Object */
let day = '', used = 0;
function takeQuota(limit) {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== day) { day = d; used = 0; }
  if (used >= limit) return false;
  used++;
  return true;
}

export default {
  async fetch(request, env) {
    const origin = env.ALLOW_ORIGIN || request.headers.get('Origin') || '*';

    if (request.method === 'OPTIONS') return withCORS(new Response(null, { status: 204 }), origin);

    const url = new URL(request.url);
    // 只暴露这一个端点：即便令牌泄露，攻击面也只是一条 chat/completions
    if (request.method !== 'POST' || !/\/chat\/completions$/.test(url.pathname)) {
      return withCORS(json({ error: 'not found' }, 404), origin);
    }

    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!env.APP_TOKEN || token !== env.APP_TOKEN) {
      return withCORS(json({ error: 'unauthorized' }, 401), origin);
    }
    if (!env.UPSTREAM_BASE || !env.UPSTREAM_KEY) {
      return withCORS(json({ error: 'proxy not configured' }, 500), origin);
    }

    const limit = parseInt(env.DAILY_LIMIT || '', 10) || DAILY_LIMIT_DEFAULT;
    if (!takeQuota(limit)) {
      return withCORS(json({ error: 'daily quota exceeded' }, 429), origin);
    }

    let payload;
    try { payload = await request.json(); }
    catch { return withCORS(json({ error: 'invalid json' }, 400), origin); }

    // 白名单转发：不把客户端塞进来的任意字段透传给上游
    const body = {
      model: payload.model || env.UPSTREAM_MODEL || '',
      messages: Array.isArray(payload.messages) ? payload.messages : [],
      temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.6,
      stream: false
    };
    if (payload.response_format && payload.response_format.type === 'json_object') {
      body.response_format = { type: 'json_object' };
    }
    if (!body.model || !body.messages.length) {
      return withCORS(json({ error: 'model / messages required' }, 400), origin);
    }

    const upstream = env.UPSTREAM_BASE.replace(/\/+$/, '') + '/chat/completions';
    let r;
    try {
      r = await fetch(upstream, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.UPSTREAM_KEY },
        body: JSON.stringify(body)
      });
    } catch (e) {
      // 只回错误类别，不回上游地址与内部细节
      return withCORS(json({ error: 'upstream unreachable' }, 502), origin);
    }

    const text = await r.text();
    return withCORS(
      new Response(text, { status: r.status, headers: { 'Content-Type': 'application/json; charset=utf-8' } }),
      origin
    );
  }
};
