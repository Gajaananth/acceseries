import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type FormEvent } from 'react'
import { z } from 'zod'
import { Combobox, type ComboboxOption } from '../../components/ui/Combobox'
import { FormField } from '../../components/ui/FormField'
import { Modal } from '../../components/ui/Modal'
import { MoneyInput } from '../../components/ui/MoneyInput'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { apiRequest } from '../../lib/api'
import { formatLkr } from '../../shared/business'
import { ErrorMessage, Loading, PageHeading } from '../dashboard/DashboardPage'

type DiscountType = 'product' | 'customer' | 'early_settlement'
type Customer = { id: string; full_name: string; phone: string }
type Agreement = { id: string; customer_id: string; status: string; customer: { full_name: string } | null }
type PaymentMethod = { key: string; name: string }
type SettlementQuote = {
  agreement_id: string
  outstanding_principal_cents: number
  outstanding_interest_cents: number
  late_fees_cents: number
  discount_amount_cents: number
  settlement_amount_cents: number
  discount_type: 'fixed' | 'interest_percentage'
}
type DiscountRequest = {
  id: string
  discount_type: DiscountType
  amount_cents: number
  reason: string
  customer_id: string | null
  agreement_id: string | null
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'settled_early'
  requester: string
  approver: string | null
  decision_at: string | null
  decision_reason: string | null
  approved_at: string | null
  applied_at: string | null
  payment_id: string | null
  quoted_principal_cents: number | null
  quoted_interest_cents: number | null
  quoted_late_fees_cents: number | null
  quoted_settlement_amount_cents: number | null
  created_at: string
}

const requestTypes = [
  { value: 'product', label: 'Product' },
  { value: 'customer', label: 'Customer' },
  { value: 'early_settlement', label: 'Early settlement' },
] as const

const discountRequestSchema = z.object({
  discount_type: z.enum(['product', 'customer', 'early_settlement']),
  amount_cents: z.number().int().min(0).max(999_999_999_999).nullable(),
  reason: z.string().trim().min(2, 'Enter a reason (at least 2 characters).').max(500),
  customer_id: z.string().uuid().nullable(),
  agreement_id: z.string().uuid().nullable(),
}).superRefine((request, context) => {
  if (request.discount_type === 'early_settlement') {
    if (!request.agreement_id || request.customer_id || request.amount_cents !== null) {
      context.addIssue({ code: 'custom', path: ['agreement_id'], message: 'Select an active agreement.' })
    }
  } else {
    if (request.agreement_id || request.amount_cents === null || request.amount_cents <= 0) {
      context.addIssue({ code: 'custom', path: ['amount_cents'], message: 'Enter a positive discount amount.' })
    }
    if (request.discount_type === 'customer' && !request.customer_id) {
      context.addIssue({ code: 'custom', path: ['customer_id'], message: 'Select the customer for this discount.' })
    }
  }
})

function requestTypeLabel(type: DiscountType): string {
  if (type === 'early_settlement') return 'Early settlement'
  return type === 'product' ? 'Product' : 'Customer'
}

function statusStyle(status: DiscountRequest['status']): string {
  if (status === 'approved' || status === 'applied' || status === 'settled_early') return 'bg-emerald-50 text-emerald-700'
  if (status === 'rejected') return 'bg-rose-50 text-rose-700'
  return 'bg-amber-50 text-amber-800'
}

function dateLabel(value: string): string {
  return new Date(value).toLocaleString('en-LK', { dateStyle: 'medium', timeStyle: 'short' })
}

