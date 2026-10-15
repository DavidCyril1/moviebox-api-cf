/**
 * Upstream fetch for MovieBox API.
 * Prefer native fetch (valid token + NG client-info works from CF egress).
 * SOCKS5/socksflare only as fallback — proxy exit is often 406/region-blocked.
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
  const timeoutMs = opts.timeoutMs || 30_000;
  const tlsHostname = opts.tlsHostname || hostnameOf(url);
  const errors = [];

  // 1) Native CF fetch first
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
      // Treat hard blocks as failure so we can try SOCKS
      if (res.status !== 403 && res.status !== 407) {
        return res;
      }
      const peek = await res.clone().text().catch(() => "");
      if (!/region|FORBIDDEN|not available/i.test(peek) && res.status !== 403) {
        return res;
      }
      errors.push(`native HTTP ${res.status}: ${peek.slice(0, 120)}`);
    } finally {
      clearTimeout(to);
    }
  } catch (e) {
    errors.push(`native: ${e?.message || e}`);
  }

  // 2) SOCKS5 + WASM TLS fallback
  const options = {
    httpVersion: "1.1",
    timeoutMs,
    tlsHostname,
  };
  if (opts.maxResponseBytes != null) options.maxResponseBytes = opts.maxResponseBytes;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const c = attempt === 0 ? (_client || freshClient()) : freshClient();
      return await c.fetch(url, init, options);
    } catch (e) {
      errors.push(`socks[${attempt}]: ${e?.message || e}`);
      _client = null;
    }
  }

  throw new Error(`upstreamFetch failed: ${errors.join(" | ")}`);
}
