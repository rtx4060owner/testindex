const baseHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const json = (data, status = 200) => Response.json(data, { status, headers: baseHeaders });

function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const maxLen = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLen; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

function isAuthorized(request, env) {
  if (!env.WORKER_API_KEY) return true;
  return timingSafeEqualStr(request.headers.get("X-Worker-Key") || "", env.WORKER_API_KEY);
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return `pbkdf2:${toHex(salt)}:${toHex(new Uint8Array(bits))}`;
}

async function verifyPassword(password, stored) {
  if (typeof stored !== "string" || !stored.startsWith("pbkdf2:")) return false;
  const parts = stored.split(":");
  if (parts.length !== 3) return false;
  const salt = fromHex(parts[1]);
  const expectedHex = parts[2];
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return timingSafeEqualStr(toHex(new Uint8Array(bits)), expectedHex);
}

async function ensureUsersTable(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'agent', password_hash TEXT NOT NULL, created_at TEXT NOT NULL)"
  ).run();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Ingest/Sync Endpoint (supports ?append=true for batched ingestion)
    if (url.pathname === "/ingest" && request.method === "POST") {
      const authHeader = request.headers.get("Authorization") || "";
      if (!env.INGEST_SECRET || !timingSafeEqualStr(authHeader, `Bearer ${env.INGEST_SECRET}`)) {
        return new Response("Unauthorized", { status: 401, headers: baseHeaders });
      }

      const append = url.searchParams.get("append") === "true";
      const chunks = await request.json();
      await ingestData(chunks, env, append);
      return json({ status: "success", indexed: chunks.length, append });
    }

    // 2. Fetch all structured KB items (with optional ?department= filter)
    if (url.pathname === "/kb" && request.method === "GET") {
      if (!isAuthorized(request, env)) return new Response("Unauthorized", { status: 401, headers: baseHeaders });
      const deptFilter = url.searchParams.get("department");
      const stmt = deptFilter && deptFilter !== "ALL"
        ? env.DB.prepare("SELECT * FROM kb_chunks WHERE department = ?").bind(deptFilter)
        : env.DB.prepare("SELECT * FROM kb_chunks");

      const { results } = await stmt.all();
      const formatted = results.map((r) => ({
        id: r.id,
        department: r.department || "Internal Medicine",
        category: r.category,
        entity: r.entity,
        keywords: r.keywords,
        content: r.content,
        rules: JSON.parse(r.rules),
      }));
      return json({ items: formatted });
    }

    // 3. Hybrid Search Endpoint (D1 FTS5 + Vectorize + RRF + Department Scope)
    if (url.pathname === "/search" && request.method === "POST") {
      if (!isAuthorized(request, env)) return new Response("Unauthorized", { status: 401, headers: baseHeaders });
      const body = await request.json();
      const query = typeof body?.query === "string" ? body.query.trim() : "";
      if (!query || query.length > 500) {
        return json({ error: "Valid query (1-500 chars) is required" }, 400);
      }
      const topK = Math.min(20, Math.max(1, Number.parseInt(body?.topK ?? 5, 10) || 5));
      const department = typeof body?.department === "string" ? body.department.trim().slice(0, 64) : null;

      const results = await hybridSearch(query, topK, department, env);
      return json({ query, department, results });
    }

    // 4. Upsert a single KB item (Admin)
    if (url.pathname === "/kb/item" && request.method === "POST") {
      if (!isAuthorized(request, env)) return new Response("Unauthorized", { status: 401, headers: baseHeaders });
      const item = await request.json();
      if (!item?.id || !item?.entity || !item?.content) {
        return json({ error: "id, entity, and content are required" }, 400);
      }
      const dept = item.department || "Internal Medicine";
      const category = item.category || "Special Operational Policies";
      const keywordsArr = Array.isArray(item.keywords)
        ? item.keywords
        : String(item.keywords || "").split(",").map((k) => k.trim()).filter(Boolean);
      const keywordsStr = keywordsArr.join(", ");
      const rulesStr = JSON.stringify(item.rules && typeof item.rules === "object" ? item.rules : {});

      await env.DB.batch([
        env.DB.prepare("DELETE FROM kb_chunks WHERE id = ?").bind(item.id),
        env.DB.prepare("DELETE FROM kb_fts WHERE id = ?").bind(item.id),
        env.DB.prepare(
          "INSERT INTO kb_chunks (id, department, category, entity, keywords, content, rules) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(item.id, dept, category, item.entity, keywordsStr, item.content, rulesStr),
        env.DB.prepare(
          "INSERT INTO kb_fts (id, department, category, entity, keywords, content) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(item.id, dept, category, item.entity, keywordsStr, item.content),
      ]);

      const textToEmbed = `[${dept}] ${category} - ${item.entity}. Keywords: ${keywordsStr}. ${item.content}`;
      const emb = await env.AI.run("@cf/baai/bge-small-en-v1.5", { text: [textToEmbed] });
      await env.VECTORIZE.upsert([{
        id: item.id,
        values: emb.data[0],
        metadata: { department: dept, category, entity: item.entity },
      }]);

      return json({ status: "saved", id: item.id });
    }

    // 5. Delete a single KB item (Admin)
    if (url.pathname === "/kb/item" && request.method === "DELETE") {
      if (!isAuthorized(request, env)) return new Response("Unauthorized", { status: 401, headers: baseHeaders });
      const body = await request.json();
      const id = typeof body?.id === "string" ? body.id.trim() : "";
      if (!id) return json({ error: "id is required" }, 400);

      await env.DB.batch([
        env.DB.prepare("DELETE FROM kb_chunks WHERE id = ?").bind(id),
        env.DB.prepare("DELETE FROM kb_fts WHERE id = ?").bind(id),
      ]);
      await env.VECTORIZE.deleteByIds([id]);

      return json({ status: "deleted", id });
    }

    // 6. User Auth: Login
    if (url.pathname === "/auth/login" && request.method === "POST") {
      if (!isAuthorized(request, env)) return new Response("Unauthorized", { status: 401, headers: baseHeaders });
      await ensureUsersTable(env);
      const body = await request.json().catch(() => null);
      const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
      const password = typeof body?.password === "string" ? body.password : "";
      if (!username || !password) return json({ error: "Username and password are required" }, 400);

      const row = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
      if (!row || !(await verifyPassword(password, row.password_hash))) {
        return json({ error: "Invalid username or password" }, 401);
      }
      return json({
        ok: true,
        user: {
          id: row.id,
          username: row.username,
          display_name: row.display_name,
          role: row.role,
        },
      });
    }

    // 7. User Auth: List Users (Admin)
    if (url.pathname === "/auth/users" && request.method === "GET") {
      if (!isAuthorized(request, env)) return new Response("Unauthorized", { status: 401, headers: baseHeaders });
      await ensureUsersTable(env);
      const { results } = await env.DB.prepare(
        "SELECT id, username, display_name, role, created_at FROM users ORDER BY created_at DESC"
      ).all();
      return json({ users: results || [] });
    }

    // 8. User Auth: Create/Update User (Admin)
    if (url.pathname === "/auth/users" && request.method === "POST") {
      if (!isAuthorized(request, env)) return new Response("Unauthorized", { status: 401, headers: baseHeaders });
      await ensureUsersTable(env);
      const body = await request.json().catch(() => null);
      const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
      const displayName = typeof body?.display_name === "string" && body.display_name.trim()
        ? body.display_name.trim().slice(0, 80)
        : username;
      const password = typeof body?.password === "string" ? body.password : "";
      const role = body?.role === "admin" ? "admin" : "agent";

      if (!username || username.length > 80 || !/^[a-z0-9._@-]+$/.test(username)) {
        return json({ error: "Valid username (letters, numbers, . _ @ -) is required" }, 400);
      }
      if (!password || password.length < 4) {
        return json({ error: "Password must be at least 4 characters" }, 400);
      }

      const id = `usr_${crypto.randomUUID().slice(0, 8)}`;
      const passwordHash = await hashPassword(password);
      const createdAt = new Date().toISOString();

      await env.DB.prepare(
        "INSERT INTO users (id, username, display_name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET display_name=excluded.display_name, role=excluded.role, password_hash=excluded.password_hash"
      ).bind(id, username, displayName, role, passwordHash, createdAt).run();

      return json({ status: "saved", username, display_name: displayName, role });
    }

    // 9. User Auth: Delete User (Admin)
    if (url.pathname === "/auth/users" && request.method === "DELETE") {
      if (!isAuthorized(request, env)) return new Response("Unauthorized", { status: 401, headers: baseHeaders });
      await ensureUsersTable(env);
      const body = await request.json().catch(() => null);
      const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
      if (!username) return json({ error: "username is required" }, 400);
      await env.DB.prepare("DELETE FROM users WHERE username = ?").bind(username).run();
      return json({ status: "deleted", username });
    }

    return new Response("Aizer Health KB Engine Active", { headers: baseHeaders });
  },
};

