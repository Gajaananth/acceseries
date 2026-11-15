import { centsToDatabaseDecimal, parseLkrToCents } from '../../shared/business'
import { productFormSchema, type Product, type ProductCategory, type ProductFormValues } from './productTypes'

const REQUIRED_HEADERS = ['sku', 'name', 'category', 'selling_price', 'quantity', 'min_stock']
const EXPORT_HEADERS = [
  'sku',
  'name',
  'barcode',
  'category',
  'brand',
  'description',
  'cost_price',
  'selling_price',
  'quantity',
  'min_stock',
  'supplier',
  'status',
]

export type ProductCsvRow = {
  line: number
  sku: string
  name: string
  values?: ProductFormValues
  errors: string[]
}

export type ProductCsvPreview = {
  rows: ProductCsvRow[]
  errors: string[]
}

function parseRecords(source: string): { records: string[][]; lines: number[] } {
  const text = source.replace(/^\uFEFF/, '')
  const records: string[][] = []
  const lines: number[] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  let line = 1
  let recordLine = 1

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += character
        if (character === '\n') line += 1
      }
      continue
    }

    if (character === '"' && field.length === 0) {
      quoted = true
    } else if (character === ',') {
      record.push(field)
      field = ''
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      record.push(field)
      if (record.some((value) => value.trim() !== '')) {
        records.push(record)
        lines.push(recordLine)
      }
      record = []
      field = ''
      line += 1
      recordLine = line
    } else {
      field += character
    }
  }

  if (quoted) throw new Error('The CSV contains an unclosed quoted field.')
  record.push(field)
  if (record.some((value) => value.trim() !== '')) {
    records.push(record)
    lines.push(recordLine)
  }
  return { records, lines }
}

function parseInteger(value: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(value.trim())) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

export function parseProductCsv(
  source: string,
  categories: readonly ProductCategory[],
  existingProducts: readonly Product[],
): ProductCsvPreview {
  let parsed: ReturnType<typeof parseRecords>
  try {
    parsed = parseRecords(source)
  } catch (error) {
    return { rows: [], errors: [error instanceof Error ? error.message : 'Unable to parse the CSV file.'] }
  }

  if (parsed.records.length === 0) return { rows: [], errors: ['The CSV file is empty.'] }
  const headers = parsed.records[0].map((header) => header.trim().toLowerCase())
  const missingHeaders = REQUIRED_HEADERS.filter((header) => !headers.includes(header))
  if (missingHeaders.length > 0) {
    return { rows: [], errors: [`Missing required columns: ${missingHeaders.join(', ')}.`] }
  }
  if (new Set(headers).size !== headers.length) {
    return { rows: [], errors: ['The CSV contains duplicate column names.'] }
  }

  const categoryIds = new Map(categories.map((category) => [category.name.trim().toLowerCase(), category.id]))
  const existingSkus = new Set(existingProducts.map((product) => product.sku.trim().toLowerCase()))
  const existingBarcodes = new Set(
    existingProducts.flatMap((product) => product.barcode ? [product.barcode.trim().toLowerCase()] : []),
  )
  const seenSkus = new Set<string>()
  const seenBarcodes = new Set<string>()

  const rows = parsed.records.slice(1).map((cells, index): ProductCsvRow => {
    const line = parsed.lines[index + 1]
    const row = Object.fromEntries(headers.map((header, column) => [header, (cells[column] ?? '').trim()]))
    const errors: string[] = []
    if (cells.length > headers.length) errors.push('This row has more values than the header.')
    const sku = row.sku ?? ''
    const name = row.name ?? ''
    const normalizedSku = sku.toLowerCase()
    if (existingSkus.has(normalizedSku) || seenSkus.has(normalizedSku)) errors.push('SKU already exists.')
    if (sku) seenSkus.add(normalizedSku)

    const barcode = row.barcode ?? ''
    const normalizedBarcode = barcode.toLowerCase()
    if (barcode && (existingBarcodes.has(normalizedBarcode) || seenBarcodes.has(normalizedBarcode))) {
      errors.push('Barcode already exists.')
    }
    if (barcode) seenBarcodes.add(normalizedBarcode)

    const categoryId = categoryIds.get((row.category ?? '').toLowerCase())
    if (!categoryId) errors.push(`Category "${row.category ?? ''}" does not exist.`)

    const costPriceCents = row.cost_price ? parseLkrToCents(row.cost_price) : 0
    const sellingPriceCents = parseLkrToCents(row.selling_price ?? '')
    if (costPriceCents === null || costPriceCents === undefined) errors.push('Cost price must be a valid LKR amount.')
    if (sellingPriceCents === null) errors.push('Selling price must be a valid LKR amount.')
    const quantity = parseInteger(row.quantity ?? '')
    const minStock = parseInteger(row.min_stock ?? '')
    if (quantity === undefined) errors.push('Quantity must be a non-negative whole number.')
    if (minStock === undefined) errors.push('Minimum stock must be a non-negative whole number.')

    const rawStatus = row.status || 'active'
    if (rawStatus !== 'active' && rawStatus !== 'archived') errors.push('Status must be active or archived.')

    const candidate = categoryId && costPriceCents !== null && costPriceCents !== undefined &&
        sellingPriceCents !== null && quantity !== undefined && minStock !== undefined &&
        (rawStatus === 'active' || rawStatus === 'archived')
      ? productFormSchema.safeParse({
        name,
        sku,
        barcode,
        category_id: categoryId,
        brand: row.brand ?? '',
        description: row.description ?? '',
        cost_price_cents: costPriceCents,
        selling_price_cents: sellingPriceCents,
        quantity,
        min_stock: minStock,
        supplier: row.supplier ?? '',
        status: rawStatus,
      })
      : undefined
    if (candidate && !candidate.success) {
      for (const issue of candidate.error.issues) {
        const message = issue.message
        if (!errors.includes(message)) errors.push(message)
      }
    }

    return { line, sku, name, values: candidate?.success ? candidate.data : undefined, errors }
  })

  return { rows, errors: [] }
}

function escapeCsvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

export function exportProductsCsv(products: readonly Product[]): string {
  const records = products.map((product) => [
    product.sku,
    product.name,
    product.barcode ?? '',
    product.category,
    product.brand ?? '',
    product.description ?? '',
    centsToDatabaseDecimal(parseLkrToCents(product.cost_price) ?? 0),
    centsToDatabaseDecimal(parseLkrToCents(product.selling_price) ?? 0),
    String(product.quantity),
    String(product.min_stock),
    product.supplier ?? '',
    product.status,
  ])
  return [EXPORT_HEADERS, ...records].map((record) => record.map(escapeCsvCell).join(',')).join('\r\n')
}
