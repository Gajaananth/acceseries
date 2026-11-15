import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z } from 'zod'
import {
  centsToDatabaseDecimal,
  databaseDecimalToCents,
  getStockStatus,
} from '../../src/shared/business'
import {
  calculateAgreement,
  generateSchedule,
  MAX_INSTALLMENT_COUNT,
} from '../../src/lib/installments/calculations'

type Env = {
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  APP_ENV?: string
  ALLOWED_ORIGINS?: string
}

type ApiUser = {
  id: string
  email: string
  name: string | null
  role: 'owner' | 'staff'
  canManageProducts: boolean
  permissions: string[]
}

type Variables = {
  supabase: SupabaseClient
  userId: string
  role: 'owner' | 'staff'
  canManageProducts: boolean
  permissions: string[]
  apiUser: ApiUser
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

const reportTypes = [
  'sales', 'balances', 'late_fees', 'overdue', 'collections',
  'inventory', 'low_stock', 'staff', 'discounts', 'expenses', 'profit',
] as const
const staffPermissionKeys = [
  'customers:read', 'customers:write', 'products:read', 'products:write',
  'sales:read', 'sales:create', 'agreements:read', 'agreements:create',
  'payments:read', 'payments:write', 'receipts:print',
  'reports:sales', 'reports:balances', 'reports:late_fees', 'reports:overdue',
  'reports:collections', 'reports:inventory', 'reports:low_stock', 'reports:staff',
  'reports:discounts', 'reports:expenses', 'reports:profit',
] as const
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
})
const staffPermissionListSchema = z.array(z.enum(staffPermissionKeys))
  .max(staffPermissionKeys.length)
  .refine((permissions) => new Set(permissions).size === permissions.length)

app.use('*', cors({
  origin: (origin, context) => {
    const allowedOrigins = (context.env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((value: string) => value.trim())
      .filter(Boolean)
    return allowedOrigins.includes(origin) ? origin : ''
  },
  allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
  allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
}))

const customerSchema = z.object({
  full_name: z.string().trim().min(2).max(200),
  phone: z.string().trim().min(8).max(32),
})

const saleItemSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().int().positive().max(2_147_483_647),
})

const cashSaleSchema = z.object({
  customer_id: z.string().uuid().nullable(),
  payment_type: z.literal('cash'),
  discount_cents: z.number().int().nonnegative().max(999_999_999_999),
  discount_type: z.enum(['product', 'customer']).nullable(),
  discount_request_id: z.string().uuid().nullable(),
  allow_negative_stock: z.boolean().optional().default(false),
  payment_method: z.enum(['cash', 'bank_transfer', 'card']),
  items: z.array(saleItemSchema).min(1),
})

const installmentSaleSchema = z.object({
  customer_id: z.string().uuid(),
  payment_type: z.literal('installment'),
  discount_cents: z.number().int().nonnegative().max(999_999_999_999),
  discount_type: z.enum(['product', 'customer']).nullable(),
  discount_request_id: z.string().uuid().nullable(),
  down_payment_cents: z.number().int().nonnegative().max(999_999_999_999),
  fixed_interest_cents: z.number().int().nonnegative().max(999_999_999_999),
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  installment_count: z.number().int().positive().max(MAX_INSTALLMENT_COUNT),
  first_due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  payment_method: z.enum(['cash', 'bank_transfer', 'card']),
  items: z.array(saleItemSchema).min(1),
})
const saleSchema = z.discriminatedUnion('payment_type', [cashSaleSchema, installmentSaleSchema])

const salesListSchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(['all', 'paid', 'pending', 'processing']).default('all'),
})

const paymentSchema = z.object({
  agreement_id: z.string().uuid(),
  amount_cents: z.number().int().positive().max(999_999_999_999),
  payment_method: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  reference: z.string().trim().max(120).optional(),
})

const paymentCustomerSearchSchema = z.object({
  search: z.string().trim().min(1).max(100),
})

const paymentListSchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
})

const settlementSchema = z.object({
  payment_method: z.enum(['cash', 'bank_transfer', 'card']),
})

const paymentReversalSchema = z.object({
  reason: z.string().trim().min(2).max(500),
})

const productMetadataSchema = z.object({
  name: z.string().trim().min(2).max(200),
  sku: z.string().trim().min(1).max(64),
  barcode: z.string().trim().max(64).nullable(),
  category_id: z.string().uuid(),
  brand: z.string().trim().max(120).nullable(),
  description: z.string().trim().max(2000).nullable(),
  cost_price_cents: z.number().int().nonnegative().max(999_999_999_999),
  selling_price_cents: z.number().int().nonnegative().max(999_999_999_999),
  min_stock: z.number().int().nonnegative().max(2_147_483_647),
  supplier: z.string().trim().max(200).nullable(),
  status: z.enum(['active', 'archived']),
})

const createProductSchema = productMetadataSchema.extend({
  quantity: z.number().int().nonnegative().max(2_147_483_647),
})

const stockMovementSchema = z.object({
  movement_type: z.enum(['stock_in', 'adjust']),
  qty: z.number().int().min(-2_147_483_647).max(2_147_483_647).refine((value) => value !== 0, 'Quantity cannot be zero.'),
  reason: z.string().trim().min(2).max(500),
}).superRefine((movement, context) => {
  if (movement.movement_type === 'stock_in' && movement.qty < 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['qty'], message: 'Stock-in quantity must be positive.' })
  }
})

const agreementSchema = z.object({
  customer_id: z.string().uuid(),
  items: z.array(z.object({
    product_id: z.string().uuid(),
    quantity: z.number().int().positive().max(2_147_483_647),
  })).min(1),
  product_discount_cents: z.number().int().nonnegative().max(999_999_999_999),
  customer_discount_cents: z.number().int().nonnegative().max(999_999_999_999),
  product_discount_request_id: z.string().uuid().nullable(),
  customer_discount_request_id: z.string().uuid().nullable(),
  down_payment_cents: z.number().int().nonnegative().max(999_999_999_999),
  fixed_interest_cents: z.number().int().nonnegative().max(999_999_999_999),
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  installment_count: z.number().int().positive().max(MAX_INSTALLMENT_COUNT),
  first_due_date: z.string(),
})

const settingsSchema = z.object({
  default_daily_interest_cents: z.number().int().nonnegative().max(999_999_999_999),
  default_weekly_interest_cents: z.number().int().nonnegative().max(999_999_999_999),
  default_monthly_interest_cents: z.number().int().nonnegative().max(999_999_999_999),
  default_grace_period_days: z.number().int().nonnegative().max(2_147_483_647),
  fixed_late_fee_cents: z.number().int().nonnegative().max(999_999_999_999),
  daily_late_fee_cents: z.number().int().nonnegative().max(999_999_999_999),
  maximum_late_fee_cents: z.number().int().nonnegative().max(999_999_999_999),
  early_settlement_discount_type: z.enum(['fixed', 'interest_percentage']),
  early_settlement_fixed_discount_cents: z.number().int().nonnegative().max(999_999_999_999),
  early_settlement_interest_discount_percent: z.number().int().min(0).max(100),
})

const discountRequestSchema = z.object({
  discount_type: z.enum(['product', 'customer', 'early_settlement']),
  amount_cents: z.number().int().nonnegative().max(999_999_999_999).nullable(),
  reason: z.string().trim().min(2).max(500),
  customer_id: z.string().uuid().nullable(),
  agreement_id: z.string().uuid().nullable(),
}).superRefine((request, context) => {
  if (request.discount_type === 'early_settlement') {
    if (!request.agreement_id || request.customer_id || request.amount_cents !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['agreement_id'], message: 'Select an active agreement.' })
    }
  } else {
    if (request.agreement_id || request.amount_cents === null || request.amount_cents <= 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['amount_cents'], message: 'Enter a positive discount amount.' })
    }
    if (request.discount_type === 'customer' && !request.customer_id) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['customer_id'], message: 'Select a customer for this discount.' })
    }
  }
})

const discountDecisionSchema = z.object({
  reason: z.string().trim().max(500).optional().default(''),
})

const earlySettlementApprovalSchema = z.object({
  payment_method: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
})

const lateFeeWaiverSchema = z.object({
  reason: z.string().trim().min(2).max(500),
})

const staffInviteSchema = z.object({
  full_name: z.string().trim().min(2).max(200),
  email: z.string().trim().email().max(254),
  permissions: staffPermissionListSchema,
})

const reportQuerySchema = z.object({
  type: z.enum(reportTypes),
  from: isoDateSchema,
  to: isoDateSchema,
}).refine((value) => value.from <= value.to, {
  path: ['to'],
  message: 'End date must be on or after the start date.',
})

const activityQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  actor_id: z.string().uuid().optional(),
  action: z.string().trim().max(100).optional(),
}).refine((value) => value.from <= value.to, {
  path: ['to'],
  message: 'End date must be on or after the start date.',
})

type SettingsRow = {
  default_daily_interest: string | number
  default_weekly_interest: string | number
  default_monthly_interest: string | number
  default_grace_period_days: number
  fixed_late_fee: string | number
  daily_late_fee: string | number
  maximum_late_fee: string | number
  early_settlement_discount_type: 'fixed' | 'interest_percentage'
  early_settlement_fixed_discount: string | number
  early_settlement_interest_discount_percent: number
}

type AgreementInterestDefaults = Pick<
  SettingsRow,
  'default_daily_interest' | 'default_weekly_interest' | 'default_monthly_interest'
>

const APPLICATION_SETTINGS_COLUMNS = 'default_daily_interest, default_weekly_interest, default_monthly_interest, default_grace_period_days, fixed_late_fee, daily_late_fee, maximum_late_fee, early_settlement_discount_type, early_settlement_fixed_discount, early_settlement_interest_discount_percent'
const agreementInterestDefaultsSchema = z.object({
  default_daily_interest: z.string(),
  default_weekly_interest: z.string(),
  default_monthly_interest: z.string(),
})

function isOwner(role: string): role is 'owner' {
  return role === 'owner'
}

function toSettingsResponse(settings: SettingsRow) {
  return {
    default_daily_interest: settings.default_daily_interest,
    default_weekly_interest: settings.default_weekly_interest,
    default_monthly_interest: settings.default_monthly_interest,
    default_grace_period_days: settings.default_grace_period_days,
    fixed_late_fee: settings.fixed_late_fee,
    daily_late_fee: settings.daily_late_fee,
    maximum_late_fee: settings.maximum_late_fee,
    early_settlement_discount_type: settings.early_settlement_discount_type,
    early_settlement_fixed_discount: settings.early_settlement_fixed_discount,
    early_settlement_interest_discount_percent: settings.early_settlement_interest_discount_percent,
  }
}

