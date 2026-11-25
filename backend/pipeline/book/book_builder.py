"""Build Book2 JSON from page images: OCR, split into lines, assign speakers.
Usage: python -m backend.pipeline.book.book_builder <img_folder> [--name "Title"] [--out book.json] [--characters Clara,Zoe]"""
import argparse
import json
import os
import re

from backend.pipeline.book.clean_ocr import QUOTES

# ellipsis forms, with surrounding spaces
ELLIPSIS = re.compile(r"\s*(?:…|\.(?:\s?\.){2,3})\s*")

# a "..." or '...' span; an apostrophe inside a word doesn't close it
# ponytail: 'the dogs' bones' closes early
QUOTE = re.compile(r"""\"[^\"]*(?:\"|$)|(?<![^\s(\[])'(?=\w)(?:[^']|'(?=\w))*(?:'(?!\w)|$)""")

ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
        "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"]
TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]


def normalize(text):
    """Curly quotes -> straight; ellipses -> AP style (' ... ')"""
    text = text.translate(QUOTES)
    text = ELLIPSIS.sub(lambda m: ". ... " if m.group().count(".") == 4 else " ... ", text)
    text = re.sub(r" \.\.\. (?=[\"')\]](?!\w)|$)", " ...", text)  # no space before a closing quote/bracket
    text = re.sub(r"(\w)- ?(\w)", r"\1\2", text)  # moun-tain / dino- saur -> mountain / dinosaur
    return text.strip()


