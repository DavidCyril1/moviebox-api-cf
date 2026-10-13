/**
 * MovieBox API client — Cloudflare Workers
 * Upstream via SOCKS5 (socksflare) — CF IPs blocked by MovieBox.
 * Signature: accept=application/json required.
 */
import { sign, clientToken } from "./sign.js";
import { randomBytes, createHash } from "node:crypto";
import { upstreamFetch } from "./proxy.js";

const BASE = "https://api6.aoneroom.com";
const HOSTS = [
  "https://api6.aoneroom.com",
  "https://api5.aoneroom.com",
  "https://api4.aoneroom.com",
  "https://api.inmoviebox.com",
];

function getEnv(key, fallback = undefined) {
  const e = globalThis.__MB_ENV__ || {};
  if (e[key] !== undefined && e[key] !== "") return e[key];
  if (typeof process !== "undefined" && process.env?.[key]) return process.env[key];
  return fallback;
}

function mirrorBase() {
  return (getEnv("MB_MIRROR_BASE") || "https://moviebox.davidcyril.name.ng").replace(/\/$/, "");
}

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
  return Number(getEnv("MB_REQUEST_TIMEOUT_MS") || 25_000);
}
function guestTimeoutMs() {
  return Number(getEnv("MB_GUEST_TIMEOUT_MS") || 90_000);
}

let _cachedToken = null;
let _cachedClientInfo = null;
let _guestTokenInflight = null;
let _lastGuestFailAt = 0;
let _hostIdx = 0;

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

function pickStaticToken() {
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
  const staticTok = pickStaticToken();
  _cachedToken = staticTok.token;
  if (staticTok.clientInfo) _cachedClientInfo = staticTok.clientInfo;
  return _cachedToken;
}

function rememberToken(token, clientInfo = null) {
  if (!token) return;
  _cachedToken = token;
  if (clientInfo) _cachedClientInfo = clientInfo;
}

function activeClientInfo() {
  return _cachedClientInfo || CLIENT_INFO;
}

