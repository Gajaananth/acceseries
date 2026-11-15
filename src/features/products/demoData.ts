import { apiRequest } from '../../lib/api'
import type { Product, ProductCategory, ProductFormValues } from './productTypes'

type DemoCustomer = {
  full_name: string
  phone: string
}

type DemoProduct = {
  name: string
  sku: string
  category: string
  kind: 'earrings' | 'necklace' | 'bracelet' | 'hair'
  color: string
  cost: number
  price: number
  quantity: number
}

const demoCategoryNames = ['Demo Earrings', 'Demo Necklaces', 'Demo Bracelets', 'Demo Hair Accessories']

const demoCustomers: DemoCustomer[] = [
  { full_name: 'Demo Customer 01', phone: '0000000101' },
  { full_name: 'Demo Customer 02', phone: '0000000102' },
  { full_name: 'Demo Customer 03', phone: '0000000103' },
  { full_name: 'Demo Customer 04', phone: '0000000104' },
  { full_name: 'Demo Customer 05', phone: '0000000105' },
]

const demoProducts: DemoProduct[] = [
  { name: 'Demo Gold Hoop Earrings', sku: 'DEMO-ER-001', category: 'Demo Earrings', kind: 'earrings', color: '#b77932', cost: 120000, price: 180000, quantity: 18 },
  { name: 'Demo Pearl Drop Earrings', sku: 'DEMO-ER-002', category: 'Demo Earrings', kind: 'earrings', color: '#8574a8', cost: 155000, price: 240000, quantity: 7 },
  { name: 'Demo Silver Pendant Necklace', sku: 'DEMO-NE-001', category: 'Demo Necklaces', kind: 'necklace', color: '#708090', cost: 210000, price: 325000, quantity: 12 },
  { name: 'Demo Layered Chain Necklace', sku: 'DEMO-NE-002', category: 'Demo Necklaces', kind: 'necklace', color: '#b77932', cost: 265000, price: 390000, quantity: 4 },
  { name: 'Demo Charm Bracelet', sku: 'DEMO-BR-001', category: 'Demo Bracelets', kind: 'bracelet', color: '#bd7191', cost: 95000, price: 155000, quantity: 15 },
  { name: 'Demo Beaded Bracelet', sku: 'DEMO-BR-002', category: 'Demo Bracelets', kind: 'bracelet', color: '#658a79', cost: 70000, price: 125000, quantity: 3 },
  { name: 'Demo Pearl Hair Clip', sku: 'DEMO-HA-001', category: 'Demo Hair Accessories', kind: 'hair', color: '#8574a8', cost: 45000, price: 85000, quantity: 20 },
  { name: 'Demo Satin Hair Barrette', sku: 'DEMO-HA-002', category: 'Demo Hair Accessories', kind: 'hair', color: '#bd7191', cost: 55000, price: 99000, quantity: 9 },
]

type DemoSeedResult = {
  categories: number
  customers: number
  products: number
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
  const jewelry = product.kind === 'earrings'
    ? '<circle cx="238" cy="197" r="37" fill="none" stroke="currentColor" stroke-width="12"/><circle cx="362" cy="197" r="37" fill="none" stroke="currentColor" stroke-width="12"/><path d="M238 235v58m124-58v58" stroke="currentColor" stroke-width="10"/><circle cx="238" cy="310" r="18" fill="currentColor"/><circle cx="362" cy="310" r="18" fill="currentColor"/>'
    : product.kind === 'necklace'
      ? '<path d="M188 150c20 112 205 112 224 0" fill="none" stroke="currentColor" stroke-width="12"/><path d="M300 245v34" stroke="currentColor" stroke-width="10"/><path d="m300 272 27 30-27 34-27-34z" fill="currentColor"/>'
      : product.kind === 'bracelet'
        ? '<ellipse cx="300" cy="235" rx="124" ry="78" fill="none" stroke="currentColor" stroke-width="18"/><circle cx="300" cy="157" r="18" fill="currentColor"/><circle cx="424" cy="235" r="18" fill="currentColor"/><circle cx="300" cy="313" r="18" fill="currentColor"/><circle cx="176" cy="235" r="18" fill="currentColor"/>'
        : '<rect x="194" y="185" width="212" height="84" rx="42" fill="none" stroke="currentColor" stroke-width="14"/><path d="M224 227h152" stroke="currentColor" stroke-width="11"/><circle cx="248" cy="227" r="10" fill="currentColor"/><circle cx="300" cy="227" r="10" fill="currentColor"/><circle cx="352" cy="227" r="10" fill="currentColor"/>'

  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="450" viewBox="0 0 600 450">
    <rect width="600" height="450" rx="28" fill="#f7f3ed"/>
    <circle cx="300" cy="220" r="150" fill="${product.color}" opacity=".12"/>
    <g color="${product.color}" stroke-linecap="round" stroke-linejoin="round">${jewelry}</g>
    <text x="300" y="390" text-anchor="middle" fill="#334155" font-family="Arial, sans-serif" font-size="21" font-weight="600">${escapeXml(product.name)}</text>
    <text x="300" y="420" text-anchor="middle" fill="#64748b" font-family="Arial, sans-serif" font-size="13" letter-spacing="3">SAMPLE PRODUCT</text>
  </svg>`
}

async function createDemoImage(product: DemoProduct): Promise<File> {
  const objectUrl = URL.createObjectURL(new Blob([demoImageSvg(product)], { type: 'image/svg+xml' }))
  try {
    const image = new Image()
    image.src = objectUrl
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Unable to generate a sample product image.'))
    })
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

export async function seedDemoData(): Promise<DemoSeedResult> {
  const [existingCategories, existingProducts, existingCustomers] = await Promise.all([
    apiRequest<ProductCategory[]>('/api/categories'),
    apiRequest<Product[]>('/api/products?include_archived=true'),
    apiRequest<DemoCustomer[]>('/api/customers'),
  ])
  const categoryIds = new Map(existingCategories.map((category) => [category.name.toLowerCase(), category.id]))
  const existingSkus = new Set(existingProducts.map((product) => product.sku.toLowerCase()))
  const existingPhones = new Set(existingCustomers.map((customer) => customer.phone))
  const result: DemoSeedResult = { categories: 0, customers: 0, products: 0 }

  for (const name of demoCategoryNames) {
    if (categoryIds.has(name.toLowerCase())) continue
    const category = await apiRequest<ProductCategory>('/api/categories', {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
    categoryIds.set(category.name.toLowerCase(), category.id)
    result.categories += 1
  }

  for (const customer of demoCustomers) {
    if (existingPhones.has(customer.phone)) continue
    await apiRequest('/api/customers', {
      method: 'POST',
      body: JSON.stringify(customer),
    })
    result.customers += 1
  }

  for (const product of demoProducts) {
    if (existingSkus.has(product.sku.toLowerCase())) continue
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
    result.products += 1
  }

  return result
}