def number_word(n):
    """1..99 -> "One".."NinetyNine" for PageOne-style keys."""
    return ONES[n] if n < 20 else TENS[n // 10] + ONES[n % 10]


def split_lines(text):
    """Split page text into [(is_quote, line)]; an unclosed quote runs to the end"""
    text = normalize(text)
    spans, at = [], 0
    for m in QUOTE.finditer(text):
        spans += [(False, text[at:m.start()]), (True, m.group())]
        at = m.end()
    spans.append((False, text[at:]))
    return [(q, " ".join(s.split())) for q, s in spans if s.strip()]


# sentence end: . ! ? and a space, not after a mid-sentence "..." or a title
# ponytail: short title list
SENTENCE_END = re.compile(r"(?<=[^.\s][.!?])(?<!\bMr\.)(?<!\bMrs\.)(?<!\bMs\.)(?<!\bDr\.)(?<!\bSt\.)([\"')\]]?)\s+")


def split_sentences(line):
    """One line -> its sentences, so narration clips start sooner"""
    parts = SENTENCE_END.split(line)  # [sentence, closer, sentence, closer, ...]
    return [s + c for s, c in zip(parts[::2], parts[1::2] + [""]) if s.strip()]


def tags(lines, i):
    """Sentences that could be quote i's speech tag: the one after it, or the one before ending in , or :"""
    nxt = lines[i + 1] if i + 1 < len(lines) else (True, "")
    prv = lines[i - 1] if i > 0 else (True, "")
    if not nxt[0]:
        yield re.split(r"(?<=[.!?])\s", nxt[1])[0]
    if not prv[0] and prv[1].endswith((",", ":")):
        yield re.split(r"(?<=[.!?])\s", prv[1])[-1]


_nlp = None


def is_living(noun):
    """True if WordNet's most common sense of the noun is a person or an animal ("mother", "bear"; not "door")."""
    from nltk.corpus import wordnet as wn  # one-time setup: python -c "import nltk; nltk.download('wordnet')"

    senses = wn.synsets(noun, pos="n")
    # ponytail: first WordNet sense only
    return bool(senses) and senses[0].lexname() in ("noun.person", "noun.animal")


def tag_subject(sentence):
    """Who talks in a speech-tag sentence (spaCy parse): the main verb's subject, or its object when inverted.
    Role nouns become names ("her mother" -> "Mother"); None for pronouns and things."""
    global _nlp
    if _nlp is None:
        import spacy  # loaded on first use: ~1 s

        _nlp = spacy.load("en_core_web_sm", exclude=["ner"])
    root = next((t for t in _nlp(sentence) if t.dep_ == "ROOT"), None)
    if root is None:
        return None
    kids = list(root.children)
    subj = (next((t for t in kids if t.dep_ in ("nsubj", "nsubjpass")), None)
            or next((t for t in kids if t.dep_ == "dobj" and t.pos_ in ("PROPN", "NOUN")), None))
    if subj is None or subj.pos_ == "PRON":
        return None
    if subj.pos_ == "PROPN":
        return " ".join([t.text for t in subj.lefts if t.dep_ == "compound"] + [subj.text])  # "Mr. Brown"
    if subj.pos_ == "NOUN" and is_living(subj.lemma_):
        return subj.lemma_.capitalize()
    return None


def find_names(texts):
    """Characters from the speech tags next to quotes across all pages: names and roles ("Zoe", "Mother")."""
    names = []
    for text in texts:
        lines = split_lines(text)
        for i in (i for i, (q, _) in enumerate(lines) if q):
            for tag in tags(lines, i):
                name = tag_subject(tag)
                if name and name not in names:
                    names.append(name)
    return names


def tag_speaker(sentence, names):
    """Speaker of a speech tag like "said Zoe." or "said her mother," if it's a known character, else None."""
    name = tag_subject(sentence)
    return name if name in names else None


def continues(lines, i):
    """True if quote i continues the quote before a one-sentence tag (same speaker)"""
    return (i >= 2 and lines[i][0] and lines[i - 2][0] and not lines[i - 1][0]
            and len(re.split(r"(?<=[.!?])\s", lines[i - 1][1])) == 1)


def assign_speakers(lines, names):
    """Rule-based speaker for each line; None where a quote couldn't be attributed."""
    speakers = [None if q else "Narrator" for q, _ in lines]
    continued = set()  # quotes that carry on the quote before their one-sentence tag
    for i, (is_quote, _) in enumerate(lines):
        if is_quote:
            speakers[i] = next(filter(None, (tag_speaker(t, names) for t in tags(lines, i))), None)
        # continued quote: "...," said Wilbur, "..." or "..." she said. "..." -> same speaker as before the tag
        if not speakers[i] and continues(lines, i):
            speakers[i] = speakers[i - 2]
            continued.add(i)
    # back-to-back quotes share a speaker, except a continued quote
    for order in (range(1, len(lines)), range(len(lines) - 2, -1, -1)):
        for i in order:
            j = i - 1 if order.step == 1 else i + 1
            if speakers[i] is None and i not in continued and lines[j][0] and speakers[j]:
                speakers[i] = speakers[j]
    return speakers


def rule_speakers(lines, names):
    """Rule-based speaker per line, "Unknown" where nothing fits: the LLM fallback"""
    speakers = assign_speakers(lines, names)
    for i, s in enumerate(speakers): # in order, so chains copy a filled speaker
        if s is None:
            speakers[i] = speakers[i - 2] if continues(lines, i) else "Unknown"
    return speakers


def llm_speakers(lines, names, text, prev_text=""):
    """Ask DeepSeek who says each quote on the page (previous page as context).
    Returns {index: name}, or None on failure."""
    quotes = [i for i, (q, _) in enumerate(lines) if q]
    if not quotes:
        return {}
    from backend.clients.arc import chat # imported here so the rules work offline

    numbered = "\n".join(f"{i}: {line}" for i, (_, line) in enumerate(lines))
    prompt = f"""You label who speaks each quote on one page of a children's picture book.
Known characters: {", ".join(names) or "(none found yet)"}

Previous page (context only):
{normalize(prev_text) or "(none)"}

This page as printed (line breaks are the book's paragraphs):
{normalize(text)}

This page as numbered lines:
{numbered}

Who speaks each quoted line ({", ".join(map(str, quotes))})?
- Use a known character's name exactly as listed when it's them; work out "he"/"she" from the story.
- A new paragraph of speech usually means a different speaker; untagged back-to-back replies usually alternate between the people talking.
- If someone not in the list speaks and the text names or describes them, give a short name ("Manager", "Mother").
- If you can't tell, use "Unknown".
Reply with only a JSON object from quoted line number to speaker, e.g. {{"0": "Zoe", "2": "Clara"}}."""
    try:
        reply = chat(prompt)
        found = json.loads(reply[reply.index("{"):reply.rindex("}") + 1])  # tolerates ```json fences or a preamble
    except Exception as e:  # speakers are a nice-to-have; never fail the page over them
        print(f"  speaker LLM failed: {e}")
        return None
    known = {n.lower(): n for n in names}
    return {int(k): known.get(v.strip().lower(), v.strip()) for k, v in found.items()
            if str(k).isdigit() and int(k) in quotes and isinstance(v, str) and 0 < len(v.strip()) <= 40
            and v.strip().lower() != "unknown"}


def build_page(img_name, text, names, prev_text=""):
    if not text.strip() or text.lower().startswith("there is no text"):
        return {"img": img_name, "question": "", "text": []}
    lines = split_lines(text)
    found = llm_speakers(lines, names, text, prev_text) or {}
    speakers = ["Narrator" if not q else found.get(i) for i, (q, _) in enumerate(lines)]
    if None in speakers: # the rules fill what the LLM missed
        print(f"  rule fallback for {img_name}: lines {[i for i, s in enumerate(speakers) if s is None]}")
        rules = rule_speakers(lines, names)
        speakers = [s or r for s, r in zip(speakers, rules)]
    # a quote stays one line; narration is split into sentences
    return {"img": img_name, "question": "",
            "text": [{"Reading": False, "Character": s, "Dialogue": sentence}
                     for s, (q, line) in zip(speakers, lines) for sentence in ([line] if q else split_sentences(line))]}


def build_book(img_dir, name, names=None):
    from backend.pipeline.ocr import ocr

    imgs = sorted(f for f in os.listdir(img_dir) if f.lower().endswith((".jpg", ".jpeg", ".png")))
    texts = []
    for i, f in enumerate(imgs, 1):
        print(f"[ocr {i}/{len(imgs)}] {f}")
        texts.append(ocr(os.path.join(img_dir, f)))
    names = names or find_names(texts)
    print(f"Characters: {names}")

    pages = {}
    for i, (f, text) in enumerate(zip(imgs, texts)):
        pages[page_key(i)] = build_page(f, text, names, texts[i - 1] if i else "")
    return book_json(name, pages, names)


def page_key(i):
    """0 -> "Cover", 1 -> "PageOne", ..."""
    return "Cover" if i == 0 else "Page" + number_word(i)


def cover_title(page):
    """Book name from the cover page's lines (as built or edited), joined; "" if it has none."""
    return " ".join(l["Dialogue"] for l in page["text"]).strip()[:80]


def book_json(name, pages, names, old=()):
    """Wrap pages in the Book2 structure; Characters = Narrator + speakers (old keeps face pictures)"""
    imgs = {c["Name"]: c.get("img", "") for c in old}
    used = [s["Character"] for p in pages.values() for s in p["text"]]
    characters = ["Narrator"] + [n for n in dict.fromkeys(names + used) if n in used and n != "Narrator"]
    return [{"Book": {"Name": name,
                      "Characters": [{"Name": n, "img": imgs.get(n, "")} for n in characters],
                      "Pages": pages}}]


if __name__ == "__main__":
    import backend.clients.arc as arc

    def offline(prompt):
        raise RuntimeError("offline")

    arc.chat = offline  # the checks below run the rules alone, no network
    assert normalize("“Don’t,” she said.") == '"Don\'t," she said.'
    assert normalize("I wonder . . . maybe") == normalize("I wonder…maybe") == "I wonder ... maybe"
    assert normalize("It ended. . . . Then") == "It ended. ... Then"
    assert normalize("“Wait . . .”") == '"Wait ..."'
    assert number_word(1) == "One" and number_word(15) == "Fifteen" and number_word(42) == "FortyTwo"
    # one line per sentence; not after "..." mid-sentence or a title
    assert split_sentences("Bram lived here. He was happy! Was he? Yes.") == ["Bram lived here.", "He was happy!", "Was he?", "Yes."]
    assert split_sentences("I wonder ... maybe not.") == ["I wonder ... maybe not."]
    assert split_sentences("Mr. Brown and Dr. Lee came. They sat.") == ["Mr. Brown and Dr. Lee came.", "They sat."]
    assert split_sentences('"Mine goes up. Yours goes down."') == ['"Mine goes up.', 'Yours goes down."']
    assert split_sentences("said Clara.") == ["said Clara."]
    assert build_page("p.png", '"Mine goes up. Yours goes down," said Clara. She smiled.', ["Clara"])["text"] == [
        {"Reading": False, "Character": "Clara", "Dialogue": '"Mine goes up. Yours goes down,"'},
        {"Reading": False, "Character": "Narrator", "Dialogue": "said Clara."},
        {"Reading": False, "Character": "Narrator", "Dialogue": "She smiled."}]
    # single quotes are dialogue too; apostrophes aren't quotes
    assert split_lines("'Maybe I was too stern,' she fretted. Miss Rosemary wasn't worried.") == \
        [(True, "'Maybe I was too stern,'"), (False, "she fretted. Miss Rosemary wasn't worried.")]
    assert split_lines("'I'm cool. See you after school.") == [(True, "'I'm cool. See you after school.")]
    assert split_lines("Zoe's dog wasn't there.") == [(False, "Zoe's dog wasn't there.")]
    assert split_lines('"He said \'hi\' to me," said Zoe.') == [(True, '"He said \'hi\' to me,"'), (False, "said Zoe.")]
    assert assign_speakers(split_lines("'Hi,' said Zoe."), ["Zoe"]) == ["Zoe", "Narrator"]
    assert find_names(["'Hi,' said Zoe."]) == ["Zoe"]
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
    # subject of the tag, any verb; roles become names; pronouns and things don't count
    assert tag_subject("Lisa's mother was saying,") == tag_subject("said her mother,") == "Mother"
    assert tag_subject("the artist wondered.") == "Artist" and tag_subject("said Corduroy to himself.") == "Corduroy"
    assert tag_subject("he said, sighing happily.") is None and tag_subject("The door slammed.") is None
    assert find_names(['"Hi," said her mother.', '"Oh!" Lisa exclaimed.']) == ["Mother", "Lisa"]
    # a quote after a one-sentence tag continues the earlier speaker, even when the next quote is someone else's
    assert assign_speakers(split_lines('"Oh!" Lisa said. "Look!" "Hi," said Zoe.'), ["Lisa", "Zoe"]) == \
        ["Lisa", "Narrator", "Lisa", "Zoe", "Narrator"]
    assert assign_speakers(split_lines('"Oh!" she said. "Look!" "Hi," said Zoe.'), ["Zoe"])[2] is None
    # DeepSeek decides the quotes; the rules fill the rest
    page = '"Want to play?" asked Clara.\n"Sure!"\n"Hi," said Zoe.'
    arc.chat = lambda prompt: '```json\n{"0": "clara", "2": "Zoe", "3": "Unknown"}\n```'
    assert [l["Character"] for l in build_page("p.png", page, n)["text"]] == ["Clara", "Narrator", "Zoe", "Zoe", "Narrator"]
    arc.chat = lambda prompt: '{"0": "Clara", "2": "Manager"}'
    assert [l["Character"] for l in build_page("p.png", page, n)["text"]][2] == "Manager"  # a speaker not in the list
    arc.chat = offline # rules alone: Clara's reply goes to Clara
    assert [l["Character"] for l in build_page("p.png", page, n)["text"]] == ["Clara", "Narrator", "Clara", "Zoe", "Narrator"]
    arc.chat = lambda prompt: "no idea"
    assert [l["Character"] for l in build_page("p.png", '"Who?" She looked.', n)["text"]] == ["Unknown", "Narrator"]
    arc.chat = offline

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