async function ingestData(chunks, env, append = false) {
  if (!append) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM kb_chunks"),
      env.DB.prepare("DELETE FROM kb_fts"),
    ]);
  }

  const vectors = [];

  for (const item of chunks) {
    const dept = item.department || "Internal Medicine";
    const keywordsStr = item.keywords.join(", ");
    const rulesStr = JSON.stringify(item.rules);

    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO kb_chunks (id, department, category, entity, keywords, content, rules) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(item.id, dept, item.category, item.entity, keywordsStr, item.content, rulesStr),
      env.DB.prepare(
        "INSERT INTO kb_fts (id, department, category, entity, keywords, content) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(item.id, dept, item.category, item.entity, keywordsStr, item.content),
    ]);

    const textToEmbed = `[${dept}] ${item.category} - ${item.entity}. Keywords: ${keywordsStr}. ${item.content}`;
    const embeddingResponse = await env.AI.run("@cf/baai/bge-small-en-v1.5", {
      text: [textToEmbed],
    });

    vectors.push({
      id: item.id,
      values: embeddingResponse.data[0],
      metadata: {
        department: dept,
        category: item.category,
        entity: item.entity,
      },
    });
  }

  for (let i = 0; i < vectors.length; i += 50) {
    await env.VECTORIZE.upsert(vectors.slice(i, i + 50));
  }
}

