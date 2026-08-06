const DEFAULT_API_ORIGIN = 'https://maxcine-api-staging.maxcine-lab.workers.dev';
const DEFAULT_APP_ORIGIN = 'https://maxcine-web-staging.pages.dev';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const upstream = new URL(request.url);
      upstream.href = `${env.API_UPSTREAM_ORIGIN || DEFAULT_API_ORIGIN}${url.pathname.slice(4)}${url.search}`;
      const headers = new Headers(request.headers);
      headers.set('Origin', env.APP_ORIGIN || DEFAULT_APP_ORIGIN);
      return fetch(new Request(upstream, {
        method: request.method,
        headers,
        body: request.body,
        redirect: 'manual'
      }));
    }
    return env.ASSETS.fetch(request);
  }
};
