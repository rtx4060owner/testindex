export const INTENT_LABELS = [
  "Eligibility or Yes/No Permission Check",
  "Queue Routing or Workflow Action",
  "Direct Factual Lookup (Phone, Duration, Fee, Time)",
];

export const DEFAULT_ROUTING_LABELS = [
  "Route to AMED_Nursing Queue",
  "Route to AMED_PSS Queue",
  "Route Directly to Dr. Murphy",
  "Route Directly to Dr. Rosenberg",
  "Contact Esther Taub via Microsoft Teams",
  "Book Appointment Directly",
  "Require Prerequisite / Records / Referral First",
];

export const YES_NO_LABELS = [
  "YES — Allowed",
  "NO — Prohibited or Restricted",
  "CONDITIONAL — Prerequisite or Referral Required",
];

/**
 * Fast deterministic intent classification for clear factual, routing, and eligibility questions.
 * Returns null if ambiguous so the NLI classifier can decide.
 */
export function classifyIntentRule(query) {
  const q = query.toLowerCase().trim();

  if (
    /\b(route|routing|queue|send to|forward|transfer|who do i contact|which team|teams)\b/.test(q)
  ) {
    return { label: INTENT_LABELS[1], score: 0.95 };
  }

  if (
    /^(what|where|when|who|how long|how much|how many)\b/.test(q) ||
    /\b(phone|fax|number|email|address|location|floor|ext|extension|fee|cost|price|duration|minutes|hours|schedule|days)\b/.test(q)
  ) {
    return { label: INTENT_LABELS[2], score: 0.95 };
  }

  if (/^(can|could|may|is|are|do|does|will)\b/.test(q) || /\b(allow|allowed|eligible|accept|permit|able to)\b/.test(q)) {
    return { label: INTENT_LABELS[0], score: 0.9 };
  }

  return null;
}

/**
 * Inspect top 3 retrieved chunks and query text to enforce exact numeric/policy boundaries.
 */
export function checkDeterministicRules(query, chunks) {
  const qLower = query.toLowerCase();
  const chunkIds = new Set(chunks.slice(0, 3).map((c) => c.id || ""));
  const ageMatch = qLower.match(/\b(\d{2})\b/);
  const age = ageMatch ? Number.parseInt(ageMatch[1], 10) : null;

  // 1. Adam Tilson New Patient Age Gate
  if (
    (qLower.includes("adam tilson") ||
      qLower.includes("tilson") ||
      chunkIds.has("pcp_adam_tilson")) &&
    qLower.includes("new") &&
    age !== null
  ) {
    if (age > 60) {
      return {
        decision: "NO",
        reason: `Adam Tilson, PA does NOT see new patients over 60-65 years old (patient age: ${age}).`,
        override_chunk_id: "pcp_adam_tilson",
      };
    }
    return {
      decision: "YES",
      reason: `Patient age (${age}) meets Adam Tilson's new patient age limit (<=60).`,
      override_chunk_id: "pcp_adam_tilson",
    };
  }

  // 2. Dr. David Coven MVP Insurance Gate
  if ((qLower.includes("coven") || chunkIds.has("spec_david_coven")) && qLower.includes("mvp")) {
    return {
      decision: "CONDITIONAL",
      reason:
        "Dr. David Coven does NOT accept MVP insurance. Inform patient of $100 self-pay fee at booking.",
      override_chunk_id: "spec_david_coven",
    };
  }

  // 3. Evening Physicals Age & CDL Gate
  if (qLower.includes("evening") || chunkIds.has("visit_evening_pe")) {
    if (qLower.includes("cdl")) {
      return {
        decision: "NO",
        reason: "No CDL exams are permitted during Evening Physical hours.",
        override_chunk_id: "visit_evening_pe",
      };
    }
    if (age !== null && age > 40) {
      return {
        decision: "NO",
        reason: `Evening Physicals are strictly for patients 40 years old and younger (patient age: ${age}).`,
        override_chunk_id: "visit_evening_pe",
      };
    }
  }

  // 4. Same-Day Sick Visit Advance Booking Gate
  const advanceTerms = ["advance", "pre-book", "next week", "tomorrow"];
  if (
    (qLower.includes("sick") || chunkIds.has("visit_same_day_sick")) &&
    advanceTerms.some((w) => qLower.includes(w))
  ) {
    return {
      decision: "NO",
      reason: "Same-Day Sick Visits cannot be pre-booked in advance (Same-Day Only, ages 18-65).",
      override_chunk_id: "visit_same_day_sick",
    };
  }

  return null;
}
