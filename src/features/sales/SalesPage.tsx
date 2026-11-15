import { jsPDF } from 'jspdf'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDownToLine, ChevronLeft, ChevronRight, Printer, Plus, ReceiptText, Search, X } from 'lucide-react'
import { useMemo, useRef, useState, type FormEvent } from 'react'
import { Combobox, type ComboboxOption } from '../../components/ui/Combobox'
import { FormField } from '../../components/ui/FormField'
import { Modal } from '../../components/ui/Modal'
import { MoneyInput } from '../../components/ui/MoneyInput'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { apiRequest } from '../../lib/api'
import {
  calculateAgreement,
  generateSchedule,
  MAX_INSTALLMENT_COUNT,
  type PaymentFrequency,
} from '../../lib/installments/calculations'
import { databaseDecimalToCents, formatLkr } from '../../shared/business'
import { ErrorMessage, Loading, PageHeading } from '../dashboard/DashboardPage'
import { findSaleStockIssues } from './salesMath'

type Customer = { id: string; full_name: string; phone: string }
type Product = {
  id: string
  name: string
  category: string
  price: string
  stock_quantity: number
  status?: string
}
type SaleLineInput = { productId: string; quantity: number }
type SaleLine = {
  id: string
  product_id: string | null
  product_name: string
  unit_price: string | number
  quantity: number
  line_total: string | number
}
type SalePayment = { amount: string | number; payment_method: string; collected_at: string }
type SaleAgreement = {
  frequency: PaymentFrequency
  installment_count: number
  fixed_interest: string | number
  total_repayment: string | number
}
type Sale = {
  id: string
  invoice_number: string
  customer_id: string | null
  total_amount: string | number
  payment_type: 'cash' | 'installment'
  payment_method: 'cash' | 'bank_transfer' | 'card'
  discount_amount: string | number
  status: 'paid' | 'pending' | 'processing'
  agreement_id: string | null
  created_at: string
  customer: { full_name: string; phone: string } | null
  items: SaleLine[]
  payments: SalePayment[]
  agreement: SaleAgreement | null
}
type SalePage = { items: Sale[]; total: number; page: number; page_size: number }
type SaleSummary = {
  cash_sales_this_week_cents: string
  average_order_value_cents: string
  sales_count: number
}
type AgreementDefaults = {
  default_daily_interest: string
  default_weekly_interest: string
  default_monthly_interest: string
}
type ApprovedDiscount = {
  id: string
  discount_type: 'product' | 'customer'
  amount_cents: number
  reason: string
  customer_id: string | null
}
type SaleRequest = {
  customer_id: string | null
  payment_type: 'cash' | 'installment'
  discount_cents: number
  discount_type: 'product' | 'customer' | null
  discount_request_id: string | null
  payment_method: 'cash' | 'bank_transfer' | 'card'
  items: Array<{ product_id: string; quantity: number }>
} & (
  | { allow_negative_stock: false }
  | {
      down_payment_cents: number
      fixed_interest_cents: number
      frequency: PaymentFrequency
      installment_count: number
      first_due_date: string
    }
)

const EMPTY_CUSTOMERS: Customer[] = []
const EMPTY_PRODUCTS: Product[] = []
const EMPTY_SALES: Sale[] = []
const SALE_PAGE_SIZE = 20
const paymentOptions = [
  { value: 'cash', label: 'Cash' },
  { value: 'installment', label: 'Installment' },
] as const
const frequencies = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
] as const
const paymentMethods = [
  { value: 'cash', label: 'Cash' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'card', label: 'Card' },
] as const
const walkIn = '__walk_in__'

