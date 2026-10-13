# MovieBox API — Cloudflare Workers

Unofficial MovieBox scraper API. **Identical endpoints and response shapes** to [moviebox-api-node](https://github.com/DavidCyril1/moviebox-api-node).

## Deploy

```bash
npm install
npx wrangler deploy
```

Optional KV for token persistence across isolates:

```bash
npx wrangler kv:namespace create TOKEN_STORE
# paste the id into wrangler.toml under [[kv_namespaces]]
```

Optional secrets / vars:

| Variable | Purpose |
|----------|---------|
| `MB_TOKEN` | Force a fixed JWT (skips auto register) |
| `MB_MIRROR_BASE` | Info fallback host |
| `MB_GUEST_TIMEOUT_MS` | Max wait for email code (default 90000) |
| `MB_REQUEST_TIMEOUT_MS` | Upstream timeout (default 20000) |

```bash
npx wrangler secret put MB_TOKEN   # optional
```

## Local dev

```bash
npm run dev
# → http://127.0.0.1:8787
```

## Endpoints (same as Node)

| Method | Path |
|--------|------|
| GET | `/search?q=<keyword>&page=1&perPage=20` |
| GET | `/info/:subjectId?se=<season>` |
| GET | `/seasons/:subjectId` |
| GET | `/sources/:subjectId/:se/:ep` |
| GET | `/episodes/:subjectId/:se?page=1&perPage=50` |
| GET | `/trending?type=2` |
| GET | `/trending/community?postNum=3` |
| GET | `/recommend/daily?page=1&perPage=20` |
| GET | `/recommend/related/:subjectId?page=1&perPage=12` |
| GET | `/captions/stream/:subjectId/:streamId` |
| GET | `/captions/ext/:subjectId/:resourceId/:episode` |
| GET | `/dub/:subjectId` |
| GET | `/staff/:staffId` |
| GET | `/staff/:staffId/subjects?start=1&end=20` |
| GET | `/download/:subjectId/:se/check?resolution=480&eps=1,2,3` |
| GET | `/stream/:subjectId/:se/:ep?resolution=480` ← CDN-safe proxied MP4 (inline) |
| GET | `/dl/:subjectId/:se/:ep?resolution=480` ← CDN-safe proxied MP4 (download) |
| GET | `/pipe/:subjectId/:se/:ep?resolution=480` ← same proxy (compat) |

## Notes

- Auto guest registration via temp-mail (same providers as Node). Registration uses direct outbound only (no SOCKS proxies on Workers).
- Token can be persisted in KV (`TOKEN_STORE`) so it survives isolate recycling.
- Stream/download proxy streams the real MP4 body (Range supported).
- Requires `nodejs_compat` (already set in `wrangler.toml`) for HMAC-MD5 signing.
