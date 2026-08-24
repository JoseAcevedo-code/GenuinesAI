import { env } from "cloudflare:workers";

import { getChatGPTUser } from "../../chatgpt-auth.ts";
import {
  OpenAIRequestError,
  createOpenAIResponse,
  type AiFileInput,
  type AiResponseResult,
} from "../../../lib/ai/openai.ts";
import { resolveModel } from "../../../lib/models.ts";
import {
  createConversation,
  getOwnedConversation,
  hasDatabase,
  saveAttachmentMetadata,
  saveExchange,
} from "../../../lib/persistence/conversations.ts";
import { localResponse } from "../../../lib/search/conversation.ts";
import {
  MAX_PROMPT_LENGTH,
  SEARCH_INTENT,
  SOCIAL_INTENT,
  hasNewsIntent,
  sanitizedHistory,
} from "../../../lib/search/intent.ts";
import {
  searchNews,
  searchSocialMedia,
  searchWikipedia,
  wikipediaSummary,
  type SearchSource,
} from "../../../lib/search/providers.ts";
import { checkRateLimit, clientKey } from "../../../lib/search/rate-limit.ts";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 256 * 1024;
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

const ACCEPTED_FILES: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  xml: "application/xml",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  rtf: "application/rtf",
  odt: "application/vnd.oasis.opendocument.text",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

type ParsedRequest = {
  prompt: string;
  model: unknown;
  history: ReturnType<typeof sanitizedHistory>;
  conversationId?: string;
  file?: File;
};

function json(body: unknown, init?: ResponseInit) {
  return Response.json(body, {
    ...init,
    headers: { ...NO_STORE, ...(init?.headers ?? {}) },
  });
}

function extension(filename: string): string {
  return filename.toLowerCase().split(".").at(-1) ?? "";
}

function cleanFilename(filename: string): string {
  const leaf = filename.replace(/\\/g, "/").split("/").at(-1) || "upload";
  return leaf.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120) || "upload";
}

function parseHistory(value: unknown) {
  if (typeof value !== "string") return sanitizedHistory(value);
  try {
    return sanitizedHistory(JSON.parse(value) as unknown);
  } catch {
    return [];
  }
}

async function parseRequest(request: Request): Promise<ParsedRequest> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const query = form.get("query");
    const fileEntry = form.get("file");
    const conversationId = form.get("conversationId");
    return {
      prompt: typeof query === "string" ? query.trim().slice(0, MAX_PROMPT_LENGTH) : "",
      model: form.get("model"),
      history: parseHistory(form.get("history")),
      conversationId: typeof conversationId === "string" && conversationId ? conversationId : undefined,
      file: fileEntry instanceof File && fileEntry.size > 0 ? fileEntry : undefined,
    };
  }

  const body = await request.json() as {
    query?: unknown;
    model?: unknown;
    history?: unknown;
    conversationId?: unknown;
  };
  return {
    prompt: typeof body.query === "string" ? body.query.trim().slice(0, MAX_PROMPT_LENGTH) : "",
    model: body.model,
    history: sanitizedHistory(body.history),
    conversationId: typeof body.conversationId === "string" && body.conversationId ? body.conversationId : undefined,
  };
}

function validateFile(file?: File): { name: string; type: string } | null {
  if (!file) return null;
  if (file.size > MAX_FILE_BYTES) throw new OpenAIRequestError(
    "File exceeds app upload limit",
    413,
    "Choose a file smaller than 10 MB.",
  );
  const name = cleanFilename(file.name);
  const expectedType = ACCEPTED_FILES[extension(name)];
  if (!expectedType) throw new OpenAIRequestError(
    "Unsupported file extension",
    415,
    "That file type isn’t supported yet. Try a document, spreadsheet, presentation, text file, PDF, or image.",
  );
  return { name, type: file.type || expectedType };
}

function dedupeSources(sources: SearchSource[]): SearchSource[] {
  return [...new Map(sources.filter((source) => source.url.startsWith("https://")).map((source) => [source.url, source])).values()];
}

