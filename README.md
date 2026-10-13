# MovieBox API — Cloudflare Workers

Unofficial MovieBox scraper API. Same endpoints/response shapes as [moviebox-api-node](https://github.com/DavidCyril1/moviebox-api-node).

## Why SOCKS5 + socksflare?

MovieBox blocks Cloudflare egress IPs. Workers' native `startTls()` after HTTP CONNECT is broken on the edge (SNI / domain-fronting). This build tunnels all MovieBox + CDN traffic through:

`socks5://solver:***@proxy.maxwell.deals:1080`

using [socksflare](https://www.npmjs.com/package/socksflare) (SOCKS5 + Rustls WASM TLS).

## Deploy

```bash
npm install
npx wrangler deploy
```

Optional:

```bash
npx wrangler secret put MB_TOKEN
```

## Local

```bash
npm run dev
```
