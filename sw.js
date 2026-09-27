/* TinyChat Service Worker
 * 策略:同源 GET 静态资源 stale-while-revalidate;
 * HTML 页面 / API / SSE 流式 / /v1 出口一律直连,绝不缓存(登录态与流式响应不可缓存)。
 */
const CACHE = 'tinychat-static-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const p = url.pathname;
  // 接口与流式响应永不缓存
  if (p.indexOf('/api/') === 0 || p.indexOf('/v1/') === 0 || p.slice(-4) === '.php') return;
  // HTML 页面不缓存(登录态、版本更新需要即时生效)
  if (p === '/' || p.slice(-5) === '.html' || p === '/chat' || p === '/admin' || p === '/login' || p.indexOf('/s/') === 0 || p === '/agreement') return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      const net = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
