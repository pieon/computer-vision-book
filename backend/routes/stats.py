"""Home page numbers."""
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter

from backend.db import books, reading

router = APIRouter()


@router.get("/stats")
def stats():
    """Home page data: scan times and reading sessions from the last 8 days (raw UTC; the app buckets them into
    its own local Mon-Sun week) and speaker coverage of the most recently updated book."""
    since = datetime.now(timezone.utc) - timedelta(days=8)
    scans = []
    for doc in books.find({"updatedAt": {"$gte": since}}, {"scans": 1, "updatedAt": 1}):
        scans += doc.get("scans") or [doc["updatedAt"]]
    sessions = list(reading.find({"start": {"$gte": since}}, {"_id": 0, "start": 1, "minutes": 1}))

    latest = None
    doc = books.find_one({}, {"book": 1}, sort=[("updatedAt", -1)])
    if doc:
        book = doc["book"][0]["Book"]
        said = [line["Character"] for page in book["Pages"].values() for line in page["text"]
                if line["Character"] != "Narrator"]
        latest = {"id": doc["_id"], "name": book["Name"], "lines": len(said),
                  "known": sum(c != "Unknown" for c in said)}
    utc = lambda t: t.replace(tzinfo=timezone.utc).isoformat() 
    return {"scans": sorted(utc(t) for t in scans if t >= since.replace(tzinfo=None)),
            "reading": [{"start": utc(r["start"]), "minutes": r["minutes"]} for r in sessions],
            "latest": latest}
