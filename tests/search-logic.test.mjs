import assert from "node:assert/strict";
import test from "node:test";

import { resolveModel, DEFAULT_MODEL } from "../lib/models.ts";
import { cleanText, decodeEntities, dedupeSentences, truncateOnWord } from "../lib/search/text.ts";
import {
  findRepeatedPhrase,
  hasNewsIntent,
  overlapsQuery,
  queryFromPrompt,
  resolveFollowUp,
  sanitizedHistory,
  topicFromNewsPrompt,
} from "../lib/search/intent.ts";
import { localResponse, repetitionResponse } from "../lib/search/conversation.ts";
import { parseFeedItems, rankNews, sortByRecency, summarizeExtract } from "../lib/search/providers.ts";
import { checkRateLimit } from "../lib/search/rate-limit.ts";
import { MIN_RELEVANCE, newsRank, recencyWeight, relevanceScore } from "../lib/search/relevance.ts";
import { readCache, writeCache } from "../lib/search/cache.ts";

test("decodeEntities handles named and numeric references", () => {
  assert.equal(decodeEntities("Bath &amp; Wells"), "Bath & Wells");
  assert.equal(decodeEntities("caf&#233;"), "café");
  assert.equal(decodeEntities("&#x2014;"), "—");
  assert.equal(decodeEntities("&notanentity;"), "&notanentity;");
});

test("cleanText strips markup and collapses the whitespace it leaves behind", () => {
  assert.equal(cleanText("<p>Hello   <b>world</b></p>"), "Hello world");
  assert.equal(cleanText("<i>a</i>&amp;<i>b</i>"), "a & b");
  assert.equal(cleanText(), "");
});

test("dedupeSentences drops only consecutive duplicates", () => {
  assert.equal(dedupeSentences("One. One. Two."), "One. Two.");
  assert.equal(dedupeSentences("One. Two. One."), "One. Two. One.");
});

test("truncateOnWord never clips mid-word when a boundary is near", () => {
  assert.equal(truncateOnWord("short", 20), "short");
  assert.equal(truncateOnWord("the quick brown fox jumps", 14), "the quick");
  // No usable boundary: fall back to a hard cut rather than returning nothing.
  assert.equal(truncateOnWord("supercalifragilistic", 10), "supercalif");
});

test("findRepeatedPhrase recognises an evenly repeated phrase", () => {
  assert.deepEqual(findRepeatedPhrase("hello hello hello"), { phrase: "hello", count: 3 });
  assert.deepEqual(findRepeatedPhrase("go now go now"), { phrase: "go now", count: 2 });
  assert.equal(findRepeatedPhrase("hello there friend"), null);
  assert.equal(findRepeatedPhrase("hello"), null);
});

test("hasNewsIntent separates live-news prompts from static questions", () => {
  assert.equal(hasNewsIntent("what are today's headlines"), true);
  assert.equal(hasNewsIntent("the current president of France"), true);
  assert.equal(hasNewsIntent("how does photosynthesis work"), false);
});

test("queryFromPrompt strips the request framing around the topic", () => {
  assert.equal(queryFromPrompt("Can you please look up the Voyager 1 probe?"), "the Voyager 1 probe");
  assert.equal(queryFromPrompt("What is quantum entanglement?"), "quantum entanglement");
  assert.equal(queryFromPrompt("Tell me about the Sahara"), "the Sahara");
});

test("topicFromNewsPrompt keeps the subject and drops the news framing", () => {
  assert.equal(topicFromNewsPrompt("What are today's top news stories about Kenya?"), "Kenya");
  assert.equal(topicFromNewsPrompt("latest news on the Kenyan election"), "Kenyan election");
  assert.equal(topicFromNewsPrompt("Look into today's top news."), "");
});

