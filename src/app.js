import { Hono } from "hono";
import * as mb from "./client.js";

export const app = new Hono();

// Inject env on every request
app.use("*", async (c, next) => {
  mb.bindEnv(c.env);
  await next();
});

function param(c, name) {
  const v = c.req.param(name);
  if (v === undefined) throw new Error(`Missing route param: ${name}`);
  return v;
}

function wrap(fn) {
  return async (c) => {
    try {
      const data = await fn(c);
      return c.json({ success: true, data });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.includes("HTTP 4") ? 400 : 502;
      return c.json({ success: false, error: msg }, status);
    }
  };
}

app.get("/", (c) =>
  c.json({
    name: "MovieBox Scraper API",
    version: "1.0.0",
    endpoints: [
      { method: "GET", path: "/search?q=<keyword>&page=1&perPage=20" },
      { method: "GET", path: "/info/:subjectId?se=<season>" },
      { method: "GET", path: "/seasons/:subjectId" },
      { method: "GET", path: "/sources/:subjectId/:se/:ep" },
      { method: "GET", path: "/episodes/:subjectId/:se?page=1&perPage=50" },
      { method: "GET", path: "/trending?type=2" },
      { method: "GET", path: "/trending/community?postNum=3" },
      { method: "GET", path: "/recommend/daily?page=1&perPage=20" },
      { method: "GET", path: "/recommend/related/:subjectId?page=1&perPage=12" },
      { method: "GET", path: "/captions/stream/:subjectId/:streamId" },
      { method: "GET", path: "/captions/ext/:subjectId/:resourceId/:episode" },
      { method: "GET", path: "/dub/:subjectId" },
      { method: "GET", path: "/staff/:staffId" },
      { method: "GET", path: "/staff/:staffId/subjects?start=1&end=20" },
      { method: "GET", path: "/download/:subjectId/:se/check?resolution=480&eps=1,2,3" },
      { method: "GET", path: "/stream/:subjectId/:se/:ep?resolution=480  ← CDN-safe proxied MP4 (inline)" },
      { method: "GET", path: "/dl/:subjectId/:se/:ep?resolution=480  ← CDN-safe proxied MP4 (download)" },
      { method: "GET", path: "/pipe/:subjectId/:se/:ep?resolution=480  ← same proxy as /stream (compat)" },
    ],
  })
);

app.get("/search", wrap((c) => {
  const q = c.req.query("q");
  if (!q) throw new Error("Missing required query param: q");
  const page = Number(c.req.query("page") ?? 1);
  const perPage = Number(c.req.query("perPage") ?? 20);
  return mb.search(q, page, perPage);
}));

app.get("/info/:subjectId", wrap((c) => {
  const subjectId = param(c, "subjectId");
  const se = c.req.query("se");
  return mb.getSubject(subjectId, se ? Number(se) : undefined);
}));

app.get("/seasons/:subjectId", wrap((c) => {
  return mb.getSeasonInfo(param(c, "subjectId"));
}));

app.get("/sources/:subjectId/:se/:ep", wrap((c) => {
  const subjectId = param(c, "subjectId");
  const se = Number(param(c, "se"));
  const ep = Number(param(c, "ep"));
  return mb.getPlayInfo(subjectId, se, ep);
}));

app.get("/episodes/:subjectId/:se", wrap((c) => {
  const subjectId = param(c, "subjectId");
  const se = Number(param(c, "se"));
  const page = Number(c.req.query("page") ?? 1);
  const perPage = Number(c.req.query("perPage") ?? 20);
  const all = Number(c.req.query("all") ?? 0);
  return mb.getResources(subjectId, se, page, perPage, all);
}));

app.get("/trending", wrap((c) => {
  const type = Number(c.req.query("type") ?? 2);
  return mb.getTrending(type);
}));

app.get("/trending/community", wrap((c) => {
  const postNum = Number(c.req.query("postNum") ?? 3);
  return mb.getCommunityTrending(postNum);
}));

app.get("/recommend/daily", wrap((c) => {
  const page = Number(c.req.query("page") ?? 1);
  const perPage = Number(c.req.query("perPage") ?? 20);
  return mb.getDailyRec(page, perPage);
}));

app.get("/recommend/related/:subjectId", wrap((c) => {
  const subjectId = param(c, "subjectId");
  const page = Number(c.req.query("page") ?? 1);
  const perPage = Number(c.req.query("perPage") ?? 12);
  return mb.getRelated(subjectId, page, perPage);
}));

app.get("/captions/stream/:subjectId/:streamId", wrap((c) => {
  const subjectId = param(c, "subjectId");
  const streamId = param(c, "streamId");
  return mb.getStreamCaptions(subjectId, streamId);
}));

