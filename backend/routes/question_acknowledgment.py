"""Follow-up question from what the child said beyond the book line: POST /question -> {question, expected_answer}.
An empty question means "nothing worth asking about" (fillers, chatter). Prompts adapted from ../CA lib/prompts.js."""
import json
import os
import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend import reading_log
from backend.clients import bedrock_gpt
from backend.config import IMG_DIR
from backend.db import BOOK_ID
from backend.pipeline.ocr import jpeg_data_url

router = APIRouter()

SYSTEM = """This is a parent-child shared reading system for children's picture books.

Style requirements:
- Use concrete, child-friendly language.
- Prefer short responses. MAX 30 words for questions.

Task: Your task is to generate ONE question to keep the parent-child pair engaged. The question must be one of the following category.

The pair just read <line_read> aloud and also said the words in <child_extra_words> (words not in the line).
If the extra words are fillers, noise, mishearings of the line, or unrelated chatter, return {"question": ""}.
Do not restate what the pair said.

Completion: A fill-in-the-blank prompt. Take a sentence from the current page and replace one word or short phrase with a blank for the child to complete. Prefer words that repeat in the story, rhyme, or match something visible in the illustration. Use the sentence as written in the text; do not paraphrase it.
Examples:
- "If only he had realized that the pebble resting on his back was the ____!"
- "I wish I were ____ again!"

Recall (R): Ask the child to remember a specific event or detail they ALREADY read. Use information from <page_illustration> or <line_read>.
Examples:
- "What color was the pebble Sylvester picked up?"
- "What did Sylvester wish to turn into when the lion came upon him?

Open-ended: Ask the child an open-ended question that does not have a right or wrong answer. The questions should ask the child's thought on the <line_read> or <page_illustration>.
Examples:
- "What do you think will happen next?"
- "Tell me what is happening in this picture."

Wh: Ask a who, what, when, where, why, or how question that asks further questions based on <child_extra_words>.
Examples:
- "Why did you feel shy in front of your friend?"
- "How did you dance during the play?"

Distancing: Ask a question that connects something in the story to the child's own life, feelings, or experiences. Stay within the book's content.
Examples:
- "What would you have done if you had the magic pebble and a lion approached you?"
- "Sylvester's family chose to keep the pebble. Would you keep it in a safe like they did?"

You have already asked <generated_question_list>. Generate question that does NOT overlap with the questions from the list.

Also decide the expected answer:
- Open-ended, distancing, subjective, or about the child's own preference or imagination: "expected_answer" is "".
- A clear, correct answer grounded in the page text: "expected_answer" is that answer in a few words.

Output JSON only. No explanation, no preface:
{"question":"<the question>","expected_answer":"<short answer>"}"""


class Heard(BaseModel):
    page_text: str
    line: str
    unmatched: str
    asked: list[str] = []
    reading: str = ""  # reading id from Book.jsx, for backend/reading_log.py
    book: str = ""  # with page_img: the page's stored image, sent to GPT as the illustration
    page_img: str = ""  # e.g. "page_002.png" (the page's "img" in the book JSON)


def illustration(book, page_img):
    """(JPEG data URL of the page's stored image, None) or (None, why there's no image). The names come from the
    browser, so they're checked before building a path."""
    if not book and not page_img:
        return None, "not sent"
    if not re.fullmatch(BOOK_ID.strip("^$"), book) or not re.fullmatch(r"page_\d{3}\.png", page_img):
        return None, "bad name"
    path = os.path.join(IMG_DIR, book, page_img)
    if not os.path.exists(path):
        return None, "no such file"
    # ponytail: 1024px long side is plenty for a picture-book page; raise if questions miss small details
    return jpeg_data_url(path, max_side=1024), None


@router.post("/question")
def question(h: Heard):
    asked = "\n".join(f'- "{q}"' for q in h.asked)
    user = (f"<current_page>\n{h.page_text}\n</current_page>\n<line_read>\n{h.line}\n</line_read>\n"
            f"<child_extra_words>\n{h.unmatched}\n</child_extra_words>\n"
            f"<generated_question_list>\n{asked}\n</generated_question_list>")
    reading_log.log(h.reading, "gpt sent", "\n" + user)
    image, why_not = illustration(h.book, h.page_img)
    if image:  # the page's illustration goes along as an image part of the message, as JPEG
        content = [{"type": "text", "text": user + "\n<page_illustration> is the current page, with its illustration."},
                   {"type": "image_url", "image_url": {"url": image}}]
        reading_log.log(h.reading, "gpt image", f"{h.book}/{h.page_img} as JPEG ({len(image) * 3 // 4 // 1024} KB)")
    else:
        content = user
        reading_log.log(h.reading, "gpt image", f"none ({why_not})")
    try:
        raw = bedrock_gpt.chat([{"role": "system", "content": SYSTEM}, {"role": "user", "content": content}])
        reading_log.log(h.reading, "gpt reply", raw)
        reply = json.loads(raw)
    except Exception as e:
        reading_log.log(h.reading, "gpt failed", repr(e))
        raise HTTPException(502, f"question failed: {e}") from e
    return {"question": str(reply.get("question") or "").strip(),
            "expected_answer": str(reply.get("expected_answer") or "").strip()}
