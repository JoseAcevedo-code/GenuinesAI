/** Text normalisation helpers shared by the intent, conversation, and provider layers. */

const NAMED_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
};

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "about", "can", "could", "do", "does", "for", "from",
  "give", "how", "i", "in", "is", "it", "me", "of", "on", "please", "search",
  "tell", "the", "this", "to", "what", "when", "where", "which", "who", "why", "you",
]);

/**
 * Decodes the HTML entities that show up in RSS and Wikipedia payloads,
 * including the numeric forms those feeds emit for punctuation.
 */
export function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (match, hex: string) => codePointOr(match, parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (match, digits: string) => codePointOr(match, Number(digits)))
    .replace(/&(?:amp|quot|apos|lt|gt|nbsp);|&#39;/gi, (entity) => NAMED_ENTITIES[entity.toLowerCase()] ?? entity);
}

function codePointOr(fallback: string, codePoint: number): string {
  if (!Number.isInteger(codePoint) || codePoint < 1 || codePoint > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

/** Strips markup and collapses whitespace. Entities are decoded after tag removal. */
export function cleanText(value = ""): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim())
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizedTokens(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function meaningfulTokens(value: string): string[] {
  return normalizedTokens(value).filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

/** Drops consecutive duplicate sentences produced by feed boilerplate. */
export function dedupeSentences(value: string): string {
  const cleaned = cleanText(value);
  const sentences = cleaned.split(/(?<=[.!?])\s+(?=[A-Z0-9“"'])/);
  const kept: string[] = [];
  let previous = "";
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    const normalized = trimmed.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!trimmed || normalized === previous) continue;
    kept.push(trimmed);
    previous = normalized;
  }
  return kept.join(" ");
}

/** Truncates on a word boundary so a clipped query never ends mid-word. */
export function truncateOnWord(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const clipped = value.slice(0, maxLength);
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace > maxLength * 0.6 ? clipped.slice(0, lastSpace) : clipped).trim();
}
