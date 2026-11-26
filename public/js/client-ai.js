import {
  INTENT_LABELS,
  DEFAULT_ROUTING_LABELS,
  YES_NO_LABELS,
  classifyIntentRule,
  checkDeterministicRules,
} from '/js/rules.js';

const NLI_MODEL = 'Xenova/nli-deberta-v3-small';
const QA_MODEL = 'Xenova/distilbert-base-cased-distilled-squad';
const EMBED_MODEL = 'Xenova/bge-small-en-v1.5';
const TRANSFORMERS_LOCAL = '/vendor/transformers/transformers.min.js';

let nliPipe = null;
let qaPipe = null;
let embedPipe = null;
let loadingPromise = null;
let activeBackend = 'not loaded';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { });
}

let cachedKbItems = null;
const kbVectorCache = new Map(); // id -> { sig, vec: Float32Array }

function buildNliHypothesis(query, proposedAnswer) {
  const cleanedQ = query.trim().replace(/\?+$/, '');
  const factMatch = cleanedQ.match(/^(?:what|where|when|who)\s+(?:is|are)\s+(.+)$/i);
  if (factMatch) return `${factMatch[1]} is ${proposedAnswer}`;
  return `${proposedAnswer} (${cleanedQ})`;
}

async function verifyAnswerWithNli(query, proposedAnswer, chunks, detReason = null) {
  const topChunks = chunks.slice(0, 3);
  const hypothesis = buildNliHypothesis(query, proposedAnswer);
  const scored = [];
  for (const c of topChunks) {
    const out = await nliPipe(`${c.entity}. ${c.content}`, [hypothesis], {
      multi_label: true,
      hypothesis_template: '{}',
    });
    scored.push({ chunk: c, score: out.scores?.[0] ?? 0 });
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const score = Number(best.score.toFixed(4));
  const supported = score >= 0.45;
  return {
    supported,
    verdict: supported ? 'Verified' : 'Needs Review',
    confidence: score,
    reason: detReason || (supported
      ? `Based on ${best.chunk.entity}: ${best.chunk.content}`
      : `Could not confirm automatically against ${best.chunk.entity}. Please check the guideline below.`),
  };
}

async function detectPreferredDevice() {
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return 'webgpu';
    } catch { }
  }
  return 'wasm';
}

