import { describe, expect, it } from 'vitest'
import { exportProductsCsv, parseProductCsv } from './productCsv'
import type { Product, ProductCategory } from './productTypes'

const categories: ProductCategory[] = [{ id: '550e8400-e29b-41d4-a716-446655440000', name: 'Earrings' }]
const existingProducts: Product[] = [{
  id: 'existing',
  name: 'Silver hoops',
  sku: 'E-001',
  barcode: '0123',
  category_id: categories[0].id,
  category: 'Earrings',
  brand: null,
  description: null,
  image_path: null,
  image_url: null,
  cost_price: '100.00',
  selling_price: '150.00',
  quantity: 3,
  min_stock: 1,
  supplier: null,
  status: 'active',
  stock_level: 'healthy',
}]

describe('product CSV', () => {
  it('parses quoted cells, validates rows, and reports duplicate or malformed data by line', () => {
    const csv = [
      'sku,name,category,selling_price,quantity,min_stock,description',
      'E-002,"Pearl, drop",Earrings,250.50,4,1,"Light ""pearl"" drop"',
      'E-001,Duplicate,Earrings,150,1,1,',
      'E-003,Bad price,Earrings,not-money,1,1,',
      'E-004,Unknown category,Necklace,25,1,1,',
    ].join('\r\n')

    const preview = parseProductCsv(csv, categories, existingProducts)

    expect(preview.errors).toEqual([])
    expect(preview.rows[0].line).toBe(2)
    expect(preview.rows[0].values?.name).toBe('Pearl, drop')
    expect(preview.rows[0].values?.description).toBe('Light "pearl" drop')
    expect(preview.rows[0].values?.selling_price_cents).toBe(25_050)
    expect(preview.rows[1].errors).toContain('SKU already exists.')
    expect(preview.rows[2].errors).toContain('Selling price must be a valid LKR amount.')
    expect(preview.rows[3].errors).toContain('Category "Necklace" does not exist.')
  })

  it('rejects missing headers and unclosed quotes instead of silently skipping rows', () => {
    expect(parseProductCsv('sku,name', categories, []).errors[0]).toContain('Missing required columns')
    expect(parseProductCsv('sku,name,category,selling_price,quantity,min_stock\nA,"broken,Earrings,1,1,0', categories, []).errors)
      .toEqual(['The CSV contains an unclosed quoted field.'])
  })

  it('exports product data with proper quoting and exact decimal strings', () => {
    const csv = exportProductsCsv([{
      ...existingProducts[0],
      name: 'Silver, "classic" hoops',
      cost_price: '123.45',
      selling_price: '200.05',
    }])

    expect(csv.split('\r\n')[0]).toBe('sku,name,barcode,category,brand,description,cost_price,selling_price,quantity,min_stock,supplier,status')
    expect(csv.split('\r\n')[1]).toContain('"Silver, ""classic"" hoops"')
    expect(csv.split('\r\n')[1]).toContain(',123.45,200.05,3,1,')
  })
})
