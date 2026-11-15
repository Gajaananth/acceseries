# Business rules

All monetary calculations use integer LKR cents. PostgreSQL stores money as `numeric(12,2)`. Conversion to rupees and currency formatting happens at display boundaries.

## Agreement totals and schedules

1. Subtotal is the sum of each unit price in cents multiplied by its quantity.
2. Final price is subtotal minus product and customer discounts. Discounts cannot exceed subtotal.
3. Remaining principal is final price minus down payment. Down payment cannot exceed final price.
4. Total repayment is remaining principal plus fixed total interest.
5. Each installment starts at `floor(total repayment cents / installment count)`. The full remainder is added to the **last installment only**. The schedule must sum exactly to total repayment. Fixed interest is split using the same last-installment remainder rule.
6. If down payment covers the final price and total repayment is zero, no installment schedule is created.
7. Daily schedules advance by one calendar day, weekly schedules by seven calendar days. Monthly dates use the original day of month, clamped to the target month's last day independently for each month; a January 31 schedule can therefore continue as February 28/29, then March 31.

## Late-fee date boundary

- The due date is day zero. `days overdue` is the count of whole calendar days from the due date to the assessment date, never less than zero.
- `chargeable days = max(0, days overdue - grace-period days)`.
- Therefore, with a due date of November 10 and a three-day grace period, November 13 is still inside grace; November 14 is the first chargeable day.
- The assessment date is inclusive. A fee assessed on November 16 for a November 10 due date and three grace days has three chargeable days (November 14, 15, and 16).
- The fixed fee is charged once when the first chargeable day occurs. The daily fee accrues for each chargeable day while the installment is not fully paid. Total assessed fees are capped at the agreement's snapshotted maximum.
- A partial payment does not stop accrual. Full settlement stops future accrual. Existing fee records are not rewritten; waivers append an owner-attributed record with a reason.

## Payment allocation

- The default allocation order is **late fees, then interest, then principal**.
- The order is configurable in application settings; each configured component may appear exactly once.
- Payments apply to the oldest due installment first, then move forward through the schedule. Within each installment, the configured component order is applied.
- Partial payments are allowed. Advance payments may cover multiple installments. The sum of allocation ledger entries must equal the payment amount exactly.
- Reversals append balancing allocation rows and mark the payment reversed; they do not edit or delete the original allocation rows.

## Discounts and settlement

- Only approved, unused discount requests may be applied. An approved request can be applied once.
- Early-settlement discounts apply to remaining interest (or use the configured fixed amount); already-paid interest is never refunded.
- Early settlement includes outstanding principal, outstanding scheduled interest and unpaid late fees, less the approved discount. The owner approves the settlement.
- Agreements snapshot the interest, grace period, and late-fee policy at creation. Later settings changes affect new agreements only.

## Sales and inventory

- Sale creation, sale items, payment, stock deduction, stock-movement record and idempotency response are committed in one database transaction.
- A sale cannot make inventory negative unless an owner explicitly approves the override; each override is audited.
- Product stock status is derived from on-hand quantity and minimum stock. It is not a separate source of truth.
- Revenue is the sale amount. Collected cash is the amount actually received. Future scheduled repayments are receivables, not revenue or cash collected.
