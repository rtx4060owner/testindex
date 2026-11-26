const DEFAULT_WORKER_URL = "https://aizer-health-kb.aizer-im-kb.workers.dev";
const SESSION_COOKIE_NAME = "aizer_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 7;

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return Response.json(data, {
    status,
    headers: {
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...extraHeaders,
    },
  });
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const maxLen = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < maxLen; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function toBase64Url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return toBase64Url(new Uint8Array(sig));
}

function parseCookies(request) {
  const raw = request.headers.get("Cookie") || "";
  const out = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return out;
}

function getSessionSecret(env) {
  return env.SESSION_SECRET || env.ADMIN_SECRET || "aizer-pages-fallback-secret";
}

async function signSessionToken(user, env) {
  const payload = {
    username: user.username || "",
    display_name: user.display_name || user.username || "",
    role: user.role || "agent",
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC,
  };
  const b64 = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(getSessionSecret(env), b64);
  return `${b64}.${sig}`;
}

async function verifySessionToken(request, env) {
  const token = parseCookies(request)[SESSION_COOKIE_NAME];
  if (!token || !token.includes(".")) return null;
  const [b64, sig] = token.split(".");
  const expected = await hmacSign(getSessionSecret(env), b64);
  if (!timingSafeEqualStr(sig, expected)) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(fromBase64Url(b64)));
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

async function requireUserAuth(request, env) {
  const user = await verifySessionToken(request, env);
  if (!user) return jsonResponse({ error: "Sign in required" }, 401);
  return null;
}

function buildCookieHeader(value, maxAge = SESSION_TTL_SEC) {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`;
}

function checkAdmin(request, env) {
  if (!env.ADMIN_SECRET) {
    return jsonResponse({ error: "Admin panel is disabled (ADMIN_SECRET not configured)" }, 503);
  }
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!timingSafeEqualStr(token, env.ADMIN_SECRET)) {
    return jsonResponse({ error: "Invalid admin passkey" }, 401);
  }
  return null;
}

async function proxyWorker(endpoint, env, options = {}) {
  const baseUrl = env.CF_WORKER_URL || DEFAULT_WORKER_URL;
  const headers = { ...(options.headers || {}) };
  if (env.WORKER_API_KEY) {
    headers["X-Worker-Key"] = env.WORKER_API_KEY;
  }
  const res = await fetch(`${baseUrl}${endpoint}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  return jsonResponse(data, res.status);
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const reqPath = url.pathname;
  const method = request.method;

  if (reqPath === "/health" && method === "GET") {
    return jsonResponse({ status: "ok", runtime: "cloudflare-pages" });
  }

  if (reqPath === "/api/auth/me" && method === "GET") {
    const user = await verifySessionToken(request, env);
    return jsonResponse({
      authEnabled: true,
      authenticated: Boolean(user),
      user,
    });
  }

  if (reqPath === "/api/auth/login" && method === "POST") {
    const body = await request.json().catch(() => null);
    const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!username || !password) {
      return jsonResponse({ error: "Username and password are required" }, 400);
    }

    let user = null;
    if (username === "admin" && env.ADMIN_SECRET && timingSafeEqualStr(password, env.ADMIN_SECRET)) {
      user = { username: "admin", display_name: "Administrator", role: "admin" };
    }

    if (!user) {
      const baseUrl = env.CF_WORKER_URL || DEFAULT_WORKER_URL;
      const headers = { "Content-Type": "application/json" };
      if (env.WORKER_API_KEY) headers["X-Worker-Key"] = env.WORKER_API_KEY;
      const wRes = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers,
        body: JSON.stringify({ username, password }),
      });
      const wData = await wRes.json().catch(() => ({}));
      if (!wRes.ok || !wData.user) {
        return jsonResponse({ error: wData.error || "Invalid username or password" }, 401);
      }
      user = wData.user;
    }

    const token = await signSessionToken(user, env);
    return jsonResponse({ authenticated: true, user }, 200, {
      "Set-Cookie": buildCookieHeader(token, SESSION_TTL_SEC),
    });
  }

  if (reqPath === "/api/auth/logout" && method === "POST") {
    return jsonResponse({ ok: true }, 200, {
      "Set-Cookie": buildCookieHeader("", 0),
    });
  }

  if (reqPath === "/api/auth/users" && method === "GET") {
    const err = checkAdmin(request, env);
    if (err) return err;
    return proxyWorker("/auth/users", env);
  }

  if (reqPath === "/api/auth/users" && (method === "POST" || method === "DELETE")) {
    const err = checkAdmin(request, env);
    if (err) return err;
    const body = await request.text();
    return proxyWorker("/auth/users", env, {
      method,
      headers: { "Content-Type": "application/json" },
      body,
    });
  }

  if (reqPath === "/changelog" && method === "GET") {
    return jsonResponse([]);
  }

  if (reqPath === "/kb" && method === "GET") {
    const authErr = await requireUserAuth(request, env);
    if (authErr) return authErr;
    return proxyWorker("/kb", env);
  }

  if (reqPath === "/search" && method === "POST") {
    const authErr = await requireUserAuth(request, env);
    if (authErr) return authErr;
    const body = await request.json().catch(() => null);
    if (!body || typeof body.query !== "string" || !body.query.trim()) {
      return jsonResponse({ error: "Query is required" }, 400);
    }
    return proxyWorker("/search", env, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: body.query.trim().slice(0, 500),
        topK: Math.min(20, Math.max(1, Number.parseInt(body.topK ?? 5, 10) || 5)),
        department: typeof body.department === "string" && body.department.trim()
          ? body.department.trim().slice(0, 64)
          : null,
      }),
    });
  }

  if (reqPath === "/admin/verify" && method === "POST") {
    const err = checkAdmin(request, env);
    if (err) return err;
    return jsonResponse({ status: "ok" });
  }

  if (reqPath === "/admin/item" && (method === "POST" || method === "DELETE")) {
    const err = checkAdmin(request, env);
    if (err) return err;
    const body = await request.text();
    return proxyWorker("/kb/item", env, {
      method,
      headers: { "Content-Type": "application/json" },
      body,
    });
  }

  if (reqPath === "/api/step-sim" && method === "GET") {
    const authErr = await requireUserAuth(request, env);
    if (authErr) return authErr;
    const id = (url.searchParams.get("id") || "").trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
      return jsonResponse({ error: "Invalid simulation id" }, 400);
    }
    const assetRes = await env.ASSETS.fetch(new URL(`/data/step_sims/${id}.json`, url.origin));
    if (assetRes.ok) {
      const data = await assetRes.json().catch(() => null);
      if (data) return jsonResponse(data);
    }
    return jsonResponse({ id, title: "", steps: [] });
  }

  if ((reqPath === "/api/step-sim" || reqPath === "/api/step-sim/upload") && method === "POST") {
    return jsonResponse(
      { error: "Saving Step Sims on Cloudflare Pages requires R2/KV storage (edit locally and redeploy, or bind KV/R2)." },
      501
    );
  }

  return env.ASSETS.fetch(request);
}
