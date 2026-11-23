"""Sound effects for a page, picked once at scan time (or after its lines are edited) and stored on the page as
page["sounds"] = {"setting": loop or None, "lines": {"<line index>": effect + "word"}}, sounds from Freesound
(backend/clients/freesound.py). The reader (Book.jsx) plays them in whichever modes are switched on: the setting as a
background loop, a line's effect when the line starts or when its `word` is said.
Two LLM calls per page: 1) which sounds the Narrator's lines call for (keywords), 2) after a Freesound search per
keyword, which of the ~10 results fits each moment and suits a children's book (or none). Sounds the user removed in
Edit Book (the book's blockedSounds) are never offered again."""
import json
import os
import threading
import time

from backend.clients import bedrock_gpt, freesound
from backend.config import IMG_DIR
from backend.db import books, deleted, lock
from backend.pipeline.ocr import jpeg_data_url

NONE = {"setting": None, "lines": {}}
SEED = 7  # same page, same seed: usually the same picks (temperature can't be set on this model)

KEYWORDS = """You add sound effects to a children's picture book read aloud. You get the narrator's lines of one page,
each with its line number, and usually a photo of the page with its illustration. Reply with JSON:
{"setting": <string or null>, "lines": [{"line": <number>, "sound": <string>, "word": <string>}]}
- setting: a background sound for the whole page: any recognisable place, indoors or out, or weather ("sea waves",
  "rain", "busy street", "quiet house", "kitchen", "classroom", "park birds", "crackling fireplace"). Use the
  illustration as well as the text: where the picture shows the scene is, even when the words don't say. null only
  for title, author, dedication or copyright pages, or when neither the words nor the picture show a place.
- lines: every line where something makes a noise, or someone does something you'd naturally hear (walking,
  running, a door closing, eating, pouring, wind, a car passing, an animal). At most one per line; skip the rest.
- Never a human voice: no sound for saying, asking, answering, talking, whispering, shouting, calling, singing,
  crying, laughing, sighing or breathing. The narrator's voice already reads the people; only non-voice sounds.
- sound: 1-3 plain words naming the sound itself, specific ("cow moo", not "animal sound"; "car driving past",
  "door knock", "tea pouring").
- word: the one word in that line where the sound happens, copied exactly as it appears in the line."""

CHOOSE = """You choose sound effects for a children's picture book read aloud. For each slot you get the moment it is
for and numbered Freesound search results (name, tags, description, seconds). Reply with JSON:
{"setting": <result id or null>, "lines": {"<line number>": <result id or null>}}
Pick the result that sounds most like that moment in a gentle children's book. Never pick anything scary, violent or
dramatic (death, dying, screams, horror, gore, blood, weapons, war, monsters), anything from games, sci-fi or cartoons
with synthetic sounds, music, or any human voice (speech, words, singing, crying, laughing, moaning, breathing): the
narrator already reads the people. null if none fits well."""


def _choose(slots, seed):
    """slots: {"setting" or "<line>": (moment text, [candidates])} -> {slot: chosen candidate or None}."""
    def show(c):
        return {"id": c["id"], "name": c["name"], "tags": c["tags"], "description": c["description"], "seconds": round(c["duration"], 1)}
    ask = {s: {"moment": moment, "results": [show(c) for c in found]} for s, (moment, found) in slots.items()}
    reply = json.loads(bedrock_gpt.chat([{"role": "system", "content": CHOOSE},
                                         {"role": "user", "content": json.dumps(ask, ensure_ascii=False)}],
                                        seed=seed, max_tokens=4000))
    picks = {"setting": reply.get("setting"), **{str(k): v for k, v in (reply.get("lines") or {}).items()}}
    chosen = {}
    for s, (_, found) in slots.items():
        by_id = {c["id"]: c for c in found}
        try:
            chosen[s] = by_id.get(int(picks.get(s)))
        except (TypeError, ValueError):  # null, or not an id: none fits
            chosen[s] = None
    return chosen


