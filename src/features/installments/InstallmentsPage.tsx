import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form'
import { z } from 'zod'
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
  splitCentsRemainderLast,
  type PaymentFrequency,
} from '../../lib/installments/calculations'
import { databaseDecimalToCents, formatLkr } from '../../shared/business'
import { ErrorMessage, Loading, PageHeading } from '../dashboard/DashboardPage'

type Customer = {
  id: string
  full_name: string
  phone: string
}

type Product = {
  id: string
  name: string
  category: string
  price: string
  stock_quantity: number
  reorder_level: number
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

type AgreementRecord = {
  id: string
  customer_id: string
  subtotal: string
  product_discount: string
  customer_discount: string
  final_price: string
  down_payment: string
  remaining_principal: string
  fixed_interest: string
  total_repayment: string
  frequency: PaymentFrequency
  installment_count: number
  first_due_date: string
  status: 'approved' | 'pending_approval' | 'settled' | 'settled_early'
  created_at: string
  customer: { full_name: string } | null
  schedule: Array<{
    installment_number: number
    due_date: string
    amount: string
    interest_amount: string
  }>
}

const EMPTY_CUSTOMERS: Customer[] = []
const EMPTY_PRODUCTS: Product[] = []
const EMPTY_DISCOUNTS: ApprovedDiscount[] = []
const moneyCents = z.number().int().min(0).max(999_999_999_999).nullable()
const frequencies = ['daily', 'weekly', 'monthly'] as const
const frequencyOptions = [
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Monthly', value: 'monthly' },
] as const

function createAgreementFormSchema(products: Product[]) {
  const productsById = new Map(products.map((product) => [product.id, product]))
  return z.object({
    customerId: z.string().uuid('Select a customer.'),
    items: z.array(z.object({
      productId: z.string().uuid('Select a product.'),
      quantity: z.number().int().min(1, 'Quantity must be at least one.').max(2_147_483_647),
    })).min(1, 'Add at least one product.'),
    productDiscountCents: moneyCents,
    customerDiscountCents: moneyCents,
    productDiscountRequestId: z.string().uuid().nullable(),
    customerDiscountRequestId: z.string().uuid().nullable(),
    downPaymentCents: moneyCents,
    fixedInterestCents: moneyCents,
    frequency: z.enum(frequencies),
    installmentCount: z.number().int().min(1, 'At least one installment is required.').max(MAX_INSTALLMENT_COUNT),
    firstDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a first due date.'),
  }).superRefine((values, context) => {
    const quantities = new Map<string, number>()
    let subtotal = 0n
    let hasMissingProduct = false

    values.items.forEach((item, index) => {
      const product = productsById.get(item.productId)
      if (!product) {
        hasMissingProduct = true
        return
      }
      const requested = (quantities.get(item.productId) ?? 0) + item.quantity
      quantities.set(item.productId, requested)
      if (requested > product.stock_quantity) {
        context.addIssue({
          code: 'custom',
          message: `Only ${product.stock_quantity} in stock.`,
          path: ['items', index, 'quantity'],
        })
      }
      subtotal += BigInt(databaseDecimalToCents(product.price)) * BigInt(item.quantity)
    })

    if (hasMissingProduct || values.items.some((item) => !productsById.has(item.productId))) return
    if (subtotal > 999_999_999_999n) {
      context.addIssue({
        code: 'custom',
        message: 'Subtotal exceeds the supported LKR limit.',
        path: ['items'],
      })
      return
    }

    const discounts = BigInt(values.productDiscountCents ?? 0) + BigInt(values.customerDiscountCents ?? 0)
    if (discounts > subtotal) {
      context.addIssue({
        code: 'custom',
        message: 'Combined discounts cannot exceed the subtotal.',
        path: ['customerDiscountCents'],
      })
      return
    }
    if (BigInt(values.downPaymentCents ?? 0) > subtotal - discounts) {
      context.addIssue({
        code: 'custom',
        message: 'Down payment cannot exceed the final price.',
        path: ['downPaymentCents'],
      })
      return
    }

    try {
      calculateAgreement({
        items: values.items.map((item) => ({
          unitPriceCents: databaseDecimalToCents(productsById.get(item.productId)!.price),
          quantity: item.quantity,
        })),
        productDiscount: values.productDiscountCents ?? 0,
        customerDiscount: values.customerDiscountCents ?? 0,
        downPayment: values.downPaymentCents ?? 0,
        fixedInterest: values.fixedInterestCents ?? 0,
        frequency: values.frequency,
        installmentCount: values.installmentCount,
        firstDueDate: values.firstDueDate,
      })
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'Check the agreement values.',
        path: ['firstDueDate'],
      })
    }
  })
}

