/**
 * MovieBox x-tr-signature HMAC-MD5 signing
 * Verified against APK v4.0.02.0831.03
 * Uses node:crypto via Workers nodejs_compat
 */
import { createHmac, createHash } from "node:crypto";

const KEY_B64 = "76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O";
const KEY = Buffer.from(KEY_B64, "base64");

function normalizeUrl(url) {
  const u = new URL(url);
  const path = u.pathname;
  const params = u.searchParams;
  if (![...params.keys()].length) return path;
  const sorted = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `${path}?${sorted}`;
}

export function sign(url, opts = {}) {
  const {
    method = "GET",
    accept = "",
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

  const norm = normalizeUrl(url);
  const message = [
    method.toUpperCase(),
    accept,
    contentType,
    bodyLen,
    timestampMs,
    bodyMd5,
    norm,
  ].join("\n");

  const mac = createHmac("md5", KEY).update(message, "utf-8").digest("base64");
  return `${timestampMs}|2|${mac}`;
}
