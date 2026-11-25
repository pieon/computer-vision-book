"""Freesound search for effects and loops. Needs FREESOUND_TOKEN. Non-commercial; credit each sound's
creator per its licence. Searches are cached in db.sounds."""
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from backend.config import ROOT  # also loads .env
from backend.db import db

URL = "https://freesound.org/apiv2/search/"
# max clip length per kind
# played on repeat under the page (waves)
FILTERS = {"effect": "duration:[0.3 TO 4]", "loop": "duration:[10 TO 120]"}
GAP = 1.1 # s between searches (60 a minute allowed)
FILE_DIR = os.path.join(ROOT, "output", "sfx")  # downloaded preview MP3s, served by routes/sounds.py
cache = db.sounds  # {_id: "<kind>|<keyword>", candidates: [...] (empty: nothing found)}
_lock = threading.Lock()
_last = 0.0


def _search(keyword, kind):
    """Top 10 results, with the fields the choosing LLM sees"""
    global _last
    query = urllib.parse.urlencode({"query": keyword, "filter": FILTERS[kind], "page_size": 10,
                                    "fields": "id,name,username,license,duration,previews,tags,description"})
    req = urllib.request.Request(f"{URL}?{query}", headers={"Authorization": f"Token {os.environ['FREESOUND_TOKEN']}"})
    with _lock: # one search at a time, GAP apart
        time.sleep(max(0.0, _last + GAP - time.monotonic()))
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                results = json.load(res)["results"]
        finally:
            _last = time.monotonic()
    return [{"keyword": keyword, "id": r["id"], "name": r["name"], "user": r["username"], "license": r["license"],
             "url": r["previews"]["preview-hq-mp3"], "duration": r["duration"], "tags": r.get("tags", [])[:8],
             "description": " ".join(str(r.get("description") or "").split())[:150]} for r in results]


def candidates(keyword, kind):
    """Up to 10 sounds for `keyword` and kind, cached; [] if none or failed (failures aren't cached)."""
    keyword = " ".join(str(keyword or "").lower().split())
    if not keyword:
        return []
    key = f"{kind}|{keyword}"
    hit = cache.find_one({"_id": key})
    if hit and "candidates" in hit:  # older entries kept one pick ("sound"): searched again
        return hit["candidates"]
    try:
        found = _search(keyword, kind)
    except (urllib.error.URLError, KeyError, ValueError, TimeoutError) as e:  # 429 / no token / network: no sound now
        print(f"freesound: {kind} {keyword!r} failed: {e!r}", flush=True)
        return []
    cache.update_one({"_id": key}, {"$set": {"candidates": found}, "$unset": {"sound": ""}}, upsert=True)
    return found


def find(keyword, kind):
    """The top result for a fixed keyword (the reader's cues), or None."""
    return next(iter(candidates(keyword, kind)), None)


def download(sound_id):
    """Download a picked sound's MP3 into output/sfx/ once; None if this app never searched it."""
    path = os.path.join(FILE_DIR, f"{sound_id}.mp3")
    if os.path.isfile(path):
        return path
    hit = cache.find_one({"candidates.id": sound_id}, {"candidates.$": 1})
    if not hit:
        return None
    os.makedirs(FILE_DIR, exist_ok=True)
    with urllib.request.urlopen(hit["candidates"][0]["url"], timeout=20) as res:
        data = res.read()
    part = f"{path}.{threading.get_ident()}.part"  # two downloads of one sound at once don't share a temp file
    with open(part, "wb") as f:
        f.write(data)
    os.replace(part, path)  # a half-written file is never served
    return path
