import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_TEST_URL
const anonKey = process.env.SUPABASE_TEST_ANON_KEY
const serviceRoleKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY
const integrationConfigured = Boolean(supabaseUrl && anonKey && serviceRoleKey)
const integrationDescribe = integrationConfigured ? describe : describe.skip

if (integrationConfigured) {
  const hostname = new URL(supabaseUrl!).hostname
  if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) {
    throw new Error('Supabase integration tests are restricted to a local Supabase URL.')
  }
}

const testPassword = `T-${randomUUID()}-Local-only!`
const fixture = {
  productIds: [] as string[],
  categoryIds: [] as string[],
  saleIds: [] as string[],
  customerIds: [] as string[],
  agreementIds: [] as string[],
  scheduleIds: [] as string[],
  discountRequestIds: [] as string[],
}

let service: SupabaseClient
let owner: SupabaseClient
let staff: SupabaseClient
let ownerId: string
let staffId: string

function assertNoError(error: { message: string } | null): void {
  if (error) throw new Error(error.message)
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function decimalToCents(value: string): bigint {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value)
  if (!match) throw new Error(`Unexpected database money value: ${value}`)
  const cents = BigInt(match[2]) * 100n + BigInt((match[3] ?? '').padEnd(2, '0') || '0')
  return match[1] === '-' ? -cents : cents
}

function addDays(days: number): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

async function createAuthClient(role: 'owner' | 'staff'): Promise<{ id: string; client: SupabaseClient }> {
  const email = `integration-${role}-${randomUUID()}@example.test`
  const { data, error } = await service.auth.admin.createUser({
    email,
    password: testPassword,
    email_confirm: true,
    user_metadata: { full_name: `Integration ${role}` },
  })
  assertNoError(error)
  if (!data.user) throw new Error(`Supabase did not create the ${role} integration user.`)

  if (role === 'owner') {
    const { data: roleRow, error: roleError } = await service
      .from('roles')
      .select('id')
      .eq('name', 'owner')
      .single()
    assertNoError(roleError)
    if (!roleRow) throw new Error('The owner role is missing from the test database.')
    const { error: profileError } = await service
      .from('profiles')
      .update({ role_id: roleRow.id })
      .eq('user_id', data.user.id)
    assertNoError(profileError)
  }

  const client = createClient(supabaseUrl!, anonKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error: loginError } = await client.auth.signInWithPassword({ email, password: testPassword })
  assertNoError(loginError)
  return { id: data.user.id, client }
}

async function createProduct(stock: number): Promise<string> {
  const suffix = randomUUID()
  const { data: category, error: categoryError } = await service
    .from('categories')
    .insert({ name: `Integration ${suffix}` })
    .select('id')
    .single()
  assertNoError(categoryError)
  if (!category) throw new Error('Unable to create an integration product category.')
  fixture.categoryIds.push(category.id)

  const { data: product, error: productError } = await service
    .from('products')
    .insert({
      name: `Integration product ${suffix}`,
      sku: `TEST-${suffix}`,
      category_id: category.id,
      cost_price: '1.00',
      price: '10.00',
      stock_quantity: stock,
      reorder_level: 1,
      status: 'active',
    })
    .select('id')
    .single()
  assertNoError(productError)
  if (!product) throw new Error('Unable to create an integration product.')
  fixture.productIds.push(product.id)
  return product.id
}

function createSale(client: SupabaseClient, productId: string, quantity: number, key = randomUUID()) {
  const sale = {
    payment_type: 'cash',
    payment_method: 'cash',
    discount_amount: '0.00',
    customer_id: null,
  }
  const items = [{ product_id: productId, quantity }]
  return client.rpc('create_sale_with_discount', {
    p_sale: sale,
    p_items: items,
    p_allow_negative_stock: false,
    p_idempotency_key: key,
    p_request_hash: requestHash({ sale, items }),
    p_discount_type: null,
    p_discount_request_id: null,
  })
}

async function createAgreementFixture(): Promise<{ agreementId: string; scheduleId: string }> {
  const { data: customer, error: customerError } = await service
    .from('customers')
    .insert({ full_name: `Integration ${randomUUID()}`, phone: `+1555${Date.now()}${Math.floor(Math.random() * 1000)}` })
    .select('id')
    .single()
  assertNoError(customerError)
  if (!customer) throw new Error('Unable to create an integration customer.')
  fixture.customerIds.push(customer.id)

  const { data: agreement, error: agreementError } = await service
    .from('agreements')
    .insert({
      customer_id: customer.id,
      subtotal: '100.00',
      product_discount: '0.00',
      customer_discount: '0.00',
      final_price: '100.00',
      down_payment: '0.00',
      remaining_principal: '100.00',
      fixed_interest: '0.00',
      total_repayment: '100.00',
      frequency: 'monthly',
      installment_count: 1,
      first_due_date: addDays(30),
      grace_period_days: 0,
      fixed_late_fee: '0.00',
      daily_late_fee: '0.00',
      maximum_late_fee: '0.00',
      status: 'approved',
      created_by: ownerId,
    })
    .select('id')
    .single()
  assertNoError(agreementError)
  if (!agreement) throw new Error('Unable to create an integration agreement.')
  fixture.agreementIds.push(agreement.id)

  const { data: schedule, error: scheduleError } = await service
    .from('agreement_schedule')
    .insert({
      agreement_id: agreement.id,
      installment_number: 1,
      due_date: addDays(30),
      amount: '100.00',
      interest_amount: '0.00',
    })
    .select('id')
    .single()
  assertNoError(scheduleError)
  if (!schedule) throw new Error('Unable to create an integration schedule row.')
  fixture.scheduleIds.push(schedule.id)
  return { agreementId: agreement.id, scheduleId: schedule.id }
}

