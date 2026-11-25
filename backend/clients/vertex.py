"""Vertex AI text-to-speech (Gemini TTS, voice Aoede), ported from CA's server/liveTTS_vertex.js.
Needs GOOGLE_APPLICATION_CREDENTIALS, VERTEX_PROJECT_ID, VERTEX_LOCATION and VERTEX_MODEL in .env."""
import hashlib
import io
import os
import threading
import wave

from backend.config import ROOT  # also loads .env
from google import genai

MODEL = os.environ["VERTEX_MODEL"]
VOICE = "Aoede"
CACHE_DIR = os.path.join(ROOT, "output", "tts")  # one WAV per model, voice and text; served by routes/tts.py

# the SDK signs requests with the service-account key named by GOOGLE_APPLICATION_CREDENTIALS
client = genai.Client(vertexai=True, project=os.environ["VERTEX_PROJECT_ID"], location=os.environ["VERTEX_LOCATION"])


def speak(text, voice=VOICE):
    """WAV bytes of `text` read aloud in a Gemini prebuilt voice (default: the narrator's)."""
    reply = client.models.generate_content(
        model=MODEL,
        contents=text,
        config={"response_modalities": ["AUDIO"],
                "speech_config": {"language_code": "en-US",
                                  "voice_config": {"prebuilt_voice_config": {"voice_name": voice}}}},
    )
    pcm = reply.candidates[0].content.parts[0].inline_data.data
    if pcm[:4] == b"RIFF":
        return pcm
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(pcm)
    return buf.getvalue()


def clip_path(text, voice=VOICE):
    """Where the clip of `text` (stripped) in `voice` (a Vertex name, e.g. "Aoede") is cached."""
    key = hashlib.sha256(f"{MODEL}|{voice}|{text.strip()}".encode()).hexdigest()  # Aoede keys match the pre-voice cache
    return os.path.join(CACHE_DIR, key[:2], key + ".wav")


def clip(text, voice=VOICE):
    """The cached clip's path, generated first if it isn't there (raises if Vertex fails).
    ponytail: no in-flight dedupe; two first requests for one line both call Vertex"""
    path = clip_path(text, voice)
    if not os.path.exists(path):
        wav = speak(text.strip(), voice)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.tmp-{os.getpid()}-{threading.get_ident()}"
        with open(tmp, "wb") as f:
            f.write(wav)
        os.replace(tmp, path)  # atomic: a reader never sees half a file
    return path
