/** Live source providers: RSS news feeds and the Wikipedia REST API. */

import { USER_AGENT } from "../branding.ts";
import { readCache, writeCache } from "./cache.ts";
import { MIN_RELEVANCE, newsRank, relevanceScore } from "./relevance.ts";
import { cleanText, dedupeSentences, truncateOnWord } from "./text.ts";
import { queryFromPrompt, topicFromNewsPrompt } from "./intent.ts";

export type SearchSource = {
  title: string;
  url: string;
  snippet: string;
  source: string;
  publishedAt?: string;
  key?: string;
};

type WikipediaPage = {
  key?: string;
  title?: string;
  excerpt?: string;
  description?: string | null;
};

type WikipediaSummary = {
  title?: string;
  extract?: string;
};

/**
 * Upstream feeds are third-party and unbounded. Reading them into memory without
 * a ceiling lets one oversized response exhaust the Worker's memory, so every
 * read is capped and the request is abandoned as soon as the cap is passed.
 */
const MAX_RESPONSE_BYTES = 1_500_000;

const HEADLINE_FEEDS = [
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml", source: "BBC News" },
  { url: "https://feeds.npr.org/1001/rss.xml", source: "NPR" },
  { url: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", source: "The New York Times" },
];

async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Upstream response declared ${declared} bytes, over the ${maxBytes} byte limit`);
  }
  if (!response.body) return response.text();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`Upstream response exceeded the ${maxBytes} byte limit`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}

/**
 * One timeout-and-size-bounded fetch used by both providers. Previously the JSON
 * and text paths were near-identical copies that drifted in their timeouts and
 * error messages.
 */
async function fetchBounded(url: URL, accept: string, timeoutMs: number, label: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: accept, "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${label} returned ${response.status}`);
    return await readCappedText(response, MAX_RESPONSE_BYTES);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${label} timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url: URL, timeoutMs: number, label: string): Promise<unknown> {
  return JSON.parse(await fetchBounded(url, "application/json", timeoutMs, label)) as unknown;
}

/**
 * Feed reads go through the TTL cache. Identical feed URLs are requested on
 * nearly every news query, and the documents change on the order of minutes.
 */
async function fetchXml(url: URL, timeoutMs: number, label: string): Promise<string> {
  const key = url.toString();
  const cached = readCache(key);
  if (cached !== null) return cached;

  const xml = await fetchBounded(url, "application/rss+xml, application/xml, text/xml", timeoutMs, label);
  writeCache(key, xml);
  return xml;
}

