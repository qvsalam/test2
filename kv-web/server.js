const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 10000);
const UPSTREAM = (process.env.KV_UPSTREAM || "https://kv-iraq.com").replace(/\/$/, "");
const API_KEY = process.env.KV_API_KEY || "";
const INDEX = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function send(res, status, body, type = "application/json; charset=utf-8", extra = {}) {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store, max-age=0",
    "x-content-type-options": "nosniff",
    ...extra
  });
  res.end(body);
}

function json(res, status, obj) {
  send(res, status, JSON.stringify(obj));
}

async function readBody(req) {
  return await new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", c => {
      raw += c;
      if (raw.length > 1024 * 64) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function sanitizeSetCookie(v) {
  if (!v) return "";
  return v
    .replace(/;\s*Domain=[^;]+/ig, "")
    .replace(/;\s*SameSite=None/ig, "; SameSite=Lax");
}

function upstreamHeaders(req, contentType) {
  const h = {
    "accept": "application/json,text/plain,*/*",
    "user-agent": "KV IRAQ/1.0 (Android-compatible web client)"
  };
  if (API_KEY) h["X-API-KEY"] = API_KEY;
  if (contentType) h["content-type"] = contentType;
  if (req.headers.authorization) h["authorization"] = req.headers.authorization;
  if (req.headers["x-device-id"]) h["x-device-id"] = req.headers["x-device-id"];
  if (req.headers.cookie) h["cookie"] = req.headers.cookie;
  return h;
}

async function relay(req, res, url, options = {}) {
  const r = await fetch(url, {
    redirect: "follow",
    cache: "no-store",
    ...options,
    headers: { ...upstreamHeaders(req, options.contentType), ...(options.headers || {}) }
  });
  const text = await r.text();
  const outHeaders = {};
  const ct = r.headers.get("content-type");
  if (ct) outHeaders["content-type"] = ct;
  const sc = r.headers.get("set-cookie");
  if (sc) outHeaders["set-cookie"] = sanitizeSetCookie(sc);
  send(res, r.status, text, outHeaders["content-type"] || "application/json; charset=utf-8", outHeaders);
}

async function handleApi(req, res, u) {
  try {
    if (u.pathname === "/api/login") {
      if (req.method !== "POST") return json(res, 405, { error: "POST required" });
      let body;
      try { body = JSON.parse(await readBody(req) || "{}"); }
      catch { return json(res, 400, { error: "Invalid JSON" }); }

      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      const phone = String(body.phone_number || body.phone || "").trim();
      const center = String(body.maintenance_center || body.center_name || "").trim();
      const deviceId = String(body.device_id || body.deviceId || "").trim();

      if (!username || !password || !phone || !center) {
        return json(res, 400, { error: "Missing login fields" });
      }

      const form = new URLSearchParams();
      form.set("username", username);
      form.set("password", password);
      form.set("phone_number", phone);
      form.set("maintenance_center", center);
      form.set("phone", phone);
      form.set("center_name", center);
      if (deviceId) {
        form.set("device_id", deviceId);
        form.set("deviceId", deviceId);
      }

      return await relay(req, res, UPSTREAM + "/api_register.php", {
        method: "POST",
        body: form.toString(),
        contentType: "application/x-www-form-urlencoded; charset=UTF-8"
      });
    }

    if (u.pathname === "/api/center") {
      const center = u.searchParams.get("center_name") || "";
      if (!center) return json(res, 400, { error: "center_name required" });
      return await relay(req, res, UPSTREAM + "/get_center_details.php?center_name=" + encodeURIComponent(center), { method: "GET" });
    }

    if (u.pathname === "/api/structure") {
      return await relay(req, res, UPSTREAM + "/api_structure.php", { method: "GET" });
    }

    if (u.pathname === "/api/nearby") {
      const lat = Number(u.searchParams.get("lat"));
      const lon = Number(u.searchParams.get("lon"));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json(res, 400, { error: "lat/lon required" });
      return await relay(req, res, UPSTREAM + "/api.php?lat=" + encodeURIComponent(lat) + "&lon=" + encodeURIComponent(lon), { method: "GET" });
    }

    return json(res, 404, { error: "Not found" });
  } catch (e) {
    return json(res, 502, { error: "Upstream connection failed", message: e && e.message ? e.message : String(e) });
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname.startsWith("/api/")) return handleApi(req, res, u);
  if (u.pathname === "/" || u.pathname === "/index.html") {
    return send(res, 200, INDEX, "text/html; charset=utf-8", {
      "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      "x-robots-tag": "noindex, nofollow"
    });
  }
  return send(res, 404, "Not found", "text/plain; charset=utf-8");
});

server.listen(PORT, "0.0.0.0", () => {});