function localDateInput(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function moneyCents(value: string | number): number {
  return databaseDecimalToCents(String(value))
}

function dateLabel(value: string): string {
  return new Date(value).toLocaleString('en-LK', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function interestDefault(defaults: AgreementDefaults | undefined, frequency: PaymentFrequency): number {
  if (!defaults) return 0
  const value = frequency === 'daily'
    ? defaults.default_daily_interest
    : frequency === 'weekly'
      ? defaults.default_weekly_interest
      : defaults.default_monthly_interest
  return moneyCents(value)
}

function saleSearchParams(params: {
  page: number
  search: string
  from: string
  to: string
  status: string
}): string {
  const query = new URLSearchParams({
    page: String(params.page),
    page_size: String(SALE_PAGE_SIZE),
    status: params.status,
  })
  if (params.search.trim()) query.set('search', params.search.trim())
  if (params.from) query.set('from', params.from)
  if (params.to) query.set('to', params.to)
  return query.toString()
}

function pdfLkr(cents: number): string {
  return `LKR ${new Intl.NumberFormat('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100)}`
}

function downloadInvoicePdf(sale: Sale, thermal: boolean): void {
  const height = Math.max(130, 105 + sale.items.length * 17)
  const document = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: thermal ? [80, height] : 'a4',
  })
  const pageWidth = document.internal.pageSize.getWidth()
  const left = thermal ? 5 : 16
  const right = pageWidth - left
  let y = thermal ? 10 : 20
  const shopName = import.meta.env.VITE_SHOP_NAME?.trim() || 'Acceseries'
  const drawRule = () => {
    document.setDrawColor(210, 218, 228)
    document.line(left, y, right, y)
    y += 6
  }
  const addPair = (label: string, value: string) => {
    document.setFont('helvetica', 'normal')
    document.text(label, left, y)
    document.setFont('helvetica', 'bold')
    document.text(value, right, y, { align: 'right' })
    y += 6
  }

  document.setFont('helvetica', 'bold')
  document.setFontSize(thermal ? 15 : 21)
  document.text(shopName, pageWidth / 2, y, { align: 'center' })
  y += thermal ? 8 : 11
  document.setFontSize(thermal ? 10 : 12)
  document.text('SALES INVOICE', pageWidth / 2, y, { align: 'center' })
  y += 7
  drawRule()
  document.setFontSize(thermal ? 9 : 10)
  addPair('Invoice', sale.invoice_number)
  addPair('Date', dateLabel(sale.created_at))
  addPair('Customer', sale.customer?.full_name ?? 'Walk-in')
  if (sale.customer?.phone) addPair('Phone', sale.customer.phone)
  addPair('Payment', sale.payment_type === 'cash' ? sale.payment_method.replace('_', ' ') : 'Installment')
  drawRule()

  document.setFont('helvetica', 'bold')
  document.text('Item', left, y)
  document.text('Amount', right, y, { align: 'right' })
  y += 6
  document.setFont('helvetica', 'normal')
  for (const item of sale.items) {
    const description = `${item.product_name}  x${item.quantity}`
    const lines = document.splitTextToSize(description, thermal ? pageWidth - left * 2 - 20 : pageWidth - left * 2 - 48)
    document.text(lines, left, y)
    document.text(pdfLkr(moneyCents(item.line_total)), right, y, { align: 'right' })
    y += Math.max(6, lines.length * 4.5)
  }
  drawRule()
  const subtotalCents = sale.items.reduce((sum, item) => sum + moneyCents(item.line_total), 0)
  addPair('Subtotal', pdfLkr(subtotalCents))
  if (moneyCents(sale.discount_amount) > 0) addPair('Discount', `-${pdfLkr(moneyCents(sale.discount_amount))}`)
  addPair('Total', pdfLkr(moneyCents(sale.total_amount)))
  if (sale.payment_type === 'installment' && sale.agreement) {
    addPair('Fixed interest', pdfLkr(moneyCents(sale.agreement.fixed_interest)))
    addPair('Repayment total', pdfLkr(moneyCents(sale.agreement.total_repayment)))
    addPair('Terms', `${sale.agreement.installment_count} ${sale.agreement.frequency}`)
  }
  const paidCents = sale.payments.reduce((sum, payment) => sum + moneyCents(payment.amount), 0)
  if (paidCents > 0) addPair(sale.payment_type === 'installment' ? 'Down payment' : 'Paid', pdfLkr(paidCents))
  y += 4
  document.setFont('helvetica', 'normal')
  document.text('Thank you for your purchase.', pageWidth / 2, y, { align: 'center' })
  document.save(`${sale.invoice_number}.pdf`)
}

function printInvoice(thermal: boolean): void {
  document.body.classList.add('invoice-printing')
  document.body.classList.toggle('thermal-printing', thermal)
  const cleanup = () => {
    document.body.classList.remove('invoice-printing', 'thermal-printing')
    window.removeEventListener('afterprint', cleanup)
  }
  window.addEventListener('afterprint', cleanup)
  window.print()
}

export function SalesPage({ search: globalSearch = '' }: { search?: string }) {
  const queryClient = useQueryClient()
  const [saleOpen, setSaleOpen] = useState(false)
  const [paymentType, setPaymentType] = useState<'cash' | 'installment'>('cash')
  const [customerId, setCustomerId] = useState(walkIn)
  const [lines, setLines] = useState<SaleLineInput[]>([{ productId: '', quantity: 1 }])
  const [discountCents, setDiscountCents] = useState<number | null>(0)
  const [discountRequestId, setDiscountRequestId] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'bank_transfer' | 'card'>('cash')
  const [frequency, setFrequency] = useState<PaymentFrequency>('monthly')
  const [installmentCount, setInstallmentCount] = useState(1)
  const [downPaymentCents, setDownPaymentCents] = useState<number | null>(0)
  const [interestEdited, setInterestEdited] = useState(false)
  const [interestDraft, setInterestDraft] = useState<number | null>(null)
  const [firstDueDate, setFirstDueDate] = useState(localDateInput)
  const [formError, setFormError] = useState('')
  const [searchText, setSearchText] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [page, setPage] = useState(1)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [thermal, setThermal] = useState(false)
  const requestKey = useRef<{ body: string; key: string } | null>(null)

  const customers = useQuery({
    queryKey: ['customers'],
    queryFn: () => apiRequest<Customer[]>('/api/customers'),
  })
  const products = useQuery({
    queryKey: ['products'],
    queryFn: () => apiRequest<Product[]>('/api/products'),
  })
  const defaults = useQuery({
    queryKey: ['agreement-defaults'],
    queryFn: () => apiRequest<AgreementDefaults>('/api/agreement-defaults'),
  })
  const availableDiscounts = useQuery({
    queryKey: ['available-discounts', customerId],
    queryFn: () => apiRequest<ApprovedDiscount[]>(
      `/api/discounts/available${customerId !== walkIn ? `?customer_id=${encodeURIComponent(customerId)}` : ''}`,
    ),
  })
  const effectiveSearch = [globalSearch, searchText].filter(Boolean).join(' ').trim()
  const sales = useQuery({
    queryKey: ['sales', page, effectiveSearch, fromDate, toDate, statusFilter],
    queryFn: () => apiRequest<SalePage>(`/api/sales?${saleSearchParams({
      page,
      search: effectiveSearch,
      from: fromDate,
      to: toDate,
      status: statusFilter,
    })}`),
  })
  const summary = useQuery({
    queryKey: ['sales-summary'],
    queryFn: () => apiRequest<SaleSummary>('/api/sales/summary'),
  })
  const detail = useQuery({
    queryKey: ['sale', detailId],
    queryFn: () => apiRequest<Sale>(`/api/sales/${detailId}`),
    enabled: detailId !== null,
  })
  const customerRows = customers.data ?? EMPTY_CUSTOMERS
  const productRows = products.data ?? EMPTY_PRODUCTS
  const discountRows = availableDiscounts.data ?? []
  const selectedDiscount = discountRows.find((discount) => discount.id === discountRequestId)
  const discountOptions: ComboboxOption<string>[] = discountRows.map((discount) => ({
    value: discount.id,
    label: `${discount.discount_type === 'product' ? 'Product' : 'Customer'} · ${formatLkr(discount.amount_cents)} · ${discount.reason}`,
  }))
  const fixedInterestCents = interestEdited
    ? interestDraft
    : interestDefault(defaults.data, frequency)

  const saleCalculation = useMemo(() => {
    if (lines.length === 0 || lines.some((line) => !line.productId)) return null
    const productsById = new Map(productRows.map((product) => [product.id, product]))
    if (lines.some((line) => !productsById.has(line.productId))) return null
    try {
      return calculateAgreement({
        items: lines.map((line) => ({
          unitPriceCents: moneyCents(productsById.get(line.productId)!.price),
          quantity: line.quantity,
        })),
        productDiscount: discountCents ?? 0,
        customerDiscount: 0,
        downPayment: paymentType === 'installment' ? downPaymentCents ?? 0 : 0,
        fixedInterest: paymentType === 'installment' ? fixedInterestCents ?? 0 : 0,
        frequency: paymentType === 'installment' ? frequency : 'monthly',
        installmentCount: paymentType === 'installment' ? installmentCount : 1,
        firstDueDate,
      })
    } catch {
      return null
    }
  }, [discountCents, downPaymentCents, firstDueDate, fixedInterestCents, frequency, installmentCount, lines, paymentType, productRows])
  const scheduleDates = useMemo(() => {
    if (paymentType !== 'installment' || !saleCalculation || saleCalculation.installmentAmounts.length === 0) return []
    try {
      return generateSchedule(firstDueDate, frequency, saleCalculation.installmentAmounts.length)
    } catch {
      return []
    }
  }, [firstDueDate, frequency, paymentType, saleCalculation])

  const stockIssues = useMemo(() => findSaleStockIssues(lines.map((line) => ({
    productId: line.productId,
    quantity: line.quantity,
  })), productRows.map((product) => ({
    id: product.id,
    name: product.name,
    stock_quantity: product.stock_quantity,
  }))), [lines, productRows])
  const stockValid = stockIssues.length === 0

  const createSale = useMutation({
    mutationFn: ({ request, idempotencyKey }: { request: SaleRequest; idempotencyKey: string }) =>
      apiRequest<Sale>('/api/sales', {
        method: 'POST',
        body: JSON.stringify(request),
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    onSuccess: async (created) => {
      requestKey.current = null
      setSaleOpen(false)
      setFormError('')
      setDetailId(created.id)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['sales'] }),
        queryClient.invalidateQueries({ queryKey: ['sales-summary'] }),
        queryClient.invalidateQueries({ queryKey: ['products'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['customers'] }),
        queryClient.invalidateQueries({ queryKey: ['agreements'] }),
        queryClient.invalidateQueries({ queryKey: ['available-discounts'] }),
      ])
    },
  })

  const customerOptions: ComboboxOption<string>[] = useMemo(() => [
    ...(paymentType === 'cash' ? [{ value: walkIn, label: 'Walk-in customer' }] : []),
    ...customerRows.map((customer) => ({
      value: customer.id,
      label: `${customer.full_name} · ${customer.phone}`,
    })),
  ], [customerRows, paymentType])
  const productOptions: ComboboxOption<string>[] = useMemo(() =>
    productRows.map((product) => ({
      value: product.id,
      label: `${product.name} · ${product.category} · ${product.stock_quantity} in stock`,
    })),
  [productRows])

  const openNewSale = () => {
    setPaymentType('cash')
    setCustomerId(walkIn)
    setLines([{ productId: '', quantity: 1 }])
    setDiscountCents(0)
    setDiscountRequestId('')
    setPaymentMethod('cash')
    setFrequency('monthly')
    setInstallmentCount(1)
    setDownPaymentCents(0)
    setInterestEdited(false)
    setInterestDraft(null)
    setFirstDueDate(localDateInput())
    setFormError('')
    createSale.reset()
    requestKey.current = null
    setSaleOpen(true)
  }

  const setLine = (index: number, patch: Partial<SaleLineInput>) => {
    setLines((current) => current.map((line, lineIndex) =>
      lineIndex === index ? { ...line, ...patch } : line,
    ))
  }

  const submitSale = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormError('')
    if (!saleCalculation) {
      setFormError('Choose a product for every line and check the sale amounts.')
      return
    }
    if (!stockValid) {
      setFormError('Requested quantity exceeds available stock. Refresh inventory and try again.')
      return
    }
    if (discountCents === null || (paymentType === 'installment' &&
      (downPaymentCents === null || fixedInterestCents === null || customerId === walkIn))) {
      setFormError('Complete the required customer and payment fields.')
      return
    }
    if (discountCents > 0 && !selectedDiscount) {
      setFormError('Choose an approved, unused discount request.')
      return
    }
    if (paymentType === 'installment' &&
      (!Number.isSafeInteger(installmentCount) || installmentCount < 1 || installmentCount > MAX_INSTALLMENT_COUNT)) {
      setFormError(`Installment count must be between 1 and ${MAX_INSTALLMENT_COUNT}.`)
      return
    }

    const common = {
      customer_id: customerId === walkIn ? null : customerId,
      payment_type: paymentType,
      discount_cents: discountCents,
      discount_type: selectedDiscount?.discount_type ?? null,
      discount_request_id: selectedDiscount?.id ?? null,
      payment_method: paymentMethod,
      items: lines.map((line) => ({ product_id: line.productId, quantity: line.quantity })),
    }
    const request: SaleRequest = paymentType === 'cash'
      ? { ...common, payment_type: 'cash', allow_negative_stock: false }
      : {
          ...common,
          customer_id: customerId,
          payment_type: 'installment',
          down_payment_cents: downPaymentCents ?? 0,
          fixed_interest_cents: fixedInterestCents ?? 0,
          frequency,
          installment_count: installmentCount,
          first_due_date: firstDueDate,
        }
    const body = JSON.stringify(request)
    if (requestKey.current?.body !== body) requestKey.current = { body, key: crypto.randomUUID() }
    createSale.mutate({ request, idempotencyKey: requestKey.current.key })
  }

  const rows = sales.data?.items ?? EMPTY_SALES
  const totalPages = Math.max(1, Math.ceil((sales.data?.total ?? 0) / SALE_PAGE_SIZE))
  const selectedSale = detail.data

  return (
    <div className="min-w-0 space-y-6">
      <PageHeading title="Sales" description="Create sales, review invoices, and track real inventory-backed transactions." />
      {summary.isPending ? <Loading /> : summary.isError ? <ErrorMessage message={summary.error.message} /> : (
        <section className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-3">
          <SummaryCard label="Cash sales this week" value={formatLkr(Number(summary.data.cash_sales_this_week_cents))} />
          <SummaryCard label="Average order value" value={formatLkr(Number(summary.data.average_order_value_cents))} />
          <SummaryCard label="Total sales" value={summary.data.sales_count.toLocaleString('en-LK')} />
        </section>
      )}

      <section className="min-w-0 rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm md:p-5">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <h3 className="text-xl font-extrabold text-slate-900">Sales history</h3>
            <button type="button" onClick={openNewSale} className="inline-flex items-center gap-2 rounded-2xl bg-[#247BDB] px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700">
              <Plus size={16} aria-hidden="true" /> New sale
            </button>
          </div>
          <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-4">
            <label className="relative min-w-0 md:col-span-2">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={searchText} onChange={(event) => { setSearchText(event.target.value); setPage(1) }} placeholder="Search invoice, customer, product" className="field-input pl-9" />
            </label>
            <input aria-label="Sales from date" type="date" value={fromDate} onChange={(event) => { setFromDate(event.target.value); setPage(1) }} className="field-input" />
            <div className="flex min-w-0 gap-2">
              <input aria-label="Sales to date" type="date" value={toDate} onChange={(event) => { setToDate(event.target.value); setPage(1) }} className="field-input" />
              <select aria-label="Filter sales by status" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1) }} className="field-input max-w-36">
                <option value="all">All status</option>
                <option value="paid">Paid</option>
                <option value="pending">Pending</option>
                <option value="processing">Processing</option>
              </select>
            </div>
          </div>
          {sales.isPending ? <Loading /> : sales.isError ? <ErrorMessage message={sales.error.message} /> : rows.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 px-5 py-10 text-center">
              <ReceiptText className="mx-auto text-slate-400" size={28} aria-hidden="true" />
              <p className="mt-3 font-semibold text-slate-800">No sales found</p>
              <p className="mt-1 text-sm text-slate-500">Sales will appear here after they are recorded.</p>
            </div>
          ) : (
            <>
              <div className="w-full min-w-0 overflow-x-auto">
                <table className="min-w-[760px] w-full text-left text-sm">
                  <thead><tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-3 pr-4 font-medium">Invoice</th>
                    <th className="py-3 pr-4 font-medium">Customer</th>
                    <th className="py-3 pr-4 font-medium">Date</th>
                    <th className="py-3 pr-4 font-medium">Type</th>
                    <th className="py-3 pr-4 font-medium">Status</th>
                    <th className="py-3 pr-4 text-right font-medium">Total</th>
                  </tr></thead>
                  <tbody>{rows.map((sale) => (
                    <tr key={sale.id} className="border-b border-slate-100 last:border-0">
                      <td className="py-3 pr-4">
                        <button type="button" onClick={() => setDetailId(sale.id)} className="font-semibold text-[#247BDB] hover:underline">{sale.invoice_number}</button>
                      </td>
                      <td className="py-3 pr-4">{sale.customer?.full_name ?? 'Walk-in'}</td>
                      <td className="py-3 pr-4 text-slate-600">{dateLabel(sale.created_at)}</td>
                      <td className="py-3 pr-4 capitalize">{sale.payment_type}</td>
                      <td className="py-3 pr-4"><span className={`status-badge ${sale.status === 'paid' ? 'success' : 'warning'}`}>{sale.status}</span></td>
                      <td className="py-3 pr-4 text-right font-semibold">{formatLkr(moneyCents(sale.total_amount))}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <div className="flex min-w-0 items-center justify-between gap-3">
                <p className="text-sm text-slate-500">{sales.data?.total ?? 0} sale(s) · page {page} of {totalPages}</p>
                <div className="flex gap-2">
                  <button type="button" aria-label="Previous sales page" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="soft-button disabled:opacity-40"><ChevronLeft size={18} /></button>
                  <button type="button" aria-label="Next sales page" disabled={page >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} className="soft-button disabled:opacity-40"><ChevronRight size={18} /></button>
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      <Modal
        open={saleOpen}
        onClose={() => setSaleOpen(false)}
        title="New sale"
        description="Select products and payment terms. Stock is checked again when the sale is saved."
        footer={
          <div className="flex min-w-0 justify-end gap-3">
            <button type="button" onClick={() => setSaleOpen(false)} className="soft-button">Cancel</button>
            <button form="sale-form" type="submit" disabled={createSale.isPending || !saleCalculation || !stockValid || products.isPending || (paymentType === 'installment' && defaults.isPending)} className="rounded-2xl bg-[#247BDB] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">
              {createSale.isPending ? 'Saving…' : 'Confirm sale'}
            </button>
          </div>
        }
      >
        <form id="sale-form" onSubmit={submitSale} className="min-w-0 space-y-5">
          <SegmentedControl
            value={paymentType}
            options={paymentOptions}
            onChange={(value) => {
              setPaymentType(value)
              setInterestEdited(false)
              setInterestDraft(null)
            }}
            ariaLabel="Payment type"
          />
          <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
            <FormField label="Customer" hint={paymentType === 'cash' ? 'Choose Walk-in for a cash sale without a customer record.' : undefined}>
              <Combobox
                options={customerOptions}
                value={customerOptions.some((option) => option.value === customerId) ? customerId : null}
                onChange={(value) => {
                  setCustomerId(value)
                  setDiscountRequestId('')
                  setDiscountCents(0)
                }}
                ariaLabel="Customer"
                placeholder="Select customer"
                searchPlaceholder="Search name or phone"
              />
            </FormField>
            <FormField label="Payment method">
              <Combobox
                options={paymentMethods}
                value={paymentMethod}
                onChange={setPaymentMethod}
                ariaLabel="Payment method"
              />
            </FormField>
          </div>

          <section className="min-w-0 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-bold text-slate-900">Products</h3>
              <button type="button" onClick={() => setLines((current) => [...current, { productId: '', quantity: 1 }])} className="soft-button inline-flex items-center gap-2"><Plus size={15} /> Add line</button>
            </div>
            {customers.isError && <ErrorMessage message={customers.error.message} />}
            {products.isError && <ErrorMessage message={products.error.message} />}
            {lines.map((line, index) => {
              const product = productRows.find((row) => row.id === line.productId)
              const lineTotalBig = product ? BigInt(moneyCents(product.price)) * BigInt(line.quantity) : 0n
              const lineTotal = lineTotalBig <= 999_999_999_999n ? Number(lineTotalBig) : null
              const stockIssue = stockIssues.find((issue) => issue.productId === line.productId)
              const exceedsStock = stockIssue !== undefined
              return (
                <div key={`${index}-${line.productId}`} className="grid min-w-0 grid-cols-1 items-end gap-3 rounded-2xl border border-slate-200 p-3 md:grid-cols-[minmax(0,1fr)_112px_130px_40px]">
                  <div className="min-w-0">
                    <FormField label={`Product ${index + 1}`}>
                      <Combobox options={productOptions} value={line.productId || null} onChange={(value) => setLine(index, { productId: value })} ariaLabel={`Product ${index + 1}`} placeholder="Select product" searchPlaceholder="Search products" />
                    </FormField>
                    {product && <p className={`mt-1 text-xs ${exceedsStock ? 'text-red-600' : 'text-slate-500'}`}>{product.stock_quantity} in stock · {formatLkr(moneyCents(product.price))} each</p>}
                  </div>
                  <FormField label="Qty" error={exceedsStock ? `Only ${stockIssue?.available ?? 0} available.` : undefined}>
                    <input
                      type="number"
                      min={1}
                      max={product?.stock_quantity ?? 2147483647}
                      step={1}
                      value={line.quantity}
                      onChange={(event) => {
                        const quantity = Number(event.target.value)
                        setLine(index, {
                          quantity: Number.isSafeInteger(quantity)
                            ? Math.max(1, Math.min(2_147_483_647, quantity))
                            : 1,
                        })
                      }}
                      className="field-input"
                    />
                  </FormField>
                  <div className="pb-3 text-right">
                    <p className="text-xs text-slate-500">Line total</p>
                    <p className="font-semibold text-slate-900">{lineTotal === null ? 'Amount exceeds limit' : formatLkr(lineTotal)}</p>
                  </div>
                  <button type="button" aria-label={`Remove product ${index + 1}`} disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((_, lineIndex) => lineIndex !== index))} className="mb-2 rounded-xl p-2 text-slate-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-30"><X size={17} /></button>
                </div>
              )
            })}
          </section>

          <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
            <FormField label="Approved discount" hint="Discounts must be approved and can be used once.">
              <Combobox
                options={discountOptions}
                value={selectedDiscount?.id ?? null}
                onChange={(id) => {
                  const discount = discountRows.find((row) => row.id === id)
                  setDiscountRequestId(id ?? '')
                  setDiscountCents(discount?.amount_cents ?? 0)
                }}
                ariaLabel="Approved discount"
                placeholder="No discount"
                searchPlaceholder="Search approved discounts…"
              />
            </FormField>
            {availableDiscounts.isError && <p role="alert" className="mt-1 text-xs text-red-700">{availableDiscounts.error.message}</p>}
            <div className="rounded-2xl bg-slate-50 p-4">
              <SummaryLine label="Subtotal" cents={saleCalculation?.subtotal ?? 0} />
              <SummaryLine label="Discount" cents={discountCents ?? 0} negative />
              <div className="my-2 border-t border-slate-200" />
              <SummaryLine label="Final amount" cents={saleCalculation?.finalPrice ?? 0} strong />
            </div>
          </div>

          {paymentType === 'installment' && (
            <section className="min-w-0 space-y-4 rounded-2xl border border-blue-100 bg-blue-50/50 p-4">
              <h3 className="font-bold text-slate-900">Installment terms</h3>
              <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
                <FormField label="Down payment">
                  <MoneyInput cents={downPaymentCents} onChange={setDownPaymentCents} />
                </FormField>
                <FormField label="Fixed total interest">
                  <MoneyInput cents={fixedInterestCents} onChange={(value) => { setInterestDraft(value); setInterestEdited(true) }} />
                </FormField>
                <FormField label="Payment frequency">
                  <SegmentedControl value={frequency} options={frequencies} onChange={(value) => { setFrequency(value); setInterestEdited(false); setInterestDraft(null) }} ariaLabel="Payment frequency" />
                </FormField>
                <FormField label={`Number of ${frequency} installments`}>
                  <input type="number" min={1} max={MAX_INSTALLMENT_COUNT} step={1} value={installmentCount} onChange={(event) => setInstallmentCount(Number(event.target.value) || 1)} className="field-input" />
                </FormField>
                <FormField label="First due date">
                  <input type="date" value={firstDueDate} onChange={(event) => setFirstDueDate(event.target.value)} className="field-input" />
                </FormField>
              </div>
              {defaults.isError && <ErrorMessage message={defaults.error.message} />}
              {saleCalculation && (
                <div className="rounded-2xl bg-white p-4">
                  <SummaryLine label="Remaining principal" cents={saleCalculation.remainingPrincipal} />
                  <SummaryLine label="Fixed interest" cents={fixedInterestCents ?? 0} />
                  <SummaryLine label="Total repayment" cents={saleCalculation.totalRepayment} strong />
                  {saleCalculation.installmentAmount > 0 && scheduleDates.length > 0 ? (
                    <>
                      <p className="mt-2 text-sm text-slate-600">
                        {formatLkr(saleCalculation.installmentAmount)} per {frequency} installment · {scheduleDates.length} payments
                      </p>
                      <div className="mt-3 max-h-40 min-w-0 overflow-auto rounded-xl border border-slate-200">
                        <table className="w-full min-w-[320px] text-left text-xs">
                          <thead className="sticky top-0 bg-slate-50 text-slate-500"><tr><th className="px-3 py-2">No.</th><th className="px-3 py-2">Due date</th><th className="px-3 py-2 text-right">Amount</th></tr></thead>
                          <tbody>{scheduleDates.map((date, index) => (
                            <tr key={`${date}-${index}`} className="border-t border-slate-100">
                              <td className="px-3 py-2">{index + 1}</td>
                              <td className="px-3 py-2">{date}</td>
                              <td className="px-3 py-2 text-right">{formatLkr(saleCalculation.installmentAmounts[index])}{index === scheduleDates.length - 1 && saleCalculation.roundingRemainder > 0 && <span className="block text-[10px] text-slate-500">Rounding remainder included</span>}</td>
                            </tr>
                          ))}</tbody>
                        </table>
                      </div>
                    </>
                  ) : <p className="mt-2 text-sm text-slate-600">No installments are due after the down payment.</p>}
                </div>
              )}
            </section>
          )}
          {(formError || createSale.isError) && <ErrorMessage message={formError || createSale.error?.message || 'Unable to save this sale.'} />}
        </form>
      </Modal>

      <Modal
        open={detailId !== null}
        onClose={() => setDetailId(null)}
        title={selectedSale?.invoice_number ?? 'Sale invoice'}
        description={selectedSale ? dateLabel(selectedSale.created_at) : 'Loading invoice details…'}
      >
        {detail.isPending ? <Loading /> : detail.isError ? <ErrorMessage message={detail.error.message} /> : selectedSale ? (
          <div className="min-w-0">
            <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-3 not-print">
              <SegmentedControl value={thermal ? 'thermal' : 'a4'} options={[
                { value: 'a4', label: 'A4 invoice' },
                { value: 'thermal', label: '80mm receipt' },
              ]} onChange={(value) => setThermal(value === 'thermal')} ariaLabel="Invoice paper layout" className="max-w-sm" />
              <div className="flex gap-2">
                <button type="button" onClick={() => printInvoice(thermal)} className="soft-button inline-flex items-center gap-2"><Printer size={16} /> Print</button>
                <button type="button" onClick={() => downloadInvoicePdf(selectedSale, thermal)} className="soft-button inline-flex items-center gap-2"><ArrowDownToLine size={16} /> PDF</button>
              </div>
            </div>
            <Invoice sale={selectedSale} thermal={thermal} />
          </div>
        ) : null}
      </Modal>
    </div>
  )
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass-panel rounded-[26px] p-5">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-3 text-2xl font-extrabold tracking-tight text-slate-900">{value}</p>
    </div>
  )
}