function toAgreementDefaultsResponse(settings: AgreementInterestDefaults) {
  return {
    default_daily_interest: settings.default_daily_interest,
    default_weekly_interest: settings.default_weekly_interest,
    default_monthly_interest: settings.default_monthly_interest,
  }
}

function multiplyCents(unitPriceCents: number, quantity: number): number {
  const total = BigInt(unitPriceCents) * BigInt(quantity)
  if (total > 999_999_999_999n) throw new RangeError('Line total exceeds numeric(12,2) range')
  return Number(total)
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function transactionFailure(error: { code?: string; message?: string }): {
  error: string
  status: 400 | 403 | 404 | 409 | 502
} {
  if (error.code === '42501') return { error: 'You do not have permission to perform this operation.', status: 403 }
  if (error.code === 'P0002') {
    if (error.message?.includes('AGREEMENT_NOT_PAYABLE')
        || error.message?.includes('AGREEMENT_NOT_OPEN')
        || error.message?.includes('EARLY_SETTLEMENT_REQUEST_NOT_PENDING')
        || error.message?.includes('DISCOUNT_REQUEST_NOT_DECIDABLE')) {
      return { error: 'The agreement or request is no longer available for this action.', status: 409 }
    }
    return { error: 'The requested record was not found or is no longer available.', status: 404 }
  }
  if (error.code === '23505') {
    return { error: 'A matching action was already recorded. Refresh to see the latest status.', status: 409 }
  }
  if (error.code === 'P0001') {
    const stockItem = /^INSUFFICIENT_STOCK:(.+)$/.exec(error.message ?? '')
    return {
      error: stockItem ? `Insufficient stock for ${stockItem[1]}. Refresh inventory and try again.` :
        'The operation conflicts with current stock or payment balances.',
      status: 409,
    }
  }
  if (error.code === '22023') {
    if (error.message?.includes('IDEMPOTENCY_KEY_REUSED')) {
      return { error: 'This Idempotency-Key was already used for a different request.', status: 409 }
    }
    if (error.message?.includes('SETTLEMENT_QUOTE_CHANGED')) {
      return { error: 'The agreement balance changed after this request. Create a fresh settlement request.', status: 409 }
    }
    if (error.message?.includes('PAYMENT_EXCEEDS_BALANCE')) {
      return { error: 'Payment exceeds the agreement’s current outstanding balance. Refresh the schedule and try again.', status: 409 }
    }
    if (error.message?.includes('INVALID_PAYMENT_METHOD')) {
      return { error: 'The selected payment method is no longer active.', status: 400 }
    }
    if (error.message?.includes('DISCOUNT_ALREADY_USED')
        || error.message?.includes('DISCOUNT_REQUEST_MISMATCH')
        || error.message?.includes('LATE_FEE_ALREADY_WAIVED_TODAY')
        || error.message?.includes('NO_LATE_FEE_TO_WAIVE')) {
      return { error: 'The request conflicts with current approvals or balances. Refresh and try again.', status: 409 }
    }
    if (error.message?.includes('APPROVED_DISCOUNT_REQUIRED')
        || error.message?.includes('DISCOUNT_ALREADY_USED_OR_NOT_APPROVED')) {
      return { error: 'Choose an approved, unused discount request.', status: 409 }
    }
    return { error: 'The submitted transaction is invalid.', status: 400 }
  }
  console.error('Transactional database operation failed', error.message ?? error.code ?? 'Unknown error')
  return { error: 'Unable to save the transaction.', status: 502 }
}

function createSupabase(env: Env, accessToken?: string): SupabaseClient | null {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined,
  })
}

function productJsonForRpc(product: z.infer<typeof productMetadataSchema>) {
  return {
    name: product.name,
    sku: product.sku,
    barcode: product.barcode,
    category_id: product.category_id,
    brand: product.brand,
    description: product.description,
    cost_price: centsToDatabaseDecimal(product.cost_price_cents),
    selling_price: centsToDatabaseDecimal(product.selling_price_cents),
    min_stock: product.min_stock,
    supplier: product.supplier,
    status: product.status,
  }
}

type ProductImageUpload = { path: string } | { error: string }

function isUploadedFile(value: unknown): value is File {
  return typeof value === 'object' && value !== null &&
    'arrayBuffer' in value && typeof value.arrayBuffer === 'function' &&
    'name' in value && typeof value.name === 'string' &&
    'type' in value && typeof value.type === 'string' &&
    'size' in value && typeof value.size === 'number'
}

async function uploadProductImage(supabase: SupabaseClient, file: File): Promise<ProductImageUpload> {
  const extensions: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  }
  if (!extensions[file.type] || file.size < 1 || file.size > 2 * 1024 * 1024) {
    return { error: 'Choose a JPEG, PNG, or WebP image no larger than 2 MB.' }
  }
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch {
    return { error: 'Unable to read the uploaded image.' }
  }
  const path = `products/${crypto.randomUUID()}.${extensions[file.type]}`
  const { error } = await supabase.storage
    .from('product-images')
    .upload(path, bytes, { contentType: file.type, upsert: false })
  if (error) {
    console.error('Product image upload failed', error.message)
    return { error: 'Unable to upload the product image.' }
  }
  return { path }
}

async function removeProductImage(supabase: SupabaseClient, path: string): Promise<string | null> {
  const { error } = await supabase.storage.from('product-images').remove([path])
  if (!error) return null
  console.error('Product image cleanup failed', error.message)
  return 'Product details were saved, but an unused image could not be removed from storage.'
}

function productWriteError(error: { code?: string; message?: string }): { error: string; status: 400 | 403 | 404 | 409 | 502 } {
  if (error.code === '23505') {
    const message = error.message?.toLowerCase() ?? ''
    return {
      error: message.includes('barcode') ? 'A product with this barcode already exists.' : 'A product with this SKU already exists.',
      status: 409,
    }
  }
  if (error.code === '23503') return { error: 'Choose a valid product category.', status: 400 }
  if (error.code === '42501') return { error: 'You do not have permission to manage products.', status: 403 }
  if (error.code === 'P0002') return { error: 'Product not found.', status: 404 }
  console.error('Product catalog write failed', error.message ?? error.code ?? 'Unknown error')
  return { error: 'Unable to save product details.', status: 502 }
}

app.get('/health', (c) => c.json({
  ok: true,
  app: 'acceseries-api',
  environment: c.env.APP_ENV ?? 'development',
  time: new Date().toISOString(),
}))

app.use('/api/*', async (c, next) => {
  const authorization = c.req.header('Authorization')
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '')
  if (!match) return c.json({ error: 'Authentication required.' }, 401)

  const supabase = createSupabase(c.env, match[1])
  if (!supabase) return c.json({ error: 'Data service is not configured.' }, 503)

  const { data, error } = await supabase.auth.getUser(match[1])
  if (error || !data.user) return c.json({ error: 'Session is invalid or expired.' }, 401)

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('full_name, role_id, roles(name)')
    .eq('user_id', data.user.id)
    .maybeSingle()
  if (profileError) {
    console.error('Profile lookup failed', profileError.message)
    return c.json({ error: 'Unable to load your account permissions.' }, 502)
  }
  if (!profile) return c.json({ error: 'Your account does not have an assigned profile.' }, 403)
  const roleRecord = profile.roles as { name?: string } | null
  if (roleRecord?.name !== 'owner' && roleRecord?.name !== 'staff') {
    return c.json({ error: 'Your account role is not valid.' }, 403)
  }
  const role = roleRecord.name
  const [rolePermissions, permissionOverrides] = await Promise.all([
    supabase
    .from('role_permissions')
    .select('permissions(key)')
      .eq('role_id', profile.role_id),
    supabase
      .from('user_permissions')
      .select('granted, permissions(key)')
      .eq('user_id', data.user.id),
  ])
  const permissionsError = rolePermissions.error ?? permissionOverrides.error
  if (permissionsError) {
    console.error('Permission lookup failed', permissionsError.message)
    return c.json({ error: 'Unable to load your account permissions.' }, 502)
  }
  const permissionKeys = new Set((rolePermissions.data ?? []).map((row) => {
    const permission = row.permissions as { key?: string } | null
    return permission?.key
  }).filter((key): key is string => typeof key === 'string'))
  for (const row of permissionOverrides.data ?? []) {
    const permission = row.permissions as { key?: string } | null
    const key = permission?.key
    if (typeof key !== 'string') continue
    if (row.granted) permissionKeys.add(key)
    else permissionKeys.delete(key)
  }
  const effectivePermissions = [...permissionKeys]
  const apiUser: ApiUser = {
    id: data.user.id,
    email: data.user.email ?? '',
    name: typeof profile.full_name === 'string' ? profile.full_name : null,
    role,
    canManageProducts: role === 'owner' || permissionKeys.has('products:write'),
    permissions: effectivePermissions,
  }
  c.set('supabase', supabase)
  c.set('userId', data.user.id)
  c.set('role', role)
  c.set('canManageProducts', apiUser.canManageProducts)
  c.set('permissions', effectivePermissions)
  c.set('apiUser', apiUser)
  await next()
})

app.get('/api/auth/me', (c) => c.json(c.get('apiUser')))

app.get('/api/dashboard', async (c) => {
  const { data, error } = await c.get('supabase').rpc('get_dashboard_overview')
  if (error || !data) {
    console.error('Dashboard query failed', error?.message ?? 'No overview returned')
    return c.json({ error: 'Unable to load dashboard data.' }, 502)
  }
  const parsed = z.object({
    metrics: z.record(z.unknown()),
    charts: z.record(z.array(z.record(z.unknown()))),
    lists: z.record(z.array(z.record(z.unknown()))),
  }).safeParse(data)
  if (!parsed.success) {
    console.error('Dashboard RPC returned invalid data', parsed.error.message)
    return c.json({ error: 'Unable to verify dashboard data.' }, 502)
  }
  return c.json(parsed.data)
})

app.get('/api/notifications', async (c) => {
  const { data, error } = await c.get('supabase').rpc('get_notifications')
  if (error || !data) {
    console.error('Notification query failed', error?.message ?? 'No notification result returned')
    return c.json({ error: 'Unable to load notifications.' }, 502)
  }
  const parsed = z.object({
    items: z.array(z.object({
      id: z.string().uuid(),
      type: z.enum(['due_today', 'overdue', 'low_stock']),
      title: z.string(),
      description: z.string(),
      href: z.enum(['/collections', '/late-payments', '/products']),
      created_at: z.string(),
    })),
    due_today_count: z.number().int().nonnegative(),
    overdue_count: z.number().int().nonnegative(),
    low_stock_count: z.number().int().nonnegative(),
  }).safeParse(data)
  if (!parsed.success) {
    console.error('Notification RPC returned invalid data', parsed.error.message)
    return c.json({ error: 'Unable to verify notifications.' }, 502)
  }
  return c.json(parsed.data)
})

