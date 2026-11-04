"""Live transcription: the reader's mic audio in over a websocket, Deepgram's transcripts back out."""
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend.clients import deepgram

router = APIRouter()


@router.websocket("/listen")
async def listen(ws: WebSocket):
    """Binary messages from the browser = audio chunks; text messages back = {"transcript", "final"}."""
    await ws.accept()

    async def chunks():
        while True:
            yield await ws.receive_bytes()

    try:
        await deepgram.transcribe(chunks(), lambda text, final: ws.send_json({"transcript": text, "final": final}))
    except WebSocketDisconnect:  # the reader left the book: the normal way this ends
        pass
    except Exception as e:  # e.g. missing key or Deepgram refused; show it, close the socket
        print(f"listen failed: {e!r}")
        await ws.close(code=1011)
