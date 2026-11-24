import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env, pipeline } from "@huggingface/transformers";
import {
  INTENT_LABELS,
  DEFAULT_ROUTING_LABELS,
  YES_NO_LABELS,
  classifyIntentRule,
  checkDeterministicRules,
} from "./rules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "0.0.0.0";
const CF_WORKER_URL = process.env.CF_WORKER_URL || "https://aizer-health-kb.aizer-im-kb.workers.dev";
const WORKER_API_KEY = process.env.WORKER_API_KEY || "";
const TRUST_PROXY = process.env.TRUST_PROXY === "true";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_QUERY_LEN = 500;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;

const NLI_MODEL = "Xenova/nli-deberta-v3-small";
const LOCAL_QA_MODEL = path.join(ROOT_DIR, "models", "deberta-v3-base-squad2-onnx");
const HAS_LOCAL_QA = fs.existsSync(LOCAL_QA_MODEL);
const QA_MODEL = HAS_LOCAL_QA ? LOCAL_QA_MODEL : "Xenova/distilbert-base-cased-distilled-squad";

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
    "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
};

const rateBuckets = new Map();

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

env.allowLocalModels = true;

console.log(`Loading INT8 ONNX NLI model (${NLI_MODEL})...`);
const classifier = await pipeline("zero-shot-classification", NLI_MODEL, { dtype: "q8" });

console.log(`Loading ONNX QA model (${QA_MODEL})...`);
const qaExtractor = await pipeline("question-answering", QA_MODEL, {
  dtype: HAS_LOCAL_QA ? "fp32" : "q8",
  local_files_only: HAS_LOCAL_QA,
});

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

async function readJsonBody(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new HttpError(413, "Payload too large");
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

function getSecurityHeaders(req) {
  const headers = { ...SECURITY_HEADERS };
  const isHttps = req?.socket?.encrypted || (TRUST_PROXY && req?.headers?.["x-forwarded-proto"] === "https");
  if (isHttps) {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }
  return headers;
}

function sendJson(res, status, data, req = null) {
  res.writeHead(status, {
    ...getSecurityHeaders(req),
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(data));
}

function buildNliHypothesis(query, proposedAnswer) {
  const cleanedQ = query.trim().replace(/\?+$/, "");
  const factMatch = cleanedQ.match(/^(?:what|where|when|who)\s+(?:is|are)\s+(.+)$/i);
  if (factMatch) return `${factMatch[1]} is ${proposedAnswer}`;
  return `${proposedAnswer} (${cleanedQ})`;
}

async function verifyAnswerWithNli(query, proposedAnswer, chunks, detReason = null) {
  const topChunks = chunks.slice(0, 3);
  const hypothesis = buildNliHypothesis(query, proposedAnswer);
  const scored = await Promise.all(
    topChunks.map(async (c) => {
      const out = await classifier(`${c.entity}. ${c.content}`, [hypothesis], {
        multi_label: true,
        hypothesis_template: "{}",
      });
      return { chunk: c, score: out.scores?.[0] ?? 0 };
    }),
  );
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const score = Number(best.score.toFixed(4));
  const supported = score >= 0.45;
  return {
    supported,
    verdict: supported ? "Verified" : "Needs Review",
    confidence: score,
    reason: detReason || (supported
      ? `Based on ${best.chunk.entity}: ${best.chunk.content}`
      : `Could not confirm automatically against ${best.chunk.entity}. Please check the guideline below.`),
  };
}

async function handleDecide(body) {
  const query = validateQuery(body?.query);
  const department = typeof body?.department === "string" && body.department.trim()
    ? body.department.trim().slice(0, 64)
    : null;

  const searchRes = await fetchWorkerJson("/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, topK: 5, department }),
  });

  const chunks = searchRes.results || [];
  if (chunks.length === 0) {
    return { error: "No matching SOP rules found.", results: [] };
  }

  let bestChunk = chunks[0];

  const ruleIntent = classifyIntentRule(query);
  let intentLabel;
  let intentScore;
  if (ruleIntent) {
    intentLabel = ruleIntent.label;
    intentScore = ruleIntent.score;
  } else {
    const intentOut = await classifier(query, INTENT_LABELS, { multi_label: false });
    intentLabel = intentOut.labels[0];
    intentScore = intentOut.scores[0];
  }

  const detCheck = checkDeterministicRules(query, chunks, department);
  if (detCheck?.override_chunk_id) {
    const match = chunks.find((c) => c.id === detCheck.override_chunk_id);
    if (match) bestChunk = match;
  }

  const groundedInput = `SOP Rule (${bestChunk.entity}): ${bestChunk.content}\nStaff Question: ${query}`;
  const payload = {
    query,
    department,
    detected_intent: {
      type: intentLabel,
      confidence: Number(intentScore.toFixed(4)),
    },
    matched_source: bestChunk,
    results: chunks,
  };

  if (detCheck || intentLabel.startsWith("Eligibility")) {
    payload.mode = "yes_no_gate";
    if (detCheck) {
      payload.yes_no_gate = {
        decision: detCheck.decision,
        confidence: 1.0,
        method: "Deterministic Rule Engine",
        explanation: detCheck.reason,
      };
    } else {
      const ynOut = await classifier(groundedInput, YES_NO_LABELS, { multi_label: false });
      payload.yes_no_gate = {
        decision: ynOut.labels[0],
        confidence: Number(ynOut.scores[0].toFixed(4)),
        method: "ONNX NLI (INT8)",
        explanation: bestChunk.content,
      };
    }
  } else if (intentLabel.startsWith("Queue Routing")) {
    payload.mode = "queue_routing";
    const routeOut = await classifier(groundedInput, DEFAULT_ROUTING_LABELS, { multi_label: false });
    const topLabel = routeOut.labels[0];
    const topScore = routeOut.scores[0];
    payload.routing_classification = {
      action: topScore >= 0.45 ? topLabel : "Review Matched SOP Policy Below",
      confidence: Number(topScore.toFixed(4)),
      low_confidence: topScore < 0.45,
      explanation: bestChunk.content,
    };
  } else {
    payload.mode = "fact_lookup";
    const qaOut = await qaExtractor(query, bestChunk.content);
    payload.direct_fact = {
      answer: qaOut.answer?.trim() || "See matched rule below",
      confidence: Number((qaOut.score ?? 0).toFixed(4)),
      context_note: bestChunk.content,
    };
  }

  const proposedAnswer = payload.yes_no_gate
    ? `${payload.yes_no_gate.decision} (${payload.yes_no_gate.explanation})`
    : payload.routing_classification
      ? payload.routing_classification.action
      : payload.direct_fact.answer;

  payload.answer_verification = await verifyAnswerWithNli(
    query,
    proposedAnswer,
    chunks,
    detCheck?.reason || null,
  );
  payload.detected_intent.confidence = payload.answer_verification.confidence;

  return payload;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const reqPath = parsedUrl.pathname;
  const clientIp = getClientIp(req);

  try {
    if (reqPath === "/health" && req.method === "GET") {
      return sendJson(res, 200, { status: "ok" }, req);
    }

    if (reqPath === "/kb" && req.method === "GET") {
      return sendJson(res, 200, await fetchWorkerJson(`/kb${parsedUrl.search}`), req);
    }

    if (reqPath === "/search" && req.method === "POST") {
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

    if (reqPath === "/decide" && req.method === "POST") {
      if (isRateLimited(clientIp)) throw new HttpError(429, "Too many requests");
      const body = await readJsonBody(req);
      return sendJson(res, 200, await handleDecide(body), req);
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