app.get('/api/reports', async (c) => {
  const parsedQuery = reportQuerySchema.safeParse(c.req.query())
  if (!parsedQuery.success) return c.json({ error: parsedQuery.error.flatten() }, 400)
  const permission = `reports:${parsedQuery.data.type}`
  if (!c.get('permissions').includes(permission)) {
    return c.json({ error: 'You do not have permission to view this report.' }, 403)
  }
  const { data, error } = await c.get('supabase').rpc('get_report', {
    p_report_type: parsedQuery.data.type,
    p_from: parsedQuery.data.from,
    p_to: parsedQuery.data.to,
  })
  if (error || !data) {
    const failure = transactionFailure(error ?? { message: 'No report data returned.' })
    return c.json({ error: failure.error }, failure.status)
  }
  const parsedReport = z.object({
    report_type: z.enum(reportTypes),
    from: isoDateSchema,
    to: isoDateSchema,
    columns: z.array(z.object({
      key: z.string(),
      label: z.string(),
      format: z.enum(['date', 'money', 'number', 'text']),
    })),
    rows: z.array(z.record(z.unknown())),
  }).safeParse(data)
  if (!parsedReport.success || parsedReport.data.report_type !== parsedQuery.data.type) {
    console.error('Report RPC returned invalid data', parsedReport.success ? 'Report type mismatch' : parsedReport.error.message)
    return c.json({ error: 'Unable to verify report data.' }, 502)
  }
  return c.json(parsedReport.data)
})

app.get('/api/staff', async (c) => {
  if (!isOwner(c.get('role'))) return c.json({ error: 'Only an owner can manage staff.' }, 403)
  const { data, error } = await c.get('supabase').rpc('get_managed_staff')
  if (error || !data) {
    console.error('Staff query failed', error?.message ?? 'No staff records returned')
    return c.json({ error: 'Unable to load staff accounts.' }, 502)
  }
  const parsed = z.array(z.object({
    id: z.string().uuid(),
    email: z.string(),
    full_name: z.string(),
    created_at: z.string(),
    permissions: z.array(z.string()),
  })).safeParse(data)
  if (!parsed.success) {
    console.error('Staff RPC returned invalid data', parsed.error.message)
    return c.json({ error: 'Unable to verify staff accounts.' }, 502)
  }
  return c.json(parsed.data)
})

app.post('/api/staff/invite', async (c) => {
  if (!isOwner(c.get('role'))) return c.json({ error: 'Only an owner can invite staff.' }, 403)
  const parsed = staffInviteSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  if (!c.env.SUPABASE_URL || !c.env.SUPABASE_SERVICE_ROLE_KEY) {
    return c.json({ error: 'Staff invitations require a configured Worker service-role secret.' }, 503)
  }
  const serviceClient = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data, error } = await serviceClient.auth.admin.inviteUserByEmail(
    parsed.data.email.toLowerCase(),
    { data: { full_name: parsed.data.full_name } },
  )
  if (error || !data.user) {
    console.error('Staff invitation failed', error?.message ?? 'No user returned')
    const duplicate = error?.message.toLowerCase().includes('already') ?? false
    return c.json({ error: duplicate ? 'An account with this email already exists.' : 'Unable to send the staff invitation.' }, duplicate ? 409 : 502)
  }
  const { error: permissionError } = await serviceClient.rpc('set_staff_permission_overrides', {
    p_user_id: data.user.id,
    p_permission_keys: parsed.data.permissions,
    p_actor_user_id: c.get('userId'),
  })
  if (permissionError) {
    console.error('Invited staff permission assignment failed', permissionError.message)
    return c.json({ error: 'The invitation was sent, but permissions could not be saved. Reopen Staff and retry the assignment.' }, 502)
  }
  return c.json({ id: data.user.id, email: data.user.email ?? parsed.data.email.toLowerCase() }, 201)
})

app.put('/api/staff/:userId/permissions', async (c) => {
  if (!isOwner(c.get('role'))) return c.json({ error: 'Only an owner can manage staff permissions.' }, 403)
  const userId = z.string().uuid().safeParse(c.req.param('userId'))
  if (!userId.success) return c.json({ error: 'Staff account ID is invalid.' }, 400)
  const parsed = z.object({ permissions: staffPermissionListSchema })
    .safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  if (!c.env.SUPABASE_URL || !c.env.SUPABASE_SERVICE_ROLE_KEY) {
    return c.json({ error: 'Staff permission updates require a configured Worker service-role secret.' }, 503)
  }
  const serviceClient = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error } = await serviceClient.rpc('set_staff_permission_overrides', {
    p_user_id: userId.data,
    p_permission_keys: parsed.data.permissions,
    p_actor_user_id: c.get('userId'),
  })
  if (error) {
    const failure = transactionFailure(error)
    if (failure.status !== 502) return c.json({ error: failure.error }, failure.status)
    console.error('Staff permission update failed', error.message)
    return c.json({ error: 'Unable to save staff permissions.' }, 502)
  }
  return c.json({ id: userId.data, permissions: parsed.data.permissions })
})

app.get('/api/activity-logs', async (c) => {
  if (!isOwner(c.get('role'))) return c.json({ error: 'Only an owner can view activity logs.' }, 403)
  const parsed = activityQuerySchema.safeParse(c.req.query())
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  const { data, error } = await c.get('supabase').rpc('get_activity_logs', {
    p_from: parsed.data.from,
    p_to: parsed.data.to,
    p_actor_id: parsed.data.actor_id ?? null,
    p_action: parsed.data.action || null,
    p_limit: 250,
  })
  if (error || !data) {
    const failure = transactionFailure(error ?? { message: 'No activity data returned.' })
    return c.json({ error: failure.error }, failure.status)
  }
  const parsedLogs = z.array(z.object({
    id: z.string().uuid(),
    action: z.string(),
    entity_type: z.string(),
    entity_id: z.string().uuid().nullable(),
    details: z.record(z.unknown()),
    created_at: z.string(),
    user_id: z.string().uuid().nullable(),
    actor: z.string(),
  })).safeParse(data)
  if (!parsedLogs.success) {
    console.error('Activity log RPC returned invalid data', parsedLogs.error.message)
    return c.json({ error: 'Unable to verify activity records.' }, 502)
  }
  return c.json(parsedLogs.data)
})

app.get('/api/customers', async (c) => {
  const supabase = c.get('supabase')
  const { data: snapshots, error: snapshotError } = await supabase
    .from('customer_balance_snapshots')
    .select('customer_id, balance, status, as_of')
  if (snapshotError) {
    console.error('Customer balance snapshot query failed', snapshotError.message)
    return c.json({ error: 'Unable to load customer balances.' }, 502)
  }
  const balanceCutover = snapshots?.[0]?.as_of
  let agreementQuery = supabase
    .from('agreements')
    .select('customer_id, total_repayment, down_payment, status, created_at, schedule:agreement_schedule(id, due_date, amount)')
    .eq('status', 'approved')
  let paymentQuery = supabase.from('payments')
    .select('id, customer_id, amount')
    .is('reversed_at', null)
    .is('sale_id', null)
  if (balanceCutover) {
    agreementQuery = agreementQuery.gt('created_at', balanceCutover)
    paymentQuery = paymentQuery.gt('collected_at', balanceCutover)
  }
  const [customers, agreements, payments, allocations] = await Promise.all([
    supabase
    .from('customers')
      .select('id, full_name, phone, created_at')
      .order('created_at', { ascending: false }),
    agreementQuery,
    paymentQuery,
    supabase.from('payment_allocations').select('payment_id, agreement_schedule_id, amount'),
  ])
  const error = customers.error ?? agreements.error ?? payments.error ?? allocations.error
  if (error) {
    console.error('Customer summary query failed', error.message)
    return c.json({ error: 'Unable to load customers.' }, 502)
  }
  const balances = new Map<string, number>(
    (snapshots ?? []).map((snapshot) => [
      snapshot.customer_id,
      databaseDecimalToCents(String(snapshot.balance)),
    ]),
  )
  const snapshotStatuses = new Map<string, 'active' | 'on_track' | 'overdue'>(
    (snapshots ?? []).map((snapshot) => [snapshot.customer_id, snapshot.status]),
  )
  for (const agreement of agreements.data ?? []) {
    const balanceCents = databaseDecimalToCents(agreement.total_repayment)
    balances.set(agreement.customer_id, (balances.get(agreement.customer_id) ?? 0) + balanceCents)
  }
  for (const payment of payments.data ?? []) {
    balances.set(
      payment.customer_id,
      (balances.get(payment.customer_id) ?? 0) - databaseDecimalToCents(payment.amount),
    )
  }
  const activePaymentIds = new Set((payments.data ?? []).map((payment) => payment.id))
  const allocatedBySchedule = new Map<string, number>()
  for (const allocation of allocations.data ?? []) {
    if (!allocation.agreement_schedule_id || !activePaymentIds.has(allocation.payment_id)) continue
    allocatedBySchedule.set(
      allocation.agreement_schedule_id,
      (allocatedBySchedule.get(allocation.agreement_schedule_id) ?? 0) +
        databaseDecimalToCents(allocation.amount),
    )
  }
  const today = new Date().toISOString().slice(0, 10)
  const overdueCustomers = new Set<string>()
  for (const agreement of agreements.data ?? []) {
    const schedule = agreement.schedule as Array<{ id: string; due_date: string; amount: string | number }> | null
    if (schedule?.some((installment) => installment.due_date < today &&
      (allocatedBySchedule.get(installment.id) ?? 0) < databaseDecimalToCents(String(installment.amount)))) {
      overdueCustomers.add(agreement.customer_id)
    }
  }
  return c.json((customers.data ?? []).map((customer) => {
    const balanceCents = Math.max(0, balances.get(customer.id) ?? 0)
    const status = overdueCustomers.has(customer.id) && balanceCents > 0
      ? 'overdue'
      : balanceCents > 0 ? (snapshotStatuses.get(customer.id) ?? 'on_track') : 'active'
    return {
      id: customer.id,
      full_name: customer.full_name,
      phone: customer.phone,
      current_balance: centsToDatabaseDecimal(balanceCents),
      status,
    }
  }))
})

app.post('/api/customers', async (c) => {
  const parsed = customerSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  const { data, error } = await c.get('supabase')
    .from('customers')
    .insert(parsed.data)
    .select('id, full_name, phone')
    .single()
  if (error) {
    console.error('Customer insert failed', error.message)
    return c.json({ error: error.code === '23505' ? 'A customer with this phone number already exists.' : 'Unable to save customer.' }, error.code === '23505' ? 409 : 502)
  }
  return c.json({ ...data, status: 'active', current_balance: '0.00' }, 201)
})

