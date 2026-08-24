/**
 * Graded relevance scoring for search results.
 *
 * `overlapsQuery` answers a yes/no question: does this candidate share any
 * meaningful token with the query? That is enough to reject total noise, but it
 * cannot order results — an article matching one token out of six ranks the
 * same as one matching all six. These helpers produce a score so results can be
 * ranked, and so a weak-but-nonzero match can be dropped rather than shown.
 */

import { meaningfulTokens } from "./text.ts";

/**
 * Below this share of query tokens, a match is treated as coincidental.
 *
 * Set just above one third so a three-token query cannot pass on a single
 * incidental word — "mars rover landing" should not match "Rover sales climb in
 * Europe". Shorter queries are unaffected: one token out of two still scores
 * 0.5, and a snippet-only hit on a one-token query also scores 0.5.
 */
export const MIN_RELEVANCE = 0.34;

/** Recency half-life for news ranking. Coverage older than a day decays fast. */
const RECENCY_HALF_LIFE_MS = 12 * 60 * 60 * 1000;

/**
 * Share of the query's meaningful tokens present in the candidate, 0..1.
 * A title match counts double: feeds pad descriptions with boilerplate, so a
 * token in the headline is much stronger evidence than one in the summary.
 */
export function relevanceScore(query: string, title: string, snippet = ""): number {
  const queryTokens = new Set(meaningfulTokens(query));
  if (queryTokens.size === 0) return 1;

  const titleTokens = new Set(meaningfulTokens(title));
  const snippetTokens = new Set(meaningfulTokens(snippet));

  let score = 0;
  for (const token of queryTokens) {
    if (titleTokens.has(token)) score += 1;
    else if (snippetTokens.has(token)) score += 0.5;
  }
  return Math.min(score / queryTokens.size, 1);
}

/** Exponential decay in [0,1]; 1 is now, 0.5 is one half-life ago. */
export function recencyWeight(publishedAt: string | undefined, now = Date.now()): number {
  if (!publishedAt) return 0.4; // Undated: plausible but unverifiable, so mid-low.
  const published = Date.parse(publishedAt);
  if (Number.isNaN(published)) return 0.4;
  const age = Math.max(now - published, 0);
  return 2 ** (-age / RECENCY_HALF_LIFE_MS);
}

/**
 * Combined news ranking. Relevance dominates because a fresh article about the
 * wrong subject is worse than a slightly older one about the right subject.
 * With no topic (a bare headlines request) relevance is 1 for everything and
 * this degrades cleanly to pure recency ordering.
 */
export function newsRank(
  query: string,
  source: { title: string; snippet: string; publishedAt?: string },
  now = Date.now(),
): number {
  return relevanceScore(query, source.title, source.snippet) * 0.7
    + recencyWeight(source.publishedAt, now) * 0.3;
}
