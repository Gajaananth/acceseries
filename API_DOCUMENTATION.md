# Worker API

The Hono Worker is the only application API. Except for `GET /health`, requests require `Authorization: Bearer <Supabase access token>`. The Worker verifies the token, loads the profile and effective permissions, validates request data, and uses the caller's Supabase identity for RLS/RPC authorization.

Base URL during local development: `http://localhost:8787`.

## Common behavior

- JSON request and response bodies use UTF-8.
- Transactional requests use an `Idempotency-Key` header. Repeating the same key and payload returns the original result; reusing the key with a different payload is rejected.
- Money inputs ending in `_cents` are non-negative integer LKR cents. Database money is formatted only for display.
- Common errors: `400` invalid input, `401` missing/invalid session, `403` insufficient permission, `404` missing record, `409` transaction conflict or duplicate action, `502` database/API failure.
- CORS allows only origins configured in the Worker `ALLOWED_ORIGINS` variable.

## Routes

| Method and path | Purpose / access |
|---|---|
| `GET /health` | Worker health check; no authentication |
| `GET /api/auth/me` | Authenticated profile, role and effective permissions |
| `GET /api/dashboard` | Permission-filtered metrics, charts and activity lists |
| `GET /api/notifications` | Due-today, overdue and low-stock notifications |
| `GET /api/reports?type=&from=&to=` | Permission-gated report data |
| `GET /api/staff` | Owner-only staff list and current effective permissions |
| `POST /api/staff/invite` | Owner-only Supabase Auth email invitation and initial permissions |
| `PUT /api/staff/:userId/permissions` | Owner-only permission update |
| `GET /api/activity-logs?from=&to=&actor_id=&action=` | Owner-only activity log, maximum 250 returned entries |
| `GET /api/customers?search=` | Customer search/list; requires customer read access |
| `POST /api/customers` | Create customer; requires customer write permission |
| `GET /api/categories` | Product category list |
| `POST /api/categories` | Create category |
| `GET /api/products?search=&category=&stock=&status=` | Product catalog and filters |
| `POST /api/products` | Create product |
| `PUT /api/products/:id` | Update product metadata |
| `POST /api/products/:id/archive` | Archive product rather than delete |
| `GET /api/products/:id/stock-movements` | Product stock movement history |
| `POST /api/products/:id/stock-movements` | Stock-in/adjustment, audited |
| `GET /api/agreement-defaults` | Default interest values for agreement preview |
| `GET /api/application-settings` | Owner-only application and fee settings |
| `PUT /api/application-settings` | Owner-only settings update |
| `GET /api/discounts/available?type=&customer_id=` | Approved, unused discounts applicable to a sale |
| `GET /api/discounts` | Discount requests and decisions |
| `POST /api/discounts` | Create a discount request |
| `POST /api/discounts/:id/approve` | Owner-only decision; idempotency key required |
| `POST /api/discounts/:id/reject` | Owner-only decision; idempotency key required |
| `GET /api/agreements/:id/early-settlement-quote` | Settlement quote |
| `POST /api/discounts/:id/settle-early` | Owner-approved early settlement; idempotency key required |
| `GET /api/late-payments` | Overdue installments and fee breakdown |
| `POST /api/late-payments/:scheduleId/waive` | Owner-only waiver with reason; idempotency key required |
| `GET /api/agreements` | Agreement list |
| `POST /api/agreements` | Create agreement; idempotency key required |
| `GET /api/sales/summary` | Sales summary tiles |
| `GET /api/sales?search=&from=&to=&status=&page=&page_size=` | Paginated sales list |
| `GET /api/sales/:id` | Sale detail and invoice data |
| `POST /api/sales` | Cash or installment sale, transactional stock deduction; idempotency key required |
| `GET /api/payments/methods` | Active payment methods |
| `GET /api/payments/customers?search=` | Customer search for collection |
| `GET /api/payments/collection/:customerId` | Open agreements and outstanding installments |
| `GET /api/payments/summary` | Collection summary |
| `GET /api/payments?page=&page_size=` | Paginated payment history |
| `GET /api/payments/:paymentId` | Receipt details |
| `POST /api/payments` | Record and allocate payment; idempotency key required |
| `POST /api/payments/:id/reverse` | Owner-only payment reversal with reason; idempotency key required |
| `POST /api/agreements/:id/settle` | Early settlement payment; idempotency key required |

## Sale request

Cash sales use `payment_type: "cash"` and may omit the customer (`customer_id: null`). Installment sales use `payment_type: "installment"` and require a customer and payment terms.

```json
{
  "payment_type": "cash",
  "customer_id": null,
  "discount_cents": 0,
  "discount_type": null,
  "discount_request_id": null,
  "payment_method": "cash",
  "items": [{ "product_id": "uuid", "quantity": 2 }]
}
```

Installment sale requests additionally include `down_payment_cents`, `fixed_interest_cents`, `frequency` (`daily`, `weekly`, or `monthly`), `installment_count`, and `first_due_date` (`YYYY-MM-DD`). A staff stock override is not permitted.

## Payment request

```json
{
  "agreement_id": "uuid",
  "amount_cents": 12500,
  "payment_method": "cash",
  "reference": "optional reference"
}
```

The response contains the payment ID. Reversal is a separate owner-only request and requires a reason; payment rows are not edited or deleted.