app.get("/captions/ext/:subjectId/:resourceId/:episode", wrap((c) => {
  const subjectId = param(c, "subjectId");
  const resourceId = param(c, "resourceId");
  const episode = Number(param(c, "episode"));
  return mb.getExtCaptions(subjectId, resourceId, episode);
}));

app.get("/dub/:subjectId", wrap((c) => {
  return mb.getDubInfo(param(c, "subjectId"));
}));

app.get("/staff/:staffId", wrap((c) => {
  return mb.getStaffInfo(param(c, "staffId"));
}));

app.get("/staff/:staffId/subjects", wrap((c) => {
  const staffId = param(c, "staffId");
  const start = Number(c.req.query("start") ?? 1);
  const end = Number(c.req.query("end") ?? 20);
  return mb.getStaffSubjects(staffId, start, end);
}));

app.get("/download/:subjectId/:se/check", wrap((c) => {
  const subjectId = param(c, "subjectId");
  const resolution = Number(c.req.query("resolution") ?? 480);
  const epsParam = c.req.query("eps") ?? "1";
  const episodes = epsParam.split(",").map(Number);
  return mb.checkDownloadAccess(subjectId, episodes, resolution);
}));

/** Resolve a real signed MP4 via resource-position/v2 (not poisoned play-info URLs). */
async function resolveRealMp4(subjectId, se, ep, resolution) {
  const perPage = 20;
  let page = 1;
  let item = null;
  let scanned = 0;
  let hasMore = true;
  const epCode = se * 100 + ep;

  const pickFrom = (items) => {
    let candidates = items.filter(
      (i) => Number(i.se) === se && Number(i.ep) === ep && Number(i.ep) > 0
    );
    if (candidates.length === 0) {
      candidates = items.filter((i) => Number(i.episode) === epCode && epCode > 0);
    }
    if (candidates.length === 0 && ep > 0) {
      candidates = items.filter(
        (i) => Number(i.ep) === ep && Number(i.se) === se
      );
    }
    const movieItems = items.filter(
      (i) =>
        Number(i.se || 0) === 0 &&
        Number(i.ep || 0) === 0 &&
        Number(i.episode || 0) === 0 &&
        i.resourceId
    );
    if (
      candidates.length === 0 &&
      movieItems.length > 0 &&
      (se === 0 || se === 1) &&
      (ep === 0 || ep === 1)
    ) {
      candidates = movieItems;
    }
    if (candidates.length === 0) return null;
    const exact = candidates.find((i) => Number(i.resolution) === resolution);
    if (exact) return exact;
    return candidates
      .slice()
      .sort(
        (a, b) =>
          Math.abs(Number(a.resolution) - resolution) -
          Math.abs(Number(b.resolution) - resolution)
      )[0];
  };

  while (hasMore && page <= 40 && !item) {
    const resourceData = await mb.getResources(subjectId, se || 1, page, perPage, 0);
    const items = resourceData.list ?? [];
    scanned += items.length;
    item = pickFrom(items);
    if (item) break;
    const pager = resourceData.pager ?? {};
    hasMore = Boolean(pager.hasMore) || items.length >= perPage;
    page += 1;
    if (items.length === 0) break;
  }

  if (!item && (se === 0 || se === 1) && (ep === 0 || ep === 1)) {
    const resourceData = await mb.getResources(subjectId, 0, 1, perPage, 0);
    const items = resourceData.list ?? [];
    scanned += items.length;
    item = pickFrom(items);
  }

  if (!item?.resourceId) {
    const err = new Error(`No resource found for S${se}E${ep} (scanned ${scanned} items)`);
    err.status = 404;
    throw err;
  }

  const posData = await mb.getResourcePositionV2(subjectId, item.resourceId, 1);
  const mp4Url = (posData?.list ?? [])[0]?.resourceLink;
  if (!mp4Url || mp4Url.includes("9a0461")) {
    const err = new Error("No real stream/download URL found");
    err.status = 404;
    throw err;
  }
  return { mp4Url, item, resolution: Number(item.resolution) || resolution };
}

/**
 * Shared CDN-safe MP4 proxy.
 * MovieBox CDN blocks many clients (403/428). We always fetch with okhttp UA
 * (and optional CloudFront cookies) on the server, then pipe bytes to the client.
 * Same URL paths as before — only the response is a real video body instead of a dead 302.
 */
