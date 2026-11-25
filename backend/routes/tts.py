"""Read-aloud audio: GET /tts?text=...&voice=... -> WAV. Each clip is generated once, then served from output/tts/."""
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from backend.clients import vertex

router = APIRouter()
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
    try:  # ponytail: the cache never shrinks
        path = vertex.clip(text, voice)  # scanned books' narrator lines are made already (pipeline/book/sounds.py)
    except Exception as e:
        raise HTTPException(502, f"TTS failed: {e}") from e
    return FileResponse(path, media_type="audio/wav", headers=HEADERS)
