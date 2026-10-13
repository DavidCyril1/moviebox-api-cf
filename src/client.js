/**
 * MovieBox API client — Cloudflare Workers port
 * Wraps https://api6.aoneroom.com/wefeed-mobile-bff/
 * Env: MB_TOKEN, MB_MIRROR_BASE, MB_GUEST_TIMEOUT_MS, MB_REQUEST_TIMEOUT_MS
 * Optional KV binding: TOKEN_STORE
 *
 * Token strategy (fail-soft, same as Node):
 *  1) in-memory cache
 *  2) MB_TOKEN env
 *  3) KV cache (if TOKEN_STORE bound)
 *  4) baked FALLBACK_TOKEN while still valid
 *  5) guest registration via temp-mail — short timeout, never blocks forever
 */
import { sign } from "./sign.js";
import { randomBytes } from "node:crypto";

const BASE = "https://api6.aoneroom.com";

function getEnv(key, fallback = undefined) {
  // Prefer request-scoped env (set on app.env by index.js)
  const e = globalThis.__MB_ENV__ || {};
  if (e[key] !== undefined && e[key] !== "") return e[key];
  if (typeof process !== "undefined" && process.env?.[key]) return process.env[key];
  return fallback;
}

function mirrorBase() {
  return (getEnv("MB_MIRROR_BASE") || "https://moviebox.davidcyril.name.ng").replace(/\/$/, "");
}

const HOST_PARAM = `host=${encodeURIComponent(BASE)}`;

const CLIENT_BUILD =
  "1786863422670304777.c58dd77ad46d7d89b4605211013d392f" +
  "-1786863190149921915.2f932bfba072c98c72572c2ecde2b365";

const CLIENT_INFO = JSON.stringify({
  package_name: "com.community.oneroom",
  version_name: "4.0.02.0831.03",
  version_code: 50020126,
  os: "android",
  os_version: "14",
  install_ch: "google-play",
  device_id: "2634a18e740b105fa3d032f2a0f9a568",
  install_store: "gp",
  gaid: "ca11ecdb-21cc-47a2-9822-19f894c22da5",
  brand: "Redmi",
  model: "23106RN0DA",
  system_language: "en",
  net: "NETWORK_3G",
  region: "NG",
  timezone: "Africa/Lagos",
  sp_code: "62120",
  "X-Child-UID": "",
  "X-Client-Build": CLIENT_BUILD,
  "X-Play-Mode": "2",
  "X-Idle-Data": "1",
  "X-Family-Mode": "0",
  "X-Content-Mode": "0",
});

const FALLBACK_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
  ".eyJ1aWQiOjkxMTAyODI4OTUyNzIzMzgzOTIsInV0cCI6MSwiZXhwIjoxNzk2MDcxNTgwLCJpYXQiOjE3ODgyOTUyODB9" +
  ".l4MFha-s4DfMUOEQqPUGKZ_1NqfgI7NewaGJ0Saruik";

function requestTimeoutMs() {
  return Number(getEnv("MB_REQUEST_TIMEOUT_MS") || 20_000);
}
function guestTimeoutMs() {
  return Number(getEnv("MB_GUEST_TIMEOUT_MS") || 90_000);
}

let _cachedToken = null;
let _cachedClientInfo = null;
let _guestTokenInflight = null;
let _lastGuestFailAt = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jwtExpMs(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8")
    );
    return (payload.exp || 0) * 1000;
  } catch {
    try {
      const payload = JSON.parse(
        Buffer.from(token.split(".")[1], "base64").toString("utf8")
      );
      return (payload.exp || 0) * 1000;
    } catch {
      return 0;
    }
  }
}

function isTokenUsable(token) {
  if (!token || typeof token !== "string") return false;
  const exp = jwtExpMs(token);
  return !exp || exp - Date.now() > 3_600_000;
}

