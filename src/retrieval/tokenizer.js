const RETRIEVAL_TOKENIZER_ID = "unicode-v2";

// Keep this list deliberately small. Retrieval must not erase negation or
// domain-bearing words merely because they are common in general prose.
const RELEVANCE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "how",
  "of",
  "or",
  "should",
  "the",
  "to",
]);

const MARK_PATTERN = /\p{M}/u;
const LATIN_LETTER_PATTERN = /\p{Script=Latin}/u;
const TOKEN_PATTERN = /[\p{L}\p{N}\p{M}_]+/gu;

function tokenizeRetrievalText(value, { removeStopWords = true } = {}) {
  const normalized = normalizeRetrievalText(value);
  const tokens = normalized.match(TOKEN_PATTERN) ?? [];

  return removeStopWords
    ? tokens.filter((token) => !RELEVANCE_STOP_WORDS.has(token))
    : tokens;
}

function normalizeRetrievalText(value) {
  const decomposed = String(value ?? "")
    .normalize("NFKD")
    .toLowerCase();
  let normalized = "";
  let previousBaseWasLatin = false;

  for (const character of decomposed) {
    if (MARK_PATTERN.test(character)) {
      if (!previousBaseWasLatin) {
        normalized += character;
      }
      continue;
    }

    normalized += character;
    previousBaseWasLatin = LATIN_LETTER_PATTERN.test(character);
  }

  return normalized.normalize("NFC");
}

module.exports = {
  RETRIEVAL_TOKENIZER_ID,
  RELEVANCE_STOP_WORDS,
  normalizeRetrievalText,
  tokenizeRetrievalText,
};
