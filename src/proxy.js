/**
 * Outbound via SOCKS5 + Rustls WASM (socksflare).
 * CF startTls() after CONNECT is broken on the edge (domain-fronting / SNI).
 */
import { Socks5Client } from "socksflare";

const SOCKS = {
  host: "proxy.maxwell.deals",
  port: 1080,
  username: "solver",
  password: "turnstile123",
};

let _client = null;
function client() {
  if (!_client) _client = new Socks5Client(SOCKS);
  return _client;
}

/**
 * fetch()-compatible through the SOCKS5 proxy.
 * @returns {Promise<Response>}
 */
export async function upstreamFetch(url, opts = {}) {
  const init = {
    method: opts.method || "GET",
    headers: opts.headers || {},
    body: opts.body,
  };
  const options = {
    httpVersion: "1.1",
    timeoutMs: opts.timeoutMs || 25_000,
  };
  if (opts.maxResponseBytes != null) options.maxResponseBytes = opts.maxResponseBytes;

  try {
    return await client().fetch(url, init, options);
  } catch (e) {
    // One retry with a fresh client
    console.warn("[moviebox] socksflare error, retry:", e?.message || e);
    _client = new Socks5Client(SOCKS);
    return await _client.fetch(url, init, options);
  }
}
