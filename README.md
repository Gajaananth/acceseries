# Acceseries

Acceseries is an accessories retail operations app: React + Vite + TypeScript frontend, Hono API on Cloudflare Workers, and Supabase Auth/PostgreSQL for identity and business data.

The app uses real Supabase data. There are no demo credentials or bundled demo business records. Users sign in with email and password; the first owner account must be promoted during initial database setup (see [SETUP.md](./SETUP.md)).

## Features

- Customer and product catalog, including stock movement tracking
- Cash and installment sales, payment collection, printable invoices and receipts
- Installment schedules, fixed-interest snapshots, late fees, discounts and early settlement
- Permission-based staff accounts, reports, activity log and live operational notifications
- Row Level Security and Worker-backed transactional database functions

## Quick start

Follow [SETUP.md](./SETUP.md) for database initialization, environment variables, and local frontend/API startup. The database bootstrap currently requires running `supabase/schema.sql` before the numbered migrations; see the setup guide before using a fresh database.

Once dependencies and environment files are configured:

```bash
npm run dev:backend
```

In another terminal:

```bash
npm run dev
```

## Development checks

```bash
npm test
npm run typecheck
npm run lint
```

See [TESTING.md](./TESTING.md) for local Supabase integration tests and [BUSINESS_RULES.md](./BUSINESS_RULES.md) for the calculation and payment rules.

## Project map

- `src/` — frontend screens, shared UI and pure calculation module
- `backend/` — authenticated Hono Worker API
- `supabase/schema.sql` — legacy baseline schema required before migrations on an empty database
- `supabase/migrations/` — ordered feature migrations
- `tests/` and `src/**/*.test.ts` — calculation, utility and integration tests

## Documentation

- [Setup](./SETUP.md)
- [Database schema](./DATABASE_SCHEMA.md)
- [API documentation](./API_DOCUMENTATION.md)
- [Deployment](./DEPLOYMENT.md)
- [Business rules](./BUSINESS_RULES.md)
- [Testing](./TESTING.md)