async function loadKvToken() {
  try {
    const kv = globalThis.__MB_ENV__?.TOKEN_STORE;
    if (!kv) return null;
    const raw = await kv.get("mb_token", "json");
    if (raw?.token && isTokenUsable(raw.token)) {
      return { token: raw.token, clientInfo: raw.clientInfo || null };
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function saveKvToken(token, clientInfo = null) {
  try {
    const kv = globalThis.__MB_ENV__?.TOKEN_STORE;
    if (!kv) return;
    await kv.put(
      "mb_token",
      JSON.stringify({ token, clientInfo, savedAt: Date.now() }),
      { expirationTtl: 60 * 60 * 24 * 80 } // ~80 days
    );
  } catch (e) {
    console.warn("[moviebox] could not persist token to KV:", e?.message || e);
  }
}

function pickStaticTokenSync() {
  const envTok = getEnv("MB_TOKEN");
  if (envTok && isTokenUsable(envTok)) {
    return { token: envTok, clientInfo: getEnv("MB_CLIENT_INFO") || null };
  }
  if (isTokenUsable(FALLBACK_TOKEN)) return { token: FALLBACK_TOKEN, clientInfo: null };
  if (envTok) return { token: envTok, clientInfo: null };
  return { token: FALLBACK_TOKEN, clientInfo: null };
}

async function resolveToken() {
  if (_cachedToken && isTokenUsable(_cachedToken)) return _cachedToken;
  const kv = await loadKvToken();
  if (kv) {
    _cachedToken = kv.token;
    if (kv.clientInfo) _cachedClientInfo = kv.clientInfo;
    return _cachedToken;
  }
  const staticTok = pickStaticTokenSync();
  _cachedToken = staticTok.token;
  if (staticTok.clientInfo) _cachedClientInfo = staticTok.clientInfo;
  return _cachedToken;
}

function rememberToken(token, clientInfo = null) {
  if (!token) return;
  _cachedToken = token;
  if (clientInfo) _cachedClientInfo = clientInfo;
  // fire-and-forget KV write
  saveKvToken(token, _cachedClientInfo);
}

function activeClientInfo() {
  return _cachedClientInfo || CLIENT_INFO;
}

/** Public entry — may refresh guest; never hangs > guestTimeoutMs */
export async function getGuestToken() {
  if (_guestTokenInflight) return _guestTokenInflight;

  if (Date.now() - _lastGuestFailAt < 60_000 && _cachedToken) {
    return _cachedToken;
  }

  _guestTokenInflight = (async () => {
    try {
      const result = await Promise.race([
        _registerGuestAccount(),
        sleep(guestTimeoutMs()).then(() => {
          throw new Error("getGuestToken: timed out waiting for verification email");
        }),
      ]);
      const token = typeof result === "string" ? result : result.token;
      const clientInfo = typeof result === "string" ? null : result.clientInfo;
      rememberToken(token, clientInfo);
      return token;
    } catch (e) {
      _lastGuestFailAt = Date.now();
      console.error("[moviebox] getGuestToken failed:", e?.message || e);
      const fallback = pickStaticTokenSync();
      if (fallback?.token) {
        _cachedToken = fallback.token;
        if (fallback.clientInfo) _cachedClientInfo = fallback.clientInfo;
        return fallback.token;
      }
      throw e;
    } finally {
      _guestTokenInflight = null;
    }
  })();

  return _guestTokenInflight;
}

async function rawRequest(url, opts = {}) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), requestTimeoutMs());
  try {
    const res = await fetch(url, {
      method: opts.method || "GET",
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal,
    });
    const text = await res.text();
    return { statusCode: res.status, body: text, headers: res.headers };
  } finally {
    clearTimeout(to);
  }
}

async function pollGuerrillaInbox(sid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let seq = 0;
  while (Date.now() < deadline) {
    await sleep(3000);
    try {
      const res = await rawRequest(
        `https://api.guerrillamail.com/ajax.php?f=check_email&seq=${seq}&sid_token=${encodeURIComponent(sid)}`,
        { method: "GET" }
      );
      const data = JSON.parse(res.body);
      const list = data.list || [];
      for (const mail of list) {
        seq = Math.max(seq, Number(mail.mail_id) || 0);
        const full = await rawRequest(
          `https://api.guerrillamail.com/ajax.php?f=fetch_email&email_id=${mail.mail_id}&sid_token=${encodeURIComponent(sid)}`,
          { method: "GET" }
        );
        const body = full.body || "";
        const m =
          body.match(/\b(\d{4,8})\b/) ||
          body.match(/verification[^0-9]*(\d{4,8})/i) ||
          body.match(/code[^0-9]*(\d{4,8})/i);
        if (m) return m[1];
      }
    } catch (e) {
      console.warn("[moviebox] inbox poll error:", e?.message || e);
    }
  }
  throw new Error("getGuestToken: timed out waiting for verification email");
}

