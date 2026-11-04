"""Vertex AI text-to-speech (Gemini TTS, voice Aoede), ported from CA's server/liveTTS_vertex.js.
Needs GOOGLE_APPLICATION_CREDENTIALS, VERTEX_PROJECT_ID, VERTEX_LOCATION and VERTEX_MODEL in .env."""
import io
import os
import re
import wave

import backend.config  # noqa: F401  loads .env
from google import genai

MODEL = os.environ["VERTEX_MODEL"]
VOICE = "Aoede"
PROMPT = "Say the following in a clear, natural, conversational way suitable for narrating a children's story: "

# the SDK signs requests with the service-account key named by GOOGLE_APPLICATION_CREDENTIALS
client = genai.Client(vertexai=True, project=os.environ["VERTEX_PROJECT_ID"], location=os.environ["VERTEX_LOCATION"])


def speak(text):
    """WAV bytes of `text` read aloud in the narrator voice."""
    text = re.sub(r"\bZoe\b", "Zoey", text)  # as in CA: the model says "Zoe" wrong
    reply = client.models.generate_content(
        model=MODEL,
        contents=PROMPT + text,
        config={"response_modalities": ["AUDIO"],
                "speech_config": {"language_code": "en-US",
                                  "voice_config": {"prebuilt_voice_config": {"voice_name": VOICE}}}},
    )
    pcm = reply.candidates[0].content.parts[0].inline_data.data  # raw 16-bit mono PCM at 24 kHz
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(pcm)
    return buf.getvalue()
