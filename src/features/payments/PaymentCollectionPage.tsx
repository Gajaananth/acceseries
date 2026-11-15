import { jsPDF } from 'jspdf'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDownToLine, ChevronLeft, ChevronRight, Printer, ReceiptText } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Combobox, type ComboboxOption } from '../../components/ui/Combobox'
import { FormField } from '../../components/ui/FormField'
import { Modal } from '../../components/ui/Modal'
import { MoneyInput } from '../../components/ui/MoneyInput'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { apiRequest } from '../../lib/api'
import {
  allocatePaymentAcrossInstallments,
  type PaymentAllocationType,
} from '../../lib/installments/calculations'
import { databaseDecimalToCents, formatLkr } from '../../shared/business'
import { ErrorMessage, Loading, PageHeading } from '../dashboard/DashboardPage'

type Customer = { id: string; full_name: string; phone: string }
type PaymentMethod = { key: string; name: string }
type OutstandingInstallment = {
  id: string
  installment_number: number
  due_date: string
  amount: string
  interest_amount: string
  late_fee_due: string
  interest_due: string
  principal_due: string
  outstanding_amount: string
  paid_amount: string
  status: 'pending' | 'partial' | 'overdue' | 'paid'
}
type AgreementCollection = {
  agreement_id: string
  agreement_reference: string
  frequency: 'daily' | 'weekly' | 'monthly'
  installment_count: number
  status: string
  outstanding_balance: string
  installments: OutstandingInstallment[]
}
type CollectionData = {
  allocation_order: PaymentAllocationType[]
  agreements: AgreementCollection[]
}
type PaymentSummary = {
  collected_this_month_cents: string
  payments_this_month: number
  overdue_installments: number
}
type PaymentListItem = {
  id: string
  receipt_number: string
  customer_id: string
  agreement_id: string
  amount: string
  payment_method: string
  reference: string | null
  collected_at: string
  reversed_at: string | null
  reversal_reason: string | null
  customer: { full_name: string } | null
}
type PaymentPage = { items: PaymentListItem[]; total: number; page: number; page_size: number }
type Receipt = {
  id: string
  receipt_number: string
  amount: string
  payment_method: string
  reference: string | null
  collected_at: string
  collected_by: string
  customer: { full_name: string; phone: string } | null
  agreement_reference: string | null
  allocations: { late_fee: string; interest: string; principal: string }
  remaining_balance: string
  reversed_at: string | null
  reversal_reason: string | null
}
type CollectionRequest = {
  agreement_id: string
  amount_cents: number
  payment_method: string
  reference?: string
}

const EMPTY_CUSTOMERS: Customer[] = []
const EMPTY_METHODS: PaymentMethod[] = []
const EMPTY_AGREEMENTS: AgreementCollection[] = []
const EMPTY_PAYMENTS: PaymentListItem[] = []
const PAGE_SIZE = 20
const receiptLayouts = [
  { value: 'a4', label: 'A4 receipt' },
  { value: 'thermal', label: '80mm receipt' },
] as const

