# GenuinesAI — latest source

This archive contains the latest deployed source for the GenuinesAI mobile-first chat website.

## Main files

- `app/page.tsx` — chat interface and interactions
- `app/globals.css` — responsive light/dark styling
- `app/api/search/route.ts` — server search endpoint
- `lib/search/` — intent detection, conversation handling, providers, text helpers, and rate limiting
- `types/` — runtime type declarations
- `tests/search-logic.test.mjs` — unit tests for search and conversation behavior
- `worker/index.ts` — Cloudflare Worker entry point

## Run locally

Requirements: Node.js 22.13 or newer and npm.

```bash
npm install
npm run test:unit
npm run dev
```

Create a production build with:

```bash
npm run build
```

The current application uses public live-news/reference sources and rule-based conversation logic. It does not include an OpenAI API key or a full model integration.

## Security

Never place an API key in `app/page.tsx`, browser storage, or a public repository. A future OpenAI key should be stored as a server-side environment secret.

The value in `.openai/hosting.json` is intentionally sanitized. A Sites deployment supplies its own project identity.