function readFeedTag(item: string, name: string): string {
  const match = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  return cleanText((match?.[1] ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
}

/** Parses one RSS document into sources. Exported for tests; does no network I/O. */
export function parseFeedItems(xml: string, feedSource: string, topic: string, seen: Set<string>): SearchSource[] {
  const results: SearchSource[] = [];
  for (const item of xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? []) {
    const title = readFeedTag(item, "title");
    const articleUrl = readFeedTag(item, "link");
    if (!title || !articleUrl || !articleUrl.startsWith("https://")) continue;

    const key = title.toLowerCase().replace(/\W/g, "").slice(0, 90);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const published = readFeedTag(item, "pubDate");
    const publishedDate = published ? new Date(published) : null;
    const description = readFeedTag(item, "description");
    results.push({
      title,
      url: articleUrl,
      source: readFeedTag(item, "source") || feedSource,
      snippet: description || (topic ? `Recent coverage matching “${topic}”.` : "A current top story."),
      publishedAt: publishedDate && !Number.isNaN(publishedDate.getTime()) ? publishedDate.toISOString() : undefined,
    });
  }
  return results;
}

/**
 * Ranks and trims news results.
 *
 * With a topic, weak matches are dropped rather than shown — returning nothing
 * lets the route say so honestly, which beats padding the list with unrelated
 * headlines. With no topic every result scores 1, so this reduces to recency
 * order and the filter is a no-op.
 */
export function rankNews(sources: SearchSource[], topic: string, limit: number, now = Date.now()): SearchSource[] {
  const scored = sources.map((source) => ({ source, rank: newsRank(topic, source, now) }));
  const relevant = topic
    ? scored.filter(({ source }) => relevanceScore(topic, source.title, source.snippet) >= MIN_RELEVANCE)
    : scored;

  return relevant
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit)
    .map(({ source }) => source);
}

export async function searchNews(prompt: string, limit: number): Promise<SearchSource[]> {
  const topic = topicFromNewsPrompt(prompt);

  // A topic search hits Google News for depth, but the curated wires are read
  // alongside it: the search feed goes thin or empty on niche phrasing, and the
  // relevance filter below means an off-topic wire story is discarded anyway.
  const feeds = topic
    ? [
        {
          url: `https://news.google.com/rss/search?q=${encodeURIComponent(`${topic} when:2d`)}&hl=en-US&gl=US&ceid=US:en`,
          source: "Google News",
        },
        ...HEADLINE_FEEDS,
      ]
    : HEADLINE_FEEDS;

  const responses = await Promise.allSettled(
    feeds.map(async (feed) => ({ ...feed, xml: await fetchXml(new URL(feed.url), 8000, `News feed ${feed.source}`) })),
  );

  const seen = new Set<string>();
  const results: SearchSource[] = [];
  for (const response of responses) {
    if (response.status !== "fulfilled") {
      console.error("[search] news feed failed:", response.reason);
      continue;
    }
    results.push(...parseFeedItems(response.value.xml, response.value.source, topic, seen));
  }

  return rankNews(results, topic, limit);
}

/** Newest first; undated items sort last rather than jumping to the top. */
export function sortByRecency(sources: SearchSource[]): SearchSource[] {
  return [...sources].sort((a, b) => {
    const aTime = a.publishedAt ? Date.parse(a.publishedAt) : Number.NEGATIVE_INFINITY;
    const bTime = b.publishedAt ? Date.parse(b.publishedAt) : Number.NEGATIVE_INFINITY;
    return bTime - aTime;
  });
}

export async function searchWikipedia(prompt: string, limit: number): Promise<SearchSource[]> {
  const query = queryFromPrompt(prompt) || truncateOnWord(prompt, 140);
  if (!query) return [];

  const url = new URL("https://en.wikipedia.org/w/rest.php/v1/search/page");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(Math.max(limit, 6)));
  const payload = await fetchJson(url, 8000, "Wikipedia search") as { pages?: WikipediaPage[] };

  // Wikipedia's own ordering favours article prominence over match quality, so
  // a search for a specific subject can return the broad parent article first.
  // Re-ranking on token overlap puts the closest article at the top, which
  // matters because the route summarises whichever result lands in position 0.
  return (payload.pages ?? []).flatMap((page): Array<{ source: SearchSource; score: number }> => {
    if (!page.title || !page.key) return [];
    const title = cleanText(page.title);
    const snippet = cleanText(page.excerpt || page.description || "Reference article");
    const score = relevanceScore(query, title, snippet);
    if (score < MIN_RELEVANCE) return [];
    return [{
      score,
      source: {
        title,
        key: page.key,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.key)}`,
        snippet,
        source: "Wikipedia",
      },
    }];
  })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ source }) => source);
}

/** First few sentences of a Wikipedia article, or "" when unavailable. */
export async function wikipediaSummary(key?: string): Promise<string> {
  if (!key) return "";
  try {
    const url = new URL(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(key)}`);
    const summary = await fetchJson(url, 7000, "Wikipedia summary") as WikipediaSummary;
    return summarizeExtract(cleanText(summary.extract || ""));
  } catch (error) {
    console.error("[search] wikipedia summary failed:", error);
    return "";
  }
}

/** Exported for tests: trims an extract to at most three sentences / 650 chars. */
export function summarizeExtract(cleaned: string): string {
  if (!cleaned) return "";
  const sentences = cleaned.split(/(?<=[.!?])\s+(?=[A-Z“"'])/);
  let result = "";
  for (const sentence of sentences.slice(0, 3)) {
    if (`${result} ${sentence}`.trim().length > 650) break;
    result = `${result} ${sentence}`.trim();
  }
  return dedupeSentences(result || truncateOnWord(cleaned, 650));
}
