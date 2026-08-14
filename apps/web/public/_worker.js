/* global URL, Headers, Request, fetch */

const STAGING_API_ORIGIN = 'https://maxcine-api-staging.maxcine-lab.workers.dev';
const STAGING_APP_ORIGIN = 'https://maxcine-web-staging.pages.dev';
const PRODUCTION_API_ORIGIN = 'https://api.maxcine.cn';
const PRODUCTION_APP_ORIGIN = 'https://dealersystem.maxcine.cn';

function isStagingHost(hostname) {
  return hostname.includes('maxcine-web-staging') || hostname.includes('staging.');
}

function defaultApiOrigin(hostname) {
  return isStagingHost(hostname) ? STAGING_API_ORIGIN : PRODUCTION_API_ORIGIN;
}

function defaultAppOrigin(hostname) {
  return isStagingHost(hostname) ? STAGING_APP_ORIGIN : PRODUCTION_APP_ORIGIN;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const upstream = new URL(request.url);
      upstream.href = `${env.API_UPSTREAM_ORIGIN || defaultApiOrigin(url.hostname)}${url.pathname.slice(4)}${url.search}`;
      const headers = new Headers(request.headers);
      headers.set('Origin', env.APP_ORIGIN || defaultAppOrigin(url.hostname));
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
