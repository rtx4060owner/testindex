import re
import torch
import requests
from typing import List, Optional
from fastapi import FastAPI
from pydantic import BaseModel
from gliclass import GLiClassModel, ZeroShotClassificationPipeline
from transformers import AutoTokenizer, AutoModelForQuestionAnswering

app = FastAPI(title="Aizer Health Non-LLM Decision Engine")

CF_SEARCH_URL = "https://aizer-health-kb.aizer-im-kb.workers.dev/search"

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

DEFAULT_ROUTING_LABELS = [
    "Route to AMED_Nursing Queue",
    "Route to AMED_PSS Queue",
    "Route Directly to Dr. Murphy",
    "Route Directly to Dr. Rosenberg",
    "Contact Esther Taub via Microsoft Teams",
    "Book Standard or Specialist Appointment",
    "General Information Lookup (No Routing Needed)",
]


class AskRequest(BaseModel):
    query: str
    custom_labels: Optional[List[str]] = None


def extract_answer_span(question: str, context: str) -> dict:
    """Pure Extractive QA restricted strictly to context token indices."""
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

    # Mask non-context tokens (question & special tokens) so span stays strictly inside context
    mask = torch.full_like(start_logits, float("-inf"))
    mask[ctx_start : ctx_end + 1] = 0.0

    masked_start = start_logits + mask
    masked_end = end_logits + mask

    start_idx = int(torch.argmax(masked_start))
    # Restrict max answer length to 25 tokens for clean short answers
    end_window = masked_end[start_idx : min(start_idx + 25, ctx_end + 1)]
    end_idx = start_idx + int(torch.argmax(end_window))

    answer_tokens = inputs["input_ids"][0][start_idx : end_idx + 1]
    answer = qa_tokenizer.decode(answer_tokens, skip_special_tokens=True).strip()

    # Clean hyphen spacing (e.g. "855 - 592 - 1423" -> "855-592-1423")
    answer = re.sub(r"\s*-\s*", "-", answer)

    start_prob = float(torch.softmax(masked_start, dim=0)[start_idx])
    end_prob = float(torch.softmax(masked_end, dim=0)[end_idx])
    confidence = round((start_prob + end_prob) / 2, 4)

    return {
        "answer": answer if answer else "See matched rule below",
        "confidence": confidence,
    }


def check_deterministic_rules(query: str, best_chunk: dict) -> Optional[dict]:
    """Deterministic check on structured JSON rules for strict age/insurance gates."""
    q_lower = query.lower()
    chunk_id = best_chunk.get("id", "")
    age_match = re.search(r"\b(\d{2})\b", q_lower)
    age = int(age_match.group(1)) if age_match else None

    if chunk_id == "pcp_adam_tilson" and "new" in q_lower and age is not None:
        if age > 60:
            return {
                "decision": "NO",
                "reason": f"Adam Tilson, PA does NOT see new patients over 60-65 years old (patient age: {age}).",
            }
        return {
            "decision": "YES",
            "reason": f"Patient age ({age}) meets Adam Tilson's new patient age limit (<=60).",
        }

    if chunk_id == "spec_david_coven" and "mvp" in q_lower:
        return {
            "decision": "CONDITIONAL",
            "reason": "Dr. David Coven does NOT accept MVP insurance. Inform patient of $100 self-pay fee at booking.",
        }

    if chunk_id == "visit_evening_pe" and age is not None:
        if age > 40:
            return {
                "decision": "NO",
                "reason": f"Evening Physicals are strictly for patients 40 years old and younger (patient age: {age}).",
            }

    return None


@app.post("/decide")
def decide(req: AskRequest):
    search_res = requests.post(
        CF_SEARCH_URL,
        json={"query": req.query, "topK": 3},
        timeout=10,
    ).json()

    chunks = search_res.get("results", [])
    if not chunks:
        return {"error": "No matching SOP rules found."}

    best_chunk = chunks[0]
    top_context = "\n".join([f"{c['entity']}: {c['content']}" for c in chunks])

    # Ground GLiClass with BOTH the retrieved rule AND the staff query
    grounded_input = (
        f"SOP Rule ({best_chunk['entity']}): {best_chunk['content']}\n"
        f"Staff Question: {req.query}"
    )

    # 1. GLiClass Multiple-Choice / Queue Routing (Context-Grounded)
    labels = req.custom_labels if req.custom_labels else DEFAULT_ROUTING_LABELS
    routing_preds = classifier(grounded_input, labels, threshold=0.01)[0]
    routing_sorted = sorted(routing_preds, key=lambda x: x["score"], reverse=True)

    # 2. Deterministic Rule Check + GLiClass Yes/No NLI Gate
    det_check = check_deterministic_rules(req.query, best_chunk)
    if det_check:
        yn_result = {
            "decision": det_check["decision"],
            "confidence": 1.0,
            "method": "deterministic_rule_engine",
            "explanation": det_check["reason"],
        }
    else:
        yn_labels = [
            "Yes, this action is allowed",
            "No, this action is prohibited or restricted",
            "Conditional, requires prerequisite or referral first",
            "Not a Yes/No question (Factual / Routing lookup)",
        ]
        yn_preds = classifier(grounded_input, yn_labels, threshold=0.01)[0]
        yn_sorted = sorted(yn_preds, key=lambda x: x["score"], reverse=True)
        yn_result = {
            "decision": yn_sorted[0]["label"],
            "confidence": round(yn_sorted[0]["score"], 4),
            "method": "gliclass_grounded_nli",
            "explanation": best_chunk["content"],
        }

    # 3. Extractive QA (Context-masked span extraction)
    extracted = extract_answer_span(req.query, best_chunk["content"])

    return {
        "query": req.query,
        "yes_no_gate": yn_result,
        "routing_classification": [
            {"label": item["label"], "score": round(item["score"], 4)}
            for item in routing_sorted[:2]
        ],
        "direct_fact_extraction": extracted,
        "matched_source": {
            "id": best_chunk["id"],
            "category": best_chunk["category"],
            "entity": best_chunk["entity"],
            "rules": best_chunk["rules"],
        },
    }