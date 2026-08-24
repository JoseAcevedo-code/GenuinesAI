import { resolveModel } from "../../../lib/models.ts";
import { localResponse } from "../../../lib/search/conversation.ts";
import {
  MAX_PROMPT_LENGTH,
  SEARCH_INTENT,
  hasNewsIntent,
  resolveFollowUp,
  sanitizedHistory,
  topicFromNewsPrompt,
} from "../../../lib/search/intent.ts";
import {
  searchNews,
  searchWikipedia,
  wikipediaSummary,
  type SearchSource,
} from "../../../lib/search/providers.ts";
import { checkRateLimit, clientKey } from "../../../lib/search/rate-limit.ts";
import { dedupeSentences } from "../../../lib/search/text.ts";

/** A prompt plus ten short history entries fits well inside this. */
const MAX_BODY_BYTES = 32_768;

const NO_STORE = { "Cache-Control": "no-store" } as const;

function json(body: unknown, init?: ResponseInit) {
  return Response.json(body, {
    ...init,
    headers: { ...NO_STORE, ...(init?.headers ?? {}) },
  });
}

export async function POST(request: Request) {
  const limit = checkRateLimit(clientKey(request));
  if (!limit.allowed) {
    return json(
      { error: "That was a lot of requests at once. Give me a moment and try again." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json({ error: "That message is too large to process." }, { status: 413 });
  }

  let body: { query?: unknown; model?: unknown; history?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return json({ error: "That request wasn’t valid JSON." }, { status: 400 });
  }

  try {
    const prompt = typeof body.query === "string" ? body.query.trim().slice(0, MAX_PROMPT_LENGTH) : "";
    const model = resolveModel(body.model);
    const history = sanitizedHistory(body.history);
    if (!prompt) return json({ error: "Enter a message to continue." }, { status: 400 });

    const directResponse = localResponse(prompt, history);
    if (directResponse) {
      return json({ answer: directResponse, sources: [], mode: "conversation" });
    }

    const resolved = resolveFollowUp(prompt, history);
    const contextualResponse = resolved.contextUsed ? localResponse(resolved.prompt, history) : null;
    if (contextualResponse) {
      return json({ answer: contextualResponse, sources: [], mode: "conversation", contextUsed: true });
    }

    const resultLimit = model.resultLimit;
    const newsIntent = hasNewsIntent(resolved.prompt);
    const explicitSearch = SEARCH_INTENT.test(resolved.prompt);

    // No intent pattern matched. Previously this returned a canned "tell me
    // what you want" reply, which meant any phrasing the regexes did not
    // anticipate — statements, unusual question forms, bare topics — was
    // refused before a single source was read. Attempting the search and
    // reporting an honest miss is strictly more useful than refusing to look.
    let sources: SearchSource[] = [];
    let mode: "news" | "knowledge" = newsIntent ? "news" : "knowledge";

    if (newsIntent) {
      try {
        sources = await searchNews(resolved.prompt, resultLimit);
      } catch (error) {
        console.error("[search] news lookup failed:", error);
        sources = [];
      }
    }

    // Reached for explicit searches, knowledge questions, and now anything the
    // intent patterns did not classify.
    if (sources.length === 0) {
      try {
        sources = await searchWikipedia(resolved.prompt, resultLimit);
        mode = "knowledge";
      } catch (error) {
        console.error("[search] wikipedia lookup failed:", error);
        sources = [];
      }
    }

    if (sources.length === 0) {
      return json({
        // Every path now reaches here only after a real lookup ran, so the
        // wording says so rather than implying the request was declined.
        answer: explicitSearch || newsIntent
          ? "I searched but couldn’t find a confident match. Try naming the person, place, event, or topic more specifically."
          : "I looked but couldn’t find a reliable source for that. Naming the specific topic — or asking me to search for it directly — usually gets there.",
        sources: [],
        mode: "error",
        searchedAt: new Date().toISOString(),
      });
    }

    const topic = topicFromNewsPrompt(resolved.prompt);
    const lead = sources[0];
    const summary = mode === "knowledge" ? await wikipediaSummary(lead.key) : "";
    const answer = mode === "news"
      ? `${topic ? `I searched current coverage for “${topic}”.` : "I searched current top stories."} Here are the strongest live matches I found, starting with ${lead.source}. Open any source to read the full report.`
      : summary
        ? `${summary} I included the closest live references below so you can verify the information and explore further.`
        : `I found a relevant reference for “${lead.title}”. I included the closest live references below so you can verify the information and explore further.`;

    return json({
      answer: dedupeSentences(answer),
      sources: sources.map((source) => ({
        title: source.title,
        url: source.url,
        snippet: source.snippet,
        source: source.source,
        publishedAt: source.publishedAt,
      })),
      mode,
      searchedAt: new Date().toISOString(),
      contextUsed: resolved.contextUsed,
    });
  } catch (error) {
    console.error("[search] request failed:", error);
    return json({ error: "I couldn’t process that message. Please try again." }, { status: 500 });
  }
}
