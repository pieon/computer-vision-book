"""VT ARC's LLM API: chat (OCR, speakers) and decide (page turns). Needs LLM_API_KEY."""
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
    except urllib.error.HTTPError as e: # e.g. 403 "restricted to the VT Campus VPN"
        raise RuntimeError(f"ARC API {e.code}: {e.read().decode(errors='replace')[:300]}") from e


def chat(content):
    """Send one user message (a string or a list of content parts) to the LLM and return its reply."""
    reply = _post("chat/completions", {
        "model": "DeepSeek-V4.1-Flash",  # the multimodal model in ARC's docs
        "messages": [{"role": "user", "content": content}],
        # the default "high" isn't needed for OCR
        "reasoning_effort": "low",
    })
    return reply["choices"][0]["message"]["content"] or ""  # content can be null


def decide(state, questions, images=()):
    """Ask the decision model about `state`; returns {question_id: answer}.
    images: data URLs (max 8), not inside `state`."""
    body = {"model": "decision.vllm-sr/d3-mini", "state": state, "questions": questions}
    if images:
        body["images"] = list(images)
    return _post("systemone", body)["answers"]
