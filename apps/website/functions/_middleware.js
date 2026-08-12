function isFujianRequest(request) {
  const cf = request.cf || {};
  if (cf.country !== 'CN') return false;
  const region = String(cf.region || '').trim().toLowerCase();
  const regionCode = String(cf.regionCode || '').trim().toLowerCase();
  if (!region && !regionCode) return false;
  return ['fujian', '福建', '福建省'].includes(region) || ['fj', 'cn-fj'].includes(regionCode);
}

function blockedPage() {
  return new Response('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>404</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111827;background:#f3f4f6}main{padding:40px;text-align:center}h1{font-size:22px}</style></head><body><main><h1>您访问的页面不存在</h1></main></body></html>', {
    status: 403,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

export async function onRequest(context) {
  if (isFujianRequest(context.request)) return blockedPage();
  return context.next();
}
