import { z } from 'zod'

export const productFormSchema = z.object({
  name: z.string().trim().min(2, 'Enter a product name.').max(200),
  sku: z.string().trim().min(1, 'Enter an SKU.').max(64),
  barcode: z.string().trim().max(64),
  category_id: z.string().uuid('Choose a category.'),
  brand: z.string().trim().max(120),
  description: z.string().trim().max(2000),
  cost_price_cents: z.number().int().min(0, 'Cost cannot be negative.').max(999_999_999_999),
  selling_price_cents: z.number().int().min(0, 'Selling price cannot be negative.').max(999_999_999_999),
  quantity: z.number().int().min(0, 'Quantity must be a non-negative whole number.').max(2_147_483_647),
  min_stock: z.number().int().min(0, 'Minimum stock must be a non-negative whole number.').max(2_147_483_647),
  supplier: z.string().trim().max(200),
  status: z.enum(['active', 'archived']),
})

export type ProductFormValues = z.infer<typeof productFormSchema>

export type ProductMutationPayload = Omit<ProductFormValues, 'barcode' | 'brand' | 'description' | 'supplier'> & {
  barcode: string | null
  brand: string | null
  description: string | null
  supplier: string | null
}

export type Product = {
  id: string
  name: string
  sku: string
  barcode: string | null
  category_id: string
  category: string
  brand: string | null
  description: string | null
  image_path: string | null
  image_url: string | null
  cost_price: string
  selling_price: string
  quantity: number
  min_stock: number
  supplier: string | null
  status: 'active' | 'archived'
  stock_level: 'healthy' | 'low' | 'critical'
}

export type ProductCategory = {
  id: string
  name: string
}

export type StockMovement = {
  id: string
  movement_type: 'stock_in' | 'adjust'
  qty: number
  reason: string
  user_id: string | null
  created_at: string
}
