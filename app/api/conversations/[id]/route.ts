import { env } from "cloudflare:workers";

import { getChatGPTUser } from "../../../chatgpt-auth.ts";
import {
  deleteConversation,
  getConversationMessages,
  getOwnedConversation,
  hasDatabase,
  listAttachmentObjectKeys,
} from "../../../../lib/persistence/conversations.ts";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function json(body: unknown, init?: ResponseInit) {
  return Response.json(body, {
    ...init,
    headers: { ...NO_STORE, ...(init?.headers ?? {}) },
  });
}

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: "Sign in with ChatGPT to view this conversation." }, { status: 401 });
  if (!hasDatabase()) return json({ error: "Saved conversations are not available yet." }, { status: 503 });
  const { id } = await context.params;

  try {
    const conversation = await getOwnedConversation(user.email, id);
    if (!conversation) return json({ error: "Conversation not found." }, { status: 404 });
    const messages = await getConversationMessages(user.email, id);
    return json({ conversation, messages: messages ?? [] });
  } catch (error) {
    console.error("[conversations] read failed:", error);
    return json({ error: "That conversation couldn’t be loaded." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: "Sign in with ChatGPT to delete conversations." }, { status: 401 });
  if (!hasDatabase()) return json({ error: "Saved conversations are not available yet." }, { status: 503 });
  const { id } = await context.params;

  try {
    const conversation = await getOwnedConversation(user.email, id);
    if (!conversation) return json({ error: "Conversation not found." }, { status: 404 });
    const objectKeys = await listAttachmentObjectKeys(user.email, id);
    if (env.BUCKET && objectKeys.length) await env.BUCKET.delete(objectKeys);
    await deleteConversation(user.email, id);
    return json({ deleted: true });
  } catch (error) {
    console.error("[conversations] delete failed:", error);
    return json({ error: "That conversation couldn’t be deleted." }, { status: 500 });
  }
}
