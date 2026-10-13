/**
 * Outbound proxy via cloudflare:sockets
 * MovieBox blocks Cloudflare egress IPs — route API + CDN through
 * proxy.maxwell.deals (HTTP CONNECT or SOCKS5), picked at random.
 */
import { connect } from "cloudflare:sockets";

const PROXIES = [
  {
    kind: "http",
    host: "proxy.maxwell.deals",
    port: 3128,
    user: "solver",
    pass: "turnstile123",
  },
  {
    kind: "socks5",
    host: "proxy.maxwell.deals",
    port: 1080,
    user: "solver",
    pass: "turnstile123",
  },
];

function pickProxy() {
  return PROXIES[Math.floor(Math.random() * PROXIES.length)];
}

function b64(s) {
  return btoa(s);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Read until CRLFCRLF from a reader, return { head: string, rest: Uint8Array } */
async function readUntilDoubleCrlf(reader) {
  const chunks = [];
  let total = 0;
  const max = 64 * 1024;
  const marker = enc.encode("\r\n\r\n");
  while (total < max) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    const buf = concat(chunks);
    const off = indexOf(buf, marker);
    if (off >= 0) {
      const headBytes = buf.slice(0, off);
      const rest = buf.slice(off + marker.length);
      return { head: dec.decode(headBytes), rest };
    }
  }
  throw new Error("proxy: timeout reading headers");
}