test("sanitizedHistory rejects malformed entries and bounds the rest", () => {
  const history = sanitizedHistory([
    { role: "user", content: "  hi  " },
    { role: "system", content: "ignored" },
    { role: "assistant", content: 42 },
    null,
    { role: "assistant", content: "x".repeat(900), sourceTitles: ["a", "b", "c", "d", 7] },
  ]);
  assert.deepEqual(history.map((item) => item.role), ["user", "assistant"]);
  assert.equal(history[0].content, "hi");
  assert.equal(history[1].content.length, 500);
  assert.deepEqual(history[1].sourceTitles, ["a", "b", "c"]);
  assert.deepEqual(sanitizedHistory("not an array"), []);
});

test("sanitizedHistory keeps only the most recent turns", () => {
  const many = Array.from({ length: 25 }, (unused, index) => ({ role: "user", content: `m${index}` }));
  const kept = sanitizedHistory(many);
  assert.equal(kept.length, 10);
  assert.equal(kept[0].content, "m15");
});

test("resolveFollowUp attaches the previous prompt only for follow-ups", () => {
  const history = [{ role: "user", content: "Explain black holes" }];
  assert.deepEqual(resolveFollowUp("tell me more", history), {
    prompt: "Explain black holes tell me more",
    contextUsed: true,
  });
  assert.deepEqual(resolveFollowUp("tell me more", []), { prompt: "tell me more", contextUsed: false });
  assert.deepEqual(resolveFollowUp("what is rain", history), { prompt: "what is rain", contextUsed: false });
});

test("overlapsQuery ignores stop words when comparing", () => {
  assert.equal(overlapsQuery("the voyager probe", "Voyager 1 spacecraft"), true);
  assert.equal(overlapsQuery("voyager probe", "Baking sourdough bread"), false);
  assert.equal(overlapsQuery("the a of", "anything"), true);
});

test("repeat commands require a whole word, not a prefix", () => {
  // Regression: "sayonara" and "echoes" previously parsed as repeat commands.
  assert.equal(repetitionResponse("sayonara", []), null);
  assert.equal(repetitionResponse("echoes of the past", []), null);
  assert.equal(repetitionResponse("repeatedly failing builds", []), null);
  assert.equal(repetitionResponse("say hello", []), "hello");
});

test("repeat commands honour, cap, and validate the count", () => {
  assert.equal(repetitionResponse("repeat 3 times hi", []), "hi hi hi");
  assert.equal(repetitionResponse("say hi 2 times", []), "hi hi");
  assert.match(repetitionResponse("repeat hi 50 times", []), /I capped that at 20 repetitions\.$/);
  assert.equal(repetitionResponse("repeat hi 50 times", []).split("\n")[0].split(" ").length, 20);
  assert.match(repetitionResponse("repeat hi 0 times", []), /at least 1/);
  assert.match(repetitionResponse("repeat", []), /want me to repeat/);
});

test("repetitionResponse reads back the conversation", () => {
  const history = [
    { role: "user", content: "how tall is Everest" },
    { role: "assistant", content: "About 8,849 metres." },
  ];
  assert.equal(repetitionResponse("repeat that", history), "About 8,849 metres.");
  assert.equal(repetitionResponse("what did i just say", history), "You said: “how tall is Everest”");
  assert.match(repetitionResponse("repeat that", []), /don’t have a previous answer/);
});

test("localResponse answers small talk and defers open questions", () => {
  assert.match(localResponse("hello", []), /I’m online/);
  assert.match(localResponse("help me debug my python code", []), /exact error message/);
  assert.equal(localResponse("what is the population of Peru", []), null);
});

test("answers the prompts that reached the live site as connection errors", () => {
  // From a real session: these produced "Search request failed (401/403)"
  // because the rule layer did not claim them and the API call was rejected.
  assert.match(localResponse("Help me debugg python code", []), /coding task|error message/);
  assert.match(localResponse("Give me a todo list", []), /need to finish/);
  // A misspelled verb and a bare language mention should still register as code.
  assert.match(localResponse("help me debug my python code", []), /error message/);
  assert.match(localResponse("my python code has a bug", []), /error message/);
  // "Sayonara" is genuinely not a request; it must not be echoed or guessed at.
  assert.equal(localResponse("Sayonara", []), null);
});

