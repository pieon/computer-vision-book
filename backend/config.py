"""Settings shared by the backend: repo paths and .env. Imported first, so every module sees .env values."""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # repo root, so paths work from any cwd
WEIGHTS = os.path.join(ROOT, "weights", "best_model.pkl")
IMG_DIR = os.path.join(ROOT, "output", "books")  # page images, one folder per book

# Load KEY=value lines from .env in the repo root; real env vars win.
_env = os.path.join(ROOT, ".env")
if os.path.exists(_env):
    for line in open(_env):
        k, sep, v = line.strip().partition("=")
        if sep and not k.startswith("#"):
            os.environ.setdefault(k, v)

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