async function ensurePersistentStorage() {
  if (!navigator.storage?.persist) return false;
  try {
    const already = await navigator.storage.persisted();
    if (already) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

async function getCacheStatus() {
  let nliCached = false;
  let qaCached = false;
  if ('caches' in window) {
    try {
      const cache = await caches.open('transformers-cache');
      const keys = await cache.keys();
      const urls = keys.map((k) => k.url);
      nliCached = urls.some((u) => u.includes(NLI_MODEL) && u.endsWith('.onnx'));
      qaCached = urls.some((u) => u.includes(QA_MODEL) && u.endsWith('.onnx'));
    } catch { }
  }
  let persisted = false;
  if (navigator.storage?.persisted) {
    try { persisted = await navigator.storage.persisted(); } catch { }
  }
  return {
    nliCached,
    qaCached,
    allCached: nliCached && qaCached,
    persisted,
  };
}

async function initTransformersRuntime() {
  const { env, pipeline } = await import(TRANSFORMERS_LOCAL);
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  return pipeline;
}

async function loadFromLocalCacheOnly() {
  if (nliPipe && qaPipe) return true;
  const status = await getCacheStatus();
  if (!status.allCached) return false;
  const device = await detectPreferredDevice();
  activeBackend = device.toUpperCase();
  const pipeline = await initTransformersRuntime();
  nliPipe = await pipeline('zero-shot-classification', NLI_MODEL, {
    dtype: 'q8',
    device,
    local_files_only: true,
  });
  qaPipe = await pipeline('question-answering', QA_MODEL, {
    dtype: 'q8',
    device,
    local_files_only: true,
  });
  return true;
}

function dotProduct(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

function keywordScore(query, item) {
  const tokens = query.toLowerCase().split(/\W+/).filter(t => t.length >= 2);
  if (!tokens.length) return 0;
  const hay = `${item.entity || ''} ${item.keywords || ''} ${item.category || ''} ${item.content || ''}`.toLowerCase();
  let hits = 0;
  for (const t of tokens) {
    if (hay.includes(t)) hits += 1;
  }
  return hits / tokens.length;
}

async function getKbItems() {
  if (cachedKbItems) return cachedKbItems;
  const res = await fetch('/kb');
  if (!res.ok) throw new Error('Failed to fetch KB items');
  const data = await res.json();
  cachedKbItems = Array.isArray(data.items) ? data.items : [];
  return cachedKbItems;
}

async function embedText(text) {
  const out = await embedPipe(text, { pooling: 'mean', normalize: true });
  return out.data;
}

async function localHybridSearch(query, topK = 5, department = null) {
  const allItems = await getKbItems();
  const scoped = department && department !== 'ALL'
    ? allItems.filter(it => it.department === department)
    : allItems;

  if (!scoped.length) return [];

  // Embed query and any uncached KB items locally in browser
  const queryVec = await embedText(query);
  for (const item of scoped) {
    const text = `${item.department} | ${item.category} | ${item.entity} | ${item.keywords || ''} | ${item.content}`;
    const existing = kbVectorCache.get(item.id);
    if (!existing || existing.sig !== text) {
      const vec = await embedText(text);
      kbVectorCache.set(item.id, { sig: text, vec });
    }
  }

  // RRF fusion of semantic cosine similarity + keyword match
  const byVec = [...scoped]
    .map(item => ({ item, score: dotProduct(queryVec, kbVectorCache.get(item.id).vec) }))
    .sort((a, b) => b.score - a.score);

  const byKw = [...scoped]
    .map(item => ({ item, score: keywordScore(query, item) }))
    .sort((a, b) => b.score - a.score);

  const rrfScores = new Map();
  const k = 60;
  byVec.forEach((entry, rank) => {
    rrfScores.set(entry.item.id, (rrfScores.get(entry.item.id) || 0) + 1 / (k + rank + 1));
  });
  byKw.forEach((entry, rank) => {
    if (entry.score > 0) {
      rrfScores.set(entry.item.id, (rrfScores.get(entry.item.id) || 0) + 1 / (k + rank + 1));
    }
  });

  return [...scoped]
    .sort((a, b) => (rrfScores.get(b.id) || 0) - (rrfScores.get(a.id) || 0))
    .slice(0, topK);
}

async function search(query, topK = 6, department = null) {
  if (embedPipe) {
    const results = await localHybridSearch(query, topK, department);
    return { query, department, results, source: `Browser Embedding (${activeBackend})` };
  }
  const res = await fetch('/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, topK, department }),
  });
  if (!res.ok) throw new Error('Search service unavailable');
  return res.json();
}

async function downloadAndTestModels(onProgress) {
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const emit = typeof onProgress === 'function' ? onProgress : () => { };
    const fileTotals = new Map();
    const device = await detectPreferredDevice();
    activeBackend = device.toUpperCase();

    const cacheStatus = await getCacheStatus();
    const useCacheOnly = cacheStatus.allCached;

    const trackProgress = (stageLabel, modelId) => (info) => {
      if (!info || !info.file) return;
      const key = `${modelId}|${info.file}`;
      const prev = fileTotals.get(key) || { loaded: 0, total: 0 };
      if (info.status === 'progress') {
        prev.loaded = info.loaded ?? prev.loaded;
        prev.total = info.total ?? prev.total;
      } else if (info.status === 'done') {
        if (prev.total) prev.loaded = prev.total;
      }
      fileTotals.set(key, prev);

      let loadedSum = 0;
      let totalSum = 0;
      for (const v of fileTotals.values()) {
        loadedSum += v.loaded || 0;
        totalSum += v.total || 0;
      }
      const pct = totalSum > 0 ? Math.min(99, Math.round((loadedSum / totalSum) * 100)) : 0;
      emit({
        stage: stageLabel,
        file: info.file,
        loadedBytes: loadedSum,
        totalBytes: totalSum,
        pct,
        device,
      });
    };

    emit({ stage: 'Loading local runtime...', file: '', loadedBytes: 0, totalBytes: 0, pct: 2, device });
    const persisted = await ensurePersistentStorage();
    const pipeline = await initTransformersRuntime();

    const tStart = performance.now();

    emit({
      stage: useCacheOnly ? `Loading NLI from PC cache...` : `Downloading NLI (${NLI_MODEL})...`,
      file: '', loadedBytes: 0, totalBytes: 0, pct: 5, device,
    });
    nliPipe = await pipeline('zero-shot-classification', NLI_MODEL, {
      dtype: 'q8',
      device,
      local_files_only: useCacheOnly,
      progress_callback: trackProgress(`Downloading NLI (${NLI_MODEL})`, NLI_MODEL),
    });

    emit({
      stage: useCacheOnly ? `Loading QA from PC cache...` : `Downloading QA (${QA_MODEL})...`,
      file: '', loadedBytes: 0, totalBytes: 0, pct: 65, device,
    });
    qaPipe = await pipeline('question-answering', QA_MODEL, {
      dtype: 'q8',
      device,
      local_files_only: useCacheOnly,
      progress_callback: trackProgress(`Downloading QA (${QA_MODEL})`, QA_MODEL),
    });

    emit({ stage: `Downloading Embedding (${EMBED_MODEL})...`, file: '', loadedBytes: 0, totalBytes: 0, pct: 85, device });
    embedPipe = await pipeline('feature-extraction', EMBED_MODEL, {
      dtype: 'q8',
      device,
      progress_callback: trackProgress(`Downloading Embedding (${EMBED_MODEL})`, EMBED_MODEL),
    });

    const loadSec = ((performance.now() - tStart) / 1000).toFixed(2);
    emit({ stage: 'Running self-test...', file: '', loadedBytes: 0, totalBytes: 0, pct: 99, device });

    const testQ = 'What is the minimum age for a Vision appointment?';
    const testCtx = 'Vision optometry sees patients ages 3 and older. Children under 3 years old are not seen in-house.';

    const tNli0 = performance.now();
    const nliRes = await nliPipe(testQ, ['Direct Factual Lookup', 'Queue Routing', 'Yes/No Eligibility']);
    const nliMs = Math.round(performance.now() - tNli0);

    const tQa0 = performance.now();
    const qaRes = await qaPipe(testQ, testCtx);
    const qaMs = Math.round(performance.now() - tQa0);

    const tEmb0 = performance.now();
    const embVec = await embedText(testQ);
    const embMs = Math.round(performance.now() - tEmb0);

    emit({ stage: 'Ready & Verified', file: '', loadedBytes: 0, totalBytes: 0, pct: 100, device });

    return {
      ok: true,
      device: activeBackend,
      fromCache: useCacheOnly,
      persisted,
      loadSec,
      nliTest: { label: nliRes.labels[0], score: nliRes.scores[0], ms: nliMs },
      qaTest: { answer: qaRes.answer, score: qaRes.score, ms: qaMs },
      embedTest: { dims: embVec.length, ms: embMs },
    };
  })();

  try {
    return await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

async function clearModelCache() {
  nliPipe = null;
  qaPipe = null;
  embedPipe = null;
  kbVectorCache.clear();
  cachedKbItems = null;
  activeBackend = 'not loaded';
  if ('caches' in window) {
    await caches.delete('transformers-cache');
  }
}

async function decide(query, department = null) {
  // If models were already downloaded to this PC's cache, load them offline without any network call
  if (!nliPipe || !qaPipe) {
    await loadFromLocalCacheOnly().catch(() => false);
  }

  const searchData = await search(query, 5, department);
  const chunks = searchData.results || [];
  if (chunks.length === 0) {
    return { error: 'No matching SOP rules found.', results: [] };
  }

  let bestChunk = chunks[0];
  const ruleIntent = classifyIntentRule(query);
  let intentLabel = ruleIntent ? ruleIntent.label : INTENT_LABELS[2];
  let intentScore = ruleIntent ? ruleIntent.score : 0.5;

  if (!ruleIntent && nliPipe) {
    const intentOut = await nliPipe(query, INTENT_LABELS, { multi_label: false });
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

  const modelsReady = Boolean(nliPipe && qaPipe);

  if (detCheck || intentLabel.startsWith('Eligibility')) {
    payload.mode = 'yes_no_gate';
    if (detCheck) {
      payload.yes_no_gate = {
        decision: detCheck.decision,
        confidence: 1.0,
        method: 'Deterministic Rule Engine (Browser)',
        explanation: detCheck.reason,
      };
    } else if (modelsReady) {
      const ynOut = await nliPipe(groundedInput, YES_NO_LABELS, { multi_label: false });
      payload.yes_no_gate = {
        decision: ynOut.labels[0],
        confidence: Number(ynOut.scores[0].toFixed(4)),
        method: `Browser ONNX NLI (${activeBackend})`,
        explanation: bestChunk.content,
      };
    } else {
      payload.yes_no_gate = {
        decision: 'CONDITIONAL — Browser AI Models Not Loaded',
        confidence: 0,
        method: 'Fallback (Load models in Admin)',
        explanation: bestChunk.content,
      };
    }
  } else if (intentLabel.startsWith('Queue Routing')) {
    payload.mode = 'queue_routing';
    if (modelsReady) {
      const routeOut = await nliPipe(groundedInput, DEFAULT_ROUTING_LABELS, { multi_label: false });
      const topLabel = routeOut.labels[0];
      const topScore = routeOut.scores[0];
      payload.routing_classification = {
        action: topScore >= 0.45 ? topLabel : 'Review Matched SOP Policy Below',
        confidence: Number(topScore.toFixed(4)),
        low_confidence: topScore < 0.45,
        explanation: bestChunk.content,
      };
    } else {
      payload.routing_classification = {
        action: 'Review Matched SOP Policy Below (Load Browser AI Models in Admin)',
        confidence: 0,
        low_confidence: true,
        explanation: bestChunk.content,
      };
    }
  } else {
    payload.mode = 'fact_lookup';
    if (modelsReady) {
      const qaOut = await qaPipe(query, bestChunk.content);
      payload.direct_fact = {
        answer: qaOut.answer?.trim() || 'See matched rule below',
        confidence: Number((qaOut.score ?? 0).toFixed(4)),
        context_note: bestChunk.content,
      };
    } else {
      payload.direct_fact = {
        answer: 'See matched rule below (load Browser AI Models in Admin for AI extraction)',
        confidence: 0,
        context_note: bestChunk.content,
      };
    }
  }

  const proposedAnswer = payload.yes_no_gate
    ? `${payload.yes_no_gate.decision} (${payload.yes_no_gate.explanation})`
    : payload.routing_classification
      ? payload.routing_classification.action
      : payload.direct_fact.answer;

  if (modelsReady) {
    payload.answer_verification = await verifyAnswerWithNli(
      query,
      proposedAnswer,
      chunks,
      detCheck?.reason || null,
    );
    payload.detected_intent.confidence = payload.answer_verification.confidence;
  } else {
    payload.answer_verification = {
      supported: Boolean(detCheck),
      verdict: detCheck ? 'Verified' : 'Models Not Loaded',
      confidence: detCheck ? 1.0 : 0,
      reason: detCheck?.reason || 'Load Browser AI Models in Admin to run client-side NLI + QA verification.',
    };
  }

  return payload;
}

window.aizerClientAI = {
  isReady: () => Boolean(nliPipe && qaPipe && embedPipe),
  getBackend: () => activeBackend,
  getCacheStatus,
  invalidateKbCache: () => { cachedKbItems = null; },
  downloadAndTestModels,
  clearModelCache,
  search,
  decide,
};
