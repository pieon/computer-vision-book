"""Checks for ElevenLabs sound generation and its pipeline path, no network (client and LLM faked). Run from the repo
root: python -m backend.clients.test_elevenlabs"""
import json
import os
import tempfile

from backend.clients import bedrock_gpt, elevenlabs
from backend.pipeline.book import sounds


class FakeSfx:
    def __init__(self):
        self.calls = []

    def convert(self, **kw):
        self.calls.append(kw)
        return iter([b"ID3", b"mp3"])


def test_generate():
    elevenlabs.FILE_DIR = tempfile.mkdtemp()
    fake = FakeSfx()
    elevenlabs._client = type("C", (), {"text_to_sound_effects": fake})()
    a = elevenlabs.generate("  gentle   rain on a window ", "loop")
    assert a["id"] == elevenlabs.sound_id("gentle rain on a window", "loop") and a["keyword"] == "gentle rain on a window"
    assert fake.calls[0]["loop"] is True and fake.calls[0]["text"].endswith(elevenlabs.TAIL["loop"])
    assert open(elevenlabs.download(a["id"]), "rb").read() == b"ID3mp3"
    assert elevenlabs.generate("gentle rain on a window", "loop") == a and len(fake.calls) == 1  # cached
    e = elevenlabs.generate("gentle rain on a window", "effect")
    assert e["id"] != a["id"] and "loop" not in fake.calls[1]
    assert elevenlabs.generate("", "effect") is None
    assert elevenlabs.download("el000000000000") is None and elevenlabs.download("../x") is None
    return fake


def test_page_path(fake):
    os.environ["SOUND_SOURCE"] = "elevenlabs"
    page = {"img": "p.png", "text": [{"Character": "Narrator", "Dialogue": "Papa knocked on the door."},
                                     {"Character": "Bram", "Dialogue": "Who?"}]}

    def fake_chat(messages, seed=None, max_tokens=512):
        assert messages[0]["content"] == sounds.DESCRIBE  # one call, no choosing
        return json.dumps({"setting": "a quiet cosy house", "lines": [
            {"line": 0, "sound": "knuckles knocking on a wooden door", "word": "knocked"},
            {"line": 1, "sound": "a voice", "word": "Who"}]})  # not the Narrator: dropped

    bedrock_gpt.chat = fake_chat
    got = sounds.page_sounds(page)
    assert got["setting"]["keyword"] == "a quiet cosy house" and list(got["lines"]) == ["0"]
    assert got["lines"]["0"]["word"] == "knocked"
    blocked = sounds.page_sounds(page, blocked=[got["lines"]["0"]["id"]])
    assert blocked["lines"] == {} and blocked["setting"]
    # too many: 3 kept, spread over the page
    many = {"img": "p.png", "text": [{"Character": "Narrator", "Dialogue": f"a bang {k}"} for k in range(7)]}
    bedrock_gpt.chat = lambda m, seed=None, max_tokens=512: json.dumps(
        {"setting": None, "lines": [{"line": k, "sound": f"bang {k}", "word": "bang"} for k in range(7)]})
    assert list(sounds.page_sounds(many)["lines"]) == ["0", "3", "6"]
    os.environ["SOUND_SOURCE"] = "freesound"
    assert sounds.source().__name__.endswith("freesound")


if __name__ == "__main__":
    test_page_path(test_generate())
    print("ok elevenlabs")
