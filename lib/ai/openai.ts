import type { ModelDefinition } from "../models.ts";
import type { SearchSource } from "../search/providers.ts";

export type AnswerCitation = {
  startIndex: number;
  endIndex: number;
  url: string;
  title: string;
};

export type AiHistoryItem = {
  role: "user" | "assistant";
  content: string;
};

export type AiFileInput = {
  name: string;
  type: string;
  bytes: Uint8Array;
};

export type AiResponseResult = {
  answer: string;
  citations: AnswerCitation[];
  sources: SearchSource[];
  mode: "conversation" | "web" | "social" | "file";
  responseId?: string;
};

type RawCitation = {
  type?: string;
  start_index?: number;
  end_index?: number;
  url?: string;
  title?: string;
};

type RawOutputText = {
  type?: string;
  text?: string;
  annotations?: RawCitation[];
};

type RawOutputItem = {
  type?: string;
  content?: RawOutputText[];
  action?: {
    sources?: Array<{ url?: string; title?: string; type?: string }>;
  };
};

type RawResponse = {
  id?: string;
  output?: RawOutputItem[];
  error?: { message?: string; code?: string };
};

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MAX_HISTORY_ITEMS = 16;
const MAX_HISTORY_CHARS = 6_000;

const BASE_INSTRUCTIONS = `You are GenuinesAI, Jose's thoughtful AI thinking partner. Your product promise is “Thoughtful answers. Clearer thinking.”

Give a direct, genuinely useful answer first. Then add explanation, options, or next steps only when they help. Match the user's language and tone. Be warm but never fake certainty. Never claim you searched, opened, read, or verified something unless a tool or supplied file actually provided it.

Use web search for current, changing, niche, disputed, or source-sensitive facts. Cite factual claims from web search with the tool's inline citations. Prefer primary and authoritative sources for hard facts. Public social posts can show reactions, firsthand claims, and what people are discussing, but they are not verified proof; label them as public discussion and corroborate consequential claims with stronger sources. When the user names Reddit, Bluesky, Mastodon, X/Twitter, TikTok, Instagram, Threads, or YouTube, search publicly indexable pages from that platform and clearly say when a platform does not expose enough reliable public results. Never imply access to private posts, feeds, or accounts. Do not expose hidden chain-of-thought. Provide concise conclusions and, when useful, a short explanation of the decisive evidence.`;

export class OpenAIRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly publicMessage: string,
  ) {
    super(message);
    this.name = "OpenAIRequestError";
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function sourceLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Web source";
  }
}

function buildSocialContext(sources: SearchSource[]): string {
  if (sources.length === 0) return "";
  const lines = sources.slice(0, 8).map((source, index) =>
    `${index + 1}. ${source.source}: ${source.title}\n${source.snippet}\n${source.url}`,
  );
  return `\n\nPublic social-search context follows. Treat it as unverified public discussion and cross-check factual claims:\n${lines.join("\n\n")}`;
}

function createUserContent(prompt: string, file?: AiFileInput, socialSources: SearchSource[] = []) {
  const text = `${prompt}${buildSocialContext(socialSources)}`;
  if (!file) return text;

  const dataUrl = `data:${file.type || "application/octet-stream"};base64,${toBase64(file.bytes)}`;
  if (file.type.startsWith("image/")) {
    return [
      { type: "input_image", image_url: dataUrl, detail: "auto" },
      { type: "input_text", text },
    ];
  }
  return [
    { type: "input_file", filename: file.name, file_data: dataUrl },
    { type: "input_text", text },
  ];
}

