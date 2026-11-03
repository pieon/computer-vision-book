"""Extract text from an image via VT ARC's LLM API. Usage: python -m ocr.ocr image.jpg"""
import base64
import json
import mimetypes
import os
import sys
import urllib.request

# Load KEY=value lines from .env in the repo root; real env vars win.
_env = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
if os.path.exists(_env):
    for line in open(_env):
        k, sep, v = line.strip().partition("=")
        if sep and not k.startswith("#"):
            os.environ.setdefault(k, v)


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


def ocr(path):
    """Send the image to the LLM and return the extracted text."""
    mime = mimetypes.guess_type(path)[0] or "image/jpeg"
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    return chat([
        {"type": "text", "text": "Extract main text in this image verbatim. Output only the text."},
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
    ])


if __name__ == "__main__":
    path = sys.argv[1]
    text = ocr(path)
    print(text)
