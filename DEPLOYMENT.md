# Deployment

## Database

Provision Supabase and apply the baseline and numbered migrations in order as described in [SETUP.md](./SETUP.md). Promote the initial owner profile before allowing sign-in. Review RLS and permissions in the target project before inviting staff.

## Cloudflare Worker

Install backend dependencies and deploy:

```powershell
npm install --prefix backend
npm --prefix backend run build
npm --prefix backend run deploy
```

Configure these Worker secrets in the target Cloudflare environment:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (Worker-only; required for Auth staff invitations and scheduled fee assessment)
- `ALLOWED_ORIGINS` (comma-separated exact frontend origins)
- `APP_ENV=production`

Use `wrangler secret put <NAME>` from `backend/` for credentials. Do not place the service-role key in the frontend or a `VITE_` variable. The Worker has a daily Cron Trigger at 00:05 UTC to assess late fees; verify Cron Trigger availability and Worker logs after deployment.

## Frontend

Build the static app with production-time values:

```powershell
npm run build
```

Configure the static host with:

- `VITE_API_URL` — deployed Worker base URL
- `VITE_SUPABASE_URL` — Supabase project URL
- `VITE_SUPABASE_ANON_KEY` — Supabase anon/public key
- `VITE_SHOP_NAME` — displayed shop name

Deploy the generated `dist/` directory to the chosen static host and add that exact origin to Worker `ALLOWED_ORIGINS` and Supabase Auth's allowed redirect URLs.

## Release checks

Run `npm test`, `npm run typecheck`, and `npm run lint`; apply migrations; verify owner and staff sign-in; exercise a small sale and payment in a non-production environment; confirm activity logs and scheduled Worker logs. Confirm no secrets are present in the frontend build.
