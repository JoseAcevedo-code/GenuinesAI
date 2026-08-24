/** Live source providers: RSS news feeds and the Wikipedia REST API. */

import { USER_AGENT } from "../branding.ts";
import { readCache, writeCache } from "./cache.ts";
import { MIN_RELEVANCE, newsRank, recencyWeight, relevanceScore } from "./relevance.ts";
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

type RedditPayload = {
  data?: {
    children?: Array<{
      data?: {
        title?: string;
        selftext?: string;
        subreddit_name_prefixed?: string;
        permalink?: string;
        created_utc?: number;
      };
    }>;
  };
};

type BlueskyPayload = {
  posts?: Array<{
    uri?: string;
    indexedAt?: string;
    author?: { handle?: string; displayName?: string };
    record?: { text?: string };
  }>;
};

type MastodonPayload = {
  statuses?: Array<{
    url?: string;
    content?: string;
    created_at?: string;
    account?: { acct?: string; display_name?: string };
  }>;
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

function socialQuery(prompt: string): string {
  return queryFromPrompt(prompt)
    .replace(/\b(?:social media|socials?|reddit|bluesky|bsky|twitter|x\.com|tiktok|instagram|threads|youtube|mastodon)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim() || queryFromPrompt(prompt) || truncateOnWord(prompt, 140);
}

/** Converts Reddit's public search payload into the same source shape as news. */
export function parseRedditResults(payload: RedditPayload): SearchSource[] {
  return (payload.data?.children ?? []).flatMap((child): SearchSource[] => {
    const post = child.data;
    if (!post) return [];
    const title = cleanText(post.title ?? "");
    const permalink = post.permalink;
    if (!title || !permalink?.startsWith("/")) return [];

    const publishedAt = typeof post.created_utc === "number"
      ? new Date(post.created_utc * 1000).toISOString()
      : undefined;
    return [{
      title,
      url: `https://www.reddit.com${permalink}`,
      // Link posts carry no body. An empty snippet keeps relevance scoring honest;
      // a placeholder naming the query would echo it back into the filter below.
      snippet: truncateOnWord(cleanText(post.selftext ?? ""), 280),
      source: `Reddit${post.subreddit_name_prefixed ? ` · ${post.subreddit_name_prefixed}` : ""}`,
      publishedAt,
    }];
  });
}

/** Converts Bluesky's public appview search response into clickable post URLs. */
export function parseBlueskyResults(payload: BlueskyPayload, query: string): SearchSource[] {
  return (payload.posts ?? []).flatMap((post): SearchSource[] => {
    const handle = post.author?.handle;
    const rkey = post.uri?.split("/").at(-1);
    const text = cleanText(post.record?.text ?? "");
    if (!handle || !rkey || !text) return [];
    const author = cleanText(post.author?.displayName || `@${handle}`);
    return [{
      title: truncateOnWord(`${author}: ${text}`, 120),
      url: `https://bsky.app/profile/${encodeURIComponent(handle)}/post/${encodeURIComponent(rkey)}`,
      snippet: truncateOnWord(text || `Public post matching “${query}”.`, 280),
      source: `Bluesky · @${handle}`,
      publishedAt: post.indexedAt,
    }];
  });
}

export function parseMastodonResults(payload: MastodonPayload, query: string): SearchSource[] {
  return (payload.statuses ?? []).flatMap((status): SearchSource[] => {
    const text = cleanText(status.content ?? "");
    if (!status.url?.startsWith("https://") || !text) return [];
    const account = cleanText(status.account?.display_name || status.account?.acct || "Mastodon user");
    return [{
      title: truncateOnWord(`${account}: ${text}`, 120),
      url: status.url,
      snippet: truncateOnWord(text || `Public post matching “${query}”.`, 280),
      source: `Mastodon${status.account?.acct ? ` · @${status.account.acct}` : ""}`,
      publishedAt: status.created_at,
    }];
  });
}

/**
 * Searches keyless public social APIs. These posts are useful evidence of what
 * people are saying, never proof that the underlying claim is true. The AI
 * route receives that distinction in its system instructions.
 */
export async function searchSocialMedia(prompt: string, limit: number): Promise<SearchSource[]> {
  const query = socialQuery(prompt);
  if (!query) return [];

  const redditUrl = new URL("https://www.reddit.com/search.json");
  redditUrl.searchParams.set("q", query);
  redditUrl.searchParams.set("sort", "relevance");
  redditUrl.searchParams.set("t", "month");
  redditUrl.searchParams.set("limit", String(Math.min(Math.max(limit * 2, 8), 24)));
  redditUrl.searchParams.set("type", "link");

  const blueskyUrl = new URL("https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts");
  blueskyUrl.searchParams.set("q", query);
  blueskyUrl.searchParams.set("sort", "latest");
  blueskyUrl.searchParams.set("limit", String(Math.min(Math.max(limit * 2, 8), 25)));

  const mastodonUrl = new URL("https://mastodon.social/api/v2/search");
  mastodonUrl.searchParams.set("q", query);
  mastodonUrl.searchParams.set("type", "statuses");
  mastodonUrl.searchParams.set("limit", String(Math.min(Math.max(limit, 5), 20)));
  mastodonUrl.searchParams.set("resolve", "false");

  const responses = await Promise.allSettled([
    fetchJson(redditUrl, 7000, "Reddit search").then((payload) => parseRedditResults(payload as RedditPayload)),
    fetchJson(blueskyUrl, 7000, "Bluesky search").then((payload) => parseBlueskyResults(payload as BlueskyPayload, query)),
    fetchJson(mastodonUrl, 7000, "Mastodon search").then((payload) => parseMastodonResults(payload as MastodonPayload, query)),
  ]);

  const sources = responses.flatMap((response) => {
    if (response.status === "fulfilled") return response.value;
    console.error("[search] social provider failed:", response.reason);
    return [];
  });

  const now = Date.now();
  return sources
    .map((source) => ({
      source,
      score: relevanceScore(query, source.title, source.snippet)
        + recencyWeight(source.publishedAt, now) * 0.35,
    }))
    .filter(({ source }) => relevanceScore(query, source.title, source.snippet) >= MIN_RELEVANCE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ source }) => source);
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