export async function getGuestToken() {
  if (_guestTokenInflight) return _guestTokenInflight;
  if (Date.now() - _lastGuestFailAt < 60_000 && _cachedToken) return _cachedToken;

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
      const fallback = pickStaticToken();
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

function buildHeaders(method, url, token, contentType, body) {
  const ts = String(Date.now());
  const accept = "application/json";
  const ct = contentType || "";
  const sig = sign(url, {
    method,
    accept,
    contentType: ct,
    body,
    timestampMs: ts,
  });
  const h = {
    accept,
    "x-tr-signature": sig,
    "x-client-token": clientToken(ts),
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
  if (ct) h["content-type"] = ct;
  return h;
}

async function mbRequest(url, opts = {}) {
  const res = await upstreamFetch(url, {
    method: opts.method || "GET",
    headers: opts.headers,
    body: opts.body,
    timeoutMs: requestTimeoutMs(),
  });
  const text = await res.text();
  return { statusCode: res.status, body: text, headers: res.headers };
}

async function get(path, _retry = false) {
  const bases = HOSTS;
  let lastErr;
  for (let i = 0; i < bases.length; i++) {
    const base = bases[(_hostIdx + i) % bases.length];
    const url = path.startsWith("http") ? path : `${base}${path}`;
    try {
      const token = await resolveToken();
      const { statusCode, body: text } = await mbRequest(url, {
        method: "GET",
        headers: buildHeaders("GET", url, token),
      });

      if ((statusCode === 406 || statusCode === 401) && !_retry) {
        console.error(`[moviebox] ${statusCode} on GET ${path} — refreshing token`);
        try { await getGuestToken(); } catch { /* */ }
        return get(path, true);
      }
      if (statusCode === 407 && !_retry) {
        // signature/host issues — try next host
        lastErr = new Error(`GET ${path} → HTTP ${statusCode}: ${text.slice(0, 200)}`);
        continue;
      }
      if (statusCode >= 400) {
        throw new Error(`GET ${path} → HTTP ${statusCode}: ${text.slice(0, 300)}`);
      }
      const json = JSON.parse(text);
      if (json.code !== 0) throw new Error(`API error ${json.code}: ${json.message}`);
      _hostIdx = (_hostIdx + i) % bases.length;
      return json.data;
    } catch (e) {
      lastErr = e;
      console.warn("[moviebox] get fail", base, e?.message || e);
    }
  }
  throw lastErr || new Error("GET failed all hosts");
}

async function post(path, body, _retry = false) {
  const ct = "application/json;charset=UTF-8";
  const bodyStr = JSON.stringify(body);
  const bases = HOSTS;
  let lastErr;
  for (let i = 0; i < bases.length; i++) {
    const base = bases[(_hostIdx + i) % bases.length];
    // rewrite host query if present
    let pathUse = path;
    if (path.includes("host=")) {
      pathUse = path.replace(/host=[^&]*/, `host=${encodeURIComponent(base)}`);
    }
    const url = pathUse.startsWith("http") ? pathUse : `${base}${pathUse}`;
    try {
      const token = await resolveToken();
      const { statusCode, body: text } = await mbRequest(url, {
        method: "POST",
        headers: buildHeaders("POST", url, token, ct, bodyStr),
        body: bodyStr,
      });

      if ((statusCode === 406 || statusCode === 401) && !_retry) {
        try { await getGuestToken(); } catch { /* */ }
        return post(path, body, true);
      }
      if (statusCode === 407 && !_retry) {
        lastErr = new Error(`POST ${path} → HTTP ${statusCode}: ${text.slice(0, 200)}`);
        continue;
      }
      if (statusCode >= 400) {
        throw new Error(`POST ${path} → HTTP ${statusCode}: ${text.slice(0, 300)}`);
      }
      const json = JSON.parse(text);
      if (json.code !== 0) throw new Error(`API error ${json.code}: ${json.message}`);
      _hostIdx = (_hostIdx + i) % bases.length;
      return json.data;
    } catch (e) {
      lastErr = e;
      console.warn("[moviebox] post fail", base, e?.message || e);
    }
  }
  throw lastErr || new Error("POST failed all hosts");
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

// temp-mail (direct)
async function pollGuerrillaInbox(sid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let seq = 0;
  while (Date.now() < deadline) {
    await sleep(3000);
    try {
      const res = await rawRequest(
        `https://api.guerrillamail.com/ajax.php?f=check_email&seq=${seq}&sid_token=${encodeURIComponent(sid)}`
      );
      const data = JSON.parse(res.body);
      for (const mail of data.list || []) {
        seq = Math.max(seq, Number(mail.mail_id) || 0);
        const full = await rawRequest(
          `https://api.guerrillamail.com/ajax.php?f=fetch_email&email_id=${mail.mail_id}&sid_token=${encodeURIComponent(sid)}`
        );
        const m = (full.body || "").match(/\b(\d{4,8})\b/);
        if (m) return m[1];
      }
    } catch (e) {
      console.warn("[moviebox] inbox poll:", e?.message || e);
    }
  }
  throw new Error("getGuestToken: timed out waiting for verification email");
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
          for (const m of data.emails || data.messages || []) {
            const body = `${m.subject || ""} ${m.body || ""} ${m.html || ""}`;
            const match = body.match(/\b(\d{6})\b/) || body.match(/\b(\d{4,8})\b/);
            if (match) return match[1];
          }
        } catch { /* */ }
      }
      throw new Error("getGuestToken: timed out waiting for verification email");
    },
  };
}

async function createGuerrillaMail() {
  const gmRes = await rawRequest(
    "https://api.guerrillamail.com/ajax.php?f=get_email_address"
  );
  const j = JSON.parse(gmRes.body);
  if (!j.email_addr || !j.sid_token) throw new Error("guerrilla: bad response");
  return {
    name: "guerrilla",
    email: j.email_addr,
    waitCode: (ms) => pollGuerrillaInbox(j.sid_token, ms),
  };
}

async function getTempEmail() {
  for (const create of [createTempmailLol, createGuerrillaMail]) {
    try {
      const box = await create();
      if (box?.email && box?.waitCode) {
        console.log("[moviebox] temp-mail:", box.name, box.email);
        return box;
      }
    } catch (e) {
      console.warn("[moviebox] temp-mail failed:", create.name, e?.message || e);
    }
  }
  throw new Error("getGuestToken: no temp email provider available");
}