export function DiscountsPage({ isOwner }: { isOwner: boolean }) {
  const queryClient = useQueryClient()
  const [type, setType] = useState<DiscountType>('product')
  const [amountCents, setAmountCents] = useState<number | null>(null)
  const [customerId, setCustomerId] = useState<string | null>(null)
  const [agreementId, setAgreementId] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({})
  const [decisionTarget, setDecisionTarget] = useState<DiscountRequest | null>(null)
  const [decisionReason, setDecisionReason] = useState('')
  const [paymentMethodByRequest, setPaymentMethodByRequest] = useState<Record<string, string>>({})
  const requestKey = useRef<{ body: string; key: string } | null>(null)
  const decisionKey = useRef<{ signature: string; key: string } | null>(null)

  const requests = useQuery({
    queryKey: ['discount-requests'],
    queryFn: () => apiRequest<DiscountRequest[]>('/api/discounts'),
  })
  const customers = useQuery({
    queryKey: ['customers'],
    queryFn: () => apiRequest<Customer[]>('/api/customers'),
  })
  const agreements = useQuery({
    queryKey: ['agreements'],
    queryFn: () => apiRequest<Agreement[]>('/api/agreements'),
    enabled: type === 'early_settlement',
  })
  const methods = useQuery({
    queryKey: ['payment-methods'],
    queryFn: () => apiRequest<PaymentMethod[]>('/api/payments/methods'),
    enabled: isOwner,
  })
  const quote = useQuery({
    queryKey: ['early-settlement-quote', agreementId],
    queryFn: () => apiRequest<SettlementQuote>(`/api/agreements/${agreementId}/early-settlement-quote`),
    enabled: type === 'early_settlement' && agreementId !== null,
  })
  const availableAgreements = (agreements.data ?? []).filter((agreement) => agreement.status === 'approved')
  const customerOptions: ComboboxOption<string>[] = (customers.data ?? []).map((customer) => ({
    value: customer.id,
    label: `${customer.full_name} · ${customer.phone}`,
  }))
  const agreementOptions: ComboboxOption<string>[] = availableAgreements.map((agreement) => ({
    value: agreement.id,
    label: `${agreement.customer?.full_name ?? 'Customer'} · ${agreement.id.slice(0, 8)}`,
  }))
  const paymentOptions: ComboboxOption<string>[] = (methods.data ?? []).map((method) => ({
    value: method.key,
    label: method.name,
  }))

  const invalidateDiscountData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['discount-requests'] }),
      queryClient.invalidateQueries({ queryKey: ['available-discounts'] }),
      queryClient.invalidateQueries({ queryKey: ['agreements'] }),
      queryClient.invalidateQueries({ queryKey: ['payments'] }),
      queryClient.invalidateQueries({ queryKey: ['payment-summary'] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    ])
  }

  const createRequest = useMutation({
    mutationFn: ({ payload, key }: { payload: z.infer<typeof discountRequestSchema>; key: string }) =>
      apiRequest<{ id: string }>('/api/discounts', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Idempotency-Key': key },
      }),
    onSuccess: async () => {
      requestKey.current = null
      setAmountCents(null)
      setCustomerId(null)
      setAgreementId(null)
      setReason('')
      setValidationErrors({})
      setType('product')
      await invalidateDiscountData()
    },
  })

  const decide = useMutation({
    mutationFn: (action: {
      type: 'approve' | 'reject' | 'settle-early'
      requestId: string
      reason?: string
      paymentMethod?: string
      idempotencyKey: string
    }) => {
      const path = action.type === 'settle-early'
        ? `/api/discounts/${action.requestId}/settle-early`
        : `/api/discounts/${action.requestId}/${action.type}`
      const payload = action.type === 'settle-early'
        ? { payment_method: action.paymentMethod }
        : { reason: action.reason ?? '' }
      return apiRequest<{ id?: string; payment_id?: string }>(path, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Idempotency-Key': action.idempotencyKey },
      })
    },
    onSuccess: async () => {
      decisionKey.current = null
      setDecisionTarget(null)
      setDecisionReason('')
      await invalidateDiscountData()
    },
  })

  const runDecision = (action: {
    type: 'approve' | 'reject' | 'settle-early'
    requestId: string
    reason?: string
    paymentMethod?: string
  }) => {
    const signature = JSON.stringify(action)
    if (decisionKey.current?.signature !== signature) {
      decisionKey.current = { signature, key: crypto.randomUUID() }
    }
    decide.mutate({ ...action, idempotencyKey: decisionKey.current.key })
  }

  const submitRequest = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const parsed = discountRequestSchema.safeParse({
      discount_type: type,
      amount_cents: type === 'early_settlement' ? null : amountCents,
      reason,
      customer_id: type === 'customer' ? customerId : null,
      agreement_id: type === 'early_settlement' ? agreementId : null,
    })
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form')
        fieldErrors[key] ??= issue.message
      }
      setValidationErrors(fieldErrors)
      return
    }
    setValidationErrors({})
    const body = JSON.stringify(parsed.data)
    if (requestKey.current?.body !== body) {
      requestKey.current = { body, key: crypto.randomUUID() }
    }
    createRequest.mutate({ payload: parsed.data, key: requestKey.current.key })
  }

  const rows = requests.data ?? []

  return (
    <div className="min-w-0 space-y-6">
      <PageHeading
        title="Discounts"
        description="Request discounts for owner approval, review decisions, and settle agreements early."
      />

      <section className="min-w-0 rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
        <h3 className="text-xl font-extrabold text-slate-900">New discount request</h3>
        <form className="mt-5 min-w-0 space-y-5" onSubmit={submitRequest}>
          <FormField label="Request type">
            <SegmentedControl
              value={type}
              options={requestTypes}
              ariaLabel="Discount request type"
              onChange={(value) => {
                setType(value)
                setAmountCents(null)
                setCustomerId(null)
                setAgreementId(null)
                setValidationErrors({})
                createRequest.reset()
              }}
            />
          </FormField>

          {type === 'early_settlement' ? (
            <div className="space-y-4">
              <FormField label="Active agreement" error={validationErrors.agreement_id}>
                <Combobox
                  options={agreementOptions}
                  value={agreementId}
                  onChange={(value) => { setAgreementId(value); setValidationErrors({}) }}
                  ariaLabel="Agreement for early settlement"
                  placeholder="Select an agreement"
                  searchPlaceholder="Search customer or agreement…"
                />
              </FormField>
              {agreements.isPending && <p className="text-sm text-slate-500">Loading active agreements…</p>}
              {agreements.isError && <ErrorMessage message={agreements.error.message} />}
              {!agreements.isPending && !agreements.isError && agreementOptions.length === 0 && (
                <p className="text-sm text-slate-500">There are no active agreements available for early settlement.</p>
              )}
              {agreementId && quote.isPending && <p className="text-sm text-slate-500">Calculating settlement quote…</p>}
              {quote.isError && <ErrorMessage message={quote.error.message} />}
              {quote.data && (
                <div className="grid min-w-0 grid-cols-1 gap-3 rounded-2xl bg-slate-50 p-4 sm:grid-cols-2">
                  <QuoteLine label="Outstanding principal" cents={quote.data.outstanding_principal_cents} />
                  <QuoteLine label="Remaining scheduled interest" cents={quote.data.outstanding_interest_cents} />
                  <QuoteLine label="Late fees" cents={quote.data.late_fees_cents} />
                  <QuoteLine label="Configured early-settlement discount" cents={quote.data.discount_amount_cents} />
                  <div className="sm:col-span-2">
                    <QuoteLine label="Proposed settlement amount" cents={quote.data.settlement_amount_cents} strong />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
              <FormField label="Discount amount (LKR)" error={validationErrors.amount_cents}>
                <MoneyInput cents={amountCents} onChange={(value) => { setAmountCents(value); setValidationErrors({}) }} />
              </FormField>
              {type === 'customer' && (
                <>
                  <FormField label="Customer" error={validationErrors.customer_id}>
                    <Combobox
                      options={customerOptions}
                      value={customerId}
                      onChange={(value) => { setCustomerId(value); setValidationErrors({}) }}
                      ariaLabel="Customer for discount"
                      placeholder="Select a customer"
                      searchPlaceholder="Search name or phone…"
                    />
                  </FormField>
                  {customers.isError && <ErrorMessage message={customers.error.message} />}
                </>
              )}
            </div>
          )}

          <FormField label="Reason" error={validationErrors.reason}>
            <textarea
              value={reason}
              onChange={(event) => { setReason(event.target.value); setValidationErrors({}) }}
              rows={3}
              minLength={2}
              maxLength={500}
              required
              className="field-input min-h-24 resize-y"
            />
          </FormField>
          {createRequest.isError && <ErrorMessage message={createRequest.error.message} />}
          <button
            type="submit"
            disabled={createRequest.isPending || (type === 'early_settlement' && (!quote.data || quote.isFetching))}
            className="rounded-2xl bg-[#247BDB] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
          >
            {createRequest.isPending ? 'Submitting…' : 'Submit for approval'}
          </button>
        </form>
      </section>

      <section className="min-w-0 rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <h3 className="text-xl font-extrabold text-slate-900">{isOwner ? 'Discount requests' : 'Your requests and available discounts'}</h3>
          {!requests.isPending && !requests.isError && (
            <span className="rounded-full bg-slate-100 px-3 py-1 text-sm font-semibold text-slate-600">{rows.length}</span>
          )}
        </div>
        {requests.isPending ? <Loading /> : requests.isError ? <ErrorMessage message={requests.error.message} /> : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">No discount requests yet.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {rows.map((request) => (
              <article key={request.id} className="min-w-0 rounded-2xl border border-slate-200 p-4">
                <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="font-bold text-slate-900">{requestTypeLabel(request.discount_type)}</h4>
                      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${statusStyle(request.status)}`}>{request.status.replace('_', ' ')}</span>
                    </div>
                    <p className="mt-1 break-words text-sm text-slate-600">{request.reason}</p>
                    <p className="mt-2 text-xs text-slate-500">
                      Requested by {request.requester} · {dateLabel(request.created_at)}
                      {request.approver ? ` · decided by ${request.approver}` : ''}
                      {request.decision_at ? ` · ${dateLabel(request.decision_at)}` : ''}
                    </p>
                    {request.decision_reason && <p className="mt-1 text-xs text-slate-500">Decision note: {request.decision_reason}</p>}
                    {request.discount_type === 'early_settlement' && request.quoted_settlement_amount_cents !== null && (
                      <div className="mt-3 grid min-w-0 grid-cols-1 gap-1 text-sm sm:grid-cols-2">
                        <QuoteLine label="Principal" cents={request.quoted_principal_cents ?? 0} />
                        <QuoteLine label="Remaining interest" cents={request.quoted_interest_cents ?? 0} />
                        <QuoteLine label="Late fees" cents={request.quoted_late_fees_cents ?? 0} />
                        <QuoteLine label="Proposed settlement" cents={request.quoted_settlement_amount_cents} strong />
                      </div>
                    )}
                  </div>
                  {request.discount_type !== 'early_settlement' && (
                    <p className="shrink-0 text-lg font-extrabold tabular-nums text-slate-900">{formatLkr(request.amount_cents)}</p>
                  )}
                </div>
                {isOwner && request.status === 'pending' && request.discount_type !== 'early_settlement' && (
                  <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
                    <button
                      type="button"
                      disabled={decide.isPending}
                      onClick={() => runDecision({ type: 'approve', requestId: request.id })}
                      className="rounded-xl bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={decide.isPending}
                      onClick={() => { setDecisionTarget(request); setDecisionReason(''); decide.reset() }}
                      className="rounded-xl border border-rose-200 px-3 py-2 text-sm font-semibold text-rose-700 disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </div>
                )}
                {isOwner && request.status === 'pending' && request.discount_type === 'early_settlement' && (
                  <div className="mt-4 grid min-w-0 grid-cols-1 gap-3 border-t border-slate-100 pt-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
                    {methods.isError && <div className="sm:col-span-3"><ErrorMessage message={methods.error.message} /></div>}
                    <FormField label="Payment method">
                      <Combobox
                        options={paymentOptions}
                        value={paymentMethodByRequest[request.id] ?? null}
                        onChange={(value) => setPaymentMethodByRequest((current) => ({ ...current, [request.id]: value }))}
                        ariaLabel={`Payment method for settlement ${request.id}`}
                        placeholder="Select payment method"
                      />
                    </FormField>
                    <button
                      type="button"
                      disabled={decide.isPending}
                      onClick={() => { setDecisionTarget(request); setDecisionReason(''); decide.reset() }}
                      className="rounded-xl border border-rose-200 px-3 py-3 text-sm font-semibold text-rose-700 disabled:opacity-50"
                    >
                      Reject
                    </button>
                    {!methods.isPending && !methods.isError && paymentOptions.length === 0 && (
                      <p className="text-xs text-amber-700">No active payment methods are configured.</p>
                    )}
                    <button
                      type="button"
                      disabled={decide.isPending || !paymentMethodByRequest[request.id] || methods.isPending}
                      onClick={() => runDecision({
                        type: 'settle-early',
                        requestId: request.id,
                        paymentMethod: paymentMethodByRequest[request.id],
                      })}
                      className="rounded-xl bg-[#247BDB] px-3 py-3 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      Approve &amp; settle
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
        {decide.isError && <div className="mt-4"><ErrorMessage message={decide.error.message} /></div>}
      </section>

      <Modal
        open={decisionTarget !== null}
        onClose={() => { setDecisionTarget(null); setDecisionReason(''); decide.reset() }}
        title="Reject discount request"
        description="A reason is required and will be recorded with the decision."
        footer={
          <div className="flex min-w-0 justify-end gap-3">
            <button type="button" className="soft-button" onClick={() => setDecisionTarget(null)}>Cancel</button>
            <button
              type="button"
              disabled={decisionReason.trim().length < 2 || decide.isPending}
              onClick={() => decisionTarget && runDecision({
                type: 'reject',
                requestId: decisionTarget.id,
                reason: decisionReason.trim(),
              })}
              className="rounded-2xl bg-rose-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
            >
              {decide.isPending ? 'Saving…' : 'Confirm rejection'}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <FormField label="Rejection reason">
            <textarea
              value={decisionReason}
              onChange={(event) => setDecisionReason(event.target.value)}
              rows={3}
              minLength={2}
              maxLength={500}
              required
              className="field-input min-h-24 resize-y"
            />
          </FormField>
          {decide.isError && <ErrorMessage message={decide.error.message} />}
        </div>
      </Modal>
    </div>
  )
}

function QuoteLine({ label, cents, strong = false }: { label: string; cents: number; strong?: boolean }) {
  return (
    <div className={`flex min-w-0 items-center justify-between gap-3 ${strong ? 'font-bold text-slate-900' : 'text-slate-600'}`}>
      <span className="min-w-0">{label}</span>
      <span className="shrink-0 tabular-nums">{formatLkr(cents)}</span>
    </div>
  )
}