test("resolveModel only accepts catalogued models", () => {
  assert.equal(resolveModel("GenuinesAI Reason").resultLimit, 6);
  assert.equal(resolveModel("GenuinesAI Fast").resultLimit, 3);
  // A loose substring match previously let any string containing "Reason" win.
  assert.equal(resolveModel("Reasonably evil model").name, DEFAULT_MODEL.name);
  assert.equal(resolveModel(undefined).name, DEFAULT_MODEL.name);
  assert.equal(resolveModel({ name: "GenuinesAI Fast" }).name, DEFAULT_MODEL.name);
});

test("parseFeedItems reads CDATA, dedupes, and rejects non-https links", () => {
  const xml = `
    <rss><channel>
      <item><title><![CDATA[Storm hits coast]]></title><link>https://example.com/a</link>
        <description>Heavy rain &amp; wind.</description><pubDate>Tue, 01 Apr 2025 10:00:00 GMT</pubDate></item>
      <item><title>Storm hits coast</title><link>https://example.com/duplicate</link></item>
      <item><title>Insecure</title><link>http://example.com/b</link></item>
      <item><title>No link</title></item>
    </channel></rss>`;
  const sources = parseFeedItems(xml, "Example Wire", "storms", new Set());
  assert.equal(sources.length, 1);
  assert.equal(sources[0].title, "Storm hits coast");
  assert.equal(sources[0].snippet, "Heavy rain & wind.");
  assert.equal(sources[0].source, "Example Wire");
  assert.equal(sources[0].publishedAt, "2025-04-01T10:00:00.000Z");
});

test("parseFeedItems falls back to a topic snippet and shares the seen set", () => {
  const xml = `<item><title>Only headline</title><link>https://example.com/x</link></item>`;
  const seen = new Set();
  assert.equal(parseFeedItems(xml, "Wire", "kenya", seen)[0].snippet, "Recent coverage matching “kenya”.");
  assert.deepEqual(parseFeedItems(xml, "Wire", "kenya", seen), []);
  assert.equal(parseFeedItems(xml, "Wire", "", new Set())[0].snippet, "A current top story.");
});

test("sortByRecency puts newest first and undated last", () => {
  const ordered = sortByRecency([
    { title: "none", url: "", snippet: "", source: "" },
    { title: "old", url: "", snippet: "", source: "", publishedAt: "2024-01-01T00:00:00.000Z" },
    { title: "new", url: "", snippet: "", source: "", publishedAt: "2025-01-01T00:00:00.000Z" },
  ]);
  assert.deepEqual(ordered.map((source) => source.title), ["new", "old", "none"]);
});

test("summarizeExtract keeps at most three sentences", () => {
  assert.equal(summarizeExtract("One. Two. Three. Four."), "One. Two. Three.");
  assert.equal(summarizeExtract(""), "");
  assert.equal(summarizeExtract("A".repeat(900)).length, 650);
});

test("checkRateLimit allows a burst then blocks within the window", () => {
  const store = new Map();
  const config = { windowMs: 1000, maxRequests: 3, maxTrackedClients: 10 };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(checkRateLimit("1.2.3.4", 1000 + attempt, config, store).allowed, true);
  }
  const blocked = checkRateLimit("1.2.3.4", 1003, config, store);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1);
  // A different client is unaffected, and the window eventually reopens.
  assert.equal(checkRateLimit("5.6.7.8", 1003, config, store).allowed, true);
  assert.equal(checkRateLimit("1.2.3.4", 2500, config, store).allowed, true);
});

test("checkRateLimit bounds how many clients it tracks", () => {
  const store = new Map();
  const config = { windowMs: 1000, maxRequests: 5, maxTrackedClients: 4 };
  for (let client = 0; client < 50; client += 1) {
    checkRateLimit(`client-${client}`, 1000 + client, config, store);
  }
  assert.ok(store.size <= 4, `expected at most 4 tracked clients, saw ${store.size}`);
});

