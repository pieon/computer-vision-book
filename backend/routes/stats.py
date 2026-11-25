"""Home page numbers."""
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter

from backend.db import books, reading

router = APIRouter()


@router.get("/stats")
def stats():
    """Home data: the last 8 days of scans and readings (UTC), and the last book read (None if none)"""
    since = datetime.now(timezone.utc) - timedelta(days=8)
    scans = []
    for doc in books.find({"updatedAt": {"$gte": since}}, {"scans": 1, "updatedAt": 1}):
        scans += doc.get("scans") or [doc["updatedAt"]]
    sessions = list(reading.find({"start": {"$gte": since}}, {"_id": 0, "start": 1, "minutes": 1}))

    latest = None
    doc = books.find_one({"lastRead": {"$exists": True}}, {"book": 1, "lastRead": 1}, sort=[("lastRead.at", -1)])
    if doc:
        book = doc["book"][0]["Book"]
        latest = {"id": doc["_id"], "name": book["Name"], "pages": len(book["Pages"]),
                  "read": {k: doc["lastRead"][k] for k in ("page", "finished", "cast")}}
    utc = lambda t: t.replace(tzinfo=timezone.utc).isoformat() 
    return {"scans": sorted(utc(t) for t in scans if t >= since.replace(tzinfo=None)),
            "reading": [{"start": utc(r["start"]), "minutes": r["minutes"]} for r in sessions],
            "latest": latest}