async function getTempEmail() {
  const providers = [
    createTempmailLol,
    createTempMailIo,
    createGuerrillaMail,
    createMailTm,
  ];
  const errors = [];
  for (const create of providers) {
    try {
      const box = await create();
      if (box?.email && box?.waitCode) {
        console.log("[moviebox] temp-mail:", box.name, box.email);
        return box;
      }
    } catch (e) {
      errors.push(`${create.name}: ${e?.message || e}`);
      console.warn("[moviebox] temp-mail provider failed:", create.name, e?.message || e);
    }
  }
  throw new Error(
    "getGuestToken: no temp email provider available — " + errors.join(" | ")
  );
}

async function createTempmailLol() {
  const res = await rawRequest("https://api.tempmail.lol/v2/inbox/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const j = JSON.parse(res.body);
  if (!j.address || !j.token) throw new Error("tempmail.lol: bad response");
  return {
    name: "tempmail.lol",
    email: j.address,
    waitCode: async (ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        await sleep(2500);
        try {
          const inbox = await rawRequest(
            `https://api.tempmail.lol/v2/inbox?token=${encodeURIComponent(j.token)}`
          );
          const data = JSON.parse(inbox.body);
          const list = data.emails || data.messages || [];
          for (const m of list) {
            const body = `${m.subject || ""} ${m.body || ""} ${m.html || ""} ${m.text || ""}`;
            const match =
              body.match(/\b(\d{6})\b/) ||
              body.match(/\b(\d{4,8})\b/) ||
              body.match(/code[^0-9]*(\d{4,8})/i);
            if (match) return match[1];
          }
        } catch {
          /* retry */
        }
      }
      throw new Error("getGuestToken: timed out waiting for verification email");
    },
  };
}

async function createTempMailIo() {
  const res = await rawRequest("https://api.internal.temp-mail.io/api/v3/email/new", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const j = JSON.parse(res.body);
  if (!j.email || !j.token) throw new Error("temp-mail.io: bad response");
  return {
    name: "temp-mail.io",
    email: j.email,
    waitCode: async (ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        await sleep(2500);
        try {
          const inbox = await rawRequest(
            `https://api.internal.temp-mail.io/api/v3/email/${encodeURIComponent(j.email)}/messages`,
            { headers: { Authorization: j.token } }
          );
          let list = [];
          try {
            list = JSON.parse(inbox.body);
          } catch {
            list = [];
          }
          if (!Array.isArray(list)) list = list?.messages || [];
          for (const m of list) {
            const id = m.id || m._id;
            if (!id) continue;
            const full = await rawRequest(
              `https://api.internal.temp-mail.io/api/v3/message/${id}`,
              { headers: { Authorization: j.token } }
            );
            const match =
              full.body.match(/\b(\d{6})\b/) || full.body.match(/\b(\d{4,8})\b/);
            if (match) return match[1];
          }
        } catch {
          /* retry */
        }
      }
      throw new Error("getGuestToken: timed out waiting for verification email");
    },
  };
}

async function createGuerrillaMail() {
  const gmRes = await rawRequest(
    "https://api.guerrillamail.com/ajax.php?f=get_email_address",
    { method: "GET" }
  );
  const j = JSON.parse(gmRes.body);
  if (!j.email_addr || !j.sid_token) throw new Error("guerrilla: bad response");
  return {
    name: "guerrilla",
    email: j.email_addr,
    waitCode: (ms) => pollGuerrillaInbox(j.sid_token, ms),
  };
}

