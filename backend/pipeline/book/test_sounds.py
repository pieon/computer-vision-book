"""Checks for page sound picking, no network: both LLM calls and Freesound are faked. Run from the repo root:
python -m backend.pipeline.book.test_sounds"""
import json

from backend.clients import bedrock_gpt, freesound
from backend.pipeline.book import sounds

PAGE = {"img": "page_009.png", "text": [
    {"Character": "Narrator", "Dialogue": "Papa knocked on the door."},
    {"Character": "Bram", "Dialogue": '"Who is it?"'},
    {"Character": "Narrator", "Dialogue": "Bram waited by the sea."},
    {"Character": "Onomatopoeia", "Dialogue": "Woof!"},
]}


def cand(keyword, id_):
    return {"keyword": keyword, "id": id_, "name": f"n{id_}", "user": "u", "license": "l", "url": f"https://x/{id_}.mp3",
            "duration": 2.0, "tags": [], "description": ""}


def test_page_sounds():
    searched, sent = [], {}

    def fake_search(keyword, kind):
        searched.append((keyword, kind))
        if "nothing" in keyword:
            return []
        base = {"zz test sea waves": 100, "zz test door knock": 200, "zz test footsteps": 300}.get(keyword, 900)
        return [cand(keyword, base + k) for k in range(3)]

    def fake_chat(messages, seed=None, max_tokens=512):
        system, user = messages[0]["content"], messages[1]["content"]
        assert seed == sounds.SEED
        if system == sounds.KEYWORDS:
            sent["lines"] = user
            return json.dumps({"setting": "zz test sea waves", "lines": [
                {"line": 0, "sound": "zz test door knock", "word": "knocked"},
                {"line": 1, "sound": "zz test voice", "word": "Who"},  # Bram's line: never used
                {"line": 3, "sound": "zz test dog bark", "word": "Woof"},  # Onomatopoeia: never used
                {"line": 2, "sound": "zz test footsteps", "word": "jumped"},  # word not in the line: dropped
            ]})
        sent["choose"] = json.loads(user)
        return json.dumps({"setting": 102, "lines": {"0": 999}})  # 999: not one of the line's results -> none

    real_chat, real_search = bedrock_gpt.chat, freesound._search
    sounds.bedrock_gpt.chat, freesound._search = fake_chat, fake_search
    try:
        got = sounds.page_sounds(PAGE, blocked=[100])
        assert '"Who is it?"' not in sent["lines"] and "Woof" not in sent["lines"], sent["lines"]  # Narrator lines only
        assert "0: Papa knocked on the door." in sent["lines"] and "2: Bram waited by the sea." in sent["lines"]
        assert set(sent["choose"]) == {"setting", "0"}, sent["choose"]
        assert [r["id"] for r in sent["choose"]["setting"]["results"]] == [101, 102]  # 100 is blocked
        assert got["setting"]["id"] == 102 and got["lines"] == {}, got
        assert ("zz test voice", "effect") not in searched and ("zz test dog bark", "effect") not in searched

        sounds.bedrock_gpt.chat = lambda m, seed=None, max_tokens=512: (
            fake_chat(m, seed) if m[0]["content"] == sounds.KEYWORDS else json.dumps({"setting": None, "lines": {"0": 201}}))
        got = sounds.page_sounds(PAGE)
        assert got["setting"] is None and got["lines"]["0"]["id"] == 201 and got["lines"]["0"]["word"] == "knocked", got
        n = len(searched)
        sounds.page_sounds(PAGE)  # every keyword is cached now
        assert len(searched) == n, searched[n:]

        freesound.cache.update_one({"_id": "effect|zz test old"}, {"$set": {"sound": cand("zz test old", 1)}}, upsert=True)
        assert [c["id"] for c in freesound.candidates("zz test old", "effect")] == [900, 901, 902]  # old entry: searched again

        sounds.bedrock_gpt.chat = lambda m, seed=None, max_tokens=512: "not json"
        assert sounds.page_sounds(PAGE) == sounds.NONE
        assert sounds.page_sounds({"img": "x.png", "text": [PAGE["text"][1]]}) == sounds.NONE  # no Narrator line: no call
    finally:
        sounds.bedrock_gpt.chat, freesound._search = real_chat, real_search
        freesound.cache.delete_many({"_id": {"$regex": r"\|zz test "}})
    print("ok sounds")


if __name__ == "__main__":
    test_page_sounds()