function parseResponse(payload: RawResponse, socialRequested: boolean, hasFile: boolean): AiResponseResult {
  let answer = "";
  const citations: AnswerCitation[] = [];
  const citedSources: SearchSource[] = [];
  const searchSources: SearchSource[] = [];
  let searchedWeb = false;

  for (const item of payload.output ?? []) {
    if (item.type === "web_search_call") {
      searchedWeb = true;
      for (const source of item.action?.sources ?? []) {
        const url = safeHttpsUrl(source.url);
        if (!url) continue;
        searchSources.push({
          title: source.title?.trim() || sourceLabel(url),
          url,
          snippet: "Source consulted during live web search.",
          source: sourceLabel(url),
        });
      }
      continue;
    }
    if (item.type !== "message") continue;

    for (const part of item.content ?? []) {
      if (part.type !== "output_text" || !part.text) continue;
      const separator = answer ? "\n\n" : "";
      const offset = answer.length + separator.length;
      answer += `${separator}${part.text}`;
      for (const annotation of part.annotations ?? []) {
        if (annotation.type !== "url_citation") continue;
        const url = safeHttpsUrl(annotation.url);
        if (!url) continue;
        const start = Number(annotation.start_index);
        const end = Number(annotation.end_index);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) continue;
        citations.push({
          startIndex: offset + start,
          endIndex: offset + end,
          url,
          title: annotation.title?.trim() || sourceLabel(url),
        });
        citedSources.push({
          title: annotation.title?.trim() || sourceLabel(url),
          url,
          snippet: "Cited in the answer.",
          source: sourceLabel(url),
        });
      }
    }
  }

  const sources = [...new Map([...citedSources, ...searchSources].map((source) => [source.url, source])).values()];
  if (!answer.trim()) {
    throw new OpenAIRequestError(
      "OpenAI returned no output text",
      502,
      "The AI service returned an empty response. Please try again.",
    );
  }

  const trimmedAnswer = answer.trim();
  const leadingTrimmed = answer.length - answer.trimStart().length;
  const adjustedCitations = citations
    .map((citation) => ({
      ...citation,
      startIndex: citation.startIndex - leadingTrimmed,
      endIndex: Math.min(citation.endIndex - leadingTrimmed, trimmedAnswer.length),
    }))
    .filter((citation) => citation.startIndex >= 0 && citation.endIndex > citation.startIndex);

  return {
    answer: trimmedAnswer,
    citations: adjustedCitations,
    sources,
    mode: socialRequested ? "social" : hasFile ? "file" : searchedWeb ? "web" : "conversation",
    responseId: payload.id,
  };
}

export async function createOpenAIResponse(options: {
  apiKey: string;
  model: ModelDefinition;
  prompt: string;
  history: AiHistoryItem[];
  file?: AiFileInput;
  socialSources?: SearchSource[];
  forceSearch?: boolean;
  signal?: AbortSignal;
}): Promise<AiResponseResult> {
  const history = options.history
    .slice(-MAX_HISTORY_ITEMS)
    .map((item) => ({
      role: item.role,
      content: item.content.trim().slice(0, MAX_HISTORY_CHARS),
    }))
    .filter((item) => item.content);

  const socialSources = options.socialSources ?? [];
  const input = [
    ...history,
    {
      role: "user" as const,
      content: createUserContent(options.prompt, options.file, socialSources),
    },
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 80_000);
  const abortFromCaller = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.model.apiModel,
        instructions: `${BASE_INSTRUCTIONS}\n\nToday is ${new Date().toISOString().slice(0, 10)}.`,
        input,
        tools: [{ type: "web_search", search_context_size: options.model.searchContextSize }],
        tool_choice: options.forceSearch || socialSources.length > 0 ? "required" : "auto",
        include: ["web_search_call.action.sources"],
        reasoning: { effort: options.model.reasoningEffort },
        max_output_tokens: options.model.maxOutputTokens,
        store: false,
      }),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({})) as RawResponse;
    if (!response.ok) {
      const upstreamMessage = payload.error?.message || `OpenAI returned ${response.status}`;
      const publicMessage = response.status === 401
        ? "The AI connection needs to be reconfigured by the site owner."
        : response.status === 429
          ? "The AI service is busy or has reached its usage limit. Please try again shortly."
          : "The AI service couldn’t complete that response. Please try again.";
      throw new OpenAIRequestError(upstreamMessage, response.status, publicMessage);
    }

    return parseResponse(payload, socialSources.length > 0, Boolean(options.file));
  } catch (error) {
    if (error instanceof OpenAIRequestError) throw error;
    if (controller.signal.aborted) {
      throw new OpenAIRequestError(
        "OpenAI request aborted or timed out",
        504,
        "That response took too long. Please try again with a shorter request.",
      );
    }
    throw new OpenAIRequestError(
      error instanceof Error ? error.message : "OpenAI request failed",
      502,
      "The AI service couldn’t be reached. Please try again.",
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}