async function proxyMp4(c, { disposition }) {
  const subjectId = param(c, "subjectId");
  const se = Number(param(c, "se"));
  const ep = Number(param(c, "ep"));
  const resolution = Number(c.req.query("resolution") ?? 480);

  const { mp4Url, item } = await resolveRealMp4(subjectId, se, ep, resolution);

  const subjectData = await mb.getSubject(subjectId).catch(() => null);
  const rawTitle = subjectData?.title ?? `Subject-${subjectId}`;
  const title =
    String(rawTitle)
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim() || `Subject-${subjectId}`;

  const isMovie =
    Number(subjectData?.subjectType) === 1 ||
    (Number(item.se || 0) === 0 &&
      Number(item.ep || 0) === 0 &&
      Number(item.episode || 0) === 0);

  const actualRes = Number(item.resolution) || resolution;
  const filename = isMovie
    ? `${title} - ${actualRes}p.mp4`
    : `${title} - S${String(se).padStart(2, "0")}E${String(ep).padStart(2, "0")} - ${actualRes}p.mp4`;

  const rangeHeader = c.req.header("range");

  let cookieHeader = "";
  try {
    const play = await mb.getPlayInfo(subjectId, se, ep).catch(() => null);
    const streams = play?.streams ?? [];
    const pick =
      streams.find((s) => String(s.resolutions || "").includes(String(actualRes))) ||
      streams[0];
    if (pick?.signCookie) {
      cookieHeader = String(pick.signCookie)
        .split(";")
        .map((p) => p.trim())
        .filter(Boolean)
        .join("; ");
    }
  } catch {
    /* optional */
  }

  const baseHeaders = {
    "user-agent": "okhttp/4.12.0",
    accept: "*/*",
    "accept-encoding": "identity",
  };
  if (rangeHeader) baseHeaders["range"] = rangeHeader;

  if (cookieHeader) baseHeaders["cookie"] = cookieHeader;

  // CDN via SOCKS5 (same proxy) — CF egress blocked
  let res = await mb.upstreamFetch(mp4Url, {
    method: "GET",
    headers: baseHeaders,
    timeoutMs: 60_000,
  });

  if (res.status >= 400 && cookieHeader) {
    const h2 = { ...baseHeaders };
    delete h2.cookie;
    res = await mb.upstreamFetch(mp4Url, { method: "GET", headers: h2, timeoutMs: 60_000 });
  }

  if (res.status >= 400) {
    const err = new Error(`CDN returned ${res.status}`);
    err.status = 502;
    throw err;
  }

  const disp =
    disposition === "attachment"
      ? `attachment; filename="${filename}"`
      : `inline; filename="${filename}"`;

  const resHeaders = {
    "content-type": res.headers.get("content-type") ?? "video/mp4",
    "content-disposition": disp,
    "accept-ranges": res.headers.get("accept-ranges") ?? "bytes",
    "access-control-allow-origin": "*",
    "access-control-expose-headers":
      "content-length, content-range, accept-ranges, content-type",
    "cache-control": "no-store",
  };
  const cl = res.headers.get("content-length");
  if (cl) resHeaders["content-length"] = cl;
  const cr = res.headers.get("content-range");
  if (cr) resHeaders["content-range"] = cr;

  return new Response(res.body, {
    status: res.status === 206 ? 206 : 200,
    headers: resHeaders,
  });
}

/**
 * GET /stream/:subjectId/:se/:ep?resolution=480
 * CDN-safe playback: streams real MP4 through this server (inline).
 * Same path as before — clients keep the same URL.
 */
app.get("/stream/:subjectId/:se/:ep", async (c) => {
  try {
    if (c.req.query("redirect") === "0") {
      const subjectId = param(c, "subjectId");
      const se = Number(param(c, "se"));
      const ep = Number(param(c, "ep"));
      const resolution = Number(c.req.query("resolution") ?? 480);
      const { mp4Url } = await resolveRealMp4(subjectId, se, ep, resolution);
      return c.json({ success: true, data: { url: mp4Url, resolution } });
    }
    return await proxyMp4(c, { disposition: "inline" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = e?.status === 404 ? 404 : e?.status === 502 ? 502 : 502;
    return c.json({ success: false, error: msg }, status);
  }
});

/**
 * GET /dl/:subjectId/:se/:ep?resolution=480
 * CDN-safe download: same path, attachment disposition, proxied bytes.
 */
app.get("/dl/:subjectId/:se/:ep", async (c) => {
  try {
    return await proxyMp4(c, { disposition: "attachment" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = e?.status === 404 ? 404 : 502;
    return c.json({ success: false, error: msg }, status);
  }
});

/**
 * GET /pipe/:subjectId/:se/:ep?resolution=480&disposition=inline|attachment
 * Alias of the same proxy (kept for older Cineverse builds that call /pipe).
 */
app.get("/pipe/:subjectId/:se/:ep", async (c) => {
  try {
    const disposition =
      (c.req.query("disposition") ?? "inline").toLowerCase() === "attachment"
        ? "attachment"
        : "inline";
    return await proxyMp4(c, { disposition });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = e?.status === 404 ? 404 : 502;
    return c.json({ success: false, error: msg }, status);
  }
});
