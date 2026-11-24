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
  const q = query.toLowerCase();
  const chunkIds = new Set(chunks.slice(0, 3).map((c) => c.id || ""));
  const ageMatch = q.match(/\b(\d{1,2})\b/);
  const age = ageMatch ? Number.parseInt(ageMatch[1], 10) : null;

  const isImed = department === "Internal Medicine" || !department;
  const isPeds = department === "Pediatrics" || chunkIds.has("peds_attendance_consent_policy");
  const isVision = department === "Vision" || q.includes("contact lens") || q.includes("vision therapy");
  const isPod = department === "Podiatry" || chunkIds.has("pod_strict_20_40_minute_rule");
  const advanceTerms = ["advance", "pre-book", "next week", "tomorrow"];

  const rules = [
    // Internal Medicine
    [
      (q.includes("adam tilson") || q.includes("tilson") || chunkIds.has("imed_pcp_adam_tilson")) && q.includes("new") && age !== null,
      age > 60 ? "NO" : "YES",
      age > 60
        ? `Adam Tilson, PA does NOT see new patients over 60-65 years old (patient age: ${age}).`
        : `Patient age (${age}) meets Adam Tilson's new patient age limit (<=60).`,
      "imed_pcp_adam_tilson",
    ],
    [
      (q.includes("coven") || chunkIds.has("imed_spec_david_coven")) && q.includes("mvp"),
      "CONDITIONAL",
      "Dr. David Coven does NOT accept MVP insurance. Inform patient of $100 self-pay fee at booking.",
      "imed_spec_david_coven",
    ],
    [
      q.includes("evening") && isImed && q.includes("cdl"),
      "NO",
      "No CDL exams are permitted during Evening Physical hours.",
      "imed_visit_types_rules",
    ],
    [
      q.includes("evening") && isImed && age !== null && age > 40,
      "NO",
      `Evening Physicals are strictly for patients 40 years old and younger (patient age: ${age}).`,
      "imed_visit_types_rules",
    ],
    // Pediatrics
    [
      isPeds && (q.includes("infant") || q.includes("baby")) && q.includes("12"),
      "NO",
      "Strict prohibition: A 12-year-old sibling is NEVER permitted to bring an infant or baby. Must be accompanied by a parent or adult sibling aged 18+.",
      "peds_attendance_consent_policy",
    ],
    [
      isPeds && (q.includes("vaccine") || q.includes("shot") || q.includes("immunization")) && q.includes("alone"),
      "NO",
      "Parent or Adult Sibling (18+) is REQUIRED for all immunization appointments with no exceptions.",
      "peds_attendance_consent_policy",
    ],
    [
      isPeds && q.includes("same day") && (q.includes("two") || q.includes("second") || q.includes("another doctor")),
      "NO",
      "A patient CANNOT see two pediatric primary care providers on the same day. Transfer to Triage Nurse or schedule in Acute Care.",
      "peds_same_day_pcp_restriction",
    ],
    // Vision
    [
      isVision && q.includes("contact lens"),
      "NO",
      "We do NOT fit, evaluate, or dispense contact lenses in-house (eyeglasses, frames, and prism lenses only).",
      "vision_services_offered",
    ],
    [
      isVision && q.includes("vision therapy"),
      "NO",
      "Vision Therapy is not provided in-house. Recommend/refer patients to Ahava Medical or Rambam Health Care Campus.",
      "vision_services_offered",
    ],
    [
      isVision && age !== null && age < 6 && (q.includes("berger") || q.includes("herbik") || q.includes("sheth")),
      "NO",
      `Dr. Berger, Dr. Herbik, and Dr. Sheth only see patients aged 6 and older (patient age: ${age}). Book with Dr. Klein, Dr. Akilov, or Dr. Goldberg (ages 3+).`,
      "vision_prov_zvi_berger",
    ],
    // Podiatry
    [
      isPod && (q.includes("30 min") || q.includes("30-min")),
      "NO",
      "30-minute slots do NOT exist in Podiatry and are strictly prohibited. All appointments are 20 or 40 minutes.",
      "pod_strict_20_40_minute_rule",
    ],
    [
      isPod && (q.includes("uhc") || q.includes("united healthcare")),
      "CONDITIONAL",
      "United Healthcare (UHC) strictly requires an active, approved insurance referral before finalizing a Podiatry appointment (no PE required).",
      "pod_financial_insurance_uhc",
    ],
    [
      isPod && q.includes("shanin") && q.includes("permanent"),
      "NO",
      "NEVER directly book permanent procedures on Dr. Richard Shanin's schedule. Route a Telephone Encounter (TE) to the Podiatry MA queue.",
      "pod_prov_richard_shanin",
    ],
    // Behavioral Health
    [
      department === "Behavioral Health" && (q.includes("book") || q.includes("schedule")),
      "CONDITIONAL",
      "Inbound Team does NOT directly schedule Behavioral Health visits. Gather intake details and route a TE to 'Portal, BH' (or transfer immediately if active crisis).",
      "bh_critical_no_direct_scheduling",
    ],
    // Same-Day Sick Advance Booking
    [
      q.includes("sick") && advanceTerms.some((w) => q.includes(w)),
      "NO",
      "Same-Day Sick Visits cannot be pre-booked in advance (Same-Day Only).",
      department === "Pediatrics" ? "peds_visit_types_specs" : "imed_visit_types_rules",
    ],
  ];

  for (const [matched, decision, reason, override_chunk_id] of rules) {
    if (matched) return { decision, reason, override_chunk_id };
  }
  return null;
}