function concat(chunks) {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function indexOf(hay, needle) {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

async function socks5Handshake(socket, targetHost, targetPort, user, pass) {
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();

  // greeting: ver=5, nmethods=1, method=2 (username/password)
  await writer.write(new Uint8Array([0x05, 0x01, 0x02]));
  const g1 = await reader.read();
  if (!g1.value || g1.value[0] !== 0x05 || g1.value[1] !== 0x02) {
    writer.releaseLock();
    reader.releaseLock();
    throw new Error("socks5: auth method rejected");
  }

  // username/password auth (RFC 1929)
  const uBytes = enc.encode(user);
  const pBytes = enc.encode(pass);
  const auth = new Uint8Array(3 + uBytes.length + pBytes.length);
  auth[0] = 0x01;
  auth[1] = uBytes.length;
  auth.set(uBytes, 2);
  auth[2 + uBytes.length] = pBytes.length;
  auth.set(pBytes, 3 + uBytes.length);
  await writer.write(auth);
  const g2 = await reader.read();
  if (!g2.value || g2.value[1] !== 0x00) {
    writer.releaseLock();
    reader.releaseLock();
    throw new Error("socks5: auth failed");
  }

  // CONNECT request
  const hostBytes = enc.encode(targetHost);
  const req = new Uint8Array(4 + 1 + hostBytes.length + 2);
  req[0] = 0x05; // ver
  req[1] = 0x01; // CONNECT
  req[2] = 0x00; // rsv
  req[3] = 0x03; // domain
  req[4] = hostBytes.length;
  req.set(hostBytes, 5);
  req[5 + hostBytes.length] = (targetPort >> 8) & 0xff;
  req[6 + hostBytes.length] = targetPort & 0xff;
  await writer.write(req);

  // response: ver, rep, rsv, atyp, addr..., port
  async function readExact(n) {
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const { value, done } = await reader.read();
      if (done) throw new Error("socks5: unexpected EOF");
      const take = Math.min(value.length, n - off);
      out.set(value.subarray(0, take), off);
      off += take;
      if (take < value.length) {
        // put back leftover — not supported; rare for small reads
      }
    }
    return out;
  }
  const hdr = await readExact(4);
  if (hdr[0] !== 0x05 || hdr[1] !== 0x00) {
    writer.releaseLock();
    reader.releaseLock();
    throw new Error(`socks5: connect failed status=${hdr[1]}`);
  }
  const atyp = hdr[3];
  if (atyp === 0x01) await readExact(4 + 2); // IPv4 + port
  else if (atyp === 0x03) {
    const len = await readExact(1);
    await readExact(len[0] + 2);
  } else if (atyp === 0x04) await readExact(16 + 2); // IPv6 + port
  else {
    writer.releaseLock();
    reader.releaseLock();
    throw new Error(`socks5: unknown atyp ${atyp}`);
  }

  writer.releaseLock();
  reader.releaseLock();
  return socket;
}

async function httpConnectHandshake(socket, targetHost, targetPort, user, pass) {
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();

  const auth = b64(`${user}:${pass}`);
  const req =
    `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
    `Host: ${targetHost}:${targetPort}\r\n` +
    `Proxy-Authorization: Basic ${auth}\r\n` +
    `Proxy-Connection: Keep-Alive\r\n` +
    `\r\n`;
  await writer.write(enc.encode(req));

  const { head } = await readUntilDoubleCrlf(reader);
  writer.releaseLock();
  reader.releaseLock();

  const statusLine = head.split("\r\n")[0] || "";
  if (!/ 200 /.test(statusLine)) {
    throw new Error(`http-proxy CONNECT failed: ${statusLine}`);
  }
  return socket;
}

/**
 * Open a TLS tunnel to hostname:port through a random proxy.
 * Returns { readable, writable } of the TLS socket.
 */
async function openTunneledTls(hostname, port) {
  const proxy = pickProxy();
  const raw = connect({
    hostname: proxy.host,
    port: proxy.port,
    secureTransport: "starttls",
  });

  if (proxy.kind === "socks5") {
    await socks5Handshake(raw, hostname, port, proxy.user, proxy.pass);
  } else {
    await httpConnectHandshake(raw, hostname, port, proxy.user, proxy.pass);
  }

  const tls = raw.startTls({ expectedServerHostname: hostname });
  return { socket: tls, proxy };
}

/**
 * Fetch a URL through a random proxy (HTTP CONNECT or SOCKS5).
 * Supports method, headers, body. Returns { statusCode, headers: Headers, body: ReadableStream|null, text: async () => string }
 */
export async function proxyFetch(url, opts = {}) {
  const u = new URL(url);
  if (u.protocol !== "https:") {
    // plain HTTP via proxy is rare for us — fall through to direct
    return directFetch(url, opts);
  }

  const port = u.port ? Number(u.port) : 443;
  let tunnel;
  try {
    tunnel = await openTunneledTls(u.hostname, port);
  } catch (e) {
    console.warn("[moviebox] proxy tunnel failed, trying direct:", e?.message || e);
    return directFetch(url, opts);
  }

  const { socket } = tunnel;
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();

  const method = (opts.method || "GET").toUpperCase();
  const path = u.pathname + u.search;
  const hdrs = { ...(opts.headers || {}) };
  if (!hdrs["host"] && !hdrs["Host"]) hdrs["Host"] = u.hostname;
  if (!hdrs["connection"] && !hdrs["Connection"]) hdrs["Connection"] = "close";
  if (opts.body && !hdrs["content-length"] && !hdrs["Content-Length"]) {
    const bodyBytes =
      typeof opts.body === "string" ? enc.encode(opts.body) : opts.body;
    hdrs["Content-Length"] = String(bodyBytes.length);
  }

  let req =
    `${method} ${path} HTTP/1.1\r\n` +
    Object.entries(hdrs)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n") +
    `\r\n\r\n`;

  await writer.write(enc.encode(req));
  if (opts.body) {
    const bodyBytes =
      typeof opts.body === "string" ? enc.encode(opts.body) : opts.body;
    await writer.write(bodyBytes);
  }
  writer.releaseLock();

  const { head, rest } = await readUntilDoubleCrlf(reader);
  const lines = head.split("\r\n");
  const statusLine = lines[0] || "";
  const m = statusLine.match(/HTTP\/[\d.]+ (\d+)/);
  const statusCode = m ? Number(m[1]) : 502;

  const headers = new Headers();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
  }

  // Build body stream: rest + remaining reader
  const bodyStream = new ReadableStream({
    async start(controller) {
      try {
        if (rest && rest.length) controller.enqueue(rest);
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.length) controller.enqueue(value);
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* */
        }
      }
    },
    cancel() {
      try {
        reader.cancel();
      } catch {
        /* */
      }
    },
  });

  return {
    statusCode,
    headers,
    body: bodyStream,
    async text() {
      const chunks = [];
      const r = bodyStream.getReader();
      while (true) {
        const { value, done } = await r.read();
        if (done) break;
        chunks.push(value);
      }
      return dec.decode(concat(chunks));
    },
  };
}

async function directFetch(url, opts = {}) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), opts.timeoutMs || 20_000);
  try {
    const res = await fetch(url, {
      method: opts.method || "GET",
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal,
      redirect: opts.redirect || "follow",
    });
    return {
      statusCode: res.status,
      headers: res.headers,
      body: res.body,
      async text() {
        return res.text();
      },
    };
  } finally {
    clearTimeout(to);
  }
}

/** Convenience: always try proxy first (MovieBox blocks CF). */
export async function upstreamFetch(url, opts = {}) {
  try {
    return await proxyFetch(url, opts);
  } catch (e) {
    console.warn("[moviebox] proxyFetch error, direct fallback:", e?.message || e);
    return directFetch(url, opts);
  }
}
