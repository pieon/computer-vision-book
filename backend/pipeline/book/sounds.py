import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from backend.clients import bedrock_gpt, elevenlabs, freesound, vertex
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

# KEYWORDS for ElevenLabs: the same slots and rules, but descriptions to generate from rather than search words
MAX_EFFECTS = 3  # line effects per page with ElevenLabs: more than this was busy (7 on one page)
DESCRIBE = KEYWORDS.split("\n- sound:")[0].replace(
    "- lines: every line where something makes a noise, or someone does something you'd naturally hear (walking,\n"
    "  running, a door closing, eating, pouring, wind, a car passing, an animal). At most one per line; skip the rest.",
    f"- lines: at most {MAX_EFFECTS} per page, at most one per line: the clearest noises (a door closing, pouring, an\n"
    "  animal, footsteps, wind), spread over the page (start, middle, end), not bunched on neighbouring lines.\n"
    "  Fewer is fine; none if nothing makes a noise.",
).replace(
    'background sound for the whole page: any recognisable place',
    'background sound for the whole page, described in one sentence for a sound generator: the place\'s layered '
    'ambience and mood ("gentle sea waves lapping on a sandy beach, distant seagulls, a light breeze"). Any recognisable place'
) + """
- sound: one sentence for a sound generator describing only that single noise: what makes it, on what, and how
  ("a small wooden door creaking open slowly", "a cow mooing once in a field", "hot tea pouring into a china cup").
  No scene around it, no music, no people talking.
- word: the one word in that line where the sound happens, copied exactly as it appears in the line."""

CHOOSE = """You choose sound effects for a children's picture book read aloud. For each slot you get the moment it is
for and numbered Freesound search results (name, tags, description, seconds). Reply with JSON:
{"setting": <result id or null>, "lines": {"<line number>": <result id or null>}}
Pick the result that sounds most like that moment in a gentle children's book. Never pick anything scary, violent or
dramatic (death, dying, screams, horror, gore, blood, weapons, war, monsters), anything from games, sci-fi or cartoons
with synthetic sounds, music, or any human voice (speech, words, singing, crying, laughing, moaning, breathing): the
narrator already reads the people. null if none fits well."""


def source():
    """The module sounds come from: elevenlabs with SOUND_SOURCE=elevenlabs in .env, else freesound."""
    return elevenlabs if os.environ.get("SOUND_SOURCE", "").strip().lower() == "elevenlabs" else freesound


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
    generated = source() is elevenlabs
    try:
        listed = "\n".join(f"{i}: {d}" for i, d in narrated.items())
        content = listed
        if image and os.path.isfile(image):  # the page photo as JPEG, same as the follow-up questions send it
            # ponytail: 1024px long side, as for questions; enough to tell a beach from a kitchen
            content = [{"type": "text", "text": listed}, {"type": "image_url", "image_url": {"url": jpeg_data_url(image, max_side=1024)}}]
        reply = json.loads(bedrock_gpt.chat([{"role": "system", "content": DESCRIBE if generated else KEYWORDS},
                                             {"role": "user", "content": content}], seed=SEED, max_tokens=4000))
        if generated:
            return _generate(reply, narrated, blocked)
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


def _generate(reply, narrated, blocked):
    """page_sounds for ElevenLabs: generate each described sound; the same description is the same sound, so one the
    user removed (blocked) is skipped, not generated again."""
    def make(prompt, kind):
        s = elevenlabs.generate(prompt, kind)
        return s if s and s["id"] not in blocked else None

    ok = {}
    for item in reply.get("lines") or []:
        try:
            i, word = int(item["line"]), str(item["word"]).strip()
        except (KeyError, TypeError, ValueError):
            continue
        # only the Narrator's lines, one sound each, and a word that's in the line (so it can be timed)
        if i in narrated and i not in ok and word and word.lower() in narrated[i].lower():
            ok[i] = (item.get("sound"), word)
    # more than MAX_EFFECTS anyway: keep ones evenly spaced over the page (first, middle, last), before generating
    order = sorted(ok)
    if len(order) > MAX_EFFECTS:
        order = [order[round(k * (len(order) - 1) / (MAX_EFFECTS - 1))] for k in range(MAX_EFFECTS)]
    # all at once (elevenlabs.CONCURRENT caps the calls across pages)
    jobs = {"setting": (reply.get("setting"), "loop"), **{str(i): (ok[i][0], "effect") for i in order}}
    with ThreadPoolExecutor(len(jobs)) as pool:
        made = dict(zip(jobs, pool.map(lambda j: make(*j), jobs.values())))
    return {"setting": made["setting"],
            "lines": {str(i): {**made[str(i)], "word": ok[i][1]} for i in order if made[str(i)]}}


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
    # downloaded now, in the background, so they're ready before the reader first plays them (Pick again doesn't wait)
    threading.Thread(target=download_all, args=([sounds["setting"], *sounds["lines"].values()],), daemon=True).start()
    n = len(sounds["lines"])
    print(f"book {book_id} sounds {img}: setting {sounds['setting'] and sounds['setting']['keyword']!r}, "
          f"{n} line effect{'s' * (n != 1)}{'' if key else ' (page changed meanwhile: not saved)'} "
          f"| {time.perf_counter() - start:.1f}s", flush=True)
    return sounds if key else None


def download_all(picked):
    """Download each picked sound's MP3 (None entries skipped); a failure is only printed: the reader's request
    downloads it later instead."""
    for s in picked:
        if not s or not isinstance(s["id"], int):  # generated sounds (ElevenLabs) are saved already
            continue
        try:
            freesound.download(s["id"])
        except Exception as e:
            print(f"  sounds: download of {s['id']} failed: {e!r}", flush=True)


# The reader's default voice for these speakers (Cast.jsx: the Narrator starts as Aoede, sound words follow the
# Narrator), so their clips can be made while the book processes; other characters' voices are chosen per reading.
VOICED = ("Narrator", "Onomatopoeia")
_voicing = threading.BoundedSemaphore(8)  # Vertex calls at once from processing (the reader's own calls don't wait)


def voiced_lines(text):
    return [l["Dialogue"] for l in text if l["Character"] in VOICED and l["Dialogue"].strip()]


def voice_page(text):
    """Make the clips of a page's narrator lines in the default voice (vertex.clip caches them)."""
    def one(line):
        with _voicing:
            try:
                vertex.clip(line)
            except Exception as e:  # made on demand while reading instead
                print(f"  voice: {line[:40]!r} failed: {e!r}", flush=True)
    lines = voiced_lines(text)
    if lines:
        with ThreadPoolExecutor(len(lines)) as pool:
            list(pool.map(one, lines))


def prepare_later(book_id, page):
    """A scanned page's sounds and narrator clips, both in the background at once. The Library's progress bar
    (routes/books.py scan_progress) counts them."""
    threading.Thread(target=set_page_sounds, args=(book_id, page["img"], page["text"]), daemon=True).start()
    threading.Thread(target=voice_page, args=(page["text"],), daemon=True).start()


def pick_later(book_id, page):
    """set_page_sounds for this page in the background."""
    threading.Thread(target=set_page_sounds, args=(book_id, page["img"], page["text"]), daemon=True).start()
