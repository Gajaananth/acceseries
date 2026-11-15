# Database schema

The database is PostgreSQL on Supabase. Money is stored as `numeric(12,2)`; the frontend and Worker exchange monetary inputs as integer LKR cents. Row Level Security is enabled for application tables. Transactional writes are performed by `SECURITY DEFINER` PostgreSQL functions and called through the authenticated Worker.

## Initialization and migrations

`supabase/schema.sql` is the legacy baseline containing the original customers, products, sales, payments, and installment tables. The numbered files in `supabase/migrations/` build on that baseline; they do not currently create all baseline tables from an empty database. On a fresh database, apply `schema.sql` once, then apply each migration in filename order. See [SETUP.md](./SETUP.md).

Do not treat `schema.sql` as the current complete schema or rerun it on a populated database. The migrations are the source of truth for the current model.

## Main tables

| Area | Tables | Purpose |
|---|---|---|
| Identity and authorization | `profiles`, `roles`, `permissions`, `role_permissions`, `user_permissions` | Profile role and effective staff permission overrides |
| Customers and catalog | `customers`, `categories`, `products` | Customer contacts and sellable products; stock level is derived from quantity and minimum stock |
| Stock audit | `stock_movements`, `stock_override_audit` | Stock-in/adjustment history and audited owner overrides |
| Sales | `sales`, `sale_items` | Sale header, immutable sale line snapshots, and cost-price snapshot for estimated profit |
| Installments | `agreements`, `agreement_items`, `agreement_schedule`, `discount_approvals` | Agreement terms, item snapshots, schedule, and approval state |
| Payments | `payments`, `payment_allocations`, `payment_methods` | Immutable collection ledger, allocation ledger, supported payment methods |
| Fees and discounts | `late_fee_records`, `discount_requests`, `early_settlement_interest_discounts`, `discounts` | Append-only assessed/waived fee records, discount workflow, and settlement discount allocations |
| Operations | `expenses`, `application_settings`, `activity_logs`, `idempotency_records` | Operating costs, configurable policy defaults, owner-visible audit log, and transaction deduplication |

Important constraints include unique customer phone, product SKU and optional barcode, unique installment number per agreement, unique idempotency key per user and operation, and unique fee type/date per installment. Foreign keys restrict deleting records that are referenced by ledger entries.

## Authorization and writes

- Owners have full application permissions. Staff permissions are resolved from role grants plus per-user overrides.
- `profiles`, permission relations, and business tables are protected by RLS. Activity log reads are owner-only.
- Product writes and transactional money/stock changes are routed through the Worker. Direct browser table writes are not the application write path.
- Key transactional functions include `create_sale`, `create_installment_sale`, `create_installment_sale_with_discounts`, `record_payment`, `reverse_payment`, `settle_agreement`, `decide_discount_request`, and `waive_late_fee`.
- Reporting functions include `get_dashboard_overview`, `get_report`, and `get_notifications`.

The agreement stores a snapshot of interest, grace period, and late-fee policy. Changing application defaults affects new agreements only.

## Historical estimates

`sale_items.cost_price_snapshot` is backfilled from the product's current cost when the migration runs. For older sales this is a current-cost estimate, not guaranteed historical cost. Profit reporting must be interpreted accordingly.