app.get('/api/products', async (c) => {
  const parsedQuery = z.object({
    include_archived: z.enum(['true', 'false']).optional(),
  }).safeParse(c.req.query())
  if (!parsedQuery.success) return c.json({ error: parsedQuery.error.flatten() }, 400)
  let query = c.get('supabase')
    .from('products')
    .select('id, name, sku, barcode, category_id, brand, description, image_path, cost_price, selling_price, quantity, min_stock, supplier, status, created_at, category_record:categories(name)')
    .order('created_at', { ascending: false })
  if (parsedQuery.data.include_archived !== 'true') query = query.eq('status', 'active')
  const { data, error } = await query
  if (error) {
    console.error('Product query failed', error.message)
    return c.json({ error: 'Unable to load products.' }, 502)
  }
  const products = await Promise.all((data ?? []).map(async (product) => {
    let imageUrl: string | null = null
    if (product.image_path) {
      const signed = await c.get('supabase').storage
        .from('product-images')
        .createSignedUrl(product.image_path, 3600)
      if (signed.error) {
        console.error('Product image URL query failed', signed.error.message)
        return { error: true as const }
      }
      imageUrl = signed.data.signedUrl
    }
    const categoryRecord = product.category_record as { name?: string } | null
    return {
      ...product,
      category: categoryRecord?.name ?? '',
      image_url: imageUrl,
      stock_level: getStockStatus(product.quantity, product.min_stock),
      price: product.selling_price,
      stock_quantity: product.quantity,
      reorder_level: product.min_stock,
    }
  }))
  if (products.some((product) => 'error' in product)) {
    return c.json({ error: 'Unable to load product images.' }, 502)
  }
  return c.json(products)
})

app.get('/api/categories', async (c) => {
  const { data, error } = await c.get('supabase')
    .from('categories')
    .select('id, name')
    .order('name', { ascending: true })
  if (error) {
    console.error('Category query failed', error.message)
    return c.json({ error: 'Unable to load product categories.' }, 502)
  }
  return c.json(data)
})

app.post('/api/categories', async (c) => {
  if (!c.get('canManageProducts')) return c.json({ error: 'You do not have permission to manage products.' }, 403)
  const schema = z.object({ name: z.string().trim().min(2).max(100) })
  const parsed = schema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Enter a category name with at least two characters.' }, 400)
  const { data, error } = await c.get('supabase')
    .from('categories')
    .insert({ name: parsed.data.name })
    .select('id, name')
    .single()
  if (error) {
    if (error.code === '23505') return c.json({ error: 'A category with this name already exists.' }, 409)
    console.error('Category insert failed', error.message)
    return c.json({ error: 'Unable to save product category.' }, 502)
  }
  return c.json(data, 201)
})

app.post('/api/products', async (c) => {
  if (!c.get('canManageProducts')) return c.json({ error: 'You do not have permission to manage products.' }, 403)
  let formData: FormData
  try {
    formData = await c.req.formData()
  } catch {
    return c.json({ error: 'Submit product details as multipart form data.' }, 400)
  }
  let rawProduct: unknown
  try {
    rawProduct = JSON.parse(String(formData.get('product') ?? ''))
  } catch {
    return c.json({ error: 'Product details are invalid.' }, 400)
  }
  const parsed = createProductSchema.safeParse(rawProduct)
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  const imageValue: unknown = formData.get('image')
  if (imageValue !== null && !isUploadedFile(imageValue)) {
    return c.json({ error: 'The product image is invalid.' }, 400)
  }

  const supabase = c.get('supabase')
  let imagePath: string | null = null
  if (isUploadedFile(imageValue)) {
    const upload = await uploadProductImage(supabase, imageValue)
    if ('error' in upload) return c.json({ error: upload.error }, 400)
    imagePath = upload.path
  }
  const { data, error } = await supabase.rpc('create_product_with_opening_stock', {
    p_product: { ...productJsonForRpc(parsed.data), quantity: parsed.data.quantity },
    p_image_path: imagePath,
  })
  if (error) {
    if (imagePath) await removeProductImage(supabase, imagePath)
    const failure = productWriteError(error)
    return c.json({ error: failure.error }, failure.status)
  }
  return c.json({ id: data }, 201)
})

app.put('/api/products/:id', async (c) => {
  if (!c.get('canManageProducts')) return c.json({ error: 'You do not have permission to manage products.' }, 403)
  const productId = z.string().uuid().safeParse(c.req.param('id'))
  if (!productId.success) return c.json({ error: 'Product ID is invalid.' }, 400)
  let formData: FormData
  try {
    formData = await c.req.formData()
  } catch {
    return c.json({ error: 'Submit product details as multipart form data.' }, 400)
  }
  let rawProduct: unknown
  try {
    rawProduct = JSON.parse(String(formData.get('product') ?? ''))
  } catch {
    return c.json({ error: 'Product details are invalid.' }, 400)
  }
  const parsed = productMetadataSchema.safeParse(rawProduct)
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  const imageValue: unknown = formData.get('image')
  const removeImage = formData.get('remove_image') === 'true'
  if ((imageValue !== null && !isUploadedFile(imageValue)) || (isUploadedFile(imageValue) && removeImage)) {
    return c.json({ error: 'Choose either a replacement image or remove the current image.' }, 400)
  }

  const supabase = c.get('supabase')
  const { data: current, error: currentError } = await supabase
    .from('products')
    .select('id, image_path')
    .eq('id', productId.data)
    .maybeSingle()
  if (currentError) {
    console.error('Product lookup failed', currentError.message)
    return c.json({ error: 'Unable to load product details.' }, 502)
  }
  if (!current) return c.json({ error: 'Product not found.' }, 404)

  let imagePath: string | null = null
  if (isUploadedFile(imageValue)) {
    const upload = await uploadProductImage(supabase, imageValue)
    if ('error' in upload) return c.json({ error: upload.error }, 400)
    imagePath = upload.path
  }
  const setImage = removeImage || imagePath !== null
  const { error } = await supabase.rpc('update_product_catalog', {
    p_product_id: productId.data,
    p_product: productJsonForRpc(parsed.data),
    p_image_path: imagePath,
    p_set_image: setImage,
  })
  if (error) {
    if (imagePath) await removeProductImage(supabase, imagePath)
    const failure = productWriteError(error)
    return c.json({ error: failure.error }, failure.status)
  }

  let warning: string | null = null
  if (current.image_path && setImage) warning = await removeProductImage(supabase, current.image_path)
  return c.json({ id: productId.data, warning })
})

app.post('/api/products/:id/archive', async (c) => {
  if (!c.get('canManageProducts')) return c.json({ error: 'You do not have permission to manage products.' }, 403)
  const productId = z.string().uuid().safeParse(c.req.param('id'))
  if (!productId.success) return c.json({ error: 'Product ID is invalid.' }, 400)
  const { error } = await c.get('supabase').rpc('archive_product', { p_product_id: productId.data })
  if (error) {
    const failure = productWriteError(error)
    return c.json({ error: failure.error }, failure.status)
  }
  return c.json({ id: productId.data })
})

app.get('/api/products/:id/stock-movements', async (c) => {
  const productId = z.string().uuid().safeParse(c.req.param('id'))
  if (!productId.success) return c.json({ error: 'Product ID is invalid.' }, 400)
  const { data, error } = await c.get('supabase')
    .from('stock_movements')
    .select('id, movement_type, qty, reason, user_id, created_at')
    .eq('product_id', productId.data)
    .order('created_at', { ascending: false })
  if (error) {
    console.error('Stock movement query failed', error.message)
    return c.json({ error: 'Unable to load stock movement history.' }, 502)
  }
  return c.json(data)
})

app.post('/api/products/:id/stock-movements', async (c) => {
  if (!c.get('canManageProducts')) return c.json({ error: 'You do not have permission to manage products.' }, 403)
  const productId = z.string().uuid().safeParse(c.req.param('id'))
  if (!productId.success) return c.json({ error: 'Product ID is invalid.' }, 400)
  const parsed = stockMovementSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  const { data, error } = await c.get('supabase').rpc('adjust_product_stock', {
    p_product_id: productId.data,
    p_movement_type: parsed.data.movement_type,
    p_qty: parsed.data.qty,
    p_reason: parsed.data.reason,
  })
  if (error) {
    if (error.message.includes('PRODUCT_ARCHIVED')) return c.json({ error: 'Archived products cannot receive stock changes.' }, 409)
    if (error.message.includes('STOCK_QUANTITY_LIMIT')) return c.json({ error: 'Quantity exceeds the supported stock limit.' }, 409)
    if (error.message.includes('PRODUCT_NOT_FOUND_OR_INSUFFICIENT_STOCK')) return c.json({ error: 'Product not found or adjustment would make stock negative.' }, 409)
    const failure = productWriteError(error)
    return c.json({ error: failure.error }, failure.status)
  }
  return c.json({ quantity: data })
})

app.get('/api/agreement-defaults', async (c) => {
  const { data, error } = await c.get('supabase').rpc('get_agreement_interest_defaults')
  const parsedDefaults = agreementInterestDefaultsSchema.safeParse(data)
  if (error || !parsedDefaults.success) {
    console.error('Agreement defaults query failed', error?.message ?? 'Invalid defaults response')
    return c.json({ error: 'Unable to load agreement defaults. Apply the application settings schema first.' }, 502)
  }
  return c.json(toAgreementDefaultsResponse(parsedDefaults.data))
})

app.get('/api/application-settings', async (c) => {
  if (!isOwner(c.get('role'))) return c.json({ error: 'Only an owner can view application settings.' }, 403)

  const { data, error } = await c.get('supabase')
    .from('application_settings')
    .select(APPLICATION_SETTINGS_COLUMNS)
    .eq('id', 'default')
    .single()
  if (error || !data) {
    console.error('Application settings query failed', error?.message ?? 'No settings row')
    return c.json({ error: 'Unable to load application settings.' }, 502)
  }
  return c.json(toSettingsResponse(data))
})

