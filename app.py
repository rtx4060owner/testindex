import re
import torch
import requests
from typing import List, Optional
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from gliclass import GLiClassModel, ZeroShotClassificationPipeline
from transformers import AutoTokenizer, AutoModelForQuestionAnswering

app = FastAPI(title="Aizer Health Non-LLM Decision Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

CF_WORKER_URL = "https://aizer-health-kb.aizer-im-kb.workers.dev"

print("Loading GLiClass model (single-label mode)...")
gliclass_model = GLiClassModel.from_pretrained("knowledgator/gliclass-small-v1.0")
gliclass_tokenizer = AutoTokenizer.from_pretrained("knowledgator/gliclass-small-v1.0")
classifier = ZeroShotClassificationPipeline(
    gliclass_model,
    gliclass_tokenizer,
    classification_type="single-label",
    device="cpu",
)

print("Loading Extractive QA model...")
QA_MODEL_NAME = "deepset/minilm-uncased-squad2"
qa_tokenizer = AutoTokenizer.from_pretrained(QA_MODEL_NAME)
qa_model = AutoModelForQuestionAnswering.from_pretrained(QA_MODEL_NAME)
qa_model.eval()

INTENT_LABELS = [
    "Eligibility or Yes/No Permission Check",
    "Queue Routing or Workflow Action",
    "Direct Factual Lookup (Phone, Duration, Fee, Time)",
]

DEFAULT_ROUTING_LABELS = [
    "Route to AMED_Nursing Queue",
    "Route to AMED_PSS Queue",
    "Route Directly to Dr. Murphy",
    "Route Directly to Dr. Rosenberg",
    "Contact Esther Taub via Microsoft Teams",
    "Book Appointment Directly",
    "Require Prerequisite / Records / Referral First",
]


class AskRequest(BaseModel):
    query: str
    custom_labels: Optional[List[str]] = None


def extract_answer_span(question: str, context: str) -> dict:
    inputs = qa_tokenizer(
        question,
        context,
        return_tensors="pt",
        truncation="only_second",
        max_length=512,
    )
    sequence_ids = inputs.sequence_ids(0)
    context_indices = [i for i, seq_id in enumerate(sequence_ids) if seq_id == 1]

    if not context_indices:
        return {"answer": "See matched rule below", "confidence": 0.0}

    ctx_start, ctx_end = context_indices[0], context_indices[-1]

    with torch.no_grad():
        outputs = qa_model(**inputs)

    start_logits = outputs.start_logits[0]
    end_logits = outputs.end_logits[0]

    mask = torch.full_like(start_logits, float("-inf"))
    mask[ctx_start : ctx_end + 1] = 0.0

    masked_start = start_logits + mask
    masked_end = end_logits + mask

    start_idx = int(torch.argmax(masked_start))
    end_window = masked_end[start_idx : min(start_idx + 22, ctx_end + 1)]
    end_idx = start_idx + int(torch.argmax(end_window))

    answer_tokens = inputs["input_ids"][0][start_idx : end_idx + 1]
    answer = qa_tokenizer.decode(answer_tokens, skip_special_tokens=True).strip()
    answer = re.sub(r"\s*-\s*", "-", answer)

    start_prob = float(torch.softmax(masked_start, dim=0)[start_idx])
    end_prob = float(torch.softmax(masked_end, dim=0)[end_idx])
    confidence = round((start_prob + end_prob) / 2, 4)

    return {
        "answer": answer if answer else "See matched rule below",
        "confidence": confidence,
    }


def check_deterministic_rules(query: str, chunks: List[dict]) -> Optional[dict]:
    """Inspect top 3 retrieved chunks and query text to enforce exact numeric/policy boundaries."""
    q_lower = query.lower()
    chunk_ids = {c.get("id", "") for c in chunks[:3]}
    age_match = re.search(r"\b(\d{2})\b", q_lower)
    age = int(age_match.group(1)) if age_match else None

    # 1. Adam Tilson New Patient Age Gate
    if ("adam tilson" in q_lower or "tilson" in q_lower or "pcp_adam_tilson" in chunk_ids) and "new" in q_lower and age is not None:
        if age > 60:
            return {
                "decision": "NO",
                "reason": f"Adam Tilson, PA does NOT see new patients over 60-65 years old (patient age: {age}).",
                "override_chunk_id": "pcp_adam_tilson",
            }
        return {
            "decision": "YES",
            "reason": f"Patient age ({age}) meets Adam Tilson's new patient age limit (<=60).",
            "override_chunk_id": "pcp_adam_tilson",
        }

    # 2. Dr. David Coven MVP Insurance Gate
    if ("coven" in q_lower or "spec_david_coven" in chunk_ids) and "mvp" in q_lower:
        return {
            "decision": "CONDITIONAL",
            "reason": "Dr. David Coven does NOT accept MVP insurance. Inform patient of $100 self-pay fee at booking.",
            "override_chunk_id": "spec_david_coven",
        }

    # 3. Evening Physicals Age & CDL Gate
    if "evening" in q_lower or "visit_evening_pe" in chunk_ids:
        if "cdl" in q_lower:
            return {
                "decision": "NO",
                "reason": "No CDL exams are permitted during Evening Physical hours.",
                "override_chunk_id": "visit_evening_pe",
            }
        if age is not None and age > 40:
            return {
                "decision": "NO",
                "reason": f"Evening Physicals are strictly for patients 40 years old and younger (patient age: {age}).",
                "override_chunk_id": "visit_evening_pe",
            }

    # 4. Same-Day Sick Visit Advance Booking Gate
    if ("sick" in q_lower or "visit_same_day_sick" in chunk_ids) and any(
        w in q_lower for w in ["advance", "pre-book", "next week", "tomorrow"]
    ):
        return {
            "decision": "NO",
            "reason": "Same-Day Sick Visits cannot be pre-booked in advance (Same-Day Only, ages 18-65).",
            "override_chunk_id": "visit_same_day_sick",
        }

    return None


@app.get("/kb")
def proxy_kb():
    return requests.get(f"{CF_WORKER_URL}/kb", timeout=10).json()


@app.post("/search")
def proxy_search(req: AskRequest):
    return requests.post(
        f"{CF_WORKER_URL}/search",
        json={"query": req.query, "topK": 5},
        timeout=10,
    ).json()


@app.post("/decide")
def decide(req: AskRequest):
    search_res = requests.post(
        f"{CF_WORKER_URL}/search",
        json={"query": req.query, "topK": 5},
        timeout=10,
    ).json()

    chunks = search_res.get("results", [])
    if not chunks:
        return {"error": "No matching SOP rules found.", "results": []}

    best_chunk = chunks[0]

    # Step 1: GLiClass Meta-Intent Classification
    intent_preds = classifier(req.query, INTENT_LABELS, threshold=0.01)[0]
    top_intent = sorted(intent_preds, key=lambda x: x["score"], reverse=True)[0]
    intent_label = top_intent["label"]

    # Step 2: Check Deterministic Rules across top 3 chunks and switch source chunk if needed
    det_check = check_deterministic_rules(req.query, chunks)
    if det_check and det_check.get("override_chunk_id"):
        for c in chunks:
            if c.get("id") == det_check["override_chunk_id"]:
                best_chunk = c
                break

    grounded_input = (
        f"SOP Rule ({best_chunk['entity']}): {best_chunk['content']}\n"
        f"Staff Question: {req.query}"
    )

    response_payload = {
        "query": req.query,
        "detected_intent": {
            "type": intent_label,
            "confidence": round(top_intent["score"], 4),
        },
        "matched_source": best_chunk,
        "results": chunks,
    }

    # Branch A: Eligibility / Yes-No Gate ONLY
    if det_check or intent_label.startswith("Eligibility"):
        response_payload["mode"] = "yes_no_gate"
        if det_check:
            response_payload["yes_no_gate"] = {
                "decision": det_check["decision"],
                "confidence": 1.0,
                "method": "Deterministic Rule Engine",
                "explanation": det_check["reason"],
            }
        else:
            yn_labels = [
                "YES — Allowed",
                "NO — Prohibited or Restricted",
                "CONDITIONAL — Prerequisite or Referral Required",
            ]
            yn_preds = classifier(grounded_input, yn_labels, threshold=0.01)[0]
            yn_sorted = sorted(yn_preds, key=lambda x: x["score"], reverse=True)
            response_payload["yes_no_gate"] = {
                "decision": yn_sorted[0]["label"],
                "confidence": round(yn_sorted[0]["score"], 4),
                "method": "GLiClass NLI",
                "explanation": best_chunk["content"],
            }

    # Branch B: Queue Routing / Workflow Action ONLY
    elif intent_label.startswith("Queue Routing"):
        response_payload["mode"] = "queue_routing"
        labels = req.custom_labels if req.custom_labels else DEFAULT_ROUTING_LABELS
        routing_preds = classifier(grounded_input, labels, threshold=0.01)[0]
        routing_sorted = sorted(routing_preds, key=lambda x: x["score"], reverse=True)
        top_route = routing_sorted[0]

        response_payload["routing_classification"] = {
            "action": top_route["label"] if top_route["score"] >= 0.45 else "Review Matched SOP Policy Below",
            "confidence": round(top_route["score"], 4),
            "low_confidence": top_route["score"] < 0.45,
            "explanation": best_chunk["content"],
        }

    # Branch C: Direct Factual Lookup ONLY
    else:
        response_payload["mode"] = "fact_lookup"
        extracted = extract_answer_span(req.query, best_chunk["content"])
        response_payload["direct_fact"] = {
            "answer": extracted["answer"],
            "confidence": extracted["confidence"],
            "context_note": best_chunk["content"],
        }

    return response_payload


app.mount("/", StaticFiles(directory="public", html=True), name="static")