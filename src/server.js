import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "0.0.0.0";
const CF_WORKER_URL = process.env.CF_WORKER_URL || "https://aizer-health-kb.aizer-im-kb.workers.dev";
const WORKER_API_KEY = process.env.WORKER_API_KEY || "";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || "").trim();
const ALLOWED_EMAILS = new Set(
  (process.env.ALLOWED_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);
const SESSION_SECRET = process.env.SESSION_SECRET || ADMIN_SECRET || crypto.randomBytes(32).toString("hex");
const SESSION_COOKIE_NAME = "aizer_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

const MAX_BODY_BYTES = 32 * 1024;
const MAX_QUERY_LEN = 500;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".avif": "image/avif",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-XSS-Protection": "0",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://accounts.google.com blob:",
    "worker-src 'self' blob:",
    "frame-src 'self' https://accounts.google.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https://*.googleusercontent.com",
    "connect-src 'self' https://huggingface.co https://*.hf.co https://*.huggingface.co https://cdn.jsdelivr.net https://accounts.google.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
};

const rateBuckets = new Map();
const sseClients = new Set();
const changelog = [];
const MAX_CHANGELOG = 25;

function recordAndBroadcast(entry) {
  const item = { ...entry, timestamp: new Date().toISOString() };
  changelog.unshift(item);
  if (changelog.length > MAX_CHANGELOG) changelog.length = MAX_CHANGELOG;

  const frame = `event: kb_update\ndata: ${JSON.stringify(item)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
}

function getClientIp(req) {
  if (TRUST_PROXY) {
    const cfIp = req.headers["cf-connecting-ip"];
    if (typeof cfIp === "string" && cfIp.trim()) return cfIp.trim();
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function isRateLimited(ip) {
  const now = Date.now();
  if (rateBuckets.size > 1000) {
    for (const [k, v] of rateBuckets) {
      if (now - v.start > RATE_LIMIT_WINDOW_MS) rateBuckets.delete(k);
    }
  }
  const entry = rateBuckets.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function fetchWorkerJson(endpoint, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (WORKER_API_KEY) headers["X-Worker-Key"] = WORKER_API_KEY;

  const res = await fetch(`${CF_WORKER_URL}${endpoint}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Worker ${endpoint} responded with ${res.status}`);
  return res.json();
}

async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new HttpError(413, "Payload too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function validateQuery(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new HttpError(400, "Query is required");
  }
  const q = raw.trim();
  if (q.length > MAX_QUERY_LEN) {
    throw new HttpError(400, `Query must be ${MAX_QUERY_LEN} characters or fewer`);
  }
  return q;
}

function requireAdmin(req) {
  if (!ADMIN_SECRET) {
    throw new HttpError(503, "Admin panel is disabled (ADMIN_SECRET not configured)");
  }
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const a = Buffer.from(token);
  const b = Buffer.from(ADMIN_SECRET);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new HttpError(401, "Invalid admin passkey");
  }
}

function getSecurityHeaders(req) {
  const headers = { ...SECURITY_HEADERS };
  const isHttps = req?.socket?.encrypted || (TRUST_PROXY && req?.headers?.["x-forwarded-proto"] === "https");
  if (isHttps) {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }
  return headers;
}

const STEP_SIMS_DIR = path.join(PUBLIC_DIR, "data", "step_sims");
const STEP_SIM_TEMPLATES_DIR = path.join(STEP_SIMS_DIR, "templates");
const STEP_SIM_IMG_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif"]);

function sanitizeSimId(raw) {
  if (typeof raw !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(raw.trim())) {
    throw new HttpError(400, "Invalid simulation id");
  }
  return raw.trim();
}

function requireSimEditAuth(req) {
  if (ADMIN_SECRET) {
    requireAdmin(req);
  }
}

function clampPct(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(100, Math.round(num * 100) / 100));
}

function sanitizeSimSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.slice(0, 50).map((s, idx) => {
    const hotspot = s?.hotspot && typeof s.hotspot === "object"
      ? {
          x: clampPct(s.hotspot.x),
          y: clampPct(s.hotspot.y),
          w: clampPct(s.hotspot.w),
          h: clampPct(s.hotspot.h),
        }
      : null;
    const highlights = Array.isArray(s?.highlights)
      ? s.highlights.slice(0, 20).map((h) => ({
          x: clampPct(h?.x),
          y: clampPct(h?.y),
          w: clampPct(h?.w),
          h: clampPct(h?.h),
        })).filter((h) => h.w > 0 && h.h > 0)
      : [];
    const arrows = Array.isArray(s?.arrows)
      ? s.arrows.slice(0, 20).map((a) => ({
          x1: clampPct(a?.x1),
          y1: clampPct(a?.y1),
          x2: clampPct(a?.x2),
          y2: clampPct(a?.y2),
          size: Math.max(0.3, Math.min(3, Number(a?.size) || 0.7)),
          color: typeof a?.color === "string" && /^#[0-9a-fA-F]{6}$/.test(a.color) ? a.color : "#F43F5E",
        }))
      : [];
    const texts = Array.isArray(s?.texts)
      ? s.texts.slice(0, 20).map((t) => ({
          x: clampPct(t?.x),
          y: clampPct(t?.y),
          text: typeof t?.text === "string" ? t.text.trim().slice(0, 200) : "",
          size: Math.max(1, Math.min(100, Number(t?.size) || 14)),
          color: typeof t?.color === "string" && /^#[0-9a-fA-F]{6}$/.test(t.color) ? t.color : "#FFFFFF",
          bgColor: typeof t?.bgColor === "string" && (/^#[0-9a-fA-F]{6}$/.test(t.bgColor) || t.bgColor === "transparent")
            ? t.bgColor
            : "#0F172A",
          bold: Boolean(t?.bold ?? true),
        })).filter((t) => t.text.length > 0)
      : [];
    return {
      id: typeof s?.id === "string" && s.id.trim() ? s.id.trim().slice(0, 64) : `step-${idx + 1}`,
      type: s?.type === "question" ? "question" : "photo",
      name: typeof s?.name === "string" ? s.name.trim().slice(0, 80) : "",
      imageUrl: typeof s?.imageUrl === "string" ? s.imageUrl.trim().slice(0, 512) : "",
      label: typeof s?.label === "string" ? s.label.trim().slice(0, 120) : "",
      instruction: typeof s?.instruction === "string" ? s.instruction.trim().slice(0, 500) : "",
      hint: typeof s?.hint === "string" ? s.hint.trim().slice(0, 300) : "",
      question: typeof s?.question === "string" ? s.question.trim().slice(0, 300) : "",
      yesTarget: typeof s?.yesTarget === "string" ? s.yesTarget.trim().slice(0, 64) : "next",
      noTarget: typeof s?.noTarget === "string" ? s.noTarget.trim().slice(0, 64) : "next",
      hotspot: hotspot && hotspot.w > 0 && hotspot.h > 0 ? hotspot : null,
      highlights,
      arrows,
      texts,
    };
  });
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return out;
}

function signSessionToken(user) {
  const payload = {
    username: user.username || user.email || "",
    display_name: user.display_name || user.name || user.username || "",
    role: user.role || "agent",
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC,
  };
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(b64).digest("base64url");
  return `${b64}.${sig}`;
}

function verifySessionToken(req) {
  const token = parseCookies(req)[SESSION_COOKIE_NAME];
  if (!token || !token.includes(".")) return null;
  const [b64, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(b64).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    if (!data?.username || (data.exp && data.exp < Math.floor(Date.now() / 1000))) return null;
    return {
      username: data.username,
      display_name: data.display_name || data.username,
      role: data.role || "agent",
    };
  } catch {
    return null;
  }
}

function requireUserAuth(req) {
  const user = verifySessionToken(req);
  if (!user) throw new HttpError(401, "Sign in required");
  return user;
}

function buildSessionCookieHeader(value, req, maxAge = SESSION_TTL_SEC) {
  const isHttps = req?.socket?.encrypted || (TRUST_PROXY && req?.headers?.["x-forwarded-proto"] === "https");
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (isHttps) parts.push("Secure");
  return parts.join("; ");
}

function sendJson(res, status, data, req = null, extraHeaders = {}) {
  res.writeHead(status, {
    ...getSecurityHeaders(req),
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const reqPath = parsedUrl.pathname;
  const clientIp = getClientIp(req);

  try {
    if (reqPath === "/health" && req.method === "GET") {
      return sendJson(res, 200, { status: "ok" }, req);
    }

    if (reqPath === "/changelog" && req.method === "GET") {
      return sendJson(res, 200, { entries: changelog }, req);
    }

    if (reqPath === "/events" && req.method === "GET") {
      req.setTimeout(0);
      res.setTimeout(0);
      res.writeHead(200, {
        ...getSecurityHeaders(req),
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      const ping = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          clearInterval(ping);
          sseClients.delete(res);
        }
      }, 25_000);
      req.on("close", () => {
        clearInterval(ping);
        sseClients.delete(res);
      });
      return;
    }

    if (reqPath === "/api/auth/me" && req.method === "GET") {
      const user = verifySessionToken(req);
      return sendJson(res, 200, {
        authEnabled: true,
        authenticated: Boolean(user),
        user,
      }, req);
    }

    if (reqPath === "/api/auth/login" && req.method === "POST") {
      if (isRateLimited(clientIp)) throw new HttpError(429, "Too many requests");
      const body = await readJsonBody(req);
      const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
      const password = typeof body?.password === "string" ? body.password : "";
      if (!username || !password) throw new HttpError(400, "Username and password are required");

      let user = null;
      if (username === "admin" && ADMIN_SECRET) {
        const a = Buffer.from(password);
        const b = Buffer.from(ADMIN_SECRET);
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
          user = { username: "admin", display_name: "Administrator", role: "admin" };
        }
      }

      if (!user) {
        const headers = { "Content-Type": "application/json" };
        if (WORKER_API_KEY) headers["X-Worker-Key"] = WORKER_API_KEY;
        const wRes = await fetch(`${CF_WORKER_URL}/auth/login`, {
          method: "POST",
          headers,
          body: JSON.stringify({ username, password }),
          signal: AbortSignal.timeout(8_000),
        });
        const wData = await wRes.json().catch(() => ({}));
        if (!wRes.ok || !wData.user) {
          throw new HttpError(wRes.status === 401 ? 401 : 401, wData.error || "Invalid username or password");
        }
        user = wData.user;
      }

      const token = signSessionToken(user);
      return sendJson(res, 200, { authenticated: true, user }, req, {
        "Set-Cookie": buildSessionCookieHeader(token, req, SESSION_TTL_SEC),
      });
    }

    if (reqPath === "/api/auth/users" && req.method === "GET") {
      requireAdmin(req);
      return sendJson(res, 200, await fetchWorkerJson("/auth/users"), req);
    }

    if (reqPath === "/api/auth/users" && (req.method === "POST" || req.method === "DELETE")) {
      requireAdmin(req);
      const body = await readJsonBody(req);
      const data = await fetchWorkerJson("/auth/users", {
        method: req.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return sendJson(res, 200, data, req);
    }

    if (reqPath === "/api/auth/google" && req.method === "POST") {
      if (!GOOGLE_CLIENT_ID) {
        throw new HttpError(503, "GOOGLE_CLIENT_ID is not configured");
      }
      const body = await readJsonBody(req);
      const credential = typeof body?.credential === "string" ? body.credential.trim() : "";
      if (!credential) throw new HttpError(400, "Missing Google credential");

      const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!verifyRes.ok) throw new HttpError(401, "Invalid Google token");
      const info = await verifyRes.json();

      if (info.aud !== GOOGLE_CLIENT_ID) {
        throw new HttpError(401, "Google token audience mismatch");
      }
      if (info.email_verified !== "true" || !info.email) {
        throw new HttpError(401, "Verified Gmail / Google email required");
      }
      const email = String(info.email).toLowerCase();
      if (ALLOWED_EMAILS.size > 0 && !ALLOWED_EMAILS.has(email)) {
        throw new HttpError(403, `Access denied for ${email}`);
      }

      const user = {
        email,
        name: info.name || email.split("@")[0],
        picture: info.picture || "",
      };
      const token = signSessionToken(user);
      return sendJson(res, 200, { authenticated: true, user }, req, {
        "Set-Cookie": buildSessionCookieHeader(token, req, SESSION_TTL_SEC),
      });
    }

    if (reqPath === "/api/auth/logout" && req.method === "POST") {
      return sendJson(res, 200, { ok: true }, req, {
        "Set-Cookie": buildSessionCookieHeader("", req, 0),
      });
    }

    if (reqPath === "/kb" && req.method === "GET") {
      requireUserAuth(req);
      return sendJson(res, 200, await fetchWorkerJson(`/kb${parsedUrl.search}`), req);
    }

    if (reqPath === "/search" && req.method === "POST") {
      requireUserAuth(req);
      if (isRateLimited(clientIp)) throw new HttpError(429, "Too many requests");
      const body = await readJsonBody(req);
      const query = validateQuery(body?.query);
      const topK = Math.min(20, Math.max(1, Number.parseInt(body?.topK ?? 5, 10) || 5));
      const department = typeof body?.department === "string" ? body.department.trim().slice(0, 64) : null;

      const data = await fetchWorkerJson("/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, topK, department }),
      });
      return sendJson(res, 200, data, req);
    }

    if (reqPath === "/api/step-sim/named-steps" && req.method === "GET") {
      requireUserAuth(req);
      const entries = [];
      const scanDir = (dirPath, sourceKind) => {
        if (!fs.existsSync(dirPath)) return;
        for (const file of fs.readdirSync(dirPath)) {
          if (!file.endsWith(".json")) continue;
          try {
            const doc = JSON.parse(fs.readFileSync(path.join(dirPath, file), "utf8"));
            const steps = Array.isArray(doc?.steps) ? doc.steps : [];
            const sourceTitle = doc?.name || doc?.title || doc?.id || file.replace(/\.json$/, "");
            steps.forEach((step, idx) => {
              const stepName = (step?.name || "").trim();
              if (!stepName) return;
              entries.push({
                key: `${sourceKind}:${file}:${idx}`,
                stepName,
                sourceTitle,
                followingCount: steps.length - 1 - idx,
                stepsFromHere: steps.slice(idx),
              });
            });
          } catch {}
        }
      };
      scanDir(STEP_SIMS_DIR, "sim");
      scanDir(STEP_SIM_TEMPLATES_DIR, "tpl");
      return sendJson(res, 200, { entries }, req);
    }

    if (reqPath === "/api/step-sim/templates" && req.method === "GET") {
      requireUserAuth(req);
      const templates = [];
      if (fs.existsSync(STEP_SIM_TEMPLATES_DIR)) {
        for (const file of fs.readdirSync(STEP_SIM_TEMPLATES_DIR)) {
          if (!file.endsWith(".json")) continue;
          try {
            const raw = JSON.parse(fs.readFileSync(path.join(STEP_SIM_TEMPLATES_DIR, file), "utf8"));
            templates.push(raw);
          } catch {}
        }
      }
      templates.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      return sendJson(res, 200, { templates }, req);
    }

    if (reqPath === "/api/step-sim/templates" && req.method === "POST") {
      requireSimEditAuth(req);
      const body = await readJsonBody(req, 512 * 1024);
      const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
      if (!name) throw new HttpError(400, "Template name is required");
      const id = sanitizeSimId(
        name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || `tpl-${Date.now()}`
      );
      const payload = {
        id,
        name,
        updatedAt: new Date().toISOString(),
        steps: sanitizeSimSteps(body?.steps),
      };
      fs.mkdirSync(STEP_SIM_TEMPLATES_DIR, { recursive: true });
      fs.writeFileSync(path.join(STEP_SIM_TEMPLATES_DIR, `${id}.json`), JSON.stringify(payload, null, 2), "utf8");
      return sendJson(res, 200, payload, req);
    }

    if (reqPath === "/api/step-sim/templates" && req.method === "DELETE") {
      requireSimEditAuth(req);
      const body = await readJsonBody(req);
      const id = sanitizeSimId(body?.id || "");
      const tplPath = path.join(STEP_SIM_TEMPLATES_DIR, `${id}.json`);
      if (fs.existsSync(tplPath)) fs.unlinkSync(tplPath);
      return sendJson(res, 200, { status: "deleted", id }, req);
    }

    if (reqPath === "/api/step-sim/images" && req.method === "GET") {
      requireUserAuth(req);
      const imagesRoot = path.join(STEP_SIMS_DIR, "images");
      const images = [];
      if (fs.existsSync(imagesRoot)) {
        for (const simFolder of fs.readdirSync(imagesRoot)) {
          const folderPath = path.join(imagesRoot, simFolder);
          if (!fs.statSync(folderPath).isDirectory()) continue;
          for (const file of fs.readdirSync(folderPath)) {
            const ext = path.extname(file).slice(1).toLowerCase();
            if (!STEP_SIM_IMG_EXTS.has(ext)) continue;
            const stat = fs.statSync(path.join(folderPath, file));
            images.push({
              url: `/data/step_sims/images/${simFolder}/${file}`,
              name: file,
              simId: simFolder,
              mtimeMs: stat.mtimeMs,
            });
          }
        }
      }
      images.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return sendJson(res, 200, { images }, req);
    }

    if (reqPath === "/api/step-sim" && req.method === "GET") {
      requireUserAuth(req);
      const simId = sanitizeSimId(parsedUrl.searchParams.get("id") || "");
      const simPath = path.join(STEP_SIMS_DIR, `${simId}.json`);
      if (!fs.existsSync(simPath)) {
        return sendJson(res, 200, { id: simId, title: "", steps: [] }, req);
      }
      const raw = fs.readFileSync(simPath, "utf8");
      return sendJson(res, 200, JSON.parse(raw), req);
    }

    if (reqPath === "/api/step-sim" && req.method === "POST") {
      requireSimEditAuth(req);
      const body = await readJsonBody(req, 256 * 1024);
      const simId = sanitizeSimId(body?.id || "");
      const payload = {
        id: simId,
        title: typeof body?.title === "string" ? body.title.trim().slice(0, 120) : "",
        updatedAt: new Date().toISOString(),
        steps: sanitizeSimSteps(body?.steps),
      };
      fs.mkdirSync(STEP_SIMS_DIR, { recursive: true });
      fs.writeFileSync(path.join(STEP_SIMS_DIR, `${simId}.json`), JSON.stringify(payload, null, 2), "utf8");
      return sendJson(res, 200, payload, req);
    }

    if (reqPath === "/api/step-sim/upload" && req.method === "POST") {
      requireSimEditAuth(req);
      const body = await readJsonBody(req, 12 * 1024 * 1024);
      const simId = sanitizeSimId(body?.id || "");
      const dataUrl = typeof body?.dataUrl === "string" ? body.dataUrl : "";
      const match = dataUrl.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+/=]+)$/);
      if (!match) {
        throw new HttpError(400, "Invalid image data URL");
      }
      let ext = match[1].toLowerCase().replace("jpeg", "jpg");
      if (ext === "svg+xml") throw new HttpError(400, "SVG uploads are not supported");
      if (!STEP_SIM_IMG_EXTS.has(ext)) {
        throw new HttpError(400, "Unsupported image format");
      }
      const buffer = Buffer.from(match[2], "base64");
      if (buffer.length > 8 * 1024 * 1024) {
        throw new HttpError(413, "Image exceeds 8MB limit");
      }
      const safeStem = (typeof body?.filename === "string" ? body.filename : "step")
        .replace(/\.[^.]+$/, "")
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 40) || "step";
      const fileName = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}-${safeStem}.${ext}`;
      const imgDir = path.join(STEP_SIMS_DIR, "images", simId);
      fs.mkdirSync(imgDir, { recursive: true });
      fs.writeFileSync(path.join(imgDir, fileName), buffer);
      return sendJson(res, 200, { imageUrl: `/data/step_sims/images/${simId}/${fileName}` }, req);
    }

    if (reqPath === "/admin/verify" && req.method === "POST") {
      requireAdmin(req);
      return sendJson(res, 200, { status: "ok" }, req);
    }

    if (reqPath === "/admin/item" && req.method === "POST") {
      requireAdmin(req);
      const body = await readJsonBody(req);
      const data = await fetchWorkerJson("/kb/item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      recordAndBroadcast({
        id: body?.id,
        action: body?.isNew ? "Added" : "Updated",
        entity: body?.entity || body?.id,
        department: body?.department || "Internal Medicine",
        category: body?.category || "",
      });
      return sendJson(res, 200, data, req);
    }

    if (reqPath === "/admin/item" && req.method === "DELETE") {
      requireAdmin(req);
      const body = await readJsonBody(req);
      const data = await fetchWorkerJson("/kb/item", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: body?.id }),
      });
      recordAndBroadcast({
        id: body?.id,
        action: "Deleted",
        entity: body?.entity || body?.id,
        department: body?.department || "Internal Medicine",
        category: body?.category || "",
      });
      return sendJson(res, 200, data, req);
    }

    if (req.method === "GET") {
      const relInput = reqPath === "/" ? "index.html" : reqPath.replace(/^\/+/, "");
      const safeRel = path.normalize(relInput).replace(/^(\.\.(\/|\\|$))+/, "");
      const filePath = path.resolve(PUBLIC_DIR, safeRel);
      const baseName = path.basename(filePath);
      if (
        filePath.startsWith(PUBLIC_DIR + path.sep) &&
        !baseName.startsWith(".") &&
        fs.existsSync(filePath) &&
        fs.statSync(filePath).isFile()
      ) {
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
          ...getSecurityHeaders(req),
          "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        });
        return fs.createReadStream(filePath).pipe(res);
      }
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    if (err instanceof HttpError) {
      return sendJson(res, err.status, { error: err.message });
    }
    console.error("Request error:", err?.name || "Error", err?.message || "");
    sendJson(res, 500, { error: "Internal server error" });
  }
});

server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;

server.listen(PORT, HOST, () => {
  console.log(`Aizer Health ONNX Decision Engine listening on http://${HOST}:${PORT}`);
});
