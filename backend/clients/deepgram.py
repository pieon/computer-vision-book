"""Deepgram live speech-to-text (nova-3). Needs DEEPGRAM_API_KEY in .env."""
import asyncio
import os

import backend.config  # noqa: F401  loads .env
from deepgram import AsyncDeepgramClient
from deepgram.listen.v1.types import ListenV1Results


async def transcribe(chunks, on_text):
    """Send audio (an async iterator of webm/opus bytes) to Deepgram; await on_text(text, final) per transcript.
    Interim transcripts arrive while someone is still talking, then one final per phrase."""
    # key passed explicitly: the SDK's default reads the env at import time, maybe before .env was loaded
    client = AsyncDeepgramClient(api_key=os.environ["DEEPGRAM_API_KEY"])
    async with client.listen.v1.connect(model="nova-3", interim_results="true", smart_format="true") as conn:
        async def read():
            async for msg in conn:
                if isinstance(msg, ListenV1Results) and msg.channel.alternatives[0].transcript:
                    await on_text(msg.channel.alternatives[0].transcript, bool(msg.is_final))

        reader = asyncio.create_task(read())
        try:
            async for data in chunks:  # Deepgram detects the webm container, so no encoding param
                await conn.send_media(data)
        finally:
            reader.cancel()