async function hybridSearch(query, topK, department, env) {
  const ftsQuery = query
    .replace(/[^\w\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .map((w) => `"${w}"*`)
    .join(" OR ");

  const fetchLimit = department ? topK * 4 : topK * 2;

  const [vectorResults, keywordResults] = await Promise.all([
    runVectorSearch(query, fetchLimit, env),
    ftsQuery ? runKeywordSearch(ftsQuery, fetchLimit, env) : Promise.resolve([]),
  ]);

  const k = 60;
  const scores = new Map();

  vectorResults.forEach((item, index) => {
    const rrfScore = 1 / (k + index + 1);
    scores.set(item.id, (scores.get(item.id) || 0) + rrfScore);
  });

  keywordResults.forEach((item, index) => {
    const rrfScore = 1 / (k + index + 1);
    scores.set(item.id, (scores.get(item.id) || 0) + rrfScore * 1.2);
  });

  const candidateIds = Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, fetchLimit)
    .map(([id, score]) => ({ id, rrf_score: Number(score.toFixed(5)) }));

  if (candidateIds.length === 0) return [];

  const placeholders = candidateIds.map(() => "?").join(",");
  let sql = `SELECT * FROM kb_chunks WHERE id IN (${placeholders})`;
  const bindings = candidateIds.map((r) => r.id);

  if (department && department !== "ALL") {
    sql += ` AND department = ?`;
    bindings.push(department);
  }

  const { results: rows } = await env.DB.prepare(sql).bind(...bindings).all();
  const rowMap = new Map(rows.map((r) => [r.id, r]));

  return candidateIds
    .map((r) => {
      const row = rowMap.get(r.id);
      if (!row) return null;
      return {
        id: row.id,
        department: row.department || "Internal Medicine",
        score: r.rrf_score,
        category: row.category,
        entity: row.entity,
        content: row.content,
        rules: JSON.parse(row.rules),
      };
    })
    .filter(Boolean)
    .slice(0, topK);
}

async function runVectorSearch(query, limit, env) {
  const embedding = await env.AI.run("@cf/baai/bge-small-en-v1.5", {
    text: [query],
  });
  const matches = await env.VECTORIZE.query(embedding.data[0], {
    topK: limit,
    returnMetadata: "none",
  });
  return matches.matches || [];
}

async function runKeywordSearch(ftsQuery, limit, env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, bm25(kb_fts) AS rank FROM kb_fts WHERE kb_fts MATCH ? ORDER BY rank LIMIT ?`
    )
      .bind(ftsQuery, limit)
      .all();
    return results || [];
  } catch (e) {
    return [];
  }
}