"""Live transcription: the reader's mic audio in over a websocket, Deepgram's transcripts back out."""
from datetime import datetime, timezone

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend import reading_log
from backend.db import reading
from backend.clients import deepgram

router = APIRouter()


@router.websocket("/listen")
async def listen(ws: WebSocket):
    """Binary messages from the browser = audio chunks; text messages back = {"transcript", "final"}."""
    await ws.accept()
    start = datetime.now(timezone.utc)

    async def chunks():
        while True:
            yield await ws.receive_bytes()

    reading = ws.query_params.get("reading", "")

    def on_text(text, final):
        reading_log.log(reading, f"deepgram {'final' if final else 'interim'}", text)
        return ws.send_json({"transcript": text, "final": final})

    try:
        await deepgram.transcribe(chunks(), on_text)
    except WebSocketDisconnect:  # the reader left the book: the normal way this ends
        pass
    except Exception as e:  # e.g. missing key or Deepgram refused; show it, close the socket
        print(f"listen failed: {e!r}")
        await ws.close(code=1011)
    finally: # one socket = one reading session
        # ponytail: no mic = reading not counted
        minutes = (datetime.now(timezone.utc) - start).total_seconds() / 60
        reading.insert_one({"bookId": ws.query_params.get("book", ""), "start": start, "minutes": minutes})
