# Developer setup

This guide starts the frontend and Worker against a new Supabase project. Use a disposable project for initial setup and testing.

## Requirements

- Node.js 22 LTS (22.12 or newer) and npm
- `psql` (PostgreSQL client)
- A Supabase project with email/password authentication enabled

## 1. Install dependencies

From the repository root in PowerShell:

```powershell
npm install
npm install --prefix backend
```

## 2. Initialize the database

> **Important:** The numbered migration files are feature migrations, not a complete empty-database baseline. The first migration expects the legacy tables in `supabase/schema.sql`. On a new, empty Supabase project, apply that baseline once, then apply all numbered migrations in filename order. Do not run the baseline again on a database that already contains these tables.

Get the database connection string from **Supabase Dashboard → Project Settings → Database → Connection string**. Use a direct connection and require SSL for hosted projects. In PowerShell, keep the password in an environment variable rather than committing it:

```powershell
$env:SUPABASE_DB_URL = "postgresql://postgres:<password>@<host>:5432/postgres?sslmode=require"
psql $env:SUPABASE_DB_URL -v ON_ERROR_STOP=1 -f .\supabase\schema.sql

$migrationFiles = Get-ChildItem .\supabase\migrations\*.sql | Sort-Object Name
foreach ($migration in $migrationFiles) {
  Write-Host "Applying $($migration.Name)"
  psql $env:SUPABASE_DB_URL -v ON_ERROR_STOP=1 -f $migration.FullName
  if ($LASTEXITCODE -ne 0) {
    throw "Migration failed: $($migration.Name)"
  }
}
```

The migration files are numbered by timestamp. Stop on the first error; do not continue with a partially migrated database. For an existing environment, apply only migrations that have not already been applied.

## 3. Create and promote the first owner

Create an email/password user in **Supabase Dashboard → Authentication → Users**. The auth trigger creates a staff profile by default. In the SQL Editor, replace the email below and promote that profile:

```sql
update public.profiles
set role_id = (select id from public.roles where name = 'owner')
where user_id = (
  select id from auth.users where lower(email) = lower('owner@example.com')
);
```

Confirm exactly one profile row was updated before signing in. The owner role is database-managed; do not set it from browser metadata.

## 4. Configure the frontend and Worker

Copy the example files:

```powershell
Copy-Item .env.example .env.local
Copy-Item backend\.env.example backend\.dev.vars
```

Set these values in root `.env.local`:

```env
VITE_API_URL=http://localhost:8787
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<project-anon-key>
VITE_SHOP_NAME=Acceseries
```

Set these values in `backend/.dev.vars`:

```env
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=<project-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<project-service-role-key>
APP_ENV=development
ALLOWED_ORIGINS=http://localhost:5173
```

`SUPABASE_SERVICE_ROLE_KEY` is only used by the Worker for Auth invitations. Never put it in `.env.local`, frontend source, or a `VITE_` variable. Keep `.dev.vars` private and do not commit it.

In the Supabase Auth URL configuration, allow the local frontend URL `http://localhost:5173`. Use the project URL and keys from the Supabase dashboard, not example values.

## 5. Run the application

Start the Worker in one PowerShell terminal:

```powershell
npm run dev:backend
```

Start Vite in another terminal:

```powershell
npm run dev
```

Open `http://localhost:5173` and sign in with the owner email/password. Staff can be invited from the Staff page after the Worker has the service-role secret configured.

## 6. Run checks

```powershell
npm test
npm run typecheck
npm run lint
npm run build
```

The local Supabase integration tests are skipped unless their three `SUPABASE_TEST_*` environment variables are set. See [TESTING.md](./TESTING.md) for running them safely.

## Troubleshooting

- **Supabase is not configured:** verify the two `VITE_SUPABASE_*` values and restart Vite.
- **API is not configured / API cannot be reached:** verify `VITE_API_URL`, that Wrangler is running, and that `ALLOWED_ORIGINS` exactly matches the frontend origin.
- **401 / 403:** verify the user has a profile, the first account was promoted to owner, and the required permission is assigned.
- **Database relation or function missing:** verify the baseline and migrations were applied in the documented order.
- **Staff invitations fail:** confirm the Worker has `SUPABASE_SERVICE_ROLE_KEY`; the browser must not have it.
