"""ElevenLabs sound generation: the same find/download as freesound.py, but generated from a description.
On with SOUND_SOURCE=elevenlabs; needs ELEVENLABS. MP3s are cached in output/sfx/ by a hash of the prompt."""
import hashlib
import os
import re
import threading

from elevenlabs.client import ElevenLabs

from backend.config import ROOT  # also loads .env

FILE_DIR = os.path.join(ROOT, "output", "sfx") # shared with Freesound
ID = re.compile(r"^el[0-9a-f]{12}$")
# added to every prompt
TAIL = {"loop": " Soft, calm ambience for a gentle children's story. No voices, no speech, no music.",
        "effect": " One short, clear sound, gentle for a children's story. No voices, no music."}
# generations at once: the plan's limit (429 above it); raise after upgrading
CONCURRENT = 4
_slots = threading.BoundedSemaphore(CONCURRENT)
LOOP_SECONDS = 30 # the API's max; loop=True repeats seamlessly
_client = None


def sound_id(prompt, kind):
    return "el" + hashlib.sha1(f"{kind}|{prompt}".encode()).hexdigest()[:12]


def _path(sid):
    return os.path.join(FILE_DIR, f"{sid}.mp3")


def generate(prompt, kind):
    """Sound for `prompt`, kind 'loop' or 'effect'; generated once, then cached. None on failure."""
    global _client
    prompt = " ".join(str(prompt or "").split())
    if not prompt:
        return None
    sid = sound_id(prompt, kind)
    sound = {"keyword": prompt, "id": sid, "name": "generated", "user": "ElevenLabs", "license": "ElevenLabs terms",
             "duration": LOOP_SECONDS if kind == "loop" else None}
    path = _path(sid)
    if os.path.isfile(path):
        return sound
    try:
        _client = _client or ElevenLabs(api_key=os.environ["ELEVENLABS"])
        extra = {"loop": True, "duration_seconds": LOOP_SECONDS} if kind == "loop" else {}
        with _slots:
            audio = _client.text_to_sound_effects.convert(text=prompt + TAIL[kind], model_id="eleven_text_to_sound_v2",
                                                          prompt_influence=0.5, output_format="mp3_44100_128", **extra)
            data = b"".join(audio)
    except Exception as e:
        print(f"elevenlabs: {kind} {prompt!r} failed: {e!r}", flush=True)
        return None
    os.makedirs(FILE_DIR, exist_ok=True)
    part = f"{path}.{threading.get_ident()}.part"  # a half-written file is never served
    with open(part, "wb") as f:
        f.write(data)
    os.replace(part, path)
    return sound


def find(keyword, kind):
    """A sound for a fixed keyword (the reader's cues), or None."""
    return generate(keyword, kind)


def download(sid):
    """A generated sound's path, or None: sounds are generated when picked, so there's nothing to fetch."""
    path = _path(sid)
    return path if ID.match(sid) and os.path.isfile(path) else None
