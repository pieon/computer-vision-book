"""Bedrock's OpenAI-compatible Chat Completions endpoint (same as ../CA). Needs BEDROCK_API_KEY, BEDROCK_MODEL in .env."""
import json
import os
import urllib.request

import backend.config  # noqa: F401  loads .env

URL = "https://bedrock-mantle.us-east-1.api.aws/openai/v1/chat/completions"
MODEL = os.environ["BEDROCK_MODEL"]


def chat(messages, seed=None, max_tokens=512):
    """Send chat messages, get the reply text back (asked for as a JSON object). seed: same seed + same messages usually
    gives the same reply (temperature can't be set: this model only takes the default). max_tokens includes the
    model's reasoning, so a long input or choice needs more."""
    body = {"model": MODEL, "messages": messages, "max_completion_tokens": max_tokens,
            "response_format": {"type": "json_object"}}
    if seed is not None:
        body["seed"] = seed
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={
        "Authorization": f"Bearer {os.environ['BEDROCK_API_KEY']}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.load(res)["choices"][0]["message"]["content"]
