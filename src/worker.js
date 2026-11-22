const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (data, status = 200) => Response.json(data, { status, headers: corsHeaders });

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // 1. Ingest/Sync Endpoint
    if (url.pathname === "/ingest" && request.method === "POST") {
      const authHeader = request.headers.get("Authorization");
      if (authHeader !== `Bearer ${env.INGEST_SECRET}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      const chunks = await request.json();
      await ingestData(chunks, env);
      return json({ status: "success", indexed: chunks.length });
    }

    // 2. Fetch all structured KB items for UI Navigation Tabs
    if (url.pathname === "/kb" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM kb_chunks").all();
      const formatted = results.map((r) => ({
        id: r.id,
        category: r.category,
        entity: r.entity,
        keywords: r.keywords,
        content: r.content,
        rules: JSON.parse(r.rules),
      }));
      return json({ items: formatted });
    }

    // 3. Hybrid Search Endpoint (D1 FTS5 + Vectorize + RRF)
    if (url.pathname === "/search" && request.method === "POST") {
      const { query, topK = 5 } = await request.json();
      if (!query || !query.trim()) {
        return json({ error: "Query is required" }, 400);
      }

      const results = await hybridSearch(query.trim(), topK, env);
      return json({ query: query.trim(), results });
    }

    // 4. Serve Frontend UI from ./public
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Aizer Health KB Engine Active", { headers: corsHeaders });
  },
};

async function ingestData(chunks, env) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM kb_chunks"),
    env.DB.prepare("DELETE FROM kb_fts"),
  ]);

  const vectors = [];

  for (const item of chunks) {
    const keywordsStr = item.keywords.join(", ");
    const rulesStr = JSON.stringify(item.rules);

    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO kb_chunks (id, category, entity, keywords, content, rules) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(item.id, item.category, item.entity, keywordsStr, item.content, rulesStr),
      env.DB.prepare(
        "INSERT INTO kb_fts (id, category, entity, keywords, content) VALUES (?, ?, ?, ?, ?)"
      ).bind(item.id, item.category, item.entity, keywordsStr, item.content),
    ]);

    const textToEmbed = `${item.category} - ${item.entity}. Keywords: ${keywordsStr}. ${item.content}`;
    const embeddingResponse = await env.AI.run("@cf/baai/bge-small-en-v1.5", {
      text: [textToEmbed],
    });

    vectors.push({
      id: item.id,
      values: embeddingResponse.data[0],
      metadata: {
        category: item.category,
        entity: item.entity,
      },
    });
  }

  await env.VECTORIZE.upsert(vectors);
}

async function hybridSearch(query, topK, env) {
  const ftsQuery = query
    .replace(/[^\w\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .map((w) => `"${w}"*`)
    .join(" OR ");

  const [vectorResults, keywordResults] = await Promise.all([
    runVectorSearch(query, topK * 2, env),
    ftsQuery ? runKeywordSearch(ftsQuery, topK * 2, env) : Promise.resolve([]),
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

  const rankedIds = Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id, score]) => ({ id, rrf_score: Number(score.toFixed(5)) }));

  if (rankedIds.length === 0) return [];

  const placeholders = rankedIds.map(() => "?").join(",");
  const { results: rows } = await env.DB.prepare(
    `SELECT * FROM kb_chunks WHERE id IN (${placeholders})`
  )
    .bind(...rankedIds.map((r) => r.id))
    .all();

  const rowMap = new Map(rows.map((r) => [r.id, r]));

  return rankedIds
    .map((r) => {
      const row = rowMap.get(r.id);
      if (!row) return null;
      return {
        id: row.id,
        score: r.rrf_score,
        category: row.category,
        entity: row.entity,
        content: row.content,
        rules: JSON.parse(row.rules),
      };
    })
    .filter(Boolean);
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