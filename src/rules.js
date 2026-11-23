export const INTENT_LABELS = [
  "Eligibility or Yes/No Permission Check",
  "Queue Routing or Workflow Action",
  "Direct Factual Lookup (Phone, Duration, Fee, Time)",
];

export const DEFAULT_ROUTING_LABELS = [
  "Route to AMED_Nursing Queue",
  "Route to AMED_PSS Queue",
  "Route to PEDS Encounters / Marisa Kraft / Hayley Newton / Anisa Azeez",
  "Route to Portal, BH / Queue, PSYCHRN (Shadasha Norfleet)",
  "Route to Portal OB / Devisha Cooper / Rebecca Wood / Taylor Jennings",
  "Route to Podiatry MA Queue",
  "Transfer Immediately to Triage Nurse / Outbound CMT / ER",
  "Book Appointment Directly",
  "Require Prerequisite / Records / Referral First",
];

export const YES_NO_LABELS = [
  "YES — Allowed",
  "NO — Prohibited or Restricted",
  "CONDITIONAL — Prerequisite or Referral Required",
];

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

export function checkDeterministicRules(query, chunks, department = null) {
  const qLower = query.toLowerCase();
  const chunkIds = new Set(chunks.slice(0, 3).map((c) => c.id || ""));
  const ageMatch = qLower.match(/\b(\d{1,2})\b/);
  const age = ageMatch ? Number.parseInt(ageMatch[1], 10) : null;

  // --- INTERNAL MEDICINE RULES ---
  if (
    (qLower.includes("adam tilson") ||
      qLower.includes("tilson") ||
      chunkIds.has("imed_pcp_adam_tilson")) &&
    qLower.includes("new") &&
    age !== null
  ) {
    if (age > 60) {
      return {
        decision: "NO",
        reason: `Adam Tilson, PA does NOT see new patients over 60-65 years old (patient age: ${age}).`,
        override_chunk_id: "imed_pcp_adam_tilson",
      };
    }
    return {
      decision: "YES",
      reason: `Patient age (${age}) meets Adam Tilson's new patient age limit (<=60).`,
      override_chunk_id: "imed_pcp_adam_tilson",
    };
  }

  if ((qLower.includes("coven") || chunkIds.has("imed_spec_david_coven")) && qLower.includes("mvp")) {
    return {
      decision: "CONDITIONAL",
      reason:
        "Dr. David Coven does NOT accept MVP insurance. Inform patient of $100 self-pay fee at booking.",
      override_chunk_id: "imed_spec_david_coven",
    };
  }

  if (qLower.includes("evening") && (department === "Internal Medicine" || !department)) {
    if (qLower.includes("cdl")) {
      return {
        decision: "NO",
        reason: "No CDL exams are permitted during Evening Physical hours.",
        override_chunk_id: "imed_visit_types_rules",
      };
    }
    if (age !== null && age > 40) {
      return {
        decision: "NO",
        reason: `Evening Physicals are strictly for patients 40 years old and younger (patient age: ${age}).`,
        override_chunk_id: "imed_visit_types_rules",
      };
    }
  }

  // --- PEDIATRICS RULES ---
  if (department === "Pediatrics" || chunkIds.has("peds_attendance_consent_policy")) {
    if ((qLower.includes("infant") || qLower.includes("baby")) && qLower.includes("12")) {
      return {
        decision: "NO",
        reason: "Strict prohibition: A 12-year-old sibling is NEVER permitted to bring an infant or baby. Must be accompanied by a parent or adult sibling aged 18+.",
        override_chunk_id: "peds_attendance_consent_policy",
      };
    }
    if ((qLower.includes("vaccine") || qLower.includes("shot") || qLower.includes("immunization")) && qLower.includes("alone")) {
      return {
        decision: "NO",
        reason: "Parent or Adult Sibling (18+) is REQUIRED for all immunization appointments with no exceptions.",
        override_chunk_id: "peds_attendance_consent_policy",
      };
    }
    if (qLower.includes("same day") && (qLower.includes("two") || qLower.includes("second") || qLower.includes("another doctor"))) {
      return {
        decision: "NO",
        reason: "A patient CANNOT see two pediatric primary care providers on the same day. Transfer to Triage Nurse or schedule in Acute Care.",
        override_chunk_id: "peds_same_day_pcp_restriction",
      };
    }
  }

  // --- VISION RULES ---
  if (department === "Vision" || qLower.includes("contact lens") || qLower.includes("vision therapy")) {
    if (qLower.includes("contact lens")) {
      return {
        decision: "NO",
        reason: "We do NOT fit, evaluate, or dispense contact lenses in-house (eyeglasses, frames, and prism lenses only).",
        override_chunk_id: "vision_services_offered",
      };
    }
    if (qLower.includes("vision therapy")) {
      return {
        decision: "NO",
        reason: "Vision Therapy is not provided in-house. Recommend/refer patients to Ahava Medical or Rambam Health Care Campus.",
        override_chunk_id: "vision_services_offered",
      };
    }
    if (
      age !== null &&
      age < 6 &&
      (qLower.includes("berger") || qLower.includes("herbik") || qLower.includes("sheth"))
    ) {
      return {
        decision: "NO",
        reason: `Dr. Berger, Dr. Herbik, and Dr. Sheth only see patients aged 6 and older (patient age: ${age}). Book with Dr. Klein, Dr. Akilov, or Dr. Goldberg (ages 3+).`,
        override_chunk_id: "vision_prov_zvi_berger",
      };
    }
  }

  // --- PODIATRY RULES ---
  if (department === "Podiatry" || chunkIds.has("pod_strict_20_40_minute_rule")) {
    if (qLower.includes("30 min") || qLower.includes("30-min")) {
      return {
        decision: "NO",
        reason: "30-minute slots do NOT exist in Podiatry and are strictly prohibited. All appointments are 20 or 40 minutes.",
        override_chunk_id: "pod_strict_20_40_minute_rule",
      };
    }
    if (qLower.includes("uhc") || qLower.includes("united healthcare")) {
      return {
        decision: "CONDITIONAL",
        reason: "United Healthcare (UHC) strictly requires an active, approved insurance referral before finalizing a Podiatry appointment (no PE required).",
        override_chunk_id: "pod_financial_insurance_uhc",
      };
    }
    if (qLower.includes("shanin") && qLower.includes("permanent")) {
      return {
        decision: "NO",
        reason: "NEVER directly book permanent procedures on Dr. Richard Shanin's schedule. Route a Telephone Encounter (TE) to the Podiatry MA queue.",
        override_chunk_id: "pod_prov_richard_shanin",
      };
    }
  }

  // --- BEHAVIORAL HEALTH RULES ---
  if (department === "Behavioral Health") {
    if (qLower.includes("book") || qLower.includes("schedule")) {
      return {
        decision: "CONDITIONAL",
        reason: "Inbound Team does NOT directly schedule Behavioral Health visits. Gather intake details and route a TE to 'Portal, BH' (or transfer immediately if active crisis).",
        override_chunk_id: "bh_critical_no_direct_scheduling",
      };
    }
  }

  // --- GENERAL SAME-DAY SICK ADVANCE BOOKING ---
  const advanceTerms = ["advance", "pre-book", "next week", "tomorrow"];
  if (qLower.includes("sick") && advanceTerms.some((w) => qLower.includes(w))) {
    return {
      decision: "NO",
      reason: "Same-Day Sick Visits cannot be pre-booked in advance (Same-Day Only).",
      override_chunk_id: department === "Pediatrics" ? "peds_visit_types_specs" : "imed_visit_types_rules",
    };
  }

  return null;
}