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
const CF_WORKER_URL = process.env.CF_WORKER_URL || "https://aizer-health-kb.aizer-im-kb.workers.dev";
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

env.allowLocalModels = true;

console.log(`Loading INT8 ONNX NLI model (${NLI_MODEL})...`);
const classifier = await pipeline("zero-shot-classification", NLI_MODEL, { dtype: "q8" });

console.log(`Loading ONNX QA model (${QA_MODEL})...`);
const qaExtractor = await pipeline("question-answering", QA_MODEL, {
  dtype: HAS_LOCAL_QA ? "fp32" : "q8",
  local_files_only: HAS_LOCAL_QA,
});

async function fetchWorkerJson(endpoint, options = {}) {
  const res = await fetch(`${CF_WORKER_URL}${endpoint}`, {
    ...options,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Worker ${endpoint} responded with ${res.status}`);
  return res.json();
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

async function handleDecide(body) {
  const query = body?.query || "";
  const department = body?.department || null;

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

  return payload;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const reqPath = parsedUrl.pathname;

  try {
    if (reqPath === "/kb" && req.method === "GET") {
      return sendJson(res, 200, await fetchWorkerJson(`/kb${parsedUrl.search}`));
    }

    if (reqPath === "/search" && req.method === "POST") {
      const body = await readJsonBody(req);
      const data = await fetchWorkerJson("/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: body?.query || "",
          topK: body?.topK || 5,
          department: body?.department || null,
        }),
      });
      return sendJson(res, 200, data);
    }

    if (reqPath === "/decide" && req.method === "POST") {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await handleDecide(body));
    }

    if (req.method === "GET") {
      const safeRel = path.normalize(reqPath === "/" ? "index.html" : reqPath).replace(/^(\.\.(\/|\\|$))+/, "");
      const filePath = path.join(PUBLIC_DIR, safeRel);
      if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
        return fs.createReadStream(filePath).pipe(res);
      }
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Aizer Health ONNX Decision Engine listening on http://localhost:${PORT}`);
});