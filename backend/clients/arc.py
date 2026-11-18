"""VT ARC's LLM API: chat (multimodal LLM; OCR and speaker labels) and decide (fast decision model; page-turn
comparison). Needs LLM_API_KEY in .env."""
import json
import os
import urllib.error
import urllib.request

import backend.config  # noqa: F401  loads .env


def _post(path, body):
    """POST JSON to ARC's LLM API and return the parsed reply."""
    base_url = os.environ.get("LLM_BASE_URL", "https://llm-api.arc.vt.edu/api/v1").rstrip("/")
    req = urllib.request.Request(
        f"{base_url}/{path}",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {os.environ['LLM_API_KEY']}",
                 "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:  # the body says why, e.g. 403 "restricted to the VT Campus VPN"
        raise RuntimeError(f"ARC API {e.code}: {e.read().decode(errors='replace')[:300]}") from e


def chat(content):
    """Send one user message (a string or a list of content parts) to the LLM and return its reply."""
    reply = _post("chat/completions", {
        "model": "DeepSeek-V4.1-Flash",  # the multimodal model in ARC's docs
        "messages": [{"role": "user", "content": content}],
        # default is "high"; reading text verbatim doesn't need it (same OCR text, slightly faster in tests)
        "reasoning_effort": "low",
    })
    return reply["choices"][0]["message"]["content"] or ""  # content can be null


def decide(state, questions, images=()):
    """Ask ARC's fast decision model questions about `state` (text). Returns {question_id: answer}, e.g. a "choice"
    question gives {"choice": "next", "probabilities": {...}, "confidence": 0.98}.
    images: data URLs, at most 8 and 8192 tokens in all with the text (~450 tokens at 512 px, capped ~1570 per
    image). They must go here, not inside `state`: the model reads `state` as plain text, base64 and all."""
    body = {"model": "decision.vllm-sr/d3-mini", "state": state, "questions": questions}
    if images:
        body["images"] = list(images)
    return _post("systemone", body)["answers"]