function amountCents(amount: string): number {
  return databaseDecimalToCents(amount)
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('en-LK', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function dateOnly(value: string): string {
  return new Date(`${value}T00:00:00`).toLocaleDateString('en-LK', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

function customerSearchUrl(search: string): string {
  return `/api/payments/customers?search=${encodeURIComponent(search)}`
}

function printReceipt(thermal: boolean): void {
  document.body.classList.add('receipt-printing')
  document.body.classList.toggle('thermal-printing', thermal)
  const cleanup = () => {
    document.body.classList.remove('receipt-printing', 'thermal-printing')
    window.removeEventListener('afterprint', cleanup)
  }
  window.addEventListener('afterprint', cleanup)
  window.print()
}

function downloadReceiptPdf(receipt: Receipt, thermal: boolean): void {
  const shopName = import.meta.env.VITE_SHOP_NAME?.trim() || 'Acceseries'
  const pageWidth = thermal ? 80 : 210
  const document = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: thermal ? [80, 175] : 'a4',
  })
  const left = thermal ? 5 : 18
  const right = pageWidth - left
  const textWidth = right - left
  let y = thermal ? 8 : 20
  const pair = (label: string, value: string) => {
    const lines = document.splitTextToSize(`${label}: ${value}`, textWidth)
    document.text(lines, left, y)
    y += Math.max(5, lines.length * 4.5)
  }

  document.setFont('helvetica', 'bold')
  document.setFontSize(thermal ? 13 : 20)
  document.text(shopName, pageWidth / 2, y, { align: 'center' })
  y += thermal ? 7 : 12
  document.setFontSize(thermal ? 10 : 14)
  document.text('Payment receipt', pageWidth / 2, y, { align: 'center' })
  y += thermal ? 7 : 12
  document.setFontSize(thermal ? 8 : 10)
  document.setFont('helvetica', 'normal')
  pair('Receipt', receipt.receipt_number)
  pair('Customer', receipt.customer?.full_name ?? 'Customer unavailable')
  pair('Date', formatDate(receipt.collected_at))
  pair('Amount', formatLkr(amountCents(receipt.amount)))
  pair('Method', receipt.payment_method)
  if (receipt.reference) pair('Reference', receipt.reference)
  if (receipt.agreement_reference) pair('Agreement', receipt.agreement_reference)
  y += 2
  document.setFont('helvetica', 'bold')
  document.text('Allocation', left, y)
  y += 5
  document.setFont('helvetica', 'normal')
  pair('Principal', formatLkr(amountCents(receipt.allocations.principal)))
  pair('Interest', formatLkr(amountCents(receipt.allocations.interest)))
  pair('Late fee', formatLkr(amountCents(receipt.allocations.late_fee)))
  pair('Remaining balance', formatLkr(amountCents(receipt.remaining_balance)))
  pair('Collected by', receipt.collected_by)
  if (receipt.reversed_at) {
    y += 2
    pair('Status', `Reversed · ${receipt.reversal_reason ?? 'Reason not supplied'}`)
  }
  document.save(`${receipt.receipt_number}.pdf`)
}

export function PaymentCollectionPage({
  isOwner,
  canRecordPayments,
  canPrintReceipts,
}: {
  isOwner: boolean
  canRecordPayments: boolean
  canPrintReceipts: boolean
}) {
  const queryClient = useQueryClient()
  const [customerSearch, setCustomerSearch] = useState('')
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)
  const [agreementId, setAgreementId] = useState('')
  const [paymentCents, setPaymentCents] = useState<number | null>(null)
  const [paymentMethod, setPaymentMethod] = useState('')
  const [reference, setReference] = useState('')
  const [receiptId, setReceiptId] = useState<string | null>(null)
  const [thermal, setThermal] = useState(false)
  const [reverseReason, setReverseReason] = useState('')
  const [formError, setFormError] = useState('')
  const [page, setPage] = useState(1)
  const collectionRequestKey = useRef<{ body: string; key: string } | null>(null)
  const reversalRequestKey = useRef<{ body: string; key: string } | null>(null)

  const customerSearchResults = useQuery({
    queryKey: ['payment-customers', customerSearch],
    queryFn: () => apiRequest<{ items: Customer[] }>(customerSearchUrl(customerSearch)),
    enabled: customerSearch.trim().length >= 2,
  })
  const methods = useQuery({
    queryKey: ['payment-methods'],
    queryFn: () => apiRequest<PaymentMethod[]>('/api/payments/methods'),
  })
  const collection = useQuery({
    queryKey: ['customer-collection', selectedCustomer?.id],
    queryFn: () => apiRequest<CollectionData>(
      `/api/payments/collection/${selectedCustomer!.id}`,
    ),
    enabled: selectedCustomer !== null,
  })
  const summary = useQuery({
    queryKey: ['payment-summary'],
    queryFn: () => apiRequest<PaymentSummary>('/api/payments/summary'),
  })
  const payments = useQuery({
    queryKey: ['payments', page],
    queryFn: () => apiRequest<PaymentPage>(`/api/payments?page=${page}&page_size=${PAGE_SIZE}`),
  })
  const receiptQuery = useQuery({
    queryKey: ['payment-receipt', receiptId],
    queryFn: () => apiRequest<Receipt>(`/api/payments/${receiptId}`),
    enabled: receiptId !== null,
  })

  const customerRows = customerSearchResults.data?.items ?? EMPTY_CUSTOMERS
  const customerOptions: ComboboxOption<string>[] = useMemo(() => {
    const options = new Map<string, Customer>()
    if (selectedCustomer) options.set(selectedCustomer.id, selectedCustomer)
    for (const customer of customerRows) options.set(customer.id, customer)
    return [...options.values()].map((customer) => ({
      value: customer.id,
      label: `${customer.full_name} · ${customer.phone}`,
    }))
  }, [customerRows, selectedCustomer])
  const agreements = collection.data?.agreements ?? EMPTY_AGREEMENTS
  const agreementOptions: ComboboxOption<string>[] = agreements.map((agreement) => ({
    value: agreement.agreement_id,
    label: `${agreement.agreement_reference} · ${agreement.frequency} · ${formatLkr(amountCents(agreement.outstanding_balance))} outstanding`,
  }))
  const selectedAgreement = agreements.find((agreement) => agreement.agreement_id === agreementId)
  const paymentMethods = methods.data ?? EMPTY_METHODS
  const methodOptions: ComboboxOption<string>[] = paymentMethods.map((method) => ({
    value: method.key,
    label: method.name,
  }))
  const outstandingCents = selectedAgreement ? amountCents(selectedAgreement.outstanding_balance) : 0
  const amountValid = paymentCents !== null && paymentCents > 0 && paymentCents <= outstandingCents
  let allocationPreview: ReturnType<typeof allocatePaymentAcrossInstallments> = []
  if (selectedAgreement && amountValid && paymentCents !== null) {
    try {
      allocationPreview = allocatePaymentAcrossInstallments(paymentCents, selectedAgreement.installments.map((installment) => ({
        id: installment.id,
        lateFeeDueCents: amountCents(installment.late_fee_due),
        interestDueCents: amountCents(installment.interest_due),
        principalDueCents: amountCents(installment.principal_due),
      })), collection.data?.allocation_order)
    } catch {
      allocationPreview = []
    }
  }
  const history = payments.data?.items ?? EMPTY_PAYMENTS
  const totalPages = Math.max(1, Math.ceil((payments.data?.total ?? 0) / PAGE_SIZE))

  const collectPayment = useMutation({
    mutationFn: ({ request, idempotencyKey }: { request: CollectionRequest; idempotencyKey: string }) =>
      apiRequest<{ id: string }>('/api/payments', {
        method: 'POST',
        body: JSON.stringify(request),
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    onSuccess: async ({ id }) => {
      collectionRequestKey.current = null
      setPaymentCents(null)
      setReference('')
      setFormError('')
      openReceipt(id)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['payments'] }),
        queryClient.invalidateQueries({ queryKey: ['payment-summary'] }),
        queryClient.invalidateQueries({ queryKey: ['customer-collection', selectedCustomer?.id] }),
        queryClient.invalidateQueries({ queryKey: ['customers'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ])
    },
  })

  const reversePayment = useMutation({
    mutationFn: ({ paymentId, reason, idempotencyKey }: { paymentId: string; reason: string; idempotencyKey: string }) =>
      apiRequest<{ id: string }>(`/api/payments/${paymentId}/reverse`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    onSuccess: async () => {
      reversalRequestKey.current = null
      setReverseReason('')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['payments'] }),
        queryClient.invalidateQueries({ queryKey: ['payment-summary'] }),
        queryClient.invalidateQueries({ queryKey: ['customer-collection'] }),
        queryClient.invalidateQueries({ queryKey: ['payment-receipt', receiptId] }),
      ])
    },
  })

  const submitPayment = () => {
    setFormError('')
    if (!selectedCustomer || !selectedAgreement || !amountValid || !paymentMethod) {
      setFormError('Choose a customer, agreement, valid amount, and payment method.')
      return
    }
    const request: CollectionRequest = {
      agreement_id: selectedAgreement.agreement_id,
      amount_cents: paymentCents!,
      payment_method: paymentMethod,
      ...(reference.trim() ? { reference: reference.trim() } : {}),
    }
    const body = JSON.stringify(request)
    if (collectionRequestKey.current?.body !== body) {
      collectionRequestKey.current = { body, key: crypto.randomUUID() }
    }
    collectPayment.mutate({ request, idempotencyKey: collectionRequestKey.current.key })
  }

  const submitReversal = () => {
    if (!receiptId || reverseReason.trim().length < 2) return
    const body = JSON.stringify({ reason: reverseReason.trim() })
    if (reversalRequestKey.current?.body !== body) {
      reversalRequestKey.current = { body, key: crypto.randomUUID() }
    }
    reversePayment.mutate({
      paymentId: receiptId,
      reason: reverseReason.trim(),
      idempotencyKey: reversalRequestKey.current.key,
    })
  }

  const openReceipt = (id: string) => {
    reversalRequestKey.current = null
    reversePayment.reset()
    setReverseReason('')
    setReceiptId(id)
  }

  return (
    <div className="min-w-0 space-y-6 pb-24 md:pb-0">
      <PageHeading title="Payment collection" description="Find an active agreement, collect an amount, and issue a receipt." />

      {summary.isPending ? <Loading /> : summary.isError ? <ErrorMessage message={summary.error.message} /> : (
        <section className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-3">
          <SummaryCard label="Collected this month" value={formatLkr(Number(summary.data.collected_this_month_cents))} />
          <SummaryCard label="Payments this month" value={summary.data.payments_this_month.toLocaleString('en-LK')} />
          <SummaryCard label="Overdue installments" value={summary.data.overdue_installments.toLocaleString('en-LK')} />
        </section>
      )}

      <section className="min-w-0 rounded-[26px] border border-slate-200 bg-white p-4 shadow-sm md:p-6">
        <h3 className="text-xl font-extrabold text-slate-900">Collect a payment</h3>
        {!canRecordPayments && <p className="mt-3 rounded-xl bg-slate-50 p-3 text-sm text-slate-600">Your account has view-only access to collections.</p>}
        <div className="mt-4 grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
          <FormField label="Search customer" hint="Search by customer name or phone number.">
            <Combobox
              options={customerOptions}
              value={selectedCustomer?.id ?? null}
              onChange={(id) => {
                const customer = customerRows.find((row) => row.id === id)
                  ?? (selectedCustomer?.id === id ? selectedCustomer : null)
                if (!customer) return
                setSelectedCustomer(customer)
                setAgreementId('')
                setPaymentCents(null)
                collectionRequestKey.current = null
              }}
              onSearchChange={setCustomerSearch}
              ariaLabel="Search customer"
              placeholder="Select customer"
              searchPlaceholder="Type a name or phone"
              emptyMessage={customerSearch.trim().length < 2 ? 'Type at least two characters to search.' : 'No customers found.'}
            />
          </FormField>
          <FormField label="Active agreement">
            <Combobox
              options={agreementOptions}
              value={agreementId || null}
              onChange={(value) => {
                setAgreementId(value)
                setPaymentCents(null)
                collectionRequestKey.current = null
              }}
              ariaLabel="Active agreement"
              placeholder={selectedCustomer ? 'Select an agreement' : 'Choose a customer first'}
              searchPlaceholder="Search agreements"
              emptyMessage="No active agreements with a balance."
            />
          </FormField>
        </div>

        {customerSearchResults.isError && <div className="mt-4"><ErrorMessage message={customerSearchResults.error.message} /></div>}
        {collection.isPending && selectedCustomer && <div className="mt-4"><Loading /></div>}
        {collection.isError && <div className="mt-4"><ErrorMessage message={collection.error.message} /></div>}
        {selectedCustomer && collection.isSuccess && agreements.length === 0 && (
          <p className="mt-4 rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">This customer has no active agreement with an outstanding balance.</p>
        )}

        {selectedAgreement && (
          <>
            <div className="mt-5 flex min-w-0 flex-wrap items-start justify-between gap-3 rounded-2xl bg-blue-50 p-4">
              <div>
                <p className="font-bold text-slate-900">{selectedAgreement.agreement_reference}</p>
                <p className="mt-1 text-sm capitalize text-slate-600">{selectedAgreement.frequency} · {selectedAgreement.installment_count} installments</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-slate-500">Outstanding balance</p>
                <p className="text-lg font-extrabold text-slate-900">{formatLkr(outstandingCents)}</p>
              </div>
            </div>

            <div className="mt-4 w-full min-w-0 overflow-x-auto rounded-2xl border border-slate-200">
              <table className="w-full min-w-[700px] text-left text-sm">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-3 py-3 font-medium">No.</th>
                    <th className="px-3 py-3 font-medium">Due</th>
                    <th className="px-3 py-3 font-medium">Status</th>
                    <th className="px-3 py-3 text-right font-medium">Installment due</th>
                    <th className="px-3 py-3 text-right font-medium">Late fee</th>
                    <th className="px-3 py-3 text-right font-medium">Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedAgreement.installments.map((installment) => (
                    <tr key={installment.id} className="border-t border-slate-100">
                      <td className="px-3 py-3">{installment.installment_number}</td>
                      <td className="px-3 py-3 whitespace-nowrap">{dateOnly(installment.due_date)}</td>
                      <td className="px-3 py-3"><StatusBadge status={installment.status} /></td>
                      <td className="px-3 py-3 text-right whitespace-nowrap">{formatLkr(amountCents(installment.amount))}</td>
                      <td className="px-3 py-3 text-right whitespace-nowrap">{formatLkr(amountCents(installment.late_fee_due))}</td>
                      <td className="px-3 py-3 text-right font-semibold whitespace-nowrap">{formatLkr(amountCents(installment.outstanding_amount))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-5 grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
              <FormField label="Payment amount" error={paymentCents !== null && paymentCents > outstandingCents ? 'Amount exceeds this agreement’s outstanding balance.' : undefined}>
                <MoneyInput cents={paymentCents} onChange={(value) => { setPaymentCents(value); collectionRequestKey.current = null }} />
              </FormField>
              <FormField label="Payment method">
                <Combobox
                  options={methodOptions}
                  value={paymentMethod || null}
                  onChange={(value) => { setPaymentMethod(value); collectionRequestKey.current = null }}
                  ariaLabel="Payment method"
                  placeholder="Select payment method"
                  emptyMessage="No active payment methods are configured."
                />
              </FormField>
              <FormField label="Reference (optional)" hint="For example, bank transfer or transaction reference.">
                <input value={reference} maxLength={120} onChange={(event) => { setReference(event.target.value); collectionRequestKey.current = null }} className="field-input" />
              </FormField>
              <div className="rounded-2xl bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Remaining after this payment</p>
                <p className="mt-1 font-extrabold text-slate-900">
                  {paymentCents !== null && paymentCents <= outstandingCents
                    ? formatLkr(outstandingCents - paymentCents)
                    : formatLkr(outstandingCents)}
                </p>
              </div>
            </div>
            {allocationPreview.length > 0 && (
              <div className="mt-4 rounded-2xl border border-blue-100 bg-blue-50/50 p-4">
                <h4 className="font-bold text-slate-900">Allocation preview</h4>
                <div className="mt-2 space-y-1">
                  {(['late_fee', 'interest', 'principal'] as const).map((type) => {
                    const cents = allocationPreview
                      .filter((allocation) => allocation.type === type)
                      .reduce((sum, allocation) => sum + allocation.amountCents, 0)
                    return cents > 0 ? <SummaryLine key={type} label={allocationLabel(type)} cents={cents} /> : null
                  })}
                </div>
                <div className="mt-3 w-full min-w-0 overflow-x-auto">
                  <table className="w-full min-w-[320px] text-left text-xs">
                    <thead><tr className="text-slate-500"><th className="py-2 pr-3 font-medium">Installment</th><th className="py-2 pr-3 font-medium">Type</th><th className="py-2 text-right font-medium">Allocated</th></tr></thead>
                    <tbody>{allocationPreview.map((allocation, index) => {
                      const installment = selectedAgreement.installments.find((row) => row.id === allocation.installmentId)
                      return (
                        <tr key={`${allocation.installmentId}-${allocation.type}-${index}`} className="border-t border-blue-100">
                          <td className="py-2 pr-3">#{installment?.installment_number ?? '—'}</td>
                          <td className="py-2 pr-3">{allocationLabel(allocation.type)}</td>
                          <td className="py-2 text-right">{formatLkr(allocation.amountCents)}</td>
                        </tr>
                      )
                    })}</tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

        {methods.isError && <div className="mt-4"><ErrorMessage message={methods.error.message} /></div>}
        {formError && <div className="mt-4"><ErrorMessage message={formError} /></div>}
        {collectPayment.isError && <div className="mt-4"><ErrorMessage message={collectPayment.error.message} /></div>}

        <div className="sticky bottom-2 z-20 mt-5 flex justify-end rounded-2xl border border-slate-200 bg-white/95 p-2 shadow-lg backdrop-blur md:static md:border-0 md:bg-transparent md:p-0 md:shadow-none md:backdrop-blur-0">
          <button
            type="button"
            onClick={submitPayment}
            disabled={!canRecordPayments || !selectedAgreement || !amountValid || !paymentMethod || collectPayment.isPending || methods.isPending}
            className="min-h-12 w-full rounded-2xl bg-[#247BDB] px-5 py-3 text-base font-bold text-white disabled:cursor-not-allowed disabled:opacity-50 md:w-auto"
          >
            {collectPayment.isPending ? 'Recording payment…' : 'Confirm payment'}
          </button>
        </div>
      </section>

      <section className="min-w-0 rounded-[26px] border border-slate-200 bg-white p-4 shadow-sm md:p-6">
        <div className="mb-4 flex min-w-0 items-center justify-between gap-3">
          <div>
            <h3 className="text-xl font-extrabold text-slate-900">Recent payments</h3>
            <p className="mt-1 text-sm text-slate-500">Payment records are immutable; owners can reverse a payment with a reason.</p>
          </div>
        </div>
        {payments.isPending ? <Loading /> : payments.isError ? <ErrorMessage message={payments.error.message} /> : history.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 px-5 py-10 text-center">
            <ReceiptText className="mx-auto text-slate-400" size={28} aria-hidden="true" />
            <p className="mt-3 font-semibold text-slate-800">No payment records yet</p>
            <p className="mt-1 text-sm text-slate-500">Collected payments will appear here.</p>
          </div>
        ) : (
          <>
            <div className="w-full min-w-0 overflow-x-auto">
              <table className="w-full min-w-[700px] text-left text-sm">
                <thead className="border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="py-3 pr-4 font-medium">Receipt</th>
                    <th className="py-3 pr-4 font-medium">Customer</th>
                    <th className="py-3 pr-4 font-medium">Date</th>
                    <th className="py-3 pr-4 font-medium">Method</th>
                    <th className="py-3 pr-4 text-right font-medium">Amount</th>
                    <th className="py-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((payment) => (
                    <tr key={payment.id} className="border-b border-slate-100 last:border-0">
                      <td className="py-3 pr-4">
                        <button type="button" onClick={() => openReceipt(payment.id)} className="font-semibold text-[#247BDB] hover:underline">{payment.receipt_number}</button>
                      </td>
                      <td className="py-3 pr-4">{payment.customer?.full_name ?? 'Customer unavailable'}</td>
                      <td className="py-3 pr-4 whitespace-nowrap text-slate-600">{formatDate(payment.collected_at)}</td>
                      <td className="py-3 pr-4">{paymentMethods.find((method) => method.key === payment.payment_method)?.name ?? payment.payment_method}</td>
                      <td className="py-3 pr-4 text-right font-semibold">{formatLkr(amountCents(payment.amount))}</td>
                      <td className="py-3"><StatusBadge status={payment.reversed_at ? 'reversed' : 'recorded'} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex min-w-0 items-center justify-between gap-3">
              <p className="text-sm text-slate-500">{payments.data?.total ?? 0} payment(s) · page {page} of {totalPages}</p>
              <div className="flex gap-2">
                <button type="button" aria-label="Previous payment page" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="soft-button min-h-11 disabled:opacity-40"><ChevronLeft size={18} /></button>
                <button type="button" aria-label="Next payment page" disabled={page >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} className="soft-button min-h-11 disabled:opacity-40"><ChevronRight size={18} /></button>
              </div>
            </div>
          </>
        )}
      </section>

      <Modal
        open={receiptId !== null}
        onClose={() => {
          setReceiptId(null)
          setReverseReason('')
          reversePayment.reset()
        }}
        title={receiptQuery.data?.receipt_number ?? 'Payment receipt'}
        description={receiptQuery.data ? formatDate(receiptQuery.data.collected_at) : 'Loading receipt…'}
      >
        {receiptQuery.isPending ? <Loading /> : receiptQuery.isError ? <ErrorMessage message={receiptQuery.error.message} /> : receiptQuery.data ? (
          <div className="min-w-0">
            {canPrintReceipts && (
              <div className="not-print mb-4 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <SegmentedControl value={thermal ? 'thermal' : 'a4'} options={receiptLayouts} onChange={(value) => setThermal(value === 'thermal')} ariaLabel="Receipt paper layout" className="max-w-sm" />
                <div className="flex gap-2">
                  <button type="button" onClick={() => printReceipt(thermal)} className="soft-button inline-flex min-h-11 items-center gap-2"><Printer size={16} /> Print</button>
                  <button type="button" onClick={() => downloadReceiptPdf(receiptQuery.data!, thermal)} className="soft-button inline-flex min-h-11 items-center gap-2"><ArrowDownToLine size={16} /> PDF</button>
                </div>
              </div>
            )}
            <ReceiptDocument receipt={receiptQuery.data} thermal={thermal} />
            {receiptQuery.data.reversed_at ? (
              <p className="not-print mt-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                Reversed on {formatDate(receiptQuery.data.reversed_at)}. Reason: {receiptQuery.data.reversal_reason}
              </p>
            ) : isOwner ? (
              <div className="not-print mt-5 rounded-2xl border border-red-200 p-4">
                <h3 className="font-bold text-slate-900">Reverse this payment</h3>
                <p className="mt-1 text-sm text-slate-600">This is permanent in the ledger and requires a reason. The payment record will not be deleted.</p>
                <div className="mt-3">
                  <FormField label="Reason for reversal">
                    <textarea value={reverseReason} maxLength={500} onChange={(event) => { setReverseReason(event.target.value); reversalRequestKey.current = null }} className="field-input min-h-24 resize-y" />
                  </FormField>
                </div>
                {reversePayment.isError && <div className="mt-3"><ErrorMessage message={reversePayment.error.message} /></div>}
                {reversePayment.isSuccess && <p role="status" className="mt-3 text-sm text-green-700">Payment reversed and allocation ledger updated.</p>}
                <button type="button" onClick={submitReversal} disabled={reverseReason.trim().length < 2 || reversePayment.isPending} className="mt-3 min-h-11 rounded-2xl border border-red-300 px-4 py-2 text-sm font-bold text-red-700 disabled:opacity-50">
                  {reversePayment.isPending ? 'Reversing…' : 'Reverse payment'}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  )
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass-panel rounded-[24px] p-5">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-extrabold tracking-tight text-slate-900">{value}</p>
    </div>
  )
}

function allocationLabel(type: PaymentAllocationType): string {
  return type === 'late_fee' ? 'Late fee' : type === 'interest' ? 'Interest' : 'Principal'
}

function SummaryLine({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 text-sm text-slate-600">
      <span>{label}</span>
      <span className="shrink-0 font-semibold text-slate-900">{formatLkr(cents)}</span>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const tone = status === 'paid' || status === 'recorded'
    ? 'success'
    : status === 'overdue' || status === 'reversed'
      ? 'danger'
      : 'warning'
  return <span className={`status-badge ${tone} capitalize`}>{status}</span>
}

function ReceiptDocument({ receipt, thermal }: { receipt: Receipt; thermal: boolean }) {
  const shopName = import.meta.env.VITE_SHOP_NAME?.trim() || 'Acceseries'
  const pair = (label: string, value: string) => (
    <div className="flex min-w-0 justify-between gap-3 py-1.5">
      <dt className="text-slate-500">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-slate-900">{value}</dd>
    </div>
  )
  return (
    <article className={`receipt-print min-w-0 bg-white text-slate-900 ${thermal ? 'thermal-receipt' : ''}`}>
      <div className={`mx-auto min-w-0 ${thermal ? 'max-w-[72mm] p-2' : 'max-w-2xl p-4 md:p-8'}`}>
        <header className="border-b border-slate-200 pb-4 text-center">
          <h2 className={thermal ? 'text-lg font-extrabold' : 'text-3xl font-extrabold'}>{shopName}</h2>
          <p className="mt-1 text-sm font-semibold uppercase tracking-widest text-slate-500">Payment receipt</p>
        </header>
        <dl className="border-b border-slate-200 py-3 text-sm">
          {pair('Receipt number', receipt.receipt_number)}
          {pair('Customer', receipt.customer?.full_name ?? 'Customer unavailable')}
          {receipt.customer?.phone && pair('Phone', receipt.customer.phone)}
          {pair('Date', formatDate(receipt.collected_at))}
          {pair('Collected by', receipt.collected_by)}
          {receipt.agreement_reference && pair('Agreement', receipt.agreement_reference)}
          {pair('Payment method', receipt.payment_method)}
          {receipt.reference && pair('Reference', receipt.reference)}
        </dl>
        <dl className="border-b border-slate-200 py-3 text-sm">
          {pair('Amount received', formatLkr(amountCents(receipt.amount)))}
          {pair('Principal', formatLkr(amountCents(receipt.allocations.principal)))}
          {pair('Interest', formatLkr(amountCents(receipt.allocations.interest)))}
          {pair('Late fee', formatLkr(amountCents(receipt.allocations.late_fee)))}
          {pair('Remaining balance', formatLkr(amountCents(receipt.remaining_balance)))}
        </dl>
        {receipt.reversed_at && (
          <p className="mt-3 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">
            Reversed · {receipt.reversal_reason}
          </p>
        )}
        <footer className="pt-4 text-center text-xs text-slate-500">Thank you.</footer>
      </div>
    </article>
  )
}