async function _registerGuestAccount() {
  const freshDeviceId = randomBytes(16).toString("hex");
  const freshGaid = [4, 2, 2, 2, 6].map((n) => randomBytes(n).toString("hex")).join("-");
  const freshCI = JSON.stringify({
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

  const { email, waitCode } = await getTempEmail();
  console.log("[moviebox] guest register email:", email);

  async function regPost(path, body_obj) {
    const base = BASE;
    const url = `${base}${path}?host=${encodeURIComponent(base)}`;
    const bodyStr = JSON.stringify(body_obj);
    const ct = "application/json;charset=UTF-8";
    const ts = String(Date.now());
    const accept = "application/json";
    const sig = sign(url, { method: "POST", accept, contentType: ct, body: bodyStr, timestampMs: ts });
    const { statusCode, body: text } = await mbRequest(url, {
      method: "POST",
      headers: {
        accept,
        "x-tr-signature": sig,
        "x-client-token": clientToken(ts),
        "x-client-info": freshCI,
        "x-client-build": CLIENT_BUILD,
        "user-agent": "okhttp/4.9.3",
        "content-type": ct,
      },
      body: bodyStr,
    });
    if (statusCode >= 400) {
      throw new Error(`regPost ${path} → HTTP ${statusCode}: ${text.slice(0, 300)}`);
    }
    const json = JSON.parse(text);
    if (json.code !== 0) throw new Error(`API error ${json.code}: ${json.message}`);
    return json.data;
  }

  await regPost(`/wefeed-mobile-bff/user-api/get-sms-code`, {
    type: 1,
    authType: 1,
    mail: email,
    package_name: "com.community.oneroom",
  });
  const code = await waitCode(55_000);
  const regData = await regPost(`/wefeed-mobile-bff/user-api/register`, {
    authType: 1,
    mail: email,
    verificationCode: code,
    password: "Mb!" + Math.random().toString(36).slice(2, 10),
    package_name: "com.community.oneroom",
  });
  const token = regData?.token;
  if (!token) throw new Error("getGuestToken: no token in register response");
  console.log("[moviebox] guest register OK");
  return { token, clientInfo: freshCI };
}

export async function search(keyword, page = 1, perPage = 20) {
  try {
    return await post(`/wefeed-mobile-bff/subject-api/search/v2?host=${encodeURIComponent(BASE)}`, {
      keyword,
      page,
      perPage,
    });
  } catch (e) {
    console.warn("[moviebox] search upstream failed:", String(e?.message || e).slice(0, 120));
    try {
      const mir = await mirrorGet(`/api/search/${encodeURIComponent(keyword)}`);
      if (mir?.status === "success" && mir?.data) return mir.data;
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
    if (msg.includes("406") || msg.includes("401") || msg.includes("timeout") || msg.includes("440")) {
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
  const q = new URLSearchParams({ subjectId, se: String(se), ep: String(ep) });
  return get(`/wefeed-mobile-bff/subject-api/play-info?${q}`);
}

export async function getStreamCaptions(subjectId, streamId) {
  const q = new URLSearchParams({ subjectId, streamId: String(streamId) });
  return get(`/wefeed-mobile-bff/subject-api/get-stream-captions?${q}`);
}

export async function getExtCaptions(subjectId, resourceId, episode) {
  const q = new URLSearchParams({ subjectId, resourceId, episode: String(episode) });
  return get(`/wefeed-mobile-bff/subject-api/get-ext-captions?${q}`);
}

export async function getDubInfo(subjectId) {
  return get(`/wefeed-mobile-bff/subject-api/dub-info?subjectId=${subjectId}`);
}

export async function getTrending(everyoneSearch = 2) {
  return get(`/wefeed-mobile-bff/subject-api/search-rank?everyoneSearch=${everyoneSearch}`);
}

export async function getCommunityTrending(postNum = 3) {
  return get(`/wefeed-mobile-bff/community/trending-entrance?postNum=${postNum}`);
}

export async function getDailyRec(page = 1, perPage = 20) {
  return post(`/wefeed-mobile-bff/subject-api/daily-movie-rec`, { page, perPage });
}

export async function getRelated(subjectId, page = 1, perPage = 12) {
  return post(`/wefeed-mobile-bff/subject-api/detail-rec`, { subjectId, page, perPage });
}

export async function getStaffInfo(staffId) {
  return get(`/wefeed-mobile-bff/subject-api/staff-info?staffId=${staffId}`);
}

export async function getStaffSubjects(staffId, start = 1, end = 20) {
  const q = new URLSearchParams({ staffId, start: String(start), end: String(end), pagerMode: "1" });
  return get(`/wefeed-mobile-bff/subject-api/staff-subject-list?${q}`);
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

export { upstreamFetch };

export function bindEnv(env) {
  globalThis.__MB_ENV__ = env || {};
  if (!_cachedToken) {
    const boot = pickStaticToken();
    _cachedToken = boot.token;
    if (boot.clientInfo) _cachedClientInfo = boot.clientInfo;
  }
}