test("relevanceScore grades matches instead of answering yes or no", () => {
  // The whole point of replacing overlapsQuery: a full match must outrank a
  // partial one, where the boolean check rated both simply "true".
  const full = relevanceScore("mars rover landing", "Mars rover landing confirmed");
  const partial = relevanceScore("mars rover landing", "Rover sales climb in Europe");
  assert.ok(full > partial);
  assert.equal(full, 1);
  assert.ok(partial < MIN_RELEVANCE);
});

test("relevanceScore weights the title above the snippet", () => {
  const inTitle = relevanceScore("eclipse", "Total eclipse tonight", "Unrelated body text");
  const inSnippet = relevanceScore("eclipse", "Unrelated headline", "A total eclipse is expected");
  assert.ok(inTitle > inSnippet);
});

test("relevanceScore treats an empty query as matching everything", () => {
  // A bare headlines request has no topic, so nothing should be filtered out.
  assert.equal(relevanceScore("", "Any headline at all"), 1);
});

test("recencyWeight decays with age and ranks undated items mid-low", () => {
  const now = Date.parse("2026-08-22T12:00:00Z");
  const fresh = recencyWeight("2026-08-22T11:00:00Z", now);
  const old = recencyWeight("2026-08-20T11:00:00Z", now);
  assert.ok(fresh > old);
  assert.ok(fresh <= 1);
  assert.equal(recencyWeight(undefined, now), 0.4);
  assert.equal(recencyWeight("not a date", now), 0.4);
});

test("newsRank prefers the on-topic story over the fresher off-topic one", () => {
  const now = Date.parse("2026-08-22T12:00:00Z");
  const onTopic = { title: "Harbor Freeway closure", snippet: "", publishedAt: "2026-08-21T12:00:00Z" };
  const offTopic = { title: "Celebrity wedding photos", snippet: "", publishedAt: "2026-08-22T11:59:00Z" };
  assert.ok(newsRank("harbor freeway", onTopic, now) > newsRank("harbor freeway", offTopic, now));
});

test("rankNews drops weak matches when a topic is given", () => {
  const sources = [
    { title: "Harbor Freeway reopens", url: "https://a", snippet: "", source: "BBC" },
    { title: "Bakery wins award", url: "https://b", snippet: "", source: "NPR" },
  ];
  const ranked = rankNews(sources, "harbor freeway", 5);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].title, "Harbor Freeway reopens");
});

test("rankNews keeps everything and sorts by recency when there is no topic", () => {
  const now = Date.parse("2026-08-22T12:00:00Z");
  const sources = [
    { title: "Older story", url: "https://a", snippet: "", source: "BBC", publishedAt: "2026-08-20T12:00:00Z" },
    { title: "Newer story", url: "https://b", snippet: "", source: "NPR", publishedAt: "2026-08-22T11:00:00Z" },
  ];
  const ranked = rankNews(sources, "", 5, now);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].title, "Newer story");
});

test("rankNews honours the result limit", () => {
  const sources = Array.from({ length: 8 }, (_, index) => ({
    title: `Story ${index}`, url: `https://${index}`, snippet: "", source: "BBC",
  }));
  assert.equal(rankNews(sources, "", 3).length, 3);
});

test("cache returns a value inside the TTL and nothing after it", () => {
  const store = new Map();
  const now = 1_000_000;
  writeCache("feed", "<rss/>", 60_000, now, store);
  assert.equal(readCache("feed", now + 30_000, store), "<rss/>");
  assert.equal(readCache("feed", now + 60_001, store), null);
});

test("cache evicts oldest entries past the ceiling", () => {
  const store = new Map();
  const now = 1_000_000;
  for (let index = 0; index < 5; index += 1) {
    writeCache(`feed-${index}`, String(index), 60_000, now, store, 3);
  }
  assert.equal(store.size, 3);
  assert.equal(readCache("feed-0", now, store), null);
  assert.equal(readCache("feed-4", now, store), "4");
});