type AgreementFormValues = z.infer<ReturnType<typeof createAgreementFormSchema>>
type AgreementPayload = {
  customer_id: string
  items: Array<{ product_id: string; quantity: number }>
  product_discount_cents: number
  customer_discount_cents: number
  product_discount_request_id: string | null
  customer_discount_request_id: string | null
  down_payment_cents: number
  fixed_interest_cents: number
  frequency: PaymentFrequency
  installment_count: number
  first_due_date: string
}

function todayAsDateInput(): string {
  const now = new Date()
  return `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`
}

function displayDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-LK', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

function defaultInterestCents(settings: AgreementDefaults | undefined, frequency: PaymentFrequency): number {
  if (!settings) return 0
  const value = frequency === 'daily'
    ? settings.default_daily_interest
    : frequency === 'weekly'
      ? settings.default_weekly_interest
      : settings.default_monthly_interest
  return databaseDecimalToCents(value)
}

export function InstallmentsPage() {
  const queryClient = useQueryClient()
  const [formOpen, setFormOpen] = useState(false)
  const [addCustomerOpen, setAddCustomerOpen] = useState(false)
  const [newCustomerName, setNewCustomerName] = useState('')
  const [newCustomerPhone, setNewCustomerPhone] = useState('')
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
  const agreements = useQuery({
    queryKey: ['agreements'],
    queryFn: () => apiRequest<AgreementRecord[]>('/api/agreements'),
  })

  const schema = useMemo(() => createAgreementFormSchema(products.data ?? []), [products.data])
  const {
    control,
    handleSubmit,
    register,
    reset,
    setValue,
    formState: { errors, isValid },
  } = useForm<AgreementFormValues>({
    resolver: zodResolver(schema),
    mode: 'onChange',
    defaultValues: {
      customerId: '',
      items: [{ productId: '', quantity: 1 }],
      productDiscountCents: 0,
      customerDiscountCents: 0,
      productDiscountRequestId: null,
      customerDiscountRequestId: null,
      downPaymentCents: 0,
      fixedInterestCents: null,
      frequency: 'monthly',
      installmentCount: 1,
      firstDueDate: todayAsDateInput(),
    },
  })
  const { fields, append, remove } = useFieldArray({ control, name: 'items' })
  const watched = useWatch({ control })
  const selectedCustomerId = watched.customerId ?? ''
  const approvedDiscounts = useQuery({
    queryKey: ['available-discounts', selectedCustomerId],
    queryFn: () => apiRequest<ApprovedDiscount[]>(
      `/api/discounts/available?customer_id=${encodeURIComponent(selectedCustomerId)}`,
    ),
    enabled: z.string().uuid().safeParse(selectedCustomerId).success,
  })
  const frequency = watched.frequency ?? 'monthly'
  const installmentCount = watched.installmentCount ?? 1
  const fixedInterestCents = watched.fixedInterestCents ?? 0
  const productRows = products.data ?? EMPTY_PRODUCTS
  const customerRows = customers.data ?? EMPTY_CUSTOMERS
  const discountRows = approvedDiscounts.data ?? EMPTY_DISCOUNTS
  const productDiscountOptions: ComboboxOption<string>[] = discountRows
    .filter((discount) => discount.discount_type === 'product')
    .map((discount) => ({
      value: discount.id,
      label: `${formatLkr(discount.amount_cents)} · ${discount.reason}`,
    }))
  const customerDiscountOptions: ComboboxOption<string>[] = discountRows
    .filter((discount) => discount.discount_type === 'customer')
    .map((discount) => ({
      value: discount.id,
      label: `${formatLkr(discount.amount_cents)} · ${discount.reason}`,
    }))
  const initializedInterest = useRef(false)
  const [agreementRequest, setAgreementRequest] = useState<{ body: string; key: string } | null>(null)

  useEffect(() => {
    if (!defaults.data || initializedInterest.current) return
    setValue('fixedInterestCents', defaultInterestCents(defaults.data, frequency))
    initializedInterest.current = true
  }, [defaults.data, frequency, setValue])

  const createCustomer = useMutation({
    mutationFn: (customer: Pick<Customer, 'full_name' | 'phone'>) =>
      apiRequest<Customer>('/api/customers', {
        method: 'POST',
        body: JSON.stringify(customer),
      }),
    onSuccess: async (customer) => {
      await queryClient.invalidateQueries({ queryKey: ['customers'] })
      setValue('customerId', customer.id, { shouldDirty: true, shouldValidate: true })
      setNewCustomerName('')
      setNewCustomerPhone('')
      setAddCustomerOpen(false)
    },
  })

  const createAgreement = useMutation({
    mutationFn: ({ payload, idempotencyKey }: { payload: AgreementPayload; idempotencyKey: string }) =>
      apiRequest<AgreementRecord>('/api/agreements', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    onSuccess: async () => {
      setAgreementRequest(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['agreements'] }),
        queryClient.invalidateQueries({ queryKey: ['products'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['available-discounts'] }),
      ])
      reset({
        customerId: '',
        items: [{ productId: '', quantity: 1 }],
        productDiscountCents: 0,
        customerDiscountCents: 0,
        productDiscountRequestId: null,
        customerDiscountRequestId: null,
        downPaymentCents: 0,
        fixedInterestCents: defaultInterestCents(defaults.data, frequency),
        frequency,
        installmentCount: 1,
        firstDueDate: todayAsDateInput(),
      })
      setFormOpen(false)
    },
  })

  const productOptions: ComboboxOption<string>[] = useMemo(
    () => productRows.map((product) => ({
      value: product.id,
      label: `${product.name} · ${product.category} · stock ${product.stock_quantity} · ${product.id}`,
    })),
    [productRows],
  )
  const customerOptions: ComboboxOption<string>[] = useMemo(
    () => customerRows.map((customer) => ({
      value: customer.id,
      label: `${customer.full_name} · ${customer.phone} · ${customer.id}`,
    })),
    [customerRows],
  )

  const calculation = useMemo(() => {
    const items = (watched.items ?? []).map((item) => ({
      productId: item.productId ?? '',
      quantity: item.quantity ?? 1,
    }))
    if (items.length === 0 || items.some((item) => !item.productId)) return null
    const byId = new Map(productRows.map((product) => [product.id, product]))
    if (items.some((item) => !byId.has(item.productId))) return null
    try {
      return calculateAgreement({
        items: items.map((item) => ({
          unitPriceCents: databaseDecimalToCents(byId.get(item.productId)!.price),
          quantity: item.quantity,
        })),
        productDiscount: watched.productDiscountCents ?? 0,
        customerDiscount: watched.customerDiscountCents ?? 0,
        downPayment: watched.downPaymentCents ?? 0,
        fixedInterest: fixedInterestCents,
        frequency,
        installmentCount,
        firstDueDate: watched.firstDueDate ?? todayAsDateInput(),
      })
    } catch {
      return null
    }
  }, [
    fixedInterestCents,
    frequency,
    installmentCount,
    productRows,
    watched.customerDiscountCents,
    watched.downPaymentCents,
    watched.firstDueDate,
    watched.items,
    watched.productDiscountCents,
  ])
  const schedule = useMemo(() => {
    if (!calculation || calculation.installmentAmounts.length === 0) return []
    try {
      return generateSchedule(watched.firstDueDate ?? todayAsDateInput(), frequency, calculation.installmentAmounts.length)
    } catch {
      return []
    }
  }, [calculation, frequency, watched.firstDueDate])
  const canSplitInterest = Number.isSafeInteger(installmentCount) && installmentCount > 0 &&
    Number.isSafeInteger(fixedInterestCents) && fixedInterestCents >= 0
  const interestAmountPerInstallment = calculation?.interestPerInstallment[0] ??
    (canSplitInterest ? splitCentsRemainderLast(fixedInterestCents, installmentCount)[0] ?? 0 : 0)
  const hasInterestRemainder = calculation?.interestPerInstallment.length
    ? calculation.interestPerInstallment.at(-1) !== calculation.interestPerInstallment[0]
    : false

  const onSubmit = (values: AgreementFormValues) => {
    const payload: AgreementPayload = {
      customer_id: values.customerId,
      items: values.items.map((item) => ({ product_id: item.productId, quantity: item.quantity })),
      product_discount_cents: values.productDiscountCents ?? 0,
      customer_discount_cents: values.customerDiscountCents ?? 0,
      product_discount_request_id: values.productDiscountRequestId,
      customer_discount_request_id: values.customerDiscountRequestId,
      down_payment_cents: values.downPaymentCents ?? 0,
      fixed_interest_cents: values.fixedInterestCents ?? 0,
      frequency: values.frequency,
      installment_count: values.installmentCount,
      first_due_date: values.firstDueDate,
    }
    const body = JSON.stringify(payload)
    const request = agreementRequest?.body === body
      ? agreementRequest
      : { body, key: crypto.randomUUID() }
    setAgreementRequest(request)
    createAgreement.mutate({ payload, idempotencyKey: request.key })
  }

  const addNewCustomer = () => {
    createCustomer.mutate({
      full_name: newCustomerName.trim(),
      phone: newCustomerPhone.trim(),
    })
  }

  return (
    <div className="space-y-6">
      <PageHeading title="Installments" description="Create agreements and review their saved repayment schedules." />
      <div className="flex min-w-0 justify-end">
        <button type="button" onClick={() => setFormOpen(true)} className="inline-flex items-center gap-2 rounded-2xl bg-[#247BDB] px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700">
          <Plus size={17} /> New agreement
        </button>
      </div>
      <section className="min-w-0 rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
        <h3 className="mb-4 text-xl font-extrabold text-slate-900">Agreements</h3>
        {agreements.isPending ? <Loading /> : agreements.isError ? <ErrorMessage message={agreements.error.message} /> : (
          <div className="w-full min-w-0 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-3 pr-4 font-medium">Customer</th>
                  <th className="py-3 pr-4 font-medium">Terms</th>
                  <th className="py-3 pr-4 font-medium">Total repayment</th>
                  <th className="py-3 pr-4 font-medium">First due</th>
                  <th className="py-3 pr-4 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {(agreements.data ?? []).map((agreement) => (
                  <tr key={agreement.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-4 pr-4 font-semibold text-slate-900">{agreement.customer?.full_name ?? 'Customer unavailable'}</td>
                    <td className="py-4 pr-4 capitalize text-slate-600">{agreement.frequency} · {agreement.installment_count} payments</td>
                    <td className="py-4 pr-4 font-semibold text-slate-900">{formatLkr(databaseDecimalToCents(agreement.total_repayment))}</td>
                    <td className="py-4 pr-4 text-slate-600">{displayDate(agreement.first_due_date)}</td>
                    <td className="py-4 pr-4">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${agreement.status === 'approved' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'}`}>
                        {agreement.status === 'approved' ? 'Approved' : 'Pending owner approval'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(agreements.data ?? []).length === 0 && <p className="py-5 text-sm text-slate-500">No installment agreements yet.</p>}
          </div>
        )}
      </section>

      <Modal
        open={formOpen}
        onClose={() => {
          setFormOpen(false)
          createAgreement.reset()
        }}
        title="New agreement"
        description="Select the customer, products, and payment terms."
        footer={
          <div className="flex min-w-0 justify-end gap-3">
            <button type="button" onClick={() => setFormOpen(false)} className="soft-button">Cancel</button>
            <button form="agreement-form" type="submit" disabled={!isValid || createAgreement.isPending || !customers.data || !products.data || !defaults.data} className="rounded-2xl bg-[#247BDB] px-4 py-3 text-sm font-semibold text-white disabled:opacity-60">
              {createAgreement.isPending ? 'Saving…' : 'Confirm agreement'}
            </button>
          </div>
        }
      >
        <form id="agreement-form" className="min-w-0 space-y-6" onSubmit={handleSubmit(onSubmit)}>
          {(customers.isError || products.isError || defaults.isError) && (
            <ErrorMessage message={customers.error?.message ?? products.error?.message ?? defaults.error?.message ?? 'Unable to load agreement options.'} />
          )}
          <section className="min-w-0 space-y-4">
            <h3 className="font-bold text-slate-900">Customer</h3>
            <div className="min-w-0">
              <label htmlFor="agreement-customer" className="mb-1.5 block text-sm font-medium text-slate-700">Customer</label>
              <Controller
                name="customerId"
                control={control}
                render={({ field }) => (
                  <Combobox
                    id="agreement-customer"
                    options={customerOptions}
                    value={field.value || null}
                    onChange={(customerId) => {
                      field.onChange(customerId ?? '')
                      setValue('productDiscountRequestId', null, { shouldDirty: true })
                      setValue('customerDiscountRequestId', null, { shouldDirty: true })
                      setValue('productDiscountCents', 0, { shouldDirty: true, shouldValidate: true })
                      setValue('customerDiscountCents', 0, { shouldDirty: true, shouldValidate: true })
                    }}
                    ariaLabel="Customer"
                    placeholder="Search by name, phone, or ID"
                    searchPlaceholder="Search customers…"
                    aria-invalid={Boolean(errors.customerId)}
                    aria-describedby={errors.customerId ? 'agreement-customer-error' : undefined}
                  />
                )}
              />
              {errors.customerId?.message && <p id="agreement-customer-error" role="alert" className="mt-1 text-xs font-medium text-red-700">{errors.customerId.message}</p>}
            </div>
            <button type="button" onClick={() => setAddCustomerOpen((open) => !open)} className="text-sm font-semibold text-[#247BDB] hover:underline">
              {addCustomerOpen ? 'Cancel adding customer' : 'Add new customer'}
            </button>
            {addCustomerOpen && (
              <div className="grid min-w-0 grid-cols-1 gap-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:grid-cols-2">
                <FormField label="Full name">
                  <input value={newCustomerName} onChange={(event) => setNewCustomerName(event.target.value)} className="field-input" minLength={2} required />
                </FormField>
                <FormField label="Phone">
                  <input type="tel" value={newCustomerPhone} onChange={(event) => setNewCustomerPhone(event.target.value)} className="field-input" minLength={8} required />
                </FormField>
                {createCustomer.isError && <div className="md:col-span-2"><ErrorMessage message={createCustomer.error.message} /></div>}
                <div className="md:col-span-2">
                  <button
                    type="button"
                    onClick={addNewCustomer}
                    disabled={createCustomer.isPending || newCustomerName.trim().length < 2 || newCustomerPhone.trim().length < 8}
                    className="rounded-xl border border-blue-200 bg-white px-4 py-2.5 text-sm font-semibold text-[#247BDB] disabled:opacity-50"
                  >
                    {createCustomer.isPending ? 'Saving…' : 'Save and select customer'}
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="min-w-0 space-y-4 border-t border-slate-100 pt-5">
            <div className="flex min-w-0 items-center justify-between gap-3">
              <h3 className="font-bold text-slate-900">Products</h3>
              <button type="button" onClick={() => append({ productId: '', quantity: 1 })} className="shrink-0 text-sm font-semibold text-[#247BDB] hover:underline">Add product</button>
            </div>
            {fields.map((row, index) => {
              const productId = watched.items?.[index]?.productId
              const selectedProduct = productRows.find((product) => product.id === productId)
              return (
                <div key={row.id} className="grid min-w-0 grid-cols-1 gap-3 rounded-2xl border border-slate-200 p-3 md:grid-cols-[minmax(0,1fr)_12rem] md:items-end">
                  <div className="min-w-0">
                    <label htmlFor={`agreement-product-${index}`} className="mb-1.5 block text-sm font-medium text-slate-700">Product</label>
                    <Controller
                      name={`items.${index}.productId`}
                      control={control}
                      render={({ field }) => (
                        <Combobox
                          id={`agreement-product-${index}`}
                          options={productOptions}
                          value={field.value || null}
                          onChange={field.onChange}
                          ariaLabel={`Product ${index + 1}`}
                          placeholder="Search products"
                          searchPlaceholder="Search name or ID…"
                          aria-invalid={Boolean(errors.items?.[index]?.productId)}
                        />
                      )}
                    />
                    {errors.items?.[index]?.productId?.message && <p role="alert" className="mt-1 text-xs font-medium text-red-700">{errors.items[index]?.productId?.message}</p>}
                    {selectedProduct && <p className="mt-1 text-xs text-slate-500">{formatLkr(databaseDecimalToCents(selectedProduct.price))} each · {selectedProduct.stock_quantity} available</p>}
                  </div>
                  <div className="flex min-w-0 items-end gap-2">
                    <div className="min-w-0 flex-1">
                      <FormField label="Quantity" error={errors.items?.[index]?.quantity?.message}>
                        <input
                          type="number"
                          min={1}
                          max={selectedProduct?.stock_quantity}
                          step={1}
                          className="field-input"
                          {...register(`items.${index}.quantity`, { valueAsNumber: true })}
                        />
                      </FormField>
                    </div>
                    <button type="button" aria-label={`Remove product ${index + 1}`} onClick={() => remove(index)} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-red-50 hover:text-red-600">
                      <Trash2 size={17} />
                    </button>
                  </div>
                </div>
              )
            })}
            {errors.items?.message && <p role="alert" className="text-xs font-medium text-red-700">{errors.items.message}</p>}
          </section>

          <section className="min-w-0 space-y-4 border-t border-slate-100 pt-5">
            <h3 className="font-bold text-slate-900">Discounts</h3>
            <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
              <Controller
                name="productDiscountRequestId"
                control={control}
                render={({ field }) => (
                  <FormField label="Approved product discount" hint="Each approved discount can be used once.">
                    <Combobox
                      options={productDiscountOptions}
                      value={field.value}
                      onChange={(id) => {
                        field.onChange(id)
                        const discount = discountRows.find((row) => row.id === id)
                        setValue('productDiscountCents', discount?.amount_cents ?? 0, { shouldDirty: true, shouldValidate: true })
                      }}
                      ariaLabel="Approved product discount"
                      placeholder="No discount"
                      searchPlaceholder="Search approved discounts…"
                    />
                  </FormField>
                )}
              />
              <Controller
                name="customerDiscountRequestId"
                control={control}
                render={({ field }) => (
                  <FormField label="Approved customer discount" hint="Only approved, unused requests are available.">
                    <Combobox
                      options={customerDiscountOptions}
                      value={field.value}
                      onChange={(id) => {
                        field.onChange(id)
                        const discount = discountRows.find((row) => row.id === id)
                        setValue('customerDiscountCents', discount?.amount_cents ?? 0, { shouldDirty: true, shouldValidate: true })
                      }}
                      ariaLabel="Approved customer discount"
                      placeholder="No discount"
                      searchPlaceholder="Search approved discounts…"
                    />
                  </FormField>
                )}
              />
            </div>
            {approvedDiscounts.isError && <ErrorMessage message={approvedDiscounts.error.message} />}
          </section>

          <section className="min-w-0 space-y-4 border-t border-slate-100 pt-5">
            <h3 className="font-bold text-slate-900">Payment terms</h3>
            <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
              <Controller
                name="downPaymentCents"
                control={control}
                render={({ field }) => (
                  <FormField label="Down payment" error={errors.downPaymentCents?.message}>
                    <MoneyInput cents={field.value} onChange={field.onChange} />
                  </FormField>
                )}
              />
              <FormField label="Payment frequency">
                <Controller
                  name="frequency"
                  control={control}
                  render={({ field }) => (
                    <SegmentedControl
                      value={field.value}
                      onChange={(nextFrequency) => {
                        field.onChange(nextFrequency)
                        setValue('fixedInterestCents', defaultInterestCents(defaults.data, nextFrequency), { shouldDirty: true, shouldValidate: true })
                      }}
                      ariaLabel="Payment frequency"
                      options={frequencyOptions}
                    />
                  )}
                />
              </FormField>
              <FormField label="Number of installments" hint={`Maximum ${MAX_INSTALLMENT_COUNT} installments.`} error={errors.installmentCount?.message}>
                <input type="number" min={1} max={MAX_INSTALLMENT_COUNT} step={1} className="field-input" {...register('installmentCount', { valueAsNumber: true })} />
              </FormField>
              <FormField label="First due date" error={errors.firstDueDate?.message}>
                <input type="date" className="field-input" {...register('firstDueDate')} />
              </FormField>
              <Controller
                name="fixedInterestCents"
                control={control}
                render={({ field }) => (
                  <FormField label="Fixed total interest (LKR)" error={errors.fixedInterestCents?.message}>
                    <MoneyInput cents={field.value} onChange={field.onChange} />
                  </FormField>
                )}
              />
            </div>
            <p className="text-sm text-slate-600">
              = {formatLkr(interestAmountPerInstallment)} per {frequency} installment
              {hasInterestRemainder ? ' (last installment includes the interest remainder)' : ''}
            </p>
          </section>

          <section className="min-w-0 space-y-4 border-t border-slate-100 pt-5">
            <h3 className="font-bold text-slate-900">Live summary</h3>
            <dl className="grid min-w-0 grid-cols-1 gap-3 rounded-2xl border border-blue-100 bg-blue-50/60 p-4 sm:grid-cols-2">
              <SummaryLine label="Subtotal" cents={calculation?.subtotal ?? 0} />
              <SummaryLine label="Discounts" cents={calculation?.discounts ?? 0} />
              <SummaryLine label="Final price" cents={calculation?.finalPrice ?? 0} />
              <SummaryLine label="Down payment" cents={watched.downPaymentCents ?? 0} />
              <SummaryLine label="Remaining principal" cents={calculation?.remainingPrincipal ?? 0} />
              <SummaryLine label="Fixed interest" cents={fixedInterestCents} />
              <SummaryLine label="Total repayment" cents={calculation?.totalRepayment ?? 0} />
              <SummaryLine label="Installment amount" cents={calculation?.installmentAmount ?? 0} />
            </dl>
          </section>

          {schedule.length > 0 && calculation && (
            <section className="min-w-0 space-y-3 border-t border-slate-100 pt-5">
              <h3 className="font-bold text-slate-900">Schedule preview</h3>
              <div className="max-h-64 min-w-0 overflow-auto rounded-2xl border border-slate-200">
                <table className="min-w-full text-left text-sm">
                  <thead className="sticky top-0 bg-slate-50 text-slate-500">
                    <tr><th className="px-3 py-2.5 font-medium">No.</th><th className="px-3 py-2.5 font-medium">Due date</th><th className="px-3 py-2.5 text-right font-medium">Amount</th></tr>
                  </thead>
                  <tbody>
                    {schedule.map((dueDate, index) => (
                      <tr key={`${index}-${dueDate}`} className="border-t border-slate-100">
                        <td className="px-3 py-2.5 text-slate-600">{index + 1}</td>
                        <td className="px-3 py-2.5 text-slate-700">{displayDate(dueDate)}</td>
                        <td className="px-3 py-2.5 text-right font-semibold text-slate-900">
                          {formatLkr(calculation.installmentAmounts[index])}
                          {index === schedule.length - 1 && <span className="block text-xs font-normal text-slate-500">Rounding remainder: {formatLkr(calculation.roundingRemainder)}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {createAgreement.isError && <ErrorMessage message={createAgreement.error.message} />}
          {defaults.isError && <ErrorMessage message={defaults.error.message} />}
        </form>
      </Modal>
    </div>
  )
}

function SummaryLine({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="flex min-w-0 justify-between gap-3 text-sm">
      <dt className="min-w-0 text-slate-600">{label}</dt>
      <dd className="shrink-0 font-semibold text-slate-900">{formatLkr(cents)}</dd>
    </div>
  )
}
