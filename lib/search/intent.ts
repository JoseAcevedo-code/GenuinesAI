/** Intent classification and query extraction for the search route. */

import { meaningfulTokens, normalizedTokens, truncateOnWord } from "./text.ts";

export type HistoryItem = {
  role: "user" | "assistant";
  content: string;
  sourceTitles?: string[];
};

export const MAX_PROMPT_LENGTH = 500;
export const MAX_HISTORY_ITEMS = 10;
export const MAX_HISTORY_CONTENT_LENGTH = 500;

export const STRONG_NEWS_INTENT = /\b(news|breaking|headlines|current events?|what happened|what's happening|updates?)\b/i;
export const TIME_SENSITIVE_INTENT = /\b(today(?:['’]s)?|latest|recent|right now)\b/i;
export const SEARCH_INTENT = /\b(search(?: the)? web|search for|look up|find online|on the web|web search|check online)\b/i;
export const GREETING = /^(hi|hello|hey|yo|good morning|good afternoon|good evening)[!. ]*$/i;
export const KNOWLEDGE_INTENT = /^(who|what|where|when|why|how|which|is|are|was|were|do|does|did|can|could|should|would|will)\b|^(tell me about|explain|teach me about|i want to know about)\b/i;
export const FOLLOW_UP = /^(tell me more|more details|go deeper|keep going|continue|expand on that|what about (that|it)|how so|why|and why)[?!. ]*$/i;
export const CODING_INTENT = /\b(help(?: me)?(?: with| to)? (?:code|coding|programming|python|javascript|typescript|html|css|react|termux|a discord bot)|learn (?:to )?(?:code|coding|programming)|can you code|write (?:some )?(?:code|python|javascript|typescript|html|css)|de-?bugg?(?:ing)?(?: my| this| the)?(?: \w+)* (?:code|program|script|app|bot|project)|(?:python|javascript|typescript|java|html|css|react|node|sql)\s+(?:code|script|program|app|bug|error)|fix (?:my |this |the )?(?:\w+ )?(?:code|bug|error|script|program)|build (?:me )?(?:an? )?(?:app|website|bot|script)|(?:code|python|javascript|typescript|program|script).{0,30}\b(?:error|bug)\b|(?:error|bug).{0,30}\b(?:code|python|javascript|typescript|program|script)\b)\b/i;

export function hasNewsIntent(prompt: string): boolean {
  if (STRONG_NEWS_INTENT.test(prompt) || TIME_SENSITIVE_INTENT.test(prompt)) return true;
  return /\bcurrent\b/i.test(prompt)
    && /\b(news|events?|status|situation|polls?|prices?|weather|scores?|president|prime minister|governor|ceo)\b/i.test(prompt);
}

/**
 * Detects a prompt that is one phrase repeated end to end ("hello hello hello"),
 * so the router acknowledges it instead of treating it as a search query.
 */
export function findRepeatedPhrase(prompt: string): { phrase: string; count: number } | null {
  const tokens = normalizedTokens(prompt);
  if (tokens.length < 2 || tokens.length > 40) return null;

  for (let unitLength = 1; unitLength <= Math.floor(tokens.length / 2); unitLength += 1) {
    if (tokens.length % unitLength !== 0) continue;
    const repeats = tokens.length / unitLength;
    if (repeats < 2) continue;
    const repeatsCleanly = tokens.every((token, index) => token === tokens[index % unitLength]);
    if (repeatsCleanly) {
      return { phrase: tokens.slice(0, unitLength).join(" "), count: repeats };
    }
  }
  return null;
}

export function lastHistoryMessage(history: HistoryItem[], role: HistoryItem["role"]): HistoryItem | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item.role === role && item.content.trim()) return item;
  }
  return undefined;
}

/** Reduces a natural-language prompt to the topic worth sending to Wikipedia. */
export function queryFromPrompt(prompt: string): string {
  const query = prompt
    .replace(/\b(tell me more|more details|go deeper|keep going|continue|expand on that)\b/gi, " ")
    .replace(/^(?:can|could|would) you\s+(?:please\s+)?/i, "")
    .replace(/^(?:please\s+)?(?:search(?: the)? web|search for|look up|find online|check online)\s+(?:for\s+)?/i, "")
    .replace(/^(?:tell me about|teach me about|i want to know about|what do you know about|explain)\s+/i, "")
    .replace(/^(?:what|who|where) (?:is|are|was|were)\s+/i, "")
    .replace(/^(?:when|why|how) (?:is|are|was|were|do|does|did)\s+/i, "")
    .replace(/[^\p{L}\p{N}\s'’-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncateOnWord(query, 140);
}

/** Reduces a news prompt to the subject to feed the Google News search feed. */
export function topicFromNewsPrompt(prompt: string): string {
  const cleaned = prompt
    .replace(/today(?:['’]s)?/gi, " ")
    .replace(/\b(what is happening|what's happening|what happened)\b/gi, " ")
    .replace(/\b(can you|could you|please|look into|tell me about|show me|search for|search|find|on the web|web)\b/gi, " ")
    .replace(/\b(top|latest|current|recent|breaking|news|headlines|stories|happening|happened|updates?|what is|what's|the)\b/gi, " ")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Strip leading framing only after the collapse above, otherwise the words
    // removed in the middle leave "What are" stranded at the front of the query.
    .replace(/^(?:what|who|where|when|which)\s+(?:is|are|was|were|has|have)\s+/i, "")
    .replace(/^(?:in|about|for|on|regarding)\s+/i, "")
    .trim();
  return cleaned.length >= 2 ? truncateOnWord(cleaned, 110) : "";
}

/** Keeps only well-formed history entries, bounded in count and length. */
export function sanitizedHistory(value: unknown): HistoryItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_HISTORY_ITEMS).flatMap((item): HistoryItem[] => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Record<string, unknown>;
    if ((candidate.role !== "user" && candidate.role !== "assistant") || typeof candidate.content !== "string") return [];
    return [{
      role: candidate.role,
      content: candidate.content.trim().slice(0, MAX_HISTORY_CONTENT_LENGTH),
      sourceTitles: Array.isArray(candidate.sourceTitles)
        ? candidate.sourceTitles.filter((title): title is string => typeof title === "string").slice(0, 3)
        : undefined,
    }];
  });
}

/** Expands "tell me more" into the previous user prompt so the search has a subject. */
export function resolveFollowUp(prompt: string, history: HistoryItem[]): { prompt: string; contextUsed: boolean } {
  if (!FOLLOW_UP.test(prompt)) return { prompt, contextUsed: false };
  const previousUser = lastHistoryMessage(history, "user");
  if (!previousUser) return { prompt, contextUsed: false };
  return { prompt: `${previousUser.content} ${prompt}`, contextUsed: true };
}

/** Shared query-token overlap check used to reject unrelated search hits. */
export function overlapsQuery(query: string, candidate: string): boolean {
  const queryTokens = new Set(meaningfulTokens(query));
  if (queryTokens.size === 0) return true;
  const candidateTokens = new Set(meaningfulTokens(candidate));
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) return true;
  }
  return false;
}