async function fallbackResponse(
  prompt: string,
  history: ReturnType<typeof sanitizedHistory>,
  resultLimit: number,
  hasFile: boolean,
): Promise<AiResponseResult> {
  if (hasFile) {
    return {
      answer: "The document is ready, but genuine file analysis needs the site’s AI connection to be configured first.",
      citations: [],
      sources: [],
      mode: "file",
    };
  }
  const direct = localResponse(prompt, history);
  if (direct) return { answer: direct, citations: [], sources: [], mode: "conversation" };

  const social = SOCIAL_INTENT.test(prompt);
  const news = hasNewsIntent(prompt);
  let sources: SearchSource[] = [];
  if (social) sources = await searchSocialMedia(prompt, resultLimit).catch(() => []);
  else if (news) sources = await searchNews(prompt, resultLimit).catch(() => []);
  else sources = await searchWikipedia(prompt, resultLimit).catch(() => []);

  if (!sources.length) {
    return {
      answer: "The genuine AI connection still needs to be configured. I also couldn’t find a strong fallback source for that request.",
      citations: [],
      sources: [],
      mode: social ? "social" : news ? "web" : "conversation",
    };
  }
  const summary = !social && !news ? await wikipediaSummary(sources[0].key) : "";
  return {
    answer: summary || (social
      ? "I found relevant public conversations below. They show what people are saying, not verified proof of the underlying claims."
      : "I found relevant live sources below. The full AI synthesis will activate once the site’s AI connection is configured."),
    citations: [],
    sources,
    mode: social ? "social" : "web",
  };
}

async function ownerObjectPrefix(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(email.toLowerCase());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest.slice(0, 10)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return json({ error: "That request is too large. Choose a file smaller than 10 MB." }, { status: 413 });
  }

  try {
    const parsed = await parseRequest(request);
    if (!parsed.prompt) return json({ error: "Enter a message to continue." }, { status: 400 });
    const fileMetadata = validateFile(parsed.file);
    const fileBytes = parsed.file ? new Uint8Array(await parsed.file.arrayBuffer()) : undefined;
    const fileInput: AiFileInput | undefined = parsed.file && fileMetadata && fileBytes
      ? { name: fileMetadata.name, type: fileMetadata.type, bytes: fileBytes }
      : undefined;

    const model = resolveModel(parsed.model);
    const socialRequested = SOCIAL_INTENT.test(parsed.prompt);
    const forceSearch = socialRequested || hasNewsIntent(parsed.prompt) || SEARCH_INTENT.test(parsed.prompt);
    const socialSources = socialRequested
      ? await searchSocialMedia(parsed.prompt, model.resultLimit).catch((error) => {
          console.error("[chat] public social lookup failed:", error);
          return [];
        })
      : [];

    const apiKey = typeof env.OPENAI_API_KEY === "string" ? env.OPENAI_API_KEY.trim() : "";
    const aiResult = apiKey
      ? await createOpenAIResponse({
          apiKey,
          model,
          prompt: parsed.prompt,
          history: parsed.history,
          file: fileInput,
          socialSources,
          forceSearch,
          signal: request.signal,
        })
      : await fallbackResponse(parsed.prompt, parsed.history, model.resultLimit, Boolean(fileInput));

    const sources = dedupeSources([...aiResult.sources, ...socialSources]).slice(0, model.resultLimit);
    const user = await getChatGPTUser();
    let conversationId = parsed.conversationId;
    let saved = false;

    if (user && hasDatabase()) {
      if (conversationId) {
        const owned = await getOwnedConversation(user.email, conversationId);
        if (!owned) return json({ error: "That saved conversation no longer exists." }, { status: 404 });
      } else {
        conversationId = (await createConversation(user.email, parsed.prompt)).id;
      }

      const ids = await saveExchange({
        ownerEmail: user.email,
        conversationId,
        prompt: parsed.prompt,
        answer: aiResult.answer,
        model: model.name,
        sources,
        citations: aiResult.citations,
        attachmentName: fileMetadata?.name,
      });
      saved = true;

      if (fileInput && env.BUCKET) {
        const objectKey = `users/${await ownerObjectPrefix(user.email)}/conversations/${conversationId}/${crypto.randomUUID()}-${fileMetadata?.name ?? "upload"}`;
        await env.BUCKET.put(objectKey, fileInput.bytes, {
          httpMetadata: { contentType: fileInput.type },
          customMetadata: { conversationId, messageId: ids.userMessageId },
        });
        await saveAttachmentMetadata({
          ownerEmail: user.email,
          conversationId,
          messageId: ids.userMessageId,
          filename: fileInput.name,
          contentType: fileInput.type,
          size: fileInput.bytes.byteLength,
          objectKey,
        });
      }
    }

    return json({
      answer: aiResult.answer,
      citations: aiResult.citations,
      sources,
      mode: aiResult.mode,
      searchedAt: forceSearch ? new Date().toISOString() : undefined,
      provider: apiKey ? "openai" : "fallback",
      configurationRequired: !apiKey,
      model: model.name,
      conversationId,
      saved,
    });
  } catch (error) {
    if (error instanceof OpenAIRequestError) {
      console.error(`[chat] AI request failed (${error.status}):`, error.message);
      return json({ error: error.publicMessage }, { status: error.status });
    }
    if (error instanceof SyntaxError) return json({ error: "That request wasn’t valid JSON." }, { status: 400 });
    console.error("[chat] request failed:", error);
    return json({ error: "I couldn’t complete that response. Please try again." }, { status: 500 });
  }
}
