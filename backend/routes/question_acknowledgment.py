"""Follow-up question from what the child said beyond the book line: POST /question -> {question, expected_answer}.
An empty question means "nothing worth asking about" (fillers, chatter). Prompts adapted from ../CA lib/prompts.js."""
import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend import reading_log
from backend.clients import bedrock_gpt

router = APIRouter()

SYSTEM = """This is a parent-child co-reading system for children's picture books.
Audience: pre-schoolers and young children, roughly ages 3-6, reading with a caregiver.
Primary goal: keep the interaction grounded in the current book page and what the child said.
Style requirements:
- Use concrete, child-friendly language.
- Prefer short responses. MAX 20 words for questions.
- Do NOT invent story facts, objects, names, or emotions not supported by the page text.

Task: generate one short, engaging follow-up question for a pre-schooler, plus the answer you would expect.

The child just read <line_read> aloud and also said the words in <child_extra_words> (words not in the line).
Make a concrete Wh-Question, description prompt, simple recall, or completion-style question inspired by those extra
words and the page text.
If the extra words are fillers, noise, mishearings of the line, or unrelated chatter, return {"question": ""}.
Do NOT ask a question that just repeats what the child said, or that overlaps with <generated_question_list>.
The child must be able to answer with words, not gestures, pointing, or physical actions.

Also decide the expected answer:
- Open-ended, subjective, or about the child's own preference or imagination: "expected_answer" is "".
- A clear, correct answer grounded in the page text: "expected_answer" is that answer in a few words.

Output JSON only. No explanation, no preface:
{"question":"<the question>","expected_answer":"<short answer>"}"""


class Heard(BaseModel):
    page_text: str
    line: str
    unmatched: str
    asked: list[str] = []
    reading: str = ""  # reading id from Book.jsx, for backend/reading_log.py


@router.post("/question")
def question(h: Heard):
    asked = "\n".join(f'- "{q}"' for q in h.asked)
    user = (f"<current_page>\n{h.page_text}\n</current_page>\n<line_read>\n{h.line}\n</line_read>\n"
            f"<child_extra_words>\n{h.unmatched}\n</child_extra_words>\n"
            f"<generated_question_list>\n{asked}\n</generated_question_list>")
    reading_log.log(h.reading, "gpt sent", "\n" + user)
    try:
        raw = bedrock_gpt.chat([{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}])
        reading_log.log(h.reading, "gpt reply", raw)
        reply = json.loads(raw)
    except Exception as e:
        reading_log.log(h.reading, "gpt failed", repr(e))
        raise HTTPException(502, f"question failed: {e}") from e
    return {"question": str(reply.get("question") or "").strip(),
            "expected_answer": str(reply.get("expected_answer") or "").strip()}