def page_sounds(page, blocked=(), image=None):
    """Pick a page's sounds from its Narrator lines (see the module docstring). NONE for a page without Narrator lines,
    or if an LLM reply is unusable. blocked: Freesound ids never to use (removed by the user). image: the page's
    stored image path; sent along so the background can follow the illustration."""
    narrated = {i: l["Dialogue"] for i, l in enumerate(page.get("text", [])) if l["Character"] == "Narrator"}
    if not narrated:
        return NONE
    blocked = set(blocked)
    try:
        listed = "\n".join(f"{i}: {d}" for i, d in narrated.items())
        content = listed
        if image and os.path.isfile(image):  # the page photo as JPEG, same as the follow-up questions send it
            # ponytail: 1024px long side, as for questions; enough to tell a beach from a kitchen
            content = [{"type": "text", "text": listed}, {"type": "image_url", "image_url": {"url": jpeg_data_url(image, max_side=1024)}}]
        reply = json.loads(bedrock_gpt.chat([{"role": "system", "content": KEYWORDS}, {"role": "user", "content": content}],
                                            seed=SEED, max_tokens=4000))
        slots, words = {}, {}
        setting = reply.get("setting")
        if setting:
            slots["setting"] = (f"background of the whole page: {setting}. Page: {' '.join(narrated.values())}",
                                [c for c in freesound.candidates(setting, "loop") if c["id"] not in blocked])
        for item in reply.get("lines") or []:
            try:
                i, word = int(item["line"]), str(item["word"]).strip()
            except (KeyError, TypeError, ValueError):
                continue
            # only the Narrator's lines, one sound each, and a word that's in the line (so it can be timed)
            if i not in narrated or str(i) in slots or not word or word.lower() not in narrated[i].lower():
                continue
            found = [c for c in freesound.candidates(item.get("sound"), "effect") if c["id"] not in blocked]
            if found:
                slots[str(i)] = (f"{item.get('sound')} — in the line: {narrated[i]}", found)
                words[str(i)] = word
        slots = {s: v for s, v in slots.items() if v[1]}
        chosen = _choose(slots, SEED) if slots else {}
    except Exception as e:
        print(f"  sounds: failed for {page.get('img')}: {e!r}", flush=True)
        return NONE
    return {"setting": chosen.get("setting"),
            "lines": {s: {**c, "word": words[s]} for s, c in chosen.items() if s != "setting" and c}}


def set_page_sounds(book_id, img, text):
    """Pick sounds for the page showing `img` with lines `text`, and store them on it, unless it changed meanwhile
    (deleted, or its lines edited: the edit picks its own). Returns the sounds stored, or None if not stored."""
    start = time.perf_counter()
    blocked = (books.find_one({"_id": book_id}, {"blockedSounds": 1}) or {}).get("blockedSounds", [])
    sounds = page_sounds({"img": img, "text": text}, blocked, os.path.join(IMG_DIR, book_id, os.path.basename(img)))
    with lock:
        doc = books.find_one({"_id": book_id}, {"book": 1}) if book_id not in deleted else None
        pages = doc["book"][0]["Book"]["Pages"] if doc else {}
        key = next((k for k, p in pages.items() if p["img"] == img and p["text"] == text), None)
        if key:  # Cover / PageOne...: no . or $, safe in the dotted path
            books.update_one({"_id": book_id}, {"$set": {f"book.0.Book.Pages.{key}.sounds": sounds}})
    n = len(sounds["lines"])
    print(f"book {book_id} sounds {img}: setting {sounds['setting'] and sounds['setting']['keyword']!r}, "
          f"{n} line effect{'s' * (n != 1)}{'' if key else ' (page changed meanwhile: not saved)'} "
          f"| {time.perf_counter() - start:.1f}s", flush=True)
    return sounds if key else None


def pick_later(book_id, page):
    """set_page_sounds for this page in the background."""
    threading.Thread(target=set_page_sounds, args=(book_id, page["img"], page["text"]), daemon=True).start()
