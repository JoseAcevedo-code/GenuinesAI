import { getChatGPTUser } from "../../chatgpt-auth.ts";
import {
  createConversation,
  hasDatabase,
  listConversations,
} from "../../../lib/persistence/conversations.ts";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function json(body: unknown, init?: ResponseInit) {
  return Response.json(body, {
    ...init,
    headers: { ...NO_STORE, ...(init?.headers ?? {}) },
  });
}

async function authorizedEmail(): Promise<string | null> {
  return (await getChatGPTUser())?.email ?? null;
}

export async function GET() {
  const email = await authorizedEmail();
  if (!email) return json({ error: "Sign in with ChatGPT to view saved conversations." }, { status: 401 });
  if (!hasDatabase()) return json({ error: "Saved conversations are not available yet." }, { status: 503 });

  try {
    return json({ conversations: await listConversations(email) });
  } catch (error) {
    console.error("[conversations] list failed:", error);
    return json({ error: "Saved conversations couldn’t be loaded." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const email = await authorizedEmail();
  if (!email) return json({ error: "Sign in with ChatGPT to save conversations." }, { status: 401 });
  if (!hasDatabase()) return json({ error: "Saved conversations are not available yet." }, { status: 503 });

  const body = await request.json().catch(() => ({})) as { title?: unknown };
  const title = typeof body.title === "string" ? body.title : "New conversation";
  try {
    return json({ conversation: await createConversation(email, title) }, { status: 201 });
  } catch (error) {
    console.error("[conversations] create failed:", error);
    return json({ error: "That conversation couldn’t be created." }, { status: 500 });
  }
}