async function createMailTm() {
  const domRes = await rawRequest("https://api.mail.tm/domains", { method: "GET" });
  const domains = JSON.parse(domRes.body);
  const domain =
    domains["hydra:member"]?.[0]?.domain ||
    domains[0]?.domain ||
    null;
  if (!domain) throw new Error("mail.tm: no domain");
  const login = "mb" + randomBytes(5).toString("hex");
  const password = "Mb!" + randomBytes(5).toString("hex");
  const email = `${login}@${domain}`;
  const acc = await rawRequest("https://api.mail.tm/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: email, password }),
  });
  if (acc.statusCode >= 400) throw new Error(`mail.tm account ${acc.statusCode}`);
  const tokRes = await rawRequest("https://api.mail.tm/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: email, password }),
  });
  const bearer = JSON.parse(tokRes.body).token;
  if (!bearer) throw new Error("mail.tm: no token");
  return {
    name: "mail.tm",
    email,
    waitCode: async (ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        await sleep(2500);
        try {
          const msgs = await rawRequest("https://api.mail.tm/messages", {
            headers: { authorization: `Bearer ${bearer}` },
          });
          const list = JSON.parse(msgs.body)["hydra:member"] || [];
          if (list.length) {
            const full = await rawRequest(
              "https://api.mail.tm/messages/" + list[0].id,
              { headers: { authorization: `Bearer ${bearer}` } }
            );
            const match =
              full.body.match(/\b(\d{6})\b/) || full.body.match(/\b(\d{4,8})\b/);
            if (match) return match[1];
          }
        } catch {
          /* retry */
        }
      }
      throw new Error("getGuestToken: timed out waiting for verification email");
    },
  };
}

async function _registerGuestAccount() {
  const freshDeviceId = randomBytes(16).toString("hex");
  const freshGaid = [4, 2, 2, 2, 6]
    .map((n) => randomBytes(n).toString("hex"))
    .join("-");

  function buildFreshClientInfo() {
    return JSON.stringify({
      package_name: "com.community.oneroom",
      version_name: "4.0.02.0831.03",
      version_code: 50020126,
      os: "android",
      os_version: "14",
      install_ch: "google-play",
      device_id: freshDeviceId,
      install_store: "gp",
      gaid: freshGaid,
      brand: "Samsung",
      model: "SM-G991B",
      system_language: "en",
      net: "NETWORK_WIFI",
      region: "NG",
      timezone: "Africa/Lagos",
      sp_code: "62120",
      "X-Child-UID": "",
      "X-Client-Build": CLIENT_BUILD,
      "X-Play-Mode": "2",
      "X-Idle-Data": "1",
      "X-Family-Mode": "0",
      "X-Content-Mode": "0",
    });
  }

  // Workers cannot use arbitrary SOCKS/HTTP proxies easily; try direct only
  const { email, waitCode } = await getTempEmail();
  console.log("[moviebox] guest register email:", email);

  const freshCI = buildFreshClientInfo();

  async function proxyPost(path, body_obj) {
    const url = `${BASE}${path}?${HOST_PARAM}`;
    const bodyStr = JSON.stringify(body_obj);
    const ct = "application/json; charset=utf-8";
    const sig = sign(url, { method: "POST", contentType: ct, body: bodyStr });
    const { statusCode, body: text } = await rawRequest(url, {
      method: "POST",
      headers: {
        "x-tr-signature": sig,
        "x-client-info": freshCI,
        "x-client-build": CLIENT_BUILD,
        "user-agent": "okhttp/4.9.3",
        "content-type": ct,
      },
      body: bodyStr,
    });
    if (statusCode === 429) {
      const err = new Error("429");
      err.is429 = true;
      throw err;
    }
    if (statusCode >= 400) {
      throw new Error(`proxyPost ${path} → HTTP ${statusCode}: ${text.slice(0, 300)}`);
    }
    const json = JSON.parse(text);
    if (json.code !== 0) throw new Error(`API error ${json.code}: ${json.message}`);
    return json.data;
  }

  await proxyPost(`/wefeed-mobile-bff/user-api/get-sms-code`, {
    type: 1,
    authType: 1,
    mail: email,
    package_name: "com.community.oneroom",
  });

  const code = await waitCode(55_000);

  const regData = await proxyPost(`/wefeed-mobile-bff/user-api/register`, {
    authType: 1,
    mail: email,
    verificationCode: code,
    password: "Mb!" + Math.random().toString(36).slice(2, 10),
    package_name: "com.community.oneroom",
  });

  const token = regData?.token;
  if (!token) throw new Error("getGuestToken: no token in register response");
  console.log("[moviebox] guest register OK via direct");
  return { token, clientInfo: freshCI };
}

