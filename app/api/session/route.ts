import { env } from "cloudflare:workers";

import { getChatGPTUser } from "../../chatgpt-auth.ts";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export async function GET() {
  const user = await getChatGPTUser();
  return Response.json({
    authenticated: Boolean(user),
    user,
    capabilities: {
      ai: typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.trim().length > 0,
      savedConversations: Boolean(env.DB),
      fileStorage: Boolean(env.BUCKET),
      webSearch: true,
      socialSearch: true,
    },
  }, { headers: NO_STORE });
}
