import { env } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";

import type { AnswerCitation } from "../ai/openai.ts";
import type { SearchSource } from "../search/providers.ts";

export type SavedConversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview: string;
};

export type SavedMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  model?: string;
  sources?: SearchSource[];
  citations?: AnswerCitation[];
  attachment?: string;
  createdAt: number;
};

type ConversationRow = {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  message_count?: number;
  preview?: string | null;
};

type MessageRow = {
  id: string;
  role: string;
  content: string;
  model?: string | null;
  sources_json?: string | null;
  citations_json?: string | null;
  attachment_name?: string | null;
  created_at: number;
};

let schemaReady: Promise<void> | null = null;

export function hasDatabase(): boolean {
  return Boolean(env.DB);
}

function database(): D1Database {
  if (!env.DB) throw new Error("D1 database binding is unavailable");
  return env.DB;
}

/**
 * Migrations are the deployment source of truth. The idempotent prepared
 * statements also make a fresh local or newly provisioned database usable on
 * its first request, without relying on multi-statement `exec()` behavior.
 */
export function ensureConversationSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const db = database();
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY NOT NULL,
        owner_email TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`),
      db.prepare("CREATE INDEX IF NOT EXISTS conversations_owner_updated_idx ON conversations (owner_email, updated_at)"),
      db.prepare(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT,
        sources_json TEXT,
        citations_json TEXT,
        attachment_name TEXT,
        created_at INTEGER NOT NULL
      )`),
      db.prepare("CREATE INDEX IF NOT EXISTS messages_conversation_created_idx ON messages (conversation_id, created_at)"),
      db.prepare(`CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        owner_email TEXT NOT NULL,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        object_key TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      )`),
      db.prepare("CREATE INDEX IF NOT EXISTS attachments_owner_conversation_idx ON attachments (owner_email, conversation_id)"),
    ]);
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

function cleanTitle(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return "New conversation";
  return collapsed.length > 72 ? `${collapsed.slice(0, 71).trimEnd()}…` : collapsed;
}

function parseJsonArray<T>(value?: string | null): T[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : undefined;
  } catch {
    return undefined;
  }
}

export async function createConversation(ownerEmail: string, title: string): Promise<SavedConversation> {
  await ensureConversationSchema();
  const db = database();
  const id = crypto.randomUUID();
  const now = Date.now();
  const normalizedTitle = cleanTitle(title);
  await db.prepare(
    "INSERT INTO conversations (id, owner_email, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(id, ownerEmail, normalizedTitle, now, now).run();
  return { id, title: normalizedTitle, createdAt: now, updatedAt: now, messageCount: 0, preview: "" };
}

export async function listConversations(ownerEmail: string): Promise<SavedConversation[]> {
  await ensureConversationSchema();
  const result = await database().prepare(`SELECT
      c.id,
      c.title,
      c.created_at,
      c.updated_at,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
      (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS preview
    FROM conversations c
    WHERE c.owner_email = ?
    ORDER BY c.updated_at DESC
    LIMIT 60`).bind(ownerEmail).all<ConversationRow>();

  return (result.results ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    messageCount: Number(row.message_count ?? 0),
    preview: row.preview ?? "",
  }));
}

export async function getOwnedConversation(ownerEmail: string, id: string): Promise<SavedConversation | null> {
  await ensureConversationSchema();
  const row = await database().prepare(`SELECT
      c.id,
      c.title,
      c.created_at,
      c.updated_at,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
      (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS preview
    FROM conversations c
    WHERE c.id = ? AND c.owner_email = ?
    LIMIT 1`).bind(id, ownerEmail).first<ConversationRow>();
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    messageCount: Number(row.message_count ?? 0),
    preview: row.preview ?? "",
  };
}