app.put('/api/application-settings', async (c) => {
  if (!isOwner(c.get('role'))) return c.json({ error: 'Only an owner can update application settings.' }, 403)

  const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  const settings = parsed.data
  const { data, error } = await c.get('supabase').rpc('update_application_settings', {
    p_settings: {
      default_daily_interest: centsToDatabaseDecimal(settings.default_daily_interest_cents),
      default_weekly_interest: centsToDatabaseDecimal(settings.default_weekly_interest_cents),
      default_monthly_interest: centsToDatabaseDecimal(settings.default_monthly_interest_cents),
      default_grace_period_days: settings.default_grace_period_days,
      fixed_late_fee: centsToDatabaseDecimal(settings.fixed_late_fee_cents),
      daily_late_fee: centsToDatabaseDecimal(settings.daily_late_fee_cents),
      maximum_late_fee: centsToDatabaseDecimal(settings.maximum_late_fee_cents),
      early_settlement_discount_type: settings.early_settlement_discount_type,
      early_settlement_fixed_discount: centsToDatabaseDecimal(settings.early_settlement_fixed_discount_cents),
      early_settlement_interest_discount_percent: settings.early_settlement_interest_discount_percent,
    },
  })
  if (error) {
    console.error('Application settings update failed', error.message)
    return c.json({ error: 'Unable to save application settings.' }, 502)
  }
  const parsedSettings = z.object({
    default_daily_interest: z.union([z.string(), z.number()]),
    default_weekly_interest: z.union([z.string(), z.number()]),
    default_monthly_interest: z.union([z.string(), z.number()]),
    default_grace_period_days: z.number().int(),
    fixed_late_fee: z.union([z.string(), z.number()]),
    daily_late_fee: z.union([z.string(), z.number()]),
    maximum_late_fee: z.union([z.string(), z.number()]),
    early_settlement_discount_type: z.enum(['fixed', 'interest_percentage']),
    early_settlement_fixed_discount: z.union([z.string(), z.number()]),
    early_settlement_interest_discount_percent: z.number().int().min(0).max(100),
  }).safeParse(data)
  if (!parsedSettings.success) {
    console.error('Application settings RPC returned invalid data')
    return c.json({ error: 'Unable to verify saved application settings.' }, 502)
  }
  return c.json(toSettingsResponse(parsedSettings.data))
})

app.get('/api/discounts/available', async (c) => {
  if (!c.get('permissions').includes('discounts:read')) {
    return c.json({ error: 'You do not have permission to view approved discounts.' }, 403)
  }
  const parsed = z.object({
    type: z.enum(['product', 'customer']).optional(),
    customer_id: z.string().uuid().optional(),
  }).safeParse(c.req.query())
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  const { data, error } = await c.get('supabase').rpc('get_available_discounts', {
    p_discount_type: parsed.data.type ?? null,
    p_customer_id: parsed.data.customer_id ?? null,
  })
  if (error || !data) {
    const failure = transactionFailure(error ?? { message: 'No approved discounts returned.' })
    return c.json({ error: failure.error }, failure.status)
  }
  const result = z.array(z.object({
    id: z.string().uuid(),
    discount_type: z.enum(['product', 'customer']),
    amount: z.string(),
    reason: z.string(),
    customer_id: z.string().uuid().nullable(),
  })).safeParse(data)
  if (!result.success) return c.json({ error: 'Unable to verify approved discounts.' }, 502)
  return c.json(result.data.map((discount) => ({
    ...discount,
    amount_cents: databaseDecimalToCents(discount.amount),
  })))
})

app.get('/api/discounts', async (c) => {
  if (!c.get('permissions').includes('discounts:read')) {
    return c.json({ error: 'You do not have permission to view discount requests.' }, 403)
  }
  const { data, error } = await c.get('supabase').rpc('get_discount_requests')
  if (error || !data) {
    const failure = transactionFailure(error ?? { message: 'No discount requests returned.' })
    return c.json({ error: failure.error }, failure.status)
  }
  const result = z.array(z.object({
    id: z.string().uuid(),
    discount_type: z.enum(['product', 'customer', 'early_settlement']),
    amount: z.string(),
    reason: z.string(),
    customer_id: z.string().uuid().nullable(),
    agreement_id: z.string().uuid().nullable(),
    status: z.enum(['pending', 'approved', 'rejected', 'applied', 'settled_early']),
    requester: z.string(),
    approver: z.string().nullable(),
    decision_at: z.string().nullable(),
    decision_reason: z.string().nullable(),
    approved_at: z.string().nullable(),
    applied_at: z.string().nullable(),
    payment_id: z.string().uuid().nullable(),
    quoted_principal: z.string().nullable(),
    quoted_interest: z.string().nullable(),
    quoted_late_fees: z.string().nullable(),
    quoted_settlement_amount: z.string().nullable(),
    created_at: z.string(),
  })).safeParse(data)
  if (!result.success) {
    console.error('Discount request RPC returned an invalid response')
    return c.json({ error: 'Unable to verify discount requests.' }, 502)
  }
  return c.json(result.data.map((request) => ({
    ...request,
    amount_cents: databaseDecimalToCents(request.amount),
    quoted_principal_cents: request.quoted_principal === null ? null : databaseDecimalToCents(request.quoted_principal),
    quoted_interest_cents: request.quoted_interest === null ? null : databaseDecimalToCents(request.quoted_interest),
    quoted_late_fees_cents: request.quoted_late_fees === null ? null : databaseDecimalToCents(request.quoted_late_fees),
    quoted_settlement_amount_cents: request.quoted_settlement_amount === null ? null : databaseDecimalToCents(request.quoted_settlement_amount),
  })))
})

app.post('/api/discounts', async (c) => {
  if (!c.get('permissions').includes('discounts:request')) {
    return c.json({ error: 'You do not have permission to request discounts.' }, 403)
  }
  const idempotencyKey = c.req.header('Idempotency-Key')
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return c.json({ error: 'A valid Idempotency-Key header is required.' }, 400)
  }
  const rawBody = await c.req.text().catch(() => '')
  let requestBody: unknown
  try {
    requestBody = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Discount request details are invalid.' }, 400)
  }
  const parsed = discountRequestSchema.safeParse(requestBody)
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  const request = parsed.data
  const { data, error } = await c.get('supabase').rpc('create_discount_request', {
    p_discount_type: request.discount_type,
    p_amount: request.amount_cents === null ? null : centsToDatabaseDecimal(request.amount_cents),
    p_reason: request.reason,
    p_customer_id: request.customer_id,
    p_agreement_id: request.agreement_id,
    p_idempotency_key: idempotencyKey,
    p_request_hash: await sha256Hex(rawBody),
  })
  if (error || !data) {
    const failure = transactionFailure(error ?? { message: 'No discount request ID returned.' })
    return c.json({ error: failure.error }, failure.status)
  }
  return c.json({ id: data }, 201)
})

app.post('/api/discounts/:id/approve', async (c) => {
  if (!isOwner(c.get('role'))) {
    return c.json({ error: 'Only an owner can approve discount requests.' }, 403)
  }
  const requestId = z.string().uuid().safeParse(c.req.param('id'))
  if (!requestId.success) return c.json({ error: 'Discount request ID is invalid.' }, 400)
  const idempotencyKey = c.req.header('Idempotency-Key')
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return c.json({ error: 'A valid Idempotency-Key header is required.' }, 400)
  }
  const rawBody = await c.req.text().catch(() => '')
  let requestBody: unknown
  try {
    requestBody = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Approval details are invalid.' }, 400)
  }
  const parsed = discountDecisionSchema.safeParse(requestBody)
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  const { data, error } = await c.get('supabase').rpc('decide_discount_request', {
    p_request_id: requestId.data,
    p_decision: 'approved',
    p_reason: parsed.data.reason,
    p_idempotency_key: idempotencyKey,
    p_request_hash: await sha256Hex(`${requestId.data}:${rawBody}`),
  })
  if (error || !data) {
    const failure = transactionFailure(error ?? { message: 'No discount request returned.' })
    return c.json({ error: failure.error }, failure.status)
  }
  return c.json({ id: data })
})

app.post('/api/discounts/:id/reject', async (c) => {
  if (!isOwner(c.get('role'))) {
    return c.json({ error: 'Only an owner can reject discount requests.' }, 403)
  }
  const requestId = z.string().uuid().safeParse(c.req.param('id'))
  if (!requestId.success) return c.json({ error: 'Discount request ID is invalid.' }, 400)
  const idempotencyKey = c.req.header('Idempotency-Key')
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return c.json({ error: 'A valid Idempotency-Key header is required.' }, 400)
  }
  const rawBody = await c.req.text().catch(() => '')
  let requestBody: unknown
  try {
    requestBody = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Rejection details are invalid.' }, 400)
  }
  const parsed = z.object({ reason: z.string().trim().min(2).max(500) }).safeParse(requestBody)
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  const { data, error } = await c.get('supabase').rpc('decide_discount_request', {
    p_request_id: requestId.data,
    p_decision: 'rejected',
    p_reason: parsed.data.reason,
    p_idempotency_key: idempotencyKey,
    p_request_hash: await sha256Hex(`${requestId.data}:${rawBody}`),
  })
  if (error || !data) {
    const failure = transactionFailure(error ?? { message: 'No discount request returned.' })
    return c.json({ error: failure.error }, failure.status)
  }
  return c.json({ id: data })
})

app.get('/api/agreements/:id/early-settlement-quote', async (c) => {
  if (!c.get('permissions').includes('payments:read')) {
    return c.json({ error: 'You do not have permission to view settlement balances.' }, 403)
  }
  const agreementId = z.string().uuid().safeParse(c.req.param('id'))
  if (!agreementId.success) return c.json({ error: 'Agreement ID is invalid.' }, 400)
  const { data, error } = await c.get('supabase').rpc('get_early_settlement_quote', {
    p_agreement_id: agreementId.data,
  })
  if (error || !data) {
    const failure = transactionFailure(error ?? { message: 'No settlement quote returned.' })
    return c.json({ error: failure.error }, failure.status)
  }
  const quote = z.object({
    agreement_id: z.string().uuid(),
    outstanding_principal: z.string(),
    outstanding_interest: z.string(),
    late_fees: z.string(),
    discount_type: z.enum(['fixed', 'interest_percentage']),
    discount_amount: z.string(),
    settlement_amount: z.string(),
  }).safeParse(data)
  if (!quote.success) return c.json({ error: 'Unable to verify settlement quote.' }, 502)
  return c.json({
    ...quote.data,
    outstanding_principal_cents: databaseDecimalToCents(quote.data.outstanding_principal),
    outstanding_interest_cents: databaseDecimalToCents(quote.data.outstanding_interest),
    late_fees_cents: databaseDecimalToCents(quote.data.late_fees),
    discount_amount_cents: databaseDecimalToCents(quote.data.discount_amount),
    settlement_amount_cents: databaseDecimalToCents(quote.data.settlement_amount),
  })
})

