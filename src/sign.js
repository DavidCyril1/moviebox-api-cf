/**
 * MovieBox x-tr-signature HMAC-MD5
 * Accept MUST be application/json in the canonical string (API rejects empty accept).
 */
import { createHmac, createHash } from "node:crypto";

const KEY = Buffer.from("76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O", "base64");

function normalizeUrl(url) {
  const u = new URL(url);
  const path = u.pathname;
  const params = [...u.searchParams.entries()];
  if (!params.length) return path;
  // Decode then sort (gateway decodes before sorting)
  const sorted = params
    .map(([k, v]) => [decodeURIComponent(k), decodeURIComponent(v)])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `${path}?${sorted}`;
}

export function sign(url, opts = {}) {
  const {
    method = "GET",
    accept = "application/json",
    contentType = "",
    body,
    timestampMs = String(Date.now()),
  } = opts;

  let bodyLen = "";
  let bodyMd5 = "";
  if (body) {
    const bytes = Buffer.from(body, "utf-8");
    bodyLen = String(bytes.length);
    bodyMd5 = createHash("md5").update(bytes).digest("hex");
  }

  const message = [
    method.toUpperCase(),
    accept,
    contentType,
    bodyLen,
    timestampMs,
    bodyMd5,
    normalizeUrl(url),
  ].join("\n");

  const mac = createHmac("md5", KEY).update(message, "utf-8").digest("base64");
  return `${timestampMs}|2|${mac}`;
}

/** X-Client-Token: timestamp,md5(reversed_timestamp) */
export function clientToken(timestampMs = String(Date.now())) {
  const rev = timestampMs.split("").reverse().join("");
  const md5 = createHash("md5").update(rev, "utf-8").digest("hex");
  return `${timestampMs},${md5}`;
}
