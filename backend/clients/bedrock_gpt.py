"""Bedrock's OpenAI-compatible Chat Completions endpoint (same as ../CA). Needs BEDROCK_API_KEY, BEDROCK_MODEL in .env."""
import json
import os
import urllib.request

import backend.config  # noqa: F401  loads .env

URL = "https://bedrock-mantle.us-east-1.api.aws/openai/v1/chat/completions"
MODEL = os.environ["BEDROCK_MODEL"]


def chat(messages):
    """Send chat messages, get the reply text back (asked for as a JSON object)."""
    body = {"model": MODEL, "messages": messages, "max_completion_tokens": 512,
            "response_format": {"type": "json_object"}}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={
        "Authorization": f"Bearer {os.environ['BEDROCK_API_KEY']}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.load(res)["choices"][0]["message"]["content"]