function assertRpcDenied(error: { code?: string } | null): void {
  expect(error?.code).toBe('42501')
}

integrationDescribe('local Supabase RPC integration', () => {
  beforeAll(async () => {
    service = createClient(supabaseUrl!, serviceRoleKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const ownerAuth = await createAuthClient('owner')
    const staffAuth = await createAuthClient('staff')
    ownerId = ownerAuth.id
    staffId = staffAuth.id
    owner = ownerAuth.client
    staff = staffAuth.client
  })

  afterAll(async () => {
    const paymentIds: string[] = []
    for (const agreementId of fixture.agreementIds) {
      const { data, error } = await service.from('payments').select('id').eq('agreement_id', agreementId)
      assertNoError(error)
      paymentIds.push(...(data ?? []).map((row) => row.id))
    }
    for (const saleId of fixture.saleIds) {
      const { data, error } = await service.from('payments').select('id').eq('sale_id', saleId)
      assertNoError(error)
      paymentIds.push(...(data ?? []).map((row) => row.id))
    }
    if (paymentIds.length) {
      assertNoError((await service.from('payment_allocations').delete().in('payment_id', paymentIds)).error)
      assertNoError((await service.from('payments').delete().in('id', paymentIds)).error)
    }
    if (fixture.scheduleIds.length) {
      assertNoError((await service.from('late_fee_records').delete().in('agreement_schedule_id', fixture.scheduleIds)).error)
    }
    if (fixture.discountRequestIds.length) {
      assertNoError((await service.from('discount_requests').delete().in('id', fixture.discountRequestIds)).error)
    }
    if (fixture.agreementIds.length) {
      assertNoError((await service.from('agreements').delete().in('id', fixture.agreementIds)).error)
    }
    if (fixture.saleIds.length) {
      assertNoError((await service.from('sales').delete().in('id', fixture.saleIds)).error)
    }
    if (fixture.productIds.length) {
      assertNoError((await service.from('stock_movements').delete().in('product_id', fixture.productIds)).error)
      assertNoError((await service.from('products').delete().in('id', fixture.productIds)).error)
    }
    if (fixture.categoryIds.length) {
      assertNoError((await service.from('categories').delete().in('id', fixture.categoryIds)).error)
    }
    if (fixture.customerIds.length) {
      assertNoError((await service.from('customers').delete().in('id', fixture.customerIds)).error)
    }
    await owner?.auth.signOut()
    await staff?.auth.signOut()
    if (ownerId) assertNoError((await service.auth.admin.deleteUser(ownerId)).error)
    if (staffId) assertNoError((await service.auth.admin.deleteUser(staffId)).error)
  })

  it('deducts stock for a successful sale', async () => {
    const productId = await createProduct(5)
    const { data, error } = await createSale(owner, productId, 2)
    assertNoError(error)
    if (!data?.sale_id) throw new Error('Sale RPC did not return a sale id.')
    fixture.saleIds.push(data.sale_id)

    const { data: product, error: productError } = await service
      .from('products')
      .select('stock_quantity')
      .eq('id', productId)
      .single()
    assertNoError(productError)
    expect(product?.stock_quantity).toBe(3)
  })

  it('rejects a sale that exceeds available stock without changing inventory', async () => {
    const productId = await createProduct(3)
    const { error } = await createSale(owner, productId, 4)
    expect(error?.code).toBe('P0001')

    const { data: product, error: productError } = await service
      .from('products')
      .select('stock_quantity')
      .eq('id', productId)
      .single()
    assertNoError(productError)
    expect(product?.stock_quantity).toBe(3)
  })

  it('serializes concurrent sales so stock cannot become negative', async () => {
    const productId = await createProduct(5)
    const results = await Promise.all([
      createSale(owner, productId, 4),
      createSale(owner, productId, 4),
    ])
    const successful = results.filter((result) => !result.error)
    const failed = results.filter((result) => result.error)
    expect(successful).toHaveLength(1)
    expect(failed).toHaveLength(1)
    expect(failed[0].error?.code).toBe('P0001')
    const saleId = successful[0].data?.sale_id
    if (saleId) fixture.saleIds.push(saleId)

    const { data: product, error } = await service
      .from('products')
      .select('stock_quantity')
      .eq('id', productId)
      .single()
    assertNoError(error)
    expect(product?.stock_quantity).toBe(1)
  })

  it('returns the original payment for a duplicate idempotent request', async () => {
    const { agreementId } = await createAgreementFixture()
    const key = randomUUID()
    const args = {
      p_agreement_id: agreementId,
      p_amount: '25.00',
      p_payment_method: 'cash',
      p_reference: null,
      p_idempotency_key: key,
      p_request_hash: requestHash({ agreementId, amount: '25.00' }),
    }
    const first = await owner.rpc('record_payment', args)
    assertNoError(first.error)
    const second = await owner.rpc('record_payment', args)
    assertNoError(second.error)
    expect(first.data).toBe(second.data)

    const { data: payments, error } = await service
      .from('payments')
      .select('id')
      .eq('agreement_id', agreementId)
    assertNoError(error)
    expect(payments).toHaveLength(1)

    const { data: allocations, error: allocationsError } = await service
      .from('payment_allocations')
      .select('amount')
      .eq('payment_id', first.data)
    assertNoError(allocationsError)
    expect(allocations?.reduce((sum, row) => sum + decimalToCents(row.amount), 0n)).toBe(2_500n)
  })

  it('reverses a payment using balancing allocation rows', async () => {
    const { agreementId } = await createAgreementFixture()
    const payment = await owner.rpc('record_payment', {
      p_agreement_id: agreementId,
      p_amount: '25.00',
      p_payment_method: 'cash',
      p_reference: null,
      p_idempotency_key: randomUUID(),
      p_request_hash: requestHash(randomUUID()),
    })
    assertNoError(payment.error)
    if (!payment.data) throw new Error('Payment RPC did not return a payment id.')

    const reversed = await owner.rpc('reverse_payment', {
      p_payment_id: payment.data,
      p_reason: 'Integration test reversal',
      p_idempotency_key: randomUUID(),
      p_request_hash: requestHash(randomUUID()),
    })
    assertNoError(reversed.error)
    expect(reversed.data).toBe(payment.data)

    const { data: rows, error } = await service
      .from('payment_allocations')
      .select('amount')
      .eq('payment_id', payment.data)
    assertNoError(error)
    const totalCents = (rows ?? []).reduce((sum, row) => sum + decimalToCents(row.amount), 0n)
    expect(totalCents).toBe(0n)
    const { data: paymentRow, error: paymentError } = await service
      .from('payments')
      .select('reversed_at')
      .eq('id', payment.data)
      .single()
    assertNoError(paymentError)
    expect(paymentRow?.reversed_at).not.toBeNull()
  })

  it('allows the owner to sell while denying the same sale permission to staff', async () => {
    const productId = await createProduct(2)
    const ownerSale = await createSale(owner, productId, 1)
    assertNoError(ownerSale.error)
    if (!ownerSale.data?.sale_id) throw new Error('Owner sale RPC did not return a sale id.')
    fixture.saleIds.push(ownerSale.data.sale_id)

    const staffSale = await createSale(staff, productId, 1)
    assertRpcDenied(staffSale.error)
  })

  it('denies staff discount approvals and late-fee waivers', async () => {
    const { data: discount, error: discountError } = await service
      .from('discount_requests')
      .insert({
        discount_type: 'product',
        amount: '1.00',
        reason: 'Integration access check',
        status: 'pending',
        requested_by: staffId,
      })
      .select('id')
      .single()
    assertNoError(discountError)
    if (!discount) throw new Error('Unable to create an integration discount request.')
    fixture.discountRequestIds.push(discount.id)

    const approval = await staff.rpc('decide_discount_request', {
      p_request_id: discount.id,
      p_decision: 'approved',
      p_reason: 'Integration access check',
      p_idempotency_key: randomUUID(),
      p_request_hash: requestHash(randomUUID()),
    })
    assertRpcDenied(approval.error)

    const { scheduleId } = await createAgreementFixture()
    const waiver = await staff.rpc('waive_late_fee', {
      p_schedule_id: scheduleId,
      p_reason: 'Integration access check',
      p_idempotency_key: randomUUID(),
      p_request_hash: requestHash(randomUUID()),
    })
    assertRpcDenied(waiver.error)
  })

  it('allows the owner to read financial summaries and denies staff without permission', async () => {
    const ownerSummary = await owner.rpc('get_payment_summary')
    assertNoError(ownerSummary.error)
    expect(ownerSummary.data).toHaveProperty('collected_this_month_cents')

    const staffSummary = await staff.rpc('get_payment_summary')
    assertRpcDenied(staffSummary.error)
  })
})
