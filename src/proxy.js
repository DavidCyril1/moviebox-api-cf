/**
 * Dual-path upstream: native CF + SOCKS5 (socksflare).
 * MovieBox often returns HTTP 440 ServiceNotAvailable on CF IPs —
 * those must fall through to SOCKS, not be treated as success.
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

/** True if MovieBox is soft-blocking this edge/IP. */
export function isBlockedPayload(status, text) {
  if (status === 403 || status === 407 || status === 440 || status === 441) return true;
  if (!text) return false;
  return /ServiceNotAvailable|not available in current region|FORBIDDEN|find no content|wasmTls/i.test(
    text
  );
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
  const preferSocks = Boolean(opts.preferSocks);
  const errors = [];

  async function tryNative() {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort("timeout"), timeoutMs);
    try {
      return await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
        redirect: "follow",
      });
    } finally {
      clearTimeout(to);
    }
  }

  async function trySocks() {
    const options = {
      httpVersion: "1.1",
      timeoutMs,
      tlsHostname,
    };
    if (opts.maxResponseBytes != null) options.maxResponseBytes = opts.maxResponseBytes;
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const c = attempt === 0 ? _client || freshClient() : freshClient();
        return await c.fetch(url, init, options);
      } catch (e) {
        last = e;
        _client = null;
        errors.push(`socks[${attempt}]: ${e?.message || e}`);
      }
    }
    throw last || new Error("socks failed");
  }

  const order = preferSocks ? ["socks", "native"] : ["native", "socks"];
  let lastRes = null;
  let lastText = "";

  for (const path of order) {
    try {
      const res = path === "native" ? await tryNative() : await trySocks();
      const text = await res.text();
      // Rebuild Response so callers can still .text()
      const rebuilt = new Response(text, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
      if (!isBlockedPayload(res.status, text)) {
        return rebuilt;
      }
      lastRes = rebuilt;
      lastText = text;
      errors.push(`${path} blocked HTTP ${res.status}: ${text.slice(0, 100)}`);
    } catch (e) {
      errors.push(`${path}: ${e?.message || e}`);
    }
  }

  if (lastRes) return lastRes;
  throw new Error(`upstreamFetch failed: ${errors.join(" | ")}`);
}