function buildHeaders(method, url, token, contentType, body) {
  const sig = sign(url, { method, contentType, body });
  return {
    "x-tr-signature": sig,
    authorization: `Bearer ${token}`,
    "x-client-info": activeClientInfo(),
    "x-client-build": CLIENT_BUILD,
    "x-play-mode": "2",
    "x-idle-data": "1",
    "x-family-mode": "0",
    "x-content-mode": "0",
    "x-client-status": "1",
    "x-child-uid": "",
    "user-agent": "okhttp/4.9.3",
  };
}

async function get(path, _retry = false) {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const token = await resolveToken();
  const { statusCode, body: text } = await rawRequest(url, {
    method: "GET",
    headers: buildHeaders("GET", url, token),
  });

  if ((statusCode === 406 || statusCode === 401) && !_retry) {
    console.error(`[moviebox] ${statusCode} on GET ${path} — refreshing token`);
    try {
      await getGuestToken();
    } catch {
      /* keep static */
    }
    return get(path, true);
  }

  if (statusCode >= 400) {
    throw new Error(`GET ${path} → HTTP ${statusCode}: ${text.slice(0, 300)}`);
  }
  const json = JSON.parse(text);
  if (json.code !== 0) throw new Error(`API error ${json.code}: ${json.message}`);
  return json.data;
}

async function post(path, body, _retry = false) {
  const ct = "application/json; charset=utf-8";
  const bodyStr = JSON.stringify(body);
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const token = await resolveToken();
  const { statusCode, body: text } = await rawRequest(url, {
    method: "POST",
    headers: {
      ...buildHeaders("POST", url, token, ct, bodyStr),
      "content-type": ct,
    },
    body: bodyStr,
  });

  if ((statusCode === 406 || statusCode === 401) && !_retry) {
    console.error(`[moviebox] ${statusCode} on POST ${path} — refreshing token`);
    try {
      await getGuestToken();
    } catch {
      /* keep static */
    }
    return post(path, body, true);
  }

  if (statusCode >= 400) {
    throw new Error(`POST ${path} → HTTP ${statusCode}: ${text.slice(0, 300)}`);
  }
  const json = JSON.parse(text);
  if (json.code !== 0) throw new Error(`API error ${json.code}: ${json.message}`);
  return json.data;
}

async function mirrorGet(path) {
  const url = `${mirrorBase()}${path.startsWith("/") ? path : `/${path}`}`;
  const { statusCode, body: text } = await rawRequest(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
  });
  if (statusCode >= 400) throw new Error(`mirror ${statusCode}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// ─── Public API used by app.js ───────────────────────────────────────────────

export async function search(keyword, page = 1, perPage = 20) {
  try {
    return await post(`/wefeed-mobile-bff/subject-api/search/v2?${HOST_PARAM}`, {
      keyword,
      page,
      perPage,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[moviebox] search upstream failed:", msg.slice(0, 120));
    try {
      const mir = await mirrorGet(`/api/search/${encodeURIComponent(keyword)}`);
      if (mir?.status === "success" && mir?.data) {
        return mir.data;
      }
    } catch (me) {
      console.warn("[moviebox] mirror search failed:", me?.message || me);
    }
    return {
      pager: { hasMore: false, page: String(page), perPage, totalCount: 0 },
      items: [],
      results: [],
    };
  }
}

export async function getSubject(subjectId, se) {
  const q = new URLSearchParams({ subjectId });
  if (se !== undefined) q.set("se", String(se));
  try {
    return await get(`/wefeed-mobile-bff/subject-api/get?${q}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("406") || msg.includes("401") || msg.includes("timeout")) {
      try {
        const mir = await mirrorGet(`/api/info/${encodeURIComponent(subjectId)}`);
        if (mir?.status === "success" && mir?.data) {
          const subject = mir.data.subject || mir.data;
          if (subject?.subjectId || subject?.title) return subject;
        }
      } catch (me) {
        console.warn("[moviebox] mirror info failed:", me?.message || me);
      }
    }
    throw e;
  }
}

export async function getSeasonInfo(subjectId) {
  return get(`/wefeed-mobile-bff/subject-api/season-info?subjectId=${subjectId}`);
}

