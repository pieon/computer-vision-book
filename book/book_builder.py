"""Turn a folder of book page images into Book2-style JSON: OCR each page, split it into
lines, and assign each line to the Narrator or a character.
Usage: python -m book.book_builder <img_folder> [--name "Title"] [--out book.json] [--characters Clara,Zoe]"""
import argparse
import json
import os
import re

from book.clean_ocr import QUOTES

# "...", ". . .", "…" (and a 4th dot for sentence-ending ellipses), with any surrounding spaces
ELLIPSIS = re.compile(r"\s*(?:…|\.(?:\s?\.){2,3})\s*")

# speech-tag verbs that don't end in -ed (regular ones like "beamed"/"cried" are matched by suffix)
VERBS = {"said", "says", "sang", "sings", "told", "spoke", "thought", "asks", "cries", "shouts", "whispers"}
NOT_NAMES = {"He", "She", "They", "I", "It", "We", "You", "The", "But", "And", "Then", "So", "His", "Her"}
NAME_TAG = re.compile(r"\b(?:said|sang|told|\w+ed)\s+([A-Z][a-z]+)|\b([A-Z][a-z]+)\s+(?:said|sang|told|\w+ed)\b")

ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
        "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"]
TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]


def normalize(text):
    """Curly quotes -> straight, ellipses -> AP style: three periods with a space on each side.
    A sentence-ending ellipsis keeps its period: "end. ... Next"."""
    text = text.translate(QUOTES)
    text = ELLIPSIS.sub(lambda m: ". ... " if m.group().count(".") == 4 else " ... ", text)
    text = re.sub(r" \.\.\. (?=[\"')\]](?!\w)|$)", " ...", text)  # no space before a closing quote/bracket
    text = re.sub(r"(\w)- ?(\w)", r"\1\2", text)  # moun-tain / dino- saur -> mountain / dinosaur
    return text.strip()


