/* ============================================================
   Service Worker — يخزّن ملفات التطبيق مؤقتاً ليعمل بدون إنترنت
   ويجعل التطبيق قابلاً للتثبيت (PWA). يعمل فقط عند فتح الموقع
   عبر http/https (سيرفر محلي أو استضافة)، ولا يعمل مع file:// —
   وهذا قيد من المتصفح نفسه وليس خللاً في الكود.
   ============================================================ */

const CACHE_NAME = "shamcash-exchange-cache-v3";
const CORE_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

/* استراتيجية: أعطِ النسخة المخزّنة فوراً (سرعة + عمل أوفلاين)،
   وفي الخلفية حاول تحديثها من الشبكة إن وُجد اتصال. لا تتدخل في
   طلبات api.telegram.org إطلاقاً — تلك يجب أن تصل الشبكة دائماً. */
self.addEventListener("fetch", (event) => {
  const url = event.request.url;
  if (url.includes("api.telegram.org")) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
