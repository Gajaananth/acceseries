import { apiRequest } from '../../lib/api'
import type { Product, ProductCategory, ProductFormValues } from './productTypes'

type DemoCustomer = {
  full_name: string
  phone: string
}

type DemoCustomerRecord = DemoCustomer & { id: string }

type DemoProduct = {
  name: string
  sku: string
  category: string
  kind: 'earbuds' | 'charger' | 'cable' | 'power_bank' | 'adapter'
  color: string
  cost: number
  price: number
  quantity: number
}

const demoCategoryNames = ['Headphones & Earbuds', 'Chargers', 'Cables', 'Power Banks', 'Adapters & Hubs']

const demoCustomers: DemoCustomer[] = [
  { full_name: 'Demo Customer 01', phone: '0000000101' },
  { full_name: 'Demo Customer 02', phone: '0000000102' },
  { full_name: 'Demo Customer 03', phone: '0000000103' },
  { full_name: 'Demo Customer 04', phone: '0000000104' },
  { full_name: 'Demo Customer 05', phone: '0000000105' },
]

const demoProducts: DemoProduct[] = [
  { name: 'Demo Wireless Bluetooth Headset', sku: 'DEMO-AU-001', category: 'Headphones & Earbuds', kind: 'earbuds', color: '#247BDB', cost: 450000, price: 690000, quantity: 18 },
  { name: 'Demo USB-C Wired Earphones', sku: 'DEMO-AU-002', category: 'Headphones & Earbuds', kind: 'earbuds', color: '#68778A', cost: 180000, price: 295000, quantity: 7 },
  { name: 'Demo 20W USB-C Wall Charger', sku: 'DEMO-CH-001', category: 'Chargers', kind: 'charger', color: '#22A06B', cost: 220000, price: 350000, quantity: 12 },
  { name: 'Demo 65W Laptop Charger', sku: 'DEMO-CH-002', category: 'Chargers', kind: 'charger', color: '#68778A', cost: 650000, price: 950000, quantity: 4 },
  { name: 'Demo Braided USB-C Cable 1m', sku: 'DEMO-CB-001', category: 'Cables', kind: 'cable', color: '#8574A8', cost: 80000, price: 145000, quantity: 15 },
  { name: 'Demo USB-A to USB-C Cable', sku: 'DEMO-CB-002', category: 'Cables', kind: 'cable', color: '#BD7191', cost: 55000, price: 99000, quantity: 3 },
  { name: 'Demo 10000mAh Power Bank', sku: 'DEMO-PB-001', category: 'Power Banks', kind: 'power_bank', color: '#22A06B', cost: 720000, price: 1050000, quantity: 20 },
  { name: 'Demo 20000mAh Power Bank', sku: 'DEMO-PB-002', category: 'Power Banks', kind: 'power_bank', color: '#247BDB', cost: 1100000, price: 1590000, quantity: 9 },
  { name: 'Demo 6-in-1 USB-C Hub', sku: 'DEMO-AD-001', category: 'Adapters & Hubs', kind: 'adapter', color: '#8574A8', cost: 580000, price: 890000, quantity: 11 },
  { name: 'Demo USB-C to HDMI Adapter', sku: 'DEMO-AD-002', category: 'Adapters & Hubs', kind: 'adapter', color: '#BD7191', cost: 250000, price: 399000, quantity: 6 },
]

type DemoSeedResult = {
  categories: number
  customers: number
  products: number
  sales: number
  payments: number
  discounts: number
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&apos;',
  })[character] ?? character)
}

