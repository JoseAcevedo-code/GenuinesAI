# GenuinesAI

GenuinesAI is a mobile-first AI thinking partner with genuine OpenAI model responses, live web citations, public social-search context, document understanding, and cloud-saved conversations.

## Main files

- `app/page.tsx` — chat interface and interactions
- `app/globals.css` — responsive light/dark styling
- `app/api/chat/route.ts` — OpenAI Responses API, web search, file analysis, and persistence orchestration
- `app/api/conversations/` — signed-in conversation history
- `app/api/search/route.ts` — keyless fallback search endpoint
- `lib/ai/` — secure server-side OpenAI integration and citation parsing
- `lib/search/` — news, Wikipedia, Reddit, Bluesky, and Mastodon providers
- `lib/persistence/` — D1 conversation storage helpers
- `types/` — runtime type declarations
- `tests/search-logic.test.mjs` — unit tests for search and conversation behavior
- `worker/index.ts` — Cloudflare Worker entry point

## Run locally

Requirements: Node.js 22.13 or newer and npm.

```bash
npm run install:ci
npm run test:unit
npm run dev
```

Create a production build with:

```bash
npm run build
```

Production requires an `OPENAI_API_KEY` runtime secret. The app maps its UI modes to current OpenAI models:

- GenuinesAI Pro → GPT-5.6 Terra
- GenuinesAI Fast → GPT-5.6 Luna
- GenuinesAI Reason → GPT-5.6 Sol

Without the secret, the UI remains usable through a clearly labeled keyless fallback, but genuine AI synthesis and file analysis stay inactive.

## Security

Never place an API key in `app/page.tsx`, browser storage, `.openai/hosting.json`, or a public repository. Store it only as the server-side `OPENAI_API_KEY` runtime secret.

ChatGPT identity headers protect user-owned D1 conversations. Uploaded bytes are stored in R2 only for signed-in users; file inputs are also sent to the configured model for the requested analysis.
