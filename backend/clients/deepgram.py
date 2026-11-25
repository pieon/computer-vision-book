"""Deepgram live speech-to-text (nova-3). Needs DEEPGRAM_API_KEY in .env."""
import asyncio
import os

import backend.config  # noqa: F401  loads .env
from deepgram import AsyncDeepgramClient
from deepgram.listen.v1.types import ListenV1Results


async def transcribe(chunks, on_text):
    """Stream webm/opus audio to Deepgram; await on_text(text, final) per transcript."""
    # explicit key: .env may load after the SDK reads the env
    client = AsyncDeepgramClient(api_key=os.environ["DEEPGRAM_API_KEY"])
    async with client.listen.v1.connect(model="nova-3", interim_results="true", smart_format="false", endpointing=50, utterance_end_ms=1000) as conn:
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
