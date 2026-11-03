from fastapi import APIRouter
from backend.clients.deepgram import transcribe

router = APIRouter()

@router.get("/transcribe")
async def transcribe_speech():
    """Transcribe live audio using Deepgram."""
    await transcribe()
    return {"message": "Transcription started"}
