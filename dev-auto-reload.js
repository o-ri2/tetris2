/**
 * 로컬 HTTP로 열었을 때만(index.html / main.js / style.css 변경 감지 → 전체 리로드)
 * file:// 로 직접 열면 동작하지 않습니다. python3 -m http.server 5500 또는 npm run dev
 */
(function () {
  if (location.protocol === 'file:') return;
  const h = location.hostname;
  if (h !== 'localhost' && h !== '127.0.0.1' && h !== '[::1]' && h !== '::1') return;

  const files = [
    'index.html',
    'index-v2.html',
    'index-v2-spec.html',
    'main.js',
    'style.css',
    'arcade-v2.css',
    'construction-spec-v2.css'
  ];
  const prev = Object.create(null);

  async function tick() {
    try {
      for (const name of files) {
        const url = new URL(name, location.href);
        url.searchParams.set('_', String(Date.now()));
        const res = await fetch(url, { cache: 'no-store', method: 'GET' });
        const lm = res.headers.get('Last-Modified');
        if (!lm) continue;
        if (prev[name] != null && prev[name] !== lm) {
          location.reload();
          return;
        }
        prev[name] = lm;
      }
    } catch (_) {
      /* 오프라인·CORS 등 무시 */
    }
  }

  setInterval(tick, 700);
  tick();
})();