app.post('/api/discounts/:id/settle-early', async (c) => {
  if (!isOwner(c.get('role'))) {
    return c.json({ error: 'Only an owner can approve and settle early.' }, 403)
  }
  const requestId = z.string().uuid().safeParse(c.req.param('id'))
  if (!requestId.success) return c.json({ error: 'Discount request ID is invalid.' }, 400)
  const idempotencyKey = c.req.header('Idempotency-Key')
  if (!idempotencyKey || idempotencyKey.length > 180) {
    return c.json({ error: 'A valid Idempotency-Key header is required.' }, 400)
  }
  const rawBody = await c.req.text().catch(() => '')
  let requestBody: unknown
  try {
    requestBody = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Settlement approval details are invalid.' }, 400)
  }
  const parsed = earlySettlementApprovalSchema.safeParse(requestBody)
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  const { data, error } = await c.get('supabase').rpc('approve_early_settlement', {
    p_request_id: requestId.data,
    p_payment_method: parsed.data.payment_method,
    p_idempotency_key: idempotencyKey,
    p_request_hash: await sha256Hex(`${requestId.data}:${rawBody}`),
  })
  if (error || !data) {
    const failure = transactionFailure(error ?? { message: 'No settlement payment returned.' })
    return c.json({ error: failure.error }, failure.status)
  }
  return c.json({ payment_id: data })
})

app.get('/api/late-payments', async (c) => {
  if (!c.get('permissions').includes('payments:read')) {
    return c.json({ error: 'You do not have permission to view overdue installments.' }, 403)
  }
  const { data, error } = await c.get('supabase').rpc('get_late_payments')
  if (error || !data) {
    const failure = transactionFailure(error ?? { message: 'No late payments returned.' })
    return c.json({ error: failure.error }, failure.status)
  }
  const result = z.array(z.object({
    schedule_id: z.string().uuid(),
    agreement_id: z.string().uuid(),
    customer_id: z.string().uuid(),
    customer_name: z.string(),
    phone: z.string(),
    installment_number: z.number().int().positive(),
    due_date: z.string(),
    days_overdue: z.number().int().nonnegative(),
    principal_due: z.string(),
    interest_due: z.string(),
    late_fee_due: z.string(),
  })).safeParse(data)
  if (!result.success) return c.json({ error: 'Unable to verify overdue installments.' }, 502)
  return c.json(result.data.map((row) => ({
    ...row,
    principal_due_cents: databaseDecimalToCents(row.principal_due),
    interest_due_cents: databaseDecimalToCents(row.interest_due),
    late_fee_due_cents: databaseDecimalToCents(row.late_fee_due),
  })))
})

app.post('/api/late-payments/:scheduleId/waive', async (c) => {
  if (!isOwner(c.get('role'))) {
    return c.json({ error: 'Only an owner can waive late fees.' }, 403)
  }
  const scheduleId = z.string().uuid().safeParse(c.req.param('scheduleId'))
  if (!scheduleId.success) return c.json({ error: 'Installment ID is invalid.' }, 400)
  const idempotencyKey = c.req.header('Idempotency-Key')
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return c.json({ error: 'A valid Idempotency-Key header is required.' }, 400)
  }
  const rawBody = await c.req.text().catch(() => '')
  let requestBody: unknown
  try {
    requestBody = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Waiver details are invalid.' }, 400)
  }
  const parsed = lateFeeWaiverSchema.safeParse(requestBody)
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  const { data, error } = await c.get('supabase').rpc('waive_late_fee', {
    p_schedule_id: scheduleId.data,
    p_reason: parsed.data.reason,
    p_idempotency_key: idempotencyKey,
    p_request_hash: await sha256Hex(`${scheduleId.data}:${rawBody}`),
  })
  if (error || !data) {
    const failure = transactionFailure(error ?? { message: 'No waiver entry returned.' })
    return c.json({ error: failure.error }, failure.status)
  }
  return c.json({ id: data })
})

app.get('/api/agreements', async (c) => {
  const { data, error } = await c.get('supabase')
    .from('agreements')
    .select('id, customer_id, subtotal, product_discount, customer_discount, final_price, down_payment, remaining_principal, fixed_interest, total_repayment, frequency, installment_count, first_due_date, grace_period_days, fixed_late_fee, daily_late_fee, maximum_late_fee, status, created_at, customer:customers(full_name), schedule:agreement_schedule(installment_number, due_date, amount, interest_amount)')
    .order('created_at', { ascending: false })
  if (error) {
    console.error('Agreement query failed', error.message)
    return c.json({ error: 'Unable to load installment agreements.' }, 502)
  }
  return c.json(data)
})