export async function getResources(subjectId, se, page = 1, perPage = 50, all = 0) {
  const q = new URLSearchParams({
    subjectId,
    page: String(page),
    perPage: String(perPage),
    all: String(all),
    se: String(se),
    pagerMode: "0",
    resolution: "0",
  });
  return get(`/wefeed-mobile-bff/subject-api/resource?${q}`);
}

export async function getPlayInfo(subjectId, se, ep) {
  const q = new URLSearchParams({
    subjectId,
    se: String(se),
    ep: String(ep),
  });
  return get(`/wefeed-mobile-bff/subject-api/play-info?${q}`);
}

export async function getStreamWithCookies(subjectId, se, ep, resolution = "480") {
  const data = await getPlayInfo(subjectId, se, ep);
  const streams = data.streams ?? [];
  const stream =
    streams.find((s) => String(s.resolutions) === String(resolution)) ?? streams[0];
  if (!stream) throw new Error("No streams found");

  const cookies = {};
  for (const part of (stream.signCookie || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) cookies[k] = v;
  }
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

  return {
    url: stream.url,
    resolution: stream.resolutions,
    format: stream.format,
    cookieHeader,
    cookies,
  };
}

export async function getStreamCaptions(subjectId, streamId) {
  const q = new URLSearchParams({ subjectId, streamId: String(streamId) });
  return get(`/wefeed-mobile-bff/subject-api/get-stream-captions?${q}`);
}

export async function getExtCaptions(subjectId, resourceId, episode) {
  const q = new URLSearchParams({
    subjectId,
    resourceId,
    episode: String(episode),
  });
  return get(`/wefeed-mobile-bff/subject-api/get-ext-captions?${q}`);
}

export async function getDubInfo(subjectId) {
  return get(`/wefeed-mobile-bff/subject-api/dub-info?subjectId=${subjectId}`);
}

export async function getTrending(everyoneSearch = 2) {
  return get(
    `/wefeed-mobile-bff/subject-api/search-rank?everyoneSearch=${everyoneSearch}`
  );
}

export async function getCommunityTrending(postNum = 3) {
  return get(
    `/wefeed-mobile-bff/community/trending-entrance?postNum=${postNum}`
  );
}

export async function getDailyRec(page = 1, perPage = 20) {
  return post(`/wefeed-mobile-bff/subject-api/daily-movie-rec`, { page, perPage });
}

export async function getRelated(subjectId, page = 1, perPage = 12) {
  return post(`/wefeed-mobile-bff/subject-api/detail-rec`, {
    subjectId,
    page,
    perPage,
  });
}

export async function getStaffInfo(staffId) {
  return get(`/wefeed-mobile-bff/subject-api/staff-info?staffId=${staffId}`);
}

export async function getStaffSubjects(staffId, start = 1, end = 20) {
  const q = new URLSearchParams({
    staffId,
    start: String(start),
    end: String(end),
    pagerMode: "1",
  });
  return get(`/wefeed-mobile-bff/subject-api/staff-subject-list?${q}`);
}

export async function getPostCount(subjectId) {
  return get(`/wefeed-mobile-bff/post/count/subject?subjectId=${subjectId}`);
}

export async function getBottomTabs() {
  return get(`/wefeed-mobile-bff/subject-api/bottom-tab`);
}

export async function getResourcePositionV2(subjectId, resourceId, resourceNum = 1) {
  const q = new URLSearchParams({
    subjectId,
    resourceId,
    failUrl: "",
    failCode: "",
    resourceNum: String(resourceNum),
    isVip: "false",
  });
  return get(`/wefeed-mobile-bff/subject-api/resource-position/v2?${q}`);
}

export async function checkDownloadAccess(subjectId, episodes, resolution = 480) {
  return post(`/wefeed-mobile-bff/vip/check-access`, {
    subjectId,
    entitlementKey: "subject_download",
    entitlementProperty: "free_download_count",
    eps: episodes,
    resolution: String(resolution),
  });
}

export async function startDownload(items) {
  return post(`/wefeed-mobile-bff/subject-api/start-download-resource`, { items });
}

/** Call once per request to inject env / KV */
export function bindEnv(env) {
  globalThis.__MB_ENV__ = env || {};
  // Warm static token
  if (!_cachedToken) {
    const boot = pickStaticTokenSync();
    _cachedToken = boot.token;
    if (boot.clientInfo) _cachedClientInfo = boot.clientInfo;
  }
}
