"""VT ARC's LLM API: chat (multimodal LLM) and decide (fast decision model). Needs LLM_API_KEY in .env."""
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


def decide(state, questions):
    """Ask ARC's decision model questions about `state` (text). Fast (~0.3 s), returns {question_id: answer},
    e.g. a "choice" question gives {"choice": "Zoe", "probabilities": {...}, "confidence": 0.98}."""
    return _post("systemone", {"model": "decision.vllm-sr/d3-mini", "state": state, "questions": questions})["answers"]