app.post('/api/agreements', async (c) => {
  if (!c.get('permissions').includes('agreements:create')) {
    return c.json({ error: 'You do not have permission to create installment agreements.' }, 403)
  }
  const idempotencyKey = c.req.header('Idempotency-Key')
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return c.json({ error: 'A valid Idempotency-Key header is required.' }, 400)
  }
  let rawBody: string
  try {
    rawBody = await c.req.text()
  } catch {
    return c.json({ error: 'Agreement details are required.' }, 400)
  }
  let requestBody: unknown
  try {
    requestBody = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Agreement details are invalid.' }, 400)
  }
  const parsed = agreementSchema.safeParse(requestBody)
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  const body = parsed.data
  const supabase = c.get('supabase')
  const requestHash = await sha256Hex(rawBody)

  const [customerResult, productsResult] = await Promise.all([
    supabase.from('customers').select('id').eq('id', body.customer_id).maybeSingle(),
    supabase.from('products')
      .select('id, name, price, stock_quantity, reorder_level')
      .in('id', [...new Set(body.items.map((item) => item.product_id))]),
  ])
  const lookupError = customerResult.error ?? productsResult.error
  if (lookupError) {
    console.error('Agreement source data query failed', lookupError.message)
    return c.json({ error: 'Unable to verify agreement details.' }, 502)
  }
  if (!customerResult.data) return c.json({ error: 'The selected customer no longer exists.' }, 404)

  const productsById = new Map((productsResult.data ?? []).map((product) => [product.id, product]))
  if (productsById.size !== new Set(body.items.map((item) => item.product_id)).size) {
    return c.json({ error: 'One or more selected products no longer exist.' }, 409)
  }

  const requestedByProduct = new Map<string, number>()
  for (const item of body.items) {
    requestedByProduct.set(item.product_id, (requestedByProduct.get(item.product_id) ?? 0) + item.quantity)
  }
  for (const [productId, quantity] of requestedByProduct) {
    const product = productsById.get(productId)
    if (!product || quantity > product.stock_quantity) {
      return c.json({ error: `Insufficient stock for ${product?.name ?? 'a selected product'}. Refresh products and try again.` }, 409)
    }
  }

  let calculation: ReturnType<typeof calculateAgreement>
  let dueDates: string[]
  try {
    calculation = calculateAgreement({
      items: body.items.map((item) => ({
        unitPriceCents: databaseDecimalToCents(productsById.get(item.product_id)!.price),
        quantity: item.quantity,
      })),
      productDiscount: body.product_discount_cents,
      customerDiscount: body.customer_discount_cents,
      downPayment: body.down_payment_cents,
      fixedInterest: body.fixed_interest_cents,
      frequency: body.frequency,
      installmentCount: body.installment_count,
      firstDueDate: body.first_due_date,
    })
    dueDates = calculation.installmentAmounts.length > 0
      ? generateSchedule(body.first_due_date, body.frequency, calculation.installmentAmounts.length)
      : []
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Agreement values are invalid.'
    return c.json({ error: message }, 400)
  }

  const agreement = {
    customer_id: body.customer_id,
    subtotal: centsToDatabaseDecimal(calculation.subtotal),
    product_discount: centsToDatabaseDecimal(body.product_discount_cents),
    customer_discount: centsToDatabaseDecimal(body.customer_discount_cents),
    final_price: centsToDatabaseDecimal(calculation.finalPrice),
    down_payment: centsToDatabaseDecimal(body.down_payment_cents),
    remaining_principal: centsToDatabaseDecimal(calculation.remainingPrincipal),
    fixed_interest: centsToDatabaseDecimal(body.fixed_interest_cents),
    total_repayment: centsToDatabaseDecimal(calculation.totalRepayment),
    frequency: body.frequency,
    installment_count: body.installment_count,
    first_due_date: body.first_due_date,
    status: 'approved',
  }
  let agreementItems
  try {
    agreementItems = body.items.map((item) => {
      const product = productsById.get(item.product_id)!
      const unitPriceCents = databaseDecimalToCents(product.price)
      return {
        product_id: item.product_id,
        product_name: product.name,
        unit_price: centsToDatabaseDecimal(unitPriceCents),
        quantity: item.quantity,
        line_total: centsToDatabaseDecimal(multiplyCents(unitPriceCents, item.quantity)),
      }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Agreement values exceed supported limits.'
    return c.json({ error: message }, 400)
  }
  const schedule = calculation.installmentAmounts.map((amount, index) => ({
    installment_number: index + 1,
    due_date: dueDates[index],
    amount: centsToDatabaseDecimal(amount),
    interest_amount: centsToDatabaseDecimal(calculation.interestPerInstallment[index]),
  }))

  const { data: agreementId, error: createError } = await supabase.rpc('create_installment_agreement_with_discounts', {
    p_idempotency_key: idempotencyKey,
    p_request_hash: requestHash,
    p_agreement: agreement,
    p_items: agreementItems,
    p_schedule: schedule,
    p_product_discount_request_id: body.product_discount_request_id,
    p_customer_discount_request_id: body.customer_discount_request_id,
  })
  if (createError || !agreementId) {
    if (createError) {
      if (createError.message.includes('INSUFFICIENT_STOCK')) {
        return c.json({ error: 'Stock changed before the agreement was saved. Refresh products and try again.' }, 409)
      }
      const failure = transactionFailure(createError)
      return c.json({ error: failure.error }, failure.status)
    }
    console.error('Agreement creation failed', 'No agreement ID returned')
    return c.json({ error: 'Unable to save the installment agreement.' }, 502)
  }

  const { data, error } = await supabase
    .from('agreements')
    .select('id, customer_id, subtotal, product_discount, customer_discount, final_price, down_payment, remaining_principal, fixed_interest, total_repayment, frequency, installment_count, first_due_date, grace_period_days, fixed_late_fee, daily_late_fee, maximum_late_fee, status, created_at, customer:customers(full_name), schedule:agreement_schedule(installment_number, due_date, amount, interest_amount)')
    .eq('id', agreementId)
    .single()
  if (error) {
    console.error('Created agreement query failed', error.message)
    return c.json({ error: 'Agreement saved but could not be reloaded. Refresh the agreement list.' }, 502)
  }
  return c.json(data, 201)
})

const saleSelect = 'id, invoice_number, customer_id, total_amount, payment_type, payment_method, discount_amount, status, agreement_id, created_at, customer:customers(full_name, phone), items:sale_items(id, product_id, product_name, unit_price, quantity, line_total), payments(amount, payment_method, collected_at), agreement:agreements!sales_agreement_id_fkey(frequency, installment_count, fixed_interest, total_repayment)'

app.get('/api/sales/summary', async (c) => {
  if (!c.get('permissions').includes('sales:read')) {
    return c.json({ error: 'You do not have permission to view sales.' }, 403)
  }
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const daysSinceMonday = (start.getUTCDay() + 6) % 7
  start.setUTCDate(start.getUTCDate() - daysSinceMonday)
  const { data, error } = await c.get('supabase').rpc('get_sales_summary', {
    p_from: start.toISOString(),
  })
  if (error) {
    console.error('Sales summary query failed', error.message)
    return c.json({ error: 'Unable to load sales summary.' }, 502)
  }
  const summary = z.object({
    cash_sales_this_week_cents: z.string(),
    average_order_value_cents: z.string(),
    sales_count: z.number().int().nonnegative(),
  }).safeParse(data)
  if (!summary.success) {
    console.error('Sales summary RPC returned an invalid response')
    return c.json({ error: 'Unable to verify sales summary.' }, 502)
  }
  return c.json(summary.data)
})

app.get('/api/sales', async (c) => {
  if (!c.get('permissions').includes('sales:read')) {
    return c.json({ error: 'You do not have permission to view sales.' }, 403)
  }
  const parsed = salesListSchema.safeParse(c.req.query())
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  const { page, page_size: pageSize, search, from, to, status } = parsed.data
  const supabase = c.get('supabase')
  let saleIds: string[] | null = null
  const term = search?.trim().replace(/[^a-z0-9\s-]/gi, '').slice(0, 80)
  if (term) {
    const [invoiceMatches, customerMatches, itemMatches] = await Promise.all([
      supabase.from('sales').select('id').ilike('invoice_number', `%${term}%`).limit(1000),
      supabase.from('customers').select('id').or(`full_name.ilike.%${term}%,phone.ilike.%${term}%`).limit(1000),
      supabase.from('sale_items').select('sale_id').ilike('product_name', `%${term}%`).limit(1000),
    ])
    const searchError = invoiceMatches.error ?? customerMatches.error ?? itemMatches.error
    if (searchError) {
      console.error('Sales search query failed', searchError.message)
      return c.json({ error: 'Unable to search sales.' }, 502)
    }
    const customerIds = (customerMatches.data ?? []).map((customer) => customer.id)
    const [customerSales, exactId] = await Promise.all([
      customerIds.length > 0
        ? supabase.from('sales').select('id').in('customer_id', customerIds).limit(1000)
        : Promise.resolve({ data: [], error: null }),
      z.string().uuid().safeParse(term).success
        ? supabase.from('sales').select('id').eq('id', term).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ])
    if (customerSales.error || exactId.error) {
      console.error('Sales search query failed', customerSales.error?.message ?? exactId.error?.message)
      return c.json({ error: 'Unable to search sales.' }, 502)
    }
    saleIds = [...new Set([
      ...(invoiceMatches.data ?? []).map((sale) => sale.id),
      ...(itemMatches.data ?? []).map((item) => item.sale_id),
      ...(customerSales.data ?? []).map((sale) => sale.id),
      ...(exactId.data ? [exactId.data.id] : []),
    ])]
    if (saleIds.length === 0) return c.json({ items: [], total: 0, page, page_size: pageSize })
  }
  let query = supabase.from('sales').select(saleSelect, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1)
  if (status !== 'all') query = query.eq('status', status)
  if (from) query = query.gte('created_at', `${from}T00:00:00.000Z`)
  if (to) query = query.lte('created_at', `${to}T23:59:59.999Z`)
  if (saleIds) query = query.in('id', saleIds)
  const { data, error, count } = await query
  if (error) {
    console.error('Sales list query failed', error.message)
    return c.json({ error: 'Unable to load sales.' }, 502)
  }
  return c.json({ items: data ?? [], total: count ?? 0, page, page_size: pageSize })
})

app.get('/api/sales/:id', async (c) => {
  if (!c.get('permissions').includes('sales:read')) {
    return c.json({ error: 'You do not have permission to view sales.' }, 403)
  }
  const saleId = z.string().uuid().safeParse(c.req.param('id'))
  if (!saleId.success) return c.json({ error: 'Sale ID is invalid.' }, 400)
  const { data, error } = await c.get('supabase').from('sales')
    .select(saleSelect)
    .eq('id', saleId.data)
    .maybeSingle()
  if (error) {
    console.error('Sale detail query failed', error.message)
    return c.json({ error: 'Unable to load sale details.' }, 502)
  }
  if (!data) return c.json({ error: 'Sale not found.' }, 404)
  return c.json(data)
})

app.get('/api/payments/methods', async (c) => {
  if (!c.get('permissions').includes('payments:read')) {
    return c.json({ error: 'You do not have permission to view payment methods.' }, 403)
  }
  const { data, error } = await c.get('supabase').from('payment_methods')
    .select('key, name')
    .eq('active', true)
    .order('name')
  if (error) {
    console.error('Payment methods query failed', error.message)
    return c.json({ error: 'Unable to load payment methods.' }, 502)
  }
  return c.json(data ?? [])
})

app.get('/api/payments/customers', async (c) => {
  if (!c.get('permissions').includes('payments:read')) {
    return c.json({ error: 'You do not have permission to search customers.' }, 403)
  }
  const parsed = paymentCustomerSearchSchema.safeParse(c.req.query())
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  const term = parsed.data.search.replace(/[^\p{L}\p{N}\s-]/gu, '').slice(0, 100)
  if (!term) return c.json({ items: [] })
  const { data, error } = await c.get('supabase').from('customers')
    .select('id, full_name, phone')
    .or(`full_name.ilike.%${term}%,phone.ilike.%${term}%`)
    .order('full_name')
    .limit(20)
  if (error) {
    console.error('Payment customer search failed', error.message)
    return c.json({ error: 'Unable to search customers.' }, 502)
  }
  return c.json({ items: data ?? [] })
})

app.get('/api/payments/collection/:customerId', async (c) => {
  if (!c.get('permissions').includes('payments:read')) {
    return c.json({ error: 'You do not have permission to view collections.' }, 403)
  }
  const customerId = z.string().uuid().safeParse(c.req.param('customerId'))
  if (!customerId.success) return c.json({ error: 'Customer ID is invalid.' }, 400)
  const { data, error } = await c.get('supabase').rpc('get_customer_collection', {
    p_customer_id: customerId.data,
  })
  if (error || !data) {
    const failure = transactionFailure(error ?? { message: 'No collection data returned.' })
    return c.json({ error: failure.error }, failure.status)
  }
  const collectionSchema = z.object({
    allocation_order: z.array(z.enum(['late_fee', 'interest', 'principal'])),
    agreements: z.array(z.object({
      agreement_id: z.string().uuid(),
      agreement_reference: z.string(),
      frequency: z.enum(['daily', 'weekly', 'monthly']),
      installment_count: z.number().int().positive(),
      status: z.string(),
      outstanding_balance: z.string(),
      installments: z.array(z.object({
        id: z.string().uuid(),
        installment_number: z.number().int().positive(),
        due_date: z.string(),
        amount: z.string(),
        interest_amount: z.string(),
        late_fee_due: z.string(),
        interest_due: z.string(),
        principal_due: z.string(),
        outstanding_amount: z.string(),
        paid_amount: z.string(),
        status: z.enum(['pending', 'partial', 'overdue', 'paid']),
      })),
    })),
  }).safeParse(data)
  if (!collectionSchema.success) {
    console.error('Customer collection RPC returned an invalid response')
    return c.json({ error: 'Unable to verify outstanding installments.' }, 502)
  }
  return c.json(collectionSchema.data)
})

app.get('/api/payments/summary', async (c) => {
  if (!c.get('permissions').includes('payments:read')) {
    return c.json({ error: 'You do not have permission to view payment metrics.' }, 403)
  }
  const { data, error } = await c.get('supabase').rpc('get_payment_summary')
  if (error || !data) {
    const failure = transactionFailure(error ?? { message: 'No payment summary returned.' })
    return c.json({ error: failure.error }, failure.status)
  }
  const summary = z.object({
    collected_this_month_cents: z.string(),
    payments_this_month: z.number().int().nonnegative(),
    overdue_installments: z.number().int().nonnegative(),
  }).safeParse(data)
  if (!summary.success) {
    console.error('Payment summary RPC returned an invalid response')
    return c.json({ error: 'Unable to verify payment summary.' }, 502)
  }
  return c.json(summary.data)
})

app.get('/api/payments', async (c) => {
  if (!c.get('permissions').includes('payments:read')) {
    return c.json({ error: 'You do not have permission to view payments.' }, 403)
  }
  const parsed = paymentListSchema.safeParse(c.req.query())
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  const { page, page_size: pageSize } = parsed.data
  const { data, error, count } = await c.get('supabase').from('payments')
    .select(
      'id, receipt_number, customer_id, agreement_id, amount, payment_method, reference, collected_at, reversed_at, reversal_reason, customer:customers(full_name)',
      { count: 'exact' },
    )
    .is('sale_id', null)
    .not('agreement_id', 'is', null)
    .order('collected_at', { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1)
  if (error) {
    console.error('Payment history query failed', error.message)
    return c.json({ error: 'Unable to load payment history.' }, 502)
  }
  return c.json({ items: data ?? [], total: count ?? 0, page, page_size: pageSize })
})

app.get('/api/payments/:paymentId', async (c) => {
  if (!c.get('permissions').includes('payments:read')) {
    return c.json({ error: 'You do not have permission to view payment receipts.' }, 403)
  }
  const paymentId = z.string().uuid().safeParse(c.req.param('paymentId'))
  if (!paymentId.success) return c.json({ error: 'Payment ID is invalid.' }, 400)
  const { data, error } = await c.get('supabase').rpc('get_payment_receipt', {
    p_payment_id: paymentId.data,
  })
  if (error || !data) {
    const failure = transactionFailure(error ?? { message: 'No payment receipt returned.' })
    return c.json({ error: failure.error }, failure.status)
  }
  const receiptSchema = z.object({
    id: z.string().uuid(),
    receipt_number: z.string(),
    amount: z.string(),
    payment_method: z.string(),
    reference: z.string().nullable(),
    collected_at: z.string(),
    collected_by: z.string(),
    customer: z.object({ full_name: z.string(), phone: z.string() }).nullable(),
    agreement_reference: z.string().nullable(),
    allocations: z.object({
      late_fee: z.string(),
      interest: z.string(),
      principal: z.string(),
    }),
    remaining_balance: z.string(),
    reversed_at: z.string().nullable(),
    reversal_reason: z.string().nullable(),
  }).safeParse(data)
  if (!receiptSchema.success) {
    console.error('Payment receipt RPC returned an invalid response')
    return c.json({ error: 'Unable to verify payment receipt.' }, 502)
  }
  return c.json(receiptSchema.data)
})

app.post('/api/sales', async (c) => {
  if (!c.get('permissions').includes('sales:create')) {
    return c.json({ error: 'You do not have permission to create sales.' }, 403)
  }
  const idempotencyKey = c.req.header('Idempotency-Key')
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return c.json({ error: 'A valid Idempotency-Key header is required.' }, 400)
  }
  const rawBody = await c.req.text().catch(() => '')
  let requestBody: unknown
  try {
    requestBody = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Sale details are invalid.' }, 400)
  }
  const parsed = saleSchema.safeParse(requestBody)
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  const body = parsed.data
  if (body.payment_type === 'cash' && body.allow_negative_stock && !isOwner(c.get('role'))) {
    return c.json({ error: 'Only an owner can approve a stock override.' }, 403)
  }
  if (body.payment_type === 'installment' && !c.get('permissions').includes('agreements:create')) {
    return c.json({ error: 'You do not have permission to create installment agreements.' }, 403)
  }
  const supabase = c.get('supabase')
  const [customerResult, productsResult] = await Promise.all([
    body.customer_id
      ? supabase.from('customers').select('id').eq('id', body.customer_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase.from('products')
      .select('id, name, price, stock_quantity, reorder_level')
      .in('id', [...new Set(body.items.map((item) => item.product_id))]),
  ])
  const lookupError = customerResult.error ?? productsResult.error
  if (lookupError) {
    console.error('Sale source data query failed', lookupError.message)
    return c.json({ error: 'Unable to verify sale details.' }, 502)
  }
  if (body.payment_type === 'installment' && !customerResult.data) {
    return c.json({ error: 'Select a valid customer for an installment sale.' }, 400)
  }
  const productsById = new Map((productsResult.data ?? []).map((product) => [product.id, product]))
  if (productsById.size !== new Set(body.items.map((item) => item.product_id)).size) {
    return c.json({ error: 'One or more selected products no longer exist.' }, 409)
  }
  let calculation: ReturnType<typeof calculateAgreement>
  try {
    calculation = calculateAgreement({
      items: body.items.map((item) => ({
        unitPriceCents: databaseDecimalToCents(productsById.get(item.product_id)!.price),
        quantity: item.quantity,
      })),
      productDiscount: body.discount_cents,
      customerDiscount: 0,
      downPayment: body.payment_type === 'installment' ? body.down_payment_cents : 0,
      fixedInterest: body.payment_type === 'installment' ? body.fixed_interest_cents : 0,
      frequency: body.payment_type === 'installment' ? body.frequency : 'monthly',
      installmentCount: body.payment_type === 'installment' ? body.installment_count : 1,
      firstDueDate: body.payment_type === 'installment' ? body.first_due_date : new Date().toISOString().slice(0, 10),
    })
  } catch (reason) {
    return c.json({ error: reason instanceof Error ? reason.message : 'Sale totals are invalid.' }, 400)
  }

  let rpcResult
  if (body.payment_type === 'cash') {
    rpcResult = await supabase.rpc('create_sale_with_discount', {
      p_sale: {
        customer_id: body.customer_id,
        payment_type: body.payment_type,
        payment_method: body.payment_method,
        discount_amount: centsToDatabaseDecimal(body.discount_cents),
      },
      p_items: body.items,
      p_allow_negative_stock: body.allow_negative_stock,
      p_idempotency_key: idempotencyKey,
      p_request_hash: await sha256Hex(rawBody),
      p_discount_type: body.discount_type,
      p_discount_request_id: body.discount_request_id,
    })
  } else {
    const dueDates = calculation.installmentAmounts.length > 0
      ? generateSchedule(body.first_due_date, body.frequency, calculation.installmentAmounts.length)
      : []
    const agreementItems = body.items.map((item) => {
      const product = productsById.get(item.product_id)!
      const unitPriceCents = databaseDecimalToCents(product.price)
      return {
        product_id: item.product_id,
        product_name: product.name,
        unit_price: centsToDatabaseDecimal(unitPriceCents),
        quantity: item.quantity,
        line_total: centsToDatabaseDecimal(multiplyCents(unitPriceCents, item.quantity)),
      }
    })
    const agreement = {
      customer_id: body.customer_id,
      subtotal: centsToDatabaseDecimal(calculation.subtotal),
      product_discount: centsToDatabaseDecimal(body.discount_type === 'product' ? body.discount_cents : 0),
      customer_discount: centsToDatabaseDecimal(body.discount_type === 'customer' ? body.discount_cents : 0),
      final_price: centsToDatabaseDecimal(calculation.finalPrice),
      down_payment: centsToDatabaseDecimal(body.down_payment_cents),
      remaining_principal: centsToDatabaseDecimal(calculation.remainingPrincipal),
      fixed_interest: centsToDatabaseDecimal(body.fixed_interest_cents),
      total_repayment: centsToDatabaseDecimal(calculation.totalRepayment),
      frequency: body.frequency,
      installment_count: body.installment_count,
      first_due_date: body.first_due_date,
      status: 'approved',
    }
    const schedule = calculation.installmentAmounts.map((amount, index) => ({
      installment_number: index + 1,
      due_date: dueDates[index],
      amount: centsToDatabaseDecimal(amount),
      interest_amount: centsToDatabaseDecimal(calculation.interestPerInstallment[index]),
    }))
    rpcResult = await supabase.rpc('create_installment_sale_with_discounts', {
      p_sale: { payment_method: body.payment_method },
      p_agreement: agreement,
      p_items: agreementItems,
      p_schedule: schedule,
      p_idempotency_key: idempotencyKey,
      p_request_hash: await sha256Hex(rawBody),
      p_product_discount_request_id: body.discount_type === 'product' ? body.discount_request_id : null,
      p_customer_discount_request_id: body.discount_type === 'customer' ? body.discount_request_id : null,
    })
  }
  if (rpcResult.error || !rpcResult.data) {
    const failure = transactionFailure(rpcResult.error ?? { message: 'No sale ID returned.' })
    return c.json({ error: failure.error }, failure.status)
  }
  const result = z.object({ sale_id: z.string().uuid(), agreement_id: z.string().uuid().nullable() })
    .safeParse(rpcResult.data)
  if (!result.success) {
    console.error('Sale RPC returned an invalid response')
    return c.json({ error: 'Sale saved, but its invoice could not be loaded.' }, 502)
  }
  const { data: sale, error: saleError } = await supabase.from('sales')
    .select(saleSelect)
    .eq('id', result.data.sale_id)
    .single()
  if (saleError) {
    console.error('Created sale query failed', saleError.message)
    return c.json({ error: 'Sale saved, but its invoice could not be loaded.' }, 502)
  }
  return c.json(sale, 201)
})

app.post('/api/payments', async (c) => {
  if (!c.get('permissions').includes('payments:write')) {
    return c.json({ error: 'You do not have permission to record payments.' }, 403)
  }
  const idempotencyKey = c.req.header('Idempotency-Key')
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return c.json({ error: 'A valid Idempotency-Key header is required.' }, 400)
  }
  const rawBody = await c.req.text().catch(() => '')
  let requestBody: unknown
  try {
    requestBody = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Payment details are invalid.' }, 400)
  }
  const parsed = paymentSchema.safeParse(requestBody)
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  const { data, error } = await c.get('supabase').rpc('record_payment', {
    p_agreement_id: parsed.data.agreement_id,
    p_amount: centsToDatabaseDecimal(parsed.data.amount_cents),
    p_payment_method: parsed.data.payment_method,
    p_reference: parsed.data.reference ?? null,
    p_idempotency_key: idempotencyKey,
    p_request_hash: await sha256Hex(rawBody),
  })
  if (error || !data) {
    const failure = transactionFailure(error ?? { message: 'No payment ID returned.' })
    return c.json({ error: failure.error }, failure.status)
  }
  return c.json({ id: data }, 201)
})

app.post('/api/payments/:id/reverse', async (c) => {
  if (!isOwner(c.get('role'))) {
    return c.json({ error: 'Only an owner can reverse payments.' }, 403)
  }
  const paymentId = z.string().uuid().safeParse(c.req.param('id'))
  if (!paymentId.success) return c.json({ error: 'Payment ID is invalid.' }, 400)
  const idempotencyKey = c.req.header('Idempotency-Key')
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return c.json({ error: 'A valid Idempotency-Key header is required.' }, 400)
  }
  const rawBody = await c.req.text().catch(() => '')
  let requestBody: unknown
  try {
    requestBody = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Reversal details are invalid.' }, 400)
  }
  const parsed = paymentReversalSchema.safeParse(requestBody)
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  const { data, error } = await c.get('supabase').rpc('reverse_payment', {
    p_payment_id: paymentId.data,
    p_reason: parsed.data.reason,
    p_idempotency_key: idempotencyKey,
    p_request_hash: await sha256Hex(`${paymentId.data}:${rawBody}`),
  })
  if (error || !data) {
    const failure = transactionFailure(error ?? { message: 'No payment ID returned.' })
    return c.json({ error: failure.error }, failure.status)
  }
  return c.json({ id: data })
})

