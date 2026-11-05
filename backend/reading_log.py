"""One plain-text log per reading (one open of a book): Deepgram transcripts and GPT question prompts/replies.
Files land in output/reading_logs/<reading id>.log."""
import os
import re
from datetime import datetime

from backend.config import ROOT

LOG_DIR = os.path.join(ROOT, "output", "reading_logs")


def log(reading, kind, text):
    """Append "HH:MM:SS kind: text" to this reading's file; no reading id = no log."""
    reading = re.sub(r"[^\w-]", "", reading or "")  # the id comes from the browser: keep it a plain filename
    if not reading:
        return
    os.makedirs(LOG_DIR, exist_ok=True)
    with open(os.path.join(LOG_DIR, f"{reading}.log"), "a") as f:
        f.write(f"{datetime.now():%H:%M:%S} {kind}: {text}\n")


if __name__ == "__main__":  # self-check: a path-traversal id stays inside LOG_DIR
    log("../../evil_test", "check", "ok")
    path = os.path.join(LOG_DIR, "evil_test.log")
    assert open(path).read().endswith("check: ok\n")
    os.remove(path)
    print("ok")
