# Acceseries Worker API

The Cloudflare Worker uses Hono, TypeScript, Zod, Supabase Auth and PostgreSQL RPCs. See the repository's [SETUP.md](../SETUP.md), [API_DOCUMENTATION.md](../API_DOCUMENTATION.md), and [DEPLOYMENT.md](../DEPLOYMENT.md).

For local development, create `backend/.dev.vars` from `.env.example` and run:

```powershell
npm install
npm run build
npm run dev
```

`SUPABASE_SERVICE_ROLE_KEY` is a server-side secret used for staff invitations and scheduled fee assessment. Never expose it to frontend code or bundle it into Vite.
