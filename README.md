# SocialAudit

Agency tool for auditing client Instagram & Facebook accounts: scored audits, AI suggestions, content ideas, and a 30-day content calendar — plus link-based audits (paste `instagram.com/handle` or `facebook.com/page`).

Built as a Cloudflare Worker (plain fetch handler, no framework) with a static dashboard and D1 storage.

## Features

- **Clients** — manage clients with industry and brand description
- **Meta OAuth** — clients connect via Facebook Login; the app discovers their Pages and linked Instagram professional accounts automatically
- **Audit + scoring** — 30-day reach/views plus per-post likes, comments, saves, shares (Meta Graph API v26.0); scores Overall, Engagement (vs size-based benchmark), Consistency, Content Mix, Reach trend, Saves & shares
- **Audit by link** — resolves an Instagram/Facebook URL or @handle to a connected account and audits it
- **AI suggestions** — strengths, improvements, content ideas (any OpenAI-compatible API), with a heuristic fallback when no AI key is set
- **30-day calendar** — format, theme, best time, caption hook per day

## Local development

```bash
npm install
npm run dev          # Node dev server on http://localhost:8787 (demo mode)
```

> `npm run dev` runs [dev-server.mjs](dev-server.mjs): the real Worker handler under Node with a SQLite-backed D1 shim, because `wrangler dev`'s local D1 fails on some Windows machines.
> `npm run dev:wrangler` uses standard `wrangler dev` where local D1 works.

In demo mode (no Meta credentials) the app synthesizes a connected account so the full flow is testable — use the **Connect Instagram / Facebook** button to attach it.

## Configuration (env vars / Worker secrets)

| Variable | Purpose |
|---|---|
| `META_APP_ID` / `META_APP_SECRET` | Meta developer app for OAuth (unset → demo mode) |
| `APP_ORIGIN` | Public origin, e.g. `https://social-audit.<account>.workers.dev` (must match the OAuth redirect URI `…/api/meta/callback` registered in the Meta app) |
| `AI_API_KEY` | OpenAI-compatible API key for AI suggestions/calendar (unset → heuristic engine) |
| `AI_BASE_URL` / `AI_MODEL` | Optional overrides (default `https://api.openai.com/v1`, `gpt-4o-mini`) |
| `SECRET_KEY` | Key material for AES-GCM encryption of stored Meta tokens (falls back to `META_APP_SECRET`) |
| `DEMO` | `1` to force demo mode |

Meta scopes requested: `instagram_basic`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`.

## Deploy (Cloudflare)

```bash
npx wrangler d1 create social-audit     # put the returned database_id into wrangler.jsonc
npm run db:remote                       # apply schema.sql (worker also auto-creates tables on first use)
npx wrangler deploy
```

**Production requirements:** real client data needs a Meta Developer app that has passed App Review + Business Verification for the scopes above; until then only app-team members can connect accounts. Add authentication before exposing the app publicly — it stores client OAuth tokens.

## API

| Method & path | Purpose |
|---|---|
| `GET /api/config` | Mode flags (demo/AI configured) |
| `POST /api/clients` · `GET /api/clients` · `DELETE /api/clients/:id` | Client CRUD |
| `GET /api/meta/auth?clientId=…` → `/api/meta/callback` | Meta OAuth flow |
| `GET/DELETE /api/clients/:id/connections` | Connected accounts |
| `POST /api/clients/:id/audit` | Run audit (body: `{igUserId?}`) |
| `POST /api/clients/:id/suggestions` | AI/heuristic suggestions |
| `POST /api/clients/:id/calendar` | Content calendar (body: `{days?}`) |
| `POST /api/audit-by-link` | Audit by profile URL (body: `{url}`) |
| `POST /api/demo/connect` | Demo-mode fake connection |
