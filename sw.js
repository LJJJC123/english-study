/* 英语学习助手 · Service Worker
   为什么加它：manifest 早就声明了 PWA，但没有 SW 时装到桌面后离线就是白屏。
   单文件应用，缓存外壳（页面 + 图标 + 插画）即可离线运行。

   策略 = 同源 GET「stale-while-revalidate」：
     先回缓存保证秒开与离线可用，后台再拉新并写回缓存（下次刷新生效）。
     跨域请求（AI 接口等）与非 GET 一律直发网络，不拦截。

   发版注意：改完 index.html 后把下面的 CACHE 版本号 +1，
   否则老用户会一直命中旧缓存，看不到新版。 */
const CACHE = 'es-shell-v3';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg', './icon-maskable.svg',
  './icon-180.png', './icon-192.png', './icon-512.png', './icon-maskable-512.png',
  './art-book.png', './art-ielts.png', './art-practice.png', './art-vocab.png', './art-wrong.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          return k === CACHE ? undefined : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                       // AI 调用是 POST，直发
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // 跨域（AI 网关）直发，不进缓存
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        // 只缓存同源正常响应；opaque / 错误页不进缓存
        if (res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });              // 离线时退回缓存
      return hit || net;
    })
  );
});