app.post('/api/agreements/:id/settle', async (c) => {
  if (!c.get('permissions').includes('payments:write')) {
    return c.json({ error: 'You do not have permission to settle agreements.' }, 403)
  }
  const agreementId = z.string().uuid().safeParse(c.req.param('id'))
  if (!agreementId.success) return c.json({ error: 'Agreement ID is invalid.' }, 400)
  const idempotencyKey = c.req.header('Idempotency-Key')
  if (!idempotencyKey || idempotencyKey.length > 180) {
    return c.json({ error: 'A valid Idempotency-Key header is required.' }, 400)
  }
  const rawBody = await c.req.text().catch(() => '')
  let requestBody: unknown
  try {
    requestBody = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Settlement details are invalid.' }, 400)
  }
  const parsed = settlementSchema.safeParse(requestBody)
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
  const { data, error } = await c.get('supabase').rpc('settle_agreement', {
    p_agreement_id: agreementId.data,
    p_payment_method: parsed.data.payment_method,
    p_idempotency_key: idempotencyKey,
    p_request_hash: await sha256Hex(`${agreementId.data}:${rawBody}`),
  })
  if (error) {
    const failure = transactionFailure(error)
    return c.json({ error: failure.error }, failure.status)
  }
  return c.json({ payment_id: data })
})

async function runScheduledLateFeeAssessment(env: Env): Promise<void> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Scheduled late-fee assessment requires Supabase service credentials.')
  }
  const serviceClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data, error } = await serviceClient.rpc('assess_all_late_fees')
  if (error || typeof data !== 'number') {
    throw new Error(`Scheduled late-fee assessment failed: ${error?.message ?? 'Invalid RPC response.'}`)
  }
  console.info(`Scheduled late-fee assessment inserted ${data} fee entries.`)
}

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext) {
    context.waitUntil(runScheduledLateFeeAssessment(env))
  },
}