function SummaryLine({ label, cents, strong = false, negative = false }: { label: string; cents: number; strong?: boolean; negative?: boolean }) {
  return (
    <div className={`flex min-w-0 items-center justify-between gap-3 py-1.5 ${strong ? 'font-bold text-slate-900' : 'text-sm text-slate-600'}`}>
      <span>{label}</span>
      <span className="shrink-0">{negative && cents > 0 ? '-' : ''}{formatLkr(cents)}</span>
    </div>
  )
}

function Invoice({ sale, thermal }: { sale: Sale; thermal: boolean }) {
  const shopName = import.meta.env.VITE_SHOP_NAME?.trim() || 'Acceseries'
  const subtotalCents = sale.items.reduce((sum, item) => sum + moneyCents(item.line_total), 0)
  const paidCents = sale.payments.reduce((sum, payment) => sum + moneyCents(payment.amount), 0)
  return (
    <article className={`invoice-print min-w-0 bg-white text-slate-900 ${thermal ? 'thermal-invoice' : ''}`}>
      <div className={`mx-auto min-w-0 ${thermal ? 'max-w-[72mm] p-2' : 'max-w-3xl p-4 md:p-8'}`}>
        <header className="border-b border-slate-200 pb-4 text-center">
          <h2 className={thermal ? 'text-lg font-extrabold' : 'text-3xl font-extrabold'}>{shopName}</h2>
          <p className="mt-1 text-sm font-semibold uppercase tracking-widest text-slate-500">Sales invoice</p>
        </header>
        <div className="grid min-w-0 grid-cols-1 gap-2 border-b border-slate-200 py-4 text-sm sm:grid-cols-2">
          <p><span className="text-slate-500">Invoice:</span> <strong>{sale.invoice_number}</strong></p>
          <p><span className="text-slate-500">Date:</span> {dateLabel(sale.created_at)}</p>
          <p><span className="text-slate-500">Customer:</span> {sale.customer?.full_name ?? 'Walk-in'}</p>
          {sale.customer?.phone && <p><span className="text-slate-500">Phone:</span> {sale.customer.phone}</p>}
          <p><span className="text-slate-500">Payment:</span> {sale.payment_type === 'cash' ? sale.payment_method.replace('_', ' ') : `Installment · ${sale.payment_method.replace('_', ' ')}`}</p>
          <p><span className="text-slate-500">Status:</span> <span className="capitalize">{sale.status}</span></p>
        </div>
        <div className="w-full min-w-0 overflow-x-auto">
          <table className="mt-4 min-w-full text-left text-sm">
            <thead><tr className="border-b border-slate-200 text-slate-500">
              <th className="py-2 pr-3 font-medium">Item</th>
              <th className="py-2 pr-3 text-right font-medium">Qty</th>
              <th className="py-2 pr-3 text-right font-medium">Unit price</th>
              <th className="py-2 text-right font-medium">Total</th>
            </tr></thead>
            <tbody>{sale.items.map((item) => (
              <tr key={item.id} className="border-b border-slate-100">
                <td className="max-w-[220px] py-3 pr-3">{item.product_name}</td>
                <td className="py-3 pr-3 text-right">{item.quantity}</td>
                <td className="whitespace-nowrap py-3 pr-3 text-right">{formatLkr(moneyCents(item.unit_price))}</td>
                <td className="whitespace-nowrap py-3 text-right font-medium">{formatLkr(moneyCents(item.line_total))}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <dl className="ml-auto mt-4 w-full max-w-sm space-y-2 text-sm">
          <SummaryLine label="Subtotal" cents={subtotalCents} />
          <SummaryLine label="Discount" cents={moneyCents(sale.discount_amount)} negative />
          <SummaryLine label="Sale total" cents={moneyCents(sale.total_amount)} strong />
          {sale.agreement && <>
            <SummaryLine label="Fixed interest" cents={moneyCents(sale.agreement.fixed_interest)} />
            <SummaryLine label="Total repayment" cents={moneyCents(sale.agreement.total_repayment)} strong />
            <p className="text-right text-xs text-slate-500">{sale.agreement.installment_count} {sale.agreement.frequency} payments</p>
          </>}
          {paidCents > 0 && <SummaryLine label={sale.payment_type === 'installment' ? 'Down payment received' : 'Paid'} cents={paidCents} />}
        </dl>
        <footer className="mt-8 border-t border-slate-200 pt-4 text-center text-xs text-slate-500">
          Thank you for your purchase.
        </footer>
      </div>
    </article>
  )
}