function demoImageSvg(product: DemoProduct): string {
  const illustration = product.kind === 'earbuds'
    ? '<path d="M228 176a48 48 0 0 1 96 0v86h-32v-78a16 16 0 0 0-32 0v78h-32zM345 176a48 48 0 0 1 96 0v86h-32v-78a16 16 0 0 0-32 0v78h-32z" fill="currentColor"/><rect x="254" y="270" width="44" height="66" rx="22" fill="currentColor"/><rect x="371" y="270" width="44" height="66" rx="22" fill="currentColor"/>'
    : product.kind === 'charger'
      ? '<rect x="228" y="171" width="144" height="150" rx="28" fill="currentColor"/><path d="M267 171v-38m66 38v-38" stroke="currentColor" stroke-width="16"/><rect x="274" y="245" width="52" height="15" rx="7" fill="#fff"/><path d="M383 216h35" stroke="currentColor" stroke-width="12" stroke-linecap="round"/>'
      : product.kind === 'cable'
        ? '<path d="M199 204c35-66 94-66 101 0s-76 68-87 8 73-98 132-28c62 74-8 143-75 102" fill="none" stroke="currentColor" stroke-width="18" stroke-linecap="round"/><rect x="175" y="184" width="39" height="40" rx="9" fill="currentColor"/><rect x="250" y="276" width="42" height="34" rx="9" fill="currentColor"/><path d="M186 184v-14m17 14v-14m58 120v18m18-18v18" stroke="currentColor" stroke-width="8"/>'
        : product.kind === 'power_bank'
          ? '<rect x="205" y="165" width="190" height="158" rx="30" fill="currentColor"/><rect x="257" y="199" width="85" height="44" rx="9" fill="#fff"/><path d="m307 204-22 24h18l-7 12 27-27h-19z" fill="currentColor"/><circle cx="251" cy="278" r="7" fill="#fff"/><circle cx="278" cy="278" r="7" fill="#fff"/><circle cx="305" cy="278" r="7" fill="#fff"/><path d="M392 220h18" stroke="currentColor" stroke-width="13" stroke-linecap="round"/>'
          : '<rect x="202" y="202" width="196" height="74" rx="30" fill="currentColor"/><path d="M300 239c-16-80 32-87 69-87" fill="none" stroke="currentColor" stroke-width="14" stroke-linecap="round"/><rect x="356" y="136" width="50" height="31" rx="8" fill="currentColor"/><rect x="226" y="225" width="22" height="26" rx="4" fill="#fff"/><rect x="267" y="225" width="22" height="26" rx="4" fill="#fff"/><rect x="308" y="225" width="22" height="26" rx="4" fill="#fff"/><rect x="349" y="225" width="22" height="26" rx="4" fill="#fff"/>'

  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="450" viewBox="0 0 600 450">
    <rect width="600" height="450" rx="28" fill="#f7f3ed"/>
    <circle cx="300" cy="230" r="150" fill="${product.color}" opacity=".12"/>
    <g color="${product.color}" stroke-linecap="round" stroke-linejoin="round">${illustration}</g>
    <text x="300" y="385" text-anchor="middle" fill="#334155" font-family="Arial, sans-serif" font-size="19" font-weight="600">${escapeXml(product.name)}</text>
    <text x="300" y="415" text-anchor="middle" fill="#64748b" font-family="Arial, sans-serif" font-size="13" letter-spacing="3">ELECTRONICS ACCESSORY</text>
  </svg>`
}

async function createDemoImage(product: DemoProduct): Promise<File> {
  const objectUrl = URL.createObjectURL(new Blob([demoImageSvg(product)], { type: 'image/svg+xml' }))
  try {
    const image = new Image()
    const imageLoaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Unable to generate a sample product image.'))
    })
    image.src = objectUrl
    await imageLoaded
    const canvas = document.createElement('canvas')
    canvas.width = 600
    canvas.height = 450
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Unable to prepare a sample product image.')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('Unable to encode a sample product image.')
    return new File([blob], `${product.sku.toLowerCase()}.png`, { type: 'image/png' })
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

function toProductFormValues(product: DemoProduct, categoryId: string): ProductFormValues {
  return {
    name: product.name,
    sku: product.sku,
    barcode: '',
    category_id: categoryId,
    brand: 'Demo Collection',
    description: 'Synthetic sample record for testing. Safe to edit or archive.',
    cost_price_cents: product.cost,
    selling_price_cents: product.price,
    quantity: product.quantity,
    min_stock: 5,
    supplier: 'Demo Supplier',
    status: 'active',
  }
}

function postIdempotently<T>(path: string, key: string, payload: unknown): Promise<T> {
  return apiRequest<T>(path, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'Idempotency-Key': `acceseries-demo-v1-${key}` },
  })
}

export async function seedDemoData(): Promise<DemoSeedResult> {
  const [existingCategories, existingProducts, existingCustomers] = await Promise.all([
    apiRequest<ProductCategory[]>('/api/categories'),
    apiRequest<Product[]>('/api/products?include_archived=true'),
    apiRequest<DemoCustomerRecord[]>('/api/customers'),
  ])
  const categoryIds = new Map(existingCategories.map((category) => [category.name.toLowerCase(), category.id]))
  const productsBySku = new Map(existingProducts.map((product) => [product.sku.toLowerCase(), product]))
  const customersByPhone = new Map(existingCustomers.map((customer) => [customer.phone, customer]))

  for (const name of demoCategoryNames) {
    if (categoryIds.has(name.toLowerCase())) continue
    const category = await apiRequest<ProductCategory>('/api/categories', {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
    categoryIds.set(category.name.toLowerCase(), category.id)
  }

  for (const customer of demoCustomers) {
    const existing = customersByPhone.get(customer.phone)
    if (existing) {
      if (existing.full_name !== customer.full_name) {
        throw new Error(`The sample phone number ${customer.phone} is already assigned to another customer.`)
      }
      continue
    }
    const created = await apiRequest<DemoCustomerRecord>('/api/customers', {
      method: 'POST',
      body: JSON.stringify(customer),
    })
    customersByPhone.set(created.phone, created)
  }

  for (const product of demoProducts) {
    const existing = productsBySku.get(product.sku.toLowerCase())
    if (existing) {
      if (existing.name !== product.name) {
        throw new Error(`The sample SKU ${product.sku} is already assigned to another product.`)
      }
      continue
    }
    const categoryId = categoryIds.get(product.category.toLowerCase())
    if (!categoryId) throw new Error(`Sample category "${product.category}" is unavailable.`)
    const values = toProductFormValues(product, categoryId)
    const formData = new FormData()
    formData.append('product', JSON.stringify({
      ...values,
      barcode: null,
      brand: values.brand || null,
      description: values.description || null,
      supplier: values.supplier || null,
    }))
    formData.append('image', await createDemoImage(product))
    await apiRequest('/api/products', { method: 'POST', body: formData })
  }

  const [seededProducts, seededCustomers] = await Promise.all([
    apiRequest<Product[]>('/api/products?include_archived=true'),
    apiRequest<DemoCustomerRecord[]>('/api/customers'),
  ])
  const sampleCustomerByPhone = new Map(seededCustomers.map((customer) => [customer.phone, customer]))
  const sampleProductBySku = new Map(seededProducts.map((product) => [product.sku.toLowerCase(), product]))
  const firstCustomer = sampleCustomerByPhone.get(demoCustomers[0].phone)
  const secondCustomer = sampleCustomerByPhone.get(demoCustomers[1].phone)
  const cashProduct = sampleProductBySku.get('demo-au-001')
  const installmentProduct = sampleProductBySku.get('demo-pb-001')
  if (!firstCustomer || !secondCustomer || !cashProduct || !installmentProduct) {
    throw new Error('Sample customers or products could not be reloaded.')
  }

  const productDiscount = await postIdempotently<{ id: string }>('/api/discounts', 'product-discount', {
    discount_type: 'product',
    amount_cents: 10000,
    reason: 'Demo product discount',
    customer_id: null,
    agreement_id: null,
  })
  await postIdempotently(`/api/discounts/${productDiscount.id}/approve`, 'product-discount-approval', {
    reason: 'Approved for sample sale.',
  })

  const customerDiscount = await postIdempotently<{ id: string }>('/api/discounts', 'customer-discount', {
    discount_type: 'customer',
    amount_cents: 7500,
    reason: 'Demo customer discount',
    customer_id: secondCustomer.id,
    agreement_id: null,
  })
  await postIdempotently(`/api/discounts/${customerDiscount.id}/approve`, 'customer-discount-approval', {
    reason: 'Approved for sample installment sale.',
  })

  await postIdempotently('/api/discounts', 'pending-product-discount', {
    discount_type: 'product',
    amount_cents: 5000,
    reason: 'Demo discount awaiting approval',
    customer_id: null,
    agreement_id: null,
  })

  await postIdempotently<{ id: string; agreement_id: string | null }>('/api/sales', 'cash-sale', {
    customer_id: firstCustomer.id,
    payment_type: 'cash',
    discount_cents: 10000,
    discount_type: 'product',
    discount_request_id: productDiscount.id,
    allow_negative_stock: false,
    payment_method: 'cash',
    items: [{ product_id: cashProduct.id, quantity: 1 }],
  })

  const installmentSale = await postIdempotently<{ id: string; agreement_id: string | null }>('/api/sales', 'installment-sale', {
    customer_id: secondCustomer.id,
    payment_type: 'installment',
    discount_cents: 7500,
    discount_type: 'customer',
    discount_request_id: customerDiscount.id,
    down_payment_cents: 50000,
    fixed_interest_cents: 12000,
    frequency: 'monthly',
    installment_count: 4,
    first_due_date: '2026-10-15',
    payment_method: 'cash',
    items: [{ product_id: installmentProduct.id, quantity: 1 }],
  })
  if (!installmentSale.agreement_id) throw new Error('The sample installment sale did not create an agreement.')

  await postIdempotently('/api/payments', 'partial-payment', {
    agreement_id: installmentSale.agreement_id,
    amount_cents: 10000,
    payment_method: 'cash',
    reference: 'DEMO-PARTIAL-PAYMENT',
  })
  await postIdempotently('/api/discounts', 'early-settlement-discount', {
    discount_type: 'early_settlement',
    amount_cents: null,
    reason: 'Demo early-settlement request awaiting approval',
    customer_id: null,
    agreement_id: installmentSale.agreement_id,
  })

  return {
    categories: demoCategoryNames.length,
    customers: demoCustomers.length,
    products: demoProducts.length,
    sales: 2,
    payments: 1,
    discounts: 4,
  }
}