export async function getConversationMessages(ownerEmail: string, id: string): Promise<SavedMessage[] | null> {
  const conversation = await getOwnedConversation(ownerEmail, id);
  if (!conversation) return null;
  const result = await database().prepare(`SELECT
      id, role, content, model, sources_json, citations_json, attachment_name, created_at
    FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
    LIMIT 240`).bind(id).all<MessageRow>();

  return (result.results ?? []).flatMap((row): SavedMessage[] => {
    if (row.role !== "user" && row.role !== "assistant") return [];
    return [{
      id: row.id,
      role: row.role,
      content: row.content,
      model: row.model ?? undefined,
      sources: parseJsonArray<SearchSource>(row.sources_json),
      citations: parseJsonArray<AnswerCitation>(row.citations_json),
      attachment: row.attachment_name ?? undefined,
      createdAt: Number(row.created_at),
    }];
  });
}

export async function saveExchange(options: {
  ownerEmail: string;
  conversationId: string;
  prompt: string;
  answer: string;
  model: string;
  sources?: SearchSource[];
  citations?: AnswerCitation[];
  attachmentName?: string;
}): Promise<{ userMessageId: string; assistantMessageId: string }> {
  await ensureConversationSchema();
  const db = database();
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  const now = Date.now();
  await db.batch([
    db.prepare(`INSERT INTO messages
      (id, conversation_id, role, content, model, sources_json, citations_json, attachment_name, created_at)
      VALUES (?, ?, 'user', ?, NULL, NULL, NULL, ?, ?)`)
      .bind(userMessageId, options.conversationId, options.prompt, options.attachmentName ?? null, now),
    db.prepare(`INSERT INTO messages
      (id, conversation_id, role, content, model, sources_json, citations_json, attachment_name, created_at)
      VALUES (?, ?, 'assistant', ?, ?, ?, ?, NULL, ?)`)
      .bind(
        assistantMessageId,
        options.conversationId,
        options.answer,
        options.model,
        options.sources?.length ? JSON.stringify(options.sources) : null,
        options.citations?.length ? JSON.stringify(options.citations) : null,
        now + 1,
      ),
    db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ? AND owner_email = ?")
      .bind(now + 1, options.conversationId, options.ownerEmail),
  ]);
  return { userMessageId, assistantMessageId };
}

/**
 * Removes the most recent user+assistant pair from a conversation.
 *
 * Regeneration replaces the last answer rather than appending a second one. The
 * ownership check lives in the `conversation_id IN (...)` clause so a caller
 * cannot delete from a conversation it does not own, and the inner SELECT keeps
 * this portable — SQLite only supports `DELETE ... LIMIT` on custom builds.
 */
export async function dropLastExchange(ownerEmail: string, conversationId: string): Promise<void> {
  await ensureConversationSchema();
  const db = database();
  await db.prepare(`DELETE FROM messages
      WHERE id IN (
        SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 2
      )
      AND conversation_id IN (SELECT id FROM conversations WHERE id = ? AND owner_email = ?)`)
    .bind(conversationId, conversationId, ownerEmail)
    .run();
}

export async function saveAttachmentMetadata(options: {
  ownerEmail: string;
  conversationId: string;
  messageId: string;
  filename: string;
  contentType: string;
  size: number;
  objectKey: string;
}): Promise<string> {
  await ensureConversationSchema();
  const id = crypto.randomUUID();
  await database().prepare(`INSERT INTO attachments
    (id, conversation_id, message_id, owner_email, filename, content_type, size, object_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      id,
      options.conversationId,
      options.messageId,
      options.ownerEmail,
      options.filename,
      options.contentType,
      options.size,
      options.objectKey,
      Date.now(),
    ).run();
  return id;
}

export async function listAttachmentObjectKeys(ownerEmail: string, conversationId: string): Promise<string[]> {
  await ensureConversationSchema();
  const result = await database().prepare(
    "SELECT object_key FROM attachments WHERE owner_email = ? AND conversation_id = ?",
  ).bind(ownerEmail, conversationId).all<{ object_key: string }>();
  return (result.results ?? []).map((row) => row.object_key);
}

export async function deleteConversation(ownerEmail: string, id: string): Promise<boolean> {
  await ensureConversationSchema();
  const result = await database().prepare(
    "DELETE FROM conversations WHERE id = ? AND owner_email = ?",
  ).bind(id, ownerEmail).run();
  return Number(result.meta.changes ?? 0) > 0;
}
