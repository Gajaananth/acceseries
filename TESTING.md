# Testing

## Standard checks

Run from the repository root:

```powershell
npm test
npm run typecheck
npm run lint
```

- `npm test` runs Vitest unit tests and any configured local Supabase integration tests.
- `npm run typecheck` checks the frontend, test files and Worker TypeScript.
- `npm run lint` lints frontend and Worker source.
- GitHub Actions runs all three checks and fails the job on a non-zero exit.

The shared calculations tests cover agreement totals, interest distribution, daily/weekly/monthly schedules, leap-year clamping, cent rounding, late-fee boundaries/caps, partial and multi-installment allocation, and early-settlement quotes.

## Local Supabase integration tests

Integration tests call the database RPCs as real authenticated owner and staff clients. They cover sale stock deduction and insufficient stock, concurrent sales, duplicate payment idempotency, reversal allocations, owner-vs-staff permissions, discount approval denial, waiver denial, and financial-summary access.

Use a **disposable local Supabase instance**. Tests create temporary users and records and attempt cleanup afterward; never point them at production or a shared database. The test module rejects non-loopback URLs.

Export the local Supabase values in PowerShell, then run:

```powershell
$env:SUPABASE_TEST_URL = "http://127.0.0.1:54321"
$env:SUPABASE_TEST_ANON_KEY = "<local-anon-key>"
$env:SUPABASE_TEST_SERVICE_ROLE_KEY = "<local-service-role-key>"
npm run test:integration
```

Without all three variables, Vitest marks the integration suite skipped. The normal CI workflow runs unit tests and static checks; it does not boot Supabase, so it skips the local integration suite. Run `npm run test:integration` against the local database before relying on database behavior changes.

The local database must be initialized as documented in [SETUP.md](./SETUP.md), including the legacy baseline before numbered migrations.
