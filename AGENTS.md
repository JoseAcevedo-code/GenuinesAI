# GenuinesAI — agent instructions

Mobile-first AI chat website. Next.js App Router compiled by **vinext** (a Vite
RSC toolchain, not the Next.js CLI) and served from a **Cloudflare Worker**.
Requires Node.js >= 22.13.

## Setup

```bash
npm run install:ci
```

Use this instead of `npm install`. `scripts/install-ci.sh` runs a bounded
`npm ci` under a lock with a tarball integrity preflight, after forcing `HOME`
and the npm cache into `.sites-runtime/`. It exits 78 if those are not
redirected, so it must be invoked through this script.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server on `0.0.0.0:5173` |
| `npm run build` | Bounded vinext production build (3m default timeout) |
| `npm run start` | Serve the production build |
| `npm run test:unit` | 34 unit tests for search and conversation logic |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `test:unit` + `build` + rendered-HTML test |

Run `test:unit`, `lint`, and `typecheck` before proposing changes. All three
pass on a clean tree.

## Known failing test

`tests/rendered-html.test.mjs` fails. It asserts the rendered HTML contains
`<meta name="codex-preview" content="development">`, which nothing in this
repository emits — the string appears only in the test file itself. It is
presumed to be injected by an external preview environment.

Do not "fix" this by adding the meta tag to `app/layout.tsx` unless that
preview marker is explicitly wanted. `npm test` chains all three stages, so it
stays red while this test exists; use `npm run test:unit` to check application
logic.

## Environment

There are no environment variables and no API keys. Do not add either without
being asked. The search providers call public keyless endpoints (BBC, NPR and
NYT RSS, Google News RSS, Wikipedia REST), so `/api/search` needs outbound
network access and degrades when egress is blocked.

Cloudflare resources arrive as bindings, not env vars: `ASSETS`, an optional
`DB` (D1), and `IMAGES`. `vite.config.ts` reads the D1 and R2 binding names
from `.openai/hosting.json`; the committed placeholder omits them, so both
bind as empty arrays and D1/R2-backed paths are inert until a real deployment
supplies them. The chat UI and `/api/search` work without them.

Never commit a real `project_id` or credentials to `.openai/hosting.json`.

## Gotchas

- **Dev host allowlist.** `vite.config.ts` sets `allowedHosts: ["terminal.local"]`.
  A preview proxied under any other hostname is rejected with a blocked-host
  page. Add the hostname to that array.
- **`dev` and `start` bypass the sandbox wrapper.** `install:ci`, `build`,
  `lint`, `typecheck`, and `db:generate` route through `scripts/sites-env.sh`,
  which redirects `HOME`, `TMPDIR`, `XDG_CONFIG_HOME`, and the Wrangler paths
  into `.sites-runtime/`. `dev` and `start` call the binaries directly and
  write to the real `HOME`. On permission errors under a strict sandbox, run
  `bash scripts/sites-env.sh -- npx vite`.
- **Startup noise.** `Unable to fetch the Request.cf object! Falling back to a
  default placeholder` is Miniflare losing a Cloudflare metadata fetch behind a
  proxy. Harmless; the server still serves.
- **macOS sandbox.** `vite.config.ts` already switches HMR to polling when
  `CODEX_SANDBOX=seatbelt`, because Seatbelt blocks FSEvents.

## Layout

- `app/` — chat UI (`page.tsx`), `layout.tsx`, `/api/search` route, ChatGPT auth helpers
- `lib/search/` — intent detection, conversation logic, providers, relevance, text, cache, rate limiting
- `lib/branding.ts` — site name, tagline, and canonical URL
- `worker/index.ts` — Worker entry; security headers and image optimization
- `db/`, `drizzle/` — Drizzle schema and migration journal
- `build/sites-vite-plugin.ts` — packages `.openai/` metadata and migrations into `dist/`
- `scripts/` — env, install, and build helpers
- `examples/d1/` — reference D1 usage, not wired into the app

Generated and ignored: `node_modules/`, `dist/`, `.wrangler/`, `.sites-runtime/`,
`*.tsbuildinfo`.
