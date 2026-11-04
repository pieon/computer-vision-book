"""Read-aloud audio: GET /tts?text=... -> WAV. Each clip is generated once, then served from output/tts/."""
import hashlib
import os

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from backend.clients import vertex
from backend.config import ROOT

router = APIRouter()
CACHE_DIR = os.path.join(ROOT, "output", "tts")
HEADERS = {"Cache-Control": "max-age=31536000, immutable"}  # same text -> same clip, so the browser can keep it


@router.get("/tts")
def tts(text: str):
    text = text.strip()
    if not text:
        raise HTTPException(400, "empty text")
    key = hashlib.sha256(f"{vertex.MODEL}|{vertex.VOICE}|{text}".encode()).hexdigest()
    path = os.path.join(CACHE_DIR, key[:2], key + ".wav")
    # ponytail: no in-flight dedupe or TTL; two first requests for one line both call Vertex, cache never shrinks
    if not os.path.exists(path):
        try:
            wav = vertex.speak(text)
        except Exception as e:
            raise HTTPException(502, f"TTS failed: {e}") from e
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.tmp-{os.getpid()}"
        with open(tmp, "wb") as f:
            f.write(wav)
        os.replace(tmp, path)  # atomic: a reader never sees half a file
    return FileResponse(path, media_type="audio/wav", headers=HEADERS)
