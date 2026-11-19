export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // 1. Endpoint to ingest/sync kb_data.json into D1 & Vectorize
    if (url.pathname === "/ingest" && request.method === "POST") {
      const authHeader = request.headers.get("Authorization");
      if (authHeader !== `Bearer ${env.INGEST_SECRET}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      const chunks = await request.json();
      await ingestData(chunks, env);
      return Response.json({ status: "success", indexed: chunks.length }, { headers: corsHeaders });
    }

    // 2. Hybrid Search Endpoint
    if (url.pathname === "/search" && request.method === "POST") {
      const { query, topK = 5 } = await request.json();
      if (!query || !query.trim()) {
        return Response.json({ error: "Query is required" }, { status: 400, headers: corsHeaders });
      }

      const results = await hybridSearch(query.trim(), topK, env);
      return Response.json({ query, results }, { headers: corsHeaders });
    }

    return new Response("Aizer Health KB Hybrid Search Engine Active", { headers: corsHeaders });
  },
};

/**
 * Ingests chunks into D1 (SQLite + FTS5) and Cloudflare Vectorize
 */
async function ingestData(chunks, env) {
  // Clear existing records
  await env.DB.batch([
    env.DB.prepare("DELETE FROM kb_chunks"),
    env.DB.prepare("DELETE FROM kb_fts"),
  ]);

  const vectors = [];

  for (const item of chunks) {
    const keywordsStr = item.keywords.join(", ");
    const rulesStr = JSON.stringify(item.rules);

    // Insert into D1 relational & FTS5 tables
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO kb_chunks (id, category, entity, keywords, content, rules) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(item.id, item.category, item.entity, keywordsStr, item.content, rulesStr),
      env.DB.prepare(
        "INSERT INTO kb_fts (id, category, entity, keywords, content) VALUES (?, ?, ?, ?, ?)"
      ).bind(item.id, item.category, item.entity, keywordsStr, item.content),
    ]);

    // Generate embedding using Workers AI (384 dimensions)
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

  // Upsert vectors into Cloudflare Vectorize
  await env.VECTORIZE.upsert(vectors);
}

/**
 * Executes Vector Search + D1 BM25 Keyword Search in parallel and merges via RRF
 */
async function hybridSearch(query, topK, env) {
  // Sanitize query for FTS5 MATCH syntax
  const ftsQuery = query
    .replace(/[^\w\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .map((w) => `"${w}"*`)
    .join(" OR ");

  // Run Vector Search and Keyword Search concurrently
  const [vectorResults, keywordResults] = await Promise.all([
    runVectorSearch(query, topK * 2, env),
    ftsQuery ? runKeywordSearch(ftsQuery, topK * 2, env) : Promise.resolve([]),
  ]);

  // Reciprocal Rank Fusion (RRF)
  const k = 60;
  const scores = new Map();

  vectorResults.forEach((item, index) => {
    const rrfScore = 1 / (k + index + 1);
    scores.set(item.id, (scores.get(item.id) || 0) + rrfScore);
  });

  keywordResults.forEach((item, index) => {
    const rrfScore = 1 / (k + index + 1);
    // Boost keyword exact matches slightly (1.2x) for medical/insurance codes
    scores.set(item.id, (scores.get(item.id) || 0) + rrfScore * 1.2);
  });

  // Sort IDs by combined RRF score descending
  const rankedIds = Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id, score]) => ({ id, rrf_score: Number(score.toFixed(5)) }));

  if (rankedIds.length === 0) return [];

  // Fetch full chunk data from D1
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