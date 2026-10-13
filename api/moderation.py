"""
Flag potentially harmful text for an admin to look at.

This is a safety net on a site used by twelve-year-olds, not a guarantee. It
is deliberately simple and deterministic — a word and pattern scanner — because
the alternative (shipping text off to a third-party classifier) would send the
kids' messages somewhere else, which is the opposite of why this site is
private in the first place.

Severity decides what happens, not whether we noticed:
  high   - held from publication AND queued for review (slurs, threats,
           sexual content aimed at or involving minors)
  medium - published, but queued for review (profanity, insults)
  low    - published, but queued (personal details: phone, address, email)

The lists live in moderation-terms.json so JL can extend them without a code
change; what ships is a starting point, not a complete one.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

TERMS_FILE = Path(__file__).parent / "moderation-terms.json"

# Patterns, unlike word lists, do not need maintaining.
PATTERNS: list[tuple[str, str, str]] = [
    # (severity, category, regex)
    ("high", "threat",
     r"\b(?:i(?:'m| am)? ?(?:gonna|going to)|i'?ll)\s+(?:kill|hurt|beat|jump|end)\s+(?:you|him|her|them|u)\b"),
    ("high", "threat", r"\b(?:kill|hang|shoot)\s+your ?self\b"),
    ("high", "self-harm", r"\b(?:kill myself|end it all|want to die|cut myself)\b"),
    ("low",  "personal-info", r"\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b"),
    ("low",  "personal-info", r"\b\d{1,5}\s+[A-Z][a-z]+\s+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Cres|Crescent)\b"),
    ("low",  "personal-info", r"\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b"),
]


def _load_terms() -> dict[str, dict[str, list[str]]]:
    if TERMS_FILE.exists():
        return json.loads(TERMS_FILE.read_text(encoding="utf-8"))
    return {}


_TERMS = _load_terms()


def reload_terms() -> None:
    """Pick up edits to moderation-terms.json without a restart."""
    global _TERMS
    _TERMS = _load_terms()


def _normalise(text: str) -> str:
    """Fold the usual evasions: f*ck, f u c k, fuuuck, f4ck."""
    t = text.lower()
    t = t.translate(str.maketrans({"4": "a", "3": "e", "1": "i", "0": "o", "5": "s", "7": "t", "@": "a", "$": "s"}))
    t = re.sub(r"[^a-z\s]", "", t)          # strip punctuation used to break words
    t = re.sub(r"(.)\1+", r"\1", t)        # fuuuuck -> fuck; terms are folded the
                                            # same way, so doubles stay comparable
    t = re.sub(r"\b(\w)\s+(?=\w\b)", r"\1", t)   # f u c k -> fuck
    return t


# Censoring your own swearing is the commonest evasion there is, and stripping
# punctuation turns "f**k" into "fk". So each letter may also appear as a
# wildcard symbol, with a little separator noise tolerated between letters.
_WILDCARD = r"[*#@$%!]"
_SEP = r"[^a-z0-9]{0,2}"

def _fuzzy(term: str) -> re.Pattern:
    parts = [rf"(?:{re.escape(ch)}|{_WILDCARD})" for ch in term.lower() if ch.isalnum()]
    return re.compile(rf"(?<![a-z]){_SEP.join(parts)}(?![a-z])", re.I)

_FUZZY_CACHE: dict[str, re.Pattern] = {}

def _fuzzy_cached(term: str) -> re.Pattern:
    if term not in _FUZZY_CACHE:
        _FUZZY_CACHE[term] = _fuzzy(term)
    return _FUZZY_CACHE[term]


def scan(text: str) -> list[dict]:
    """Return every reason this text might need a human look. Empty is clean."""
    if not text or not text.strip():
        return []
    findings: list[dict] = []
    norm = _normalise(text)

    for severity, category, terms in (
        (sev, cat, words)
        for sev, cats in _TERMS.items()
        for cat, words in cats.items()
    ):
        for w in terms:
            if w.startswith("["):           # placeholder entry, not a real term
                continue
            hit = (re.search(rf"\b{re.escape(_normalise(w))}\b", norm)
                   or _fuzzy_cached(w).search(text))
            if hit:
                findings.append({"severity": severity, "category": category, "match": w})
                break      # one hit per category is enough to flag it

    for severity, category, pattern in PATTERNS:
        m = re.search(pattern, text, re.I)
        if m:
            findings.append({"severity": severity, "category": category,
                             "match": m.group(0)[:60]})

    return findings


def worst(findings: list[dict]) -> str | None:
    for level in ("high", "medium", "low"):
        if any(f["severity"] == level for f in findings):
            return level
    return None


def should_hold(findings: list[dict]) -> bool:
    """High severity is held back from the site until an admin clears it."""
    return worst(findings) == "high"
