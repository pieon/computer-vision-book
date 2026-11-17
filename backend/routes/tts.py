"""Read-aloud audio: GET /tts?text=...&voice=... -> WAV. Each clip is generated once, then served from output/tts/."""
import hashlib
import os

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from backend.clients import vertex
from backend.config import ROOT

router = APIRouter()
CACHE_DIR = os.path.join(ROOT, "output", "tts")
# the voices the reader can pick per character (Cast.jsx, from CA's mates), lowercase -> Vertex name
VOICES = {v.lower(): v for v in ("Aoede", "umbriel", "puck", "Enceladus", "zephyr", "iapetus", "kore")}
HEADERS = {"Cache-Control": "max-age=31536000, immutable"}  # same text -> same clip, so the browser can keep it


@router.get("/tts")
def tts(text: str, voice: str = vertex.VOICE):
    text = text.strip()
    if not text:
        raise HTTPException(400, "empty text")
    voice = VOICES.get(voice.lower())
    if not voice:
        raise HTTPException(400, "unknown voice")
    key = hashlib.sha256(f"{vertex.MODEL}|{voice}|{text}".encode()).hexdigest()  # Aoede keys match the pre-voice cache
    path = os.path.join(CACHE_DIR, key[:2], key + ".wav")
    # ponytail: no in-flight dedupe or TTL; two first requests for one line both call Vertex, cache never shrinks
    if not os.path.exists(path):
        try:
            wav = vertex.speak(text, voice)
        except Exception as e:
            raise HTTPException(502, f"TTS failed: {e}") from e
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.tmp-{os.getpid()}"
        with open(tmp, "wb") as f:
            f.write(wav)
        os.replace(tmp, path)  # atomic: a reader never sees half a file
    return FileResponse(path, media_type="audio/wav", headers=HEADERS)
