// Railway pairing gate for OpenMausBot.
// GET /_railway/pair, behind HTTP basic auth (OMB_ADMIN_USER / OMB_ADMIN_PASSWORD),
// asks the server on loopback for a one-time admin pairing code (the same call
// `openmausbot pair` makes) and redirects the browser to /pair#code=..., where
// one click pairs it. Listens on 127.0.0.1 only; Caddy routes /_railway/* here.
import http from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";

const PORT = Number(process.env.OMB_PAIR_GATE_PORT || 8801);
const OMB_PORT = Number(process.env.OMB_PORT || 8799);
const USER = process.env.OMB_ADMIN_USER || "admin";
const PASSWORD = process.env.OMB_ADMIN_PASSWORD || "";
delete process.env.OMB_ADMIN_PASSWORD;

const digest = (s) => createHash("sha256").update(String(s)).digest();
const same = (a, b) => timingSafeEqual(digest(a), digest(b));

// 10 wrong passwords from one client address lock it out for 15 minutes.
const failures = new Map();
const LIMIT = 10, WINDOW_MS = 15 * 60 * 1000;
function clientOf(req) {
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real) return real.trim();
  const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return xff[0] || req.socket.remoteAddress || "unknown";
}
function locked(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW_MS) { failures.delete(ip); return false; }
  return f.count >= LIMIT;
}
function fail(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > WINDOW_MS) failures.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY", ...headers });
  res.end(body);
}
const page = (title, text) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.4rem">${title}</h1><p>${text}</p></body>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://x");
  if (url.pathname !== "/_railway/pair" || (req.method !== "GET" && req.method !== "HEAD")) {
    return send(res, 404, page("Not found", "The pairing gate lives at <code>/_railway/pair</code>."));
  }
  const ip = clientOf(req);
  if (!PASSWORD) return send(res, 503, page("Pairing gate disabled", "OMB_ADMIN_PASSWORD is not set on this service."));
  if (locked(ip)) return send(res, 429, page("Too many attempts", "Wait 15 minutes and try again."));
  const auth = String(req.headers.authorization || "");
  let ok = false;
  if (auth.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i >= 0) ok = same(decoded.slice(0, i), USER) & same(decoded.slice(i + 1), PASSWORD) ? true : false;
  }
  if (!ok) {
    if (auth) { fail(ip); console.warn(`[pair-gate] wrong password from ${ip}`); }
    return send(res, 401, page("Sign in", `Use the user <code>${USER}</code> and the <code>OMB_ADMIN_PASSWORD</code> value from this service's Variables tab on Railway.`), { "www-authenticate": 'Basic realm="OpenMausBot pairing", charset="UTF-8"' });
  }
  failures.delete(ip);
  try {
    const r = await fetch(`http://127.0.0.1:${OMB_PORT}/api/auth/pairing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // No scopes: the server default, the same full-access code `openmausbot pair` mints.
      body: JSON.stringify({ label: url.searchParams.get("label") || "Railway browser" }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.code) throw new Error(`server answered ${r.status}: ${body.error || "no code"}`);
    console.log(`[pair-gate] issued a one-time admin pairing code to ${ip}`);
    // Relative redirect: the browser stays on the address it used.
    return send(res, 302, page("Pairing", `Continue to <a href="/pair#code=${body.code}">/pair</a>.`), { location: `/pair#code=${body.code}` });
  } catch (error) {
    console.error(`[pair-gate] could not open a pairing code: ${error.message}`);
    return send(res, 502, page("Server not ready", "OpenMausBot is still starting. Reload in a few seconds."));
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`[pair-gate] listening on 127.0.0.1:${PORT}`));
