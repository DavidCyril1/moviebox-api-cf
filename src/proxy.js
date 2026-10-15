/**
 * Outbound via SOCKS5 + Rustls WASM (socksflare).
 * CF startTls() after CONNECT is broken on the edge.
 *
 * Strategy:
 *  1) socksflare with explicit SNI (tlsHostname)
 *  2) fresh Socks5Client retry
 *  3) native fetch fallback (some MovieBox edges still answer CF)
 */
import { Socks5Client } from "socksflare";

const SOCKS = {
  host: "proxy.maxwell.deals",
  port: 1080,
  username: "solver",
  password: "turnstile123",
};

let _client = null;

function freshClient() {
  _client = new Socks5Client({ ...SOCKS });
  return _client;
}

function client() {
  if (!_client) return freshClient();
  return _client;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * @returns {Promise<Response>}
 */
export async function upstreamFetch(url, opts = {}) {
  const init = {
    method: opts.method || "GET",
    headers: opts.headers || {},
    body: opts.body,
  };
  const tlsHostname = opts.tlsHostname || hostnameOf(url);
  const timeoutMs = opts.timeoutMs || 30_000;
  const options = {
    httpVersion: "1.1",
    timeoutMs,
    tlsHostname,
  };
  if (opts.maxResponseBytes != null) options.maxResponseBytes = opts.maxResponseBytes;

  const errors = [];

  // Attempt 1: existing / new socks client
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const c = attempt === 0 ? client() : freshClient();
      const res = await c.fetch(url, init, options);
      if (res && res.status > 0) return res;
      errors.push(`socks empty status attempt=${attempt}`);
    } catch (e) {
      const msg = e?.message || String(e);
      errors.push(`socks[${attempt}]: ${msg}`);
      console.warn("[moviebox] socksflare fail:", msg);
      _client = null;
    }
  }

  // Attempt 2: native fetch (CF egress) — works when MovieBox is not ASN-blocking this POP
  try {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort("timeout"), timeoutMs);
    try {
      const res = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
        redirect: "follow",
      });
      return res;
    } finally {
      clearTimeout(to);
    }
  } catch (e) {
    errors.push(`native: ${e?.message || e}`);
  }

  throw new Error(`upstreamFetch failed for ${hostnameOf(url) || url}: ${errors.join(" | ")}`);
}