def number_word(n):
    """1..99 -> "One".."NinetyNine" for PageOne-style keys."""
    return ONES[n] if n < 20 else TENS[n // 10] + ONES[n % 10]


def split_lines(text):
    """Split page text into [(is_quote, line)]: each "..." span is dialogue, text between is narration.
    An unclosed quote (OCR cut off the page) runs to the end."""
    spans = re.findall(r'"[^"]*(?:"|$)|[^"]+', normalize(text))
    return [(s.startswith('"'), " ".join(s.split())) for s in spans if s.strip()]


def tags(lines, i):
    """Narration sentences that could be the speech tag of quote i: the first sentence after it
    ("...," said Zoe.), then the last sentence before it if that ends in , or : (Zoe said, "...")."""
    nxt = lines[i + 1] if i + 1 < len(lines) else (True, "")
    prv = lines[i - 1] if i > 0 else (True, "")
    if not nxt[0]:
        yield re.split(r"(?<=[.!?])\s", nxt[1])[0]
    if not prv[0] and prv[1].endswith((",", ":")):
        yield re.split(r"(?<=[.!?])\s", prv[1])[-1]


def find_names(texts):
    """Character names from speech tags next to quotes ("said Zoe", "Clara beamed") across all pages."""
    names = []
    for text in texts:
        lines = split_lines(text)
        for i in (i for i, (q, _) in enumerate(lines) if q):
            for tag in tags(lines, i):
                for m in NAME_TAG.finditer(tag):
                    name = m.group(1) or m.group(2)
                    if name not in NOT_NAMES and name not in names:
                        names.append(name)
    return names


def tag_speaker(sentence, names):
    """Speaker named in a short speech tag like "said Zoe." or "Clara beamed.", else None."""
    words = re.findall(r"[A-Za-z']+", sentence)
    if len(words) > 8 or not any(w in VERBS or w.endswith("ed") for w in words):
        return None
    return next((w for w in words if w in names), None)


def assign_speakers(lines, names):
    """Rule-based speaker for each line; None where a quote couldn't be attributed."""
    speakers = [None if q else "Narrator" for q, _ in lines]
    for i, (is_quote, _) in enumerate(lines):
        if is_quote:
            speakers[i] = next(filter(None, (tag_speaker(t, names) for t in tags(lines, i))), None)
        # interrupted quote: "...," said Wilbur, "..." -> second part has the same speaker
        if is_quote and not speakers[i] and i >= 2 and lines[i - 1][1].endswith(",") and lines[i - 2][0]:
            speakers[i] = speakers[i - 2]
    # back-to-back quotes with no narration between them share a speaker
    for order in (range(1, len(lines)), range(len(lines) - 2, -1, -1)):
        for i in order:
            j = i - 1 if order.step == 1 else i + 1
            if speakers[i] is None and lines[j][0] and speakers[j]:
                speakers[i] = speakers[j]
    return speakers


def llm_speakers(lines, unresolved, names):
    """Ask the LLM who says each unresolved quote. Returns {index: name}; empty if the reply doesn't parse."""
    from ocr.ocr import chat  # imported here so the rule-based parts work without .env/network

    numbered = "\n".join(f"{i}: {line}" for i, (_, line) in enumerate(lines))
    reply = chat(
        "These numbered lines are one page of a children's book.\n"
        f"Known characters: {', '.join(names) or 'unknown'}.\n{numbered}\n\n"
        f"Who speaks each of lines {unresolved}? Answer only with a JSON object mapping "
        'line number to character name, e.g. {"3": "Zoe"}.'
    )
    m = re.search(r"\{.*\}", reply, re.S)
    try:
        return {int(k): str(v) for k, v in json.loads(m.group()).items()} if m else {}
    except (ValueError, AttributeError):
        return {}


def build_page(img_name, text, names):
    if not text.strip() or text.lower().startswith("there is no text"):
        return {"img": img_name, "question": "", "text": []}
    lines = split_lines(text)
    speakers = assign_speakers(lines, names)
    unresolved = [i for i, s in enumerate(speakers) if s is None]
    if unresolved:
        print(f"  LLM fallback for {img_name}: lines {unresolved}")
        found = llm_speakers(lines, unresolved, names)
        for i in unresolved:
            speakers[i] = found.get(i, "Unknown")
    return {"img": img_name, "question": "",
            "text": [{"Reading": False, "Character": s, "Dialogue": line} for s, (_, line) in zip(speakers, lines)]}


def build_book(img_dir, name, names=None):
    from ocr.ocr import ocr

    imgs = sorted(f for f in os.listdir(img_dir) if f.lower().endswith((".jpg", ".jpeg", ".png")))
    texts = []
    for i, f in enumerate(imgs, 1):
        print(f"[ocr {i}/{len(imgs)}] {f}")
        texts.append(ocr(os.path.join(img_dir, f)))
    names = names or find_names(texts)
    print(f"Characters: {names}")

    pages = {}
    for i, (f, text) in enumerate(zip(imgs, texts)):
        pages["Cover" if i == 0 else "Page" + number_word(i)] = build_page(f, text, names)
    used = [s["Character"] for p in pages.values() for s in p["text"]]
    characters = ["Narrator"] + [n for n in dict.fromkeys(names + used) if n in used and n != "Narrator"]
    return [{"Book": {"id": 1, "Name": name,
                      "Characters": [{"Name": n, "img": ""} for n in characters],
                      "Pages": pages}}]


if __name__ == "__main__":
    assert normalize("“Don’t,” she said.") == '"Don\'t," she said.'
    assert normalize("I wonder . . . maybe") == normalize("I wonder…maybe") == "I wonder ... maybe"
    assert normalize("It ended. . . . Then") == "It ended. ... Then"
    assert normalize("“Wait . . .”") == '"Wait ..."'
    assert number_word(1) == "One" and number_word(15) == "Fifteen" and number_word(42) == "FortyTwo"
    n = ["Clara", "Zoe"]
    assert split_lines("“You count, and I’ll hide,” said Clara.") == [(True, '"You count, and I\'ll hide,"'), (False, "said Clara.")]
    assert assign_speakers(split_lines("“Welcome to my house!” Clara beamed."), n) == ["Clara", "Narrator"]
    assert assign_speakers(split_lines("“Hi,” sang Zoe. It was their first sleepover."), n) == ["Zoe", "Narrator"]
    assert assign_speakers(split_lines('Zoe said, "Look!"'), n) == ["Narrator", "Zoe"]
    assert assign_speakers(split_lines('"Mine goes up." "Yours goes down." said Clara.'), n) == ["Clara", "Clara", "Narrator"]
    assert assign_speakers(split_lines('"Who?" She looked around.'), n) == [None, "Narrator"]
    assert assign_speakers(split_lines("Zoe checked under the blanket. No Clara."), n) == ["Narrator"]
    assert assign_speakers(split_lines('"Oh," said Zoe, "look!"'), n) == ["Zoe", "Narrator", "Zoe"]
    assert find_names(['"Hi," said Zoe.', '"Yes!" Clara beamed. She said so.']) == ["Zoe", "Clara"]
    assert find_names(["One hundred people came. Many waved."]) == []

    p = argparse.ArgumentParser()
    p.add_argument("img_dir", help="Folder of page images, in reading order by file name.")
    p.add_argument("--name", help="Book title (default: folder name).")
    p.add_argument("--out", default="book.json")
    p.add_argument("--characters", help="Comma-separated character names (default: detect from speech tags).")
    args = p.parse_args()

    book = build_book(args.img_dir, args.name or os.path.basename(os.path.normpath(args.img_dir)),
                      args.characters.split(",") if args.characters else None)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(book, f, ensure_ascii=False, indent=2)
    print(f"-> {args.out}")
