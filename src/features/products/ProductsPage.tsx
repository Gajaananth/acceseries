import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, ArrowDownToLine, FileUp, FolderPlus, History, Package, Pencil, Plus, Search, SlidersHorizontal, Sparkles, Warehouse } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { Combobox, type ComboboxOption } from '../../components/ui/Combobox'
import { Modal } from '../../components/ui/Modal'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { apiRequest } from '../../lib/api'
import { databaseDecimalToCents, formatLkr } from '../../shared/business'
import { useAuth } from '../auth/authContext'
import { ErrorMessage, Loading, PageHeading } from '../dashboard/DashboardPage'
import { ProductForm } from './ProductForm'
import { ProductImportModal, StockHistoryModal, StockMovementModal } from './ProductModals'
import { seedDemoData } from './demoData'
import { exportProductsCsv, type ProductCsvRow } from './productCsv'
import type { Product, ProductCategory, ProductFormValues, ProductMutationPayload } from './productTypes'

type StockFilter = 'all' | 'low' | 'out'
type StatusFilter = 'all' | 'active' | 'archived'
type ProductWriteResult = { id: string; warning?: string | null }

const stockFilterOptions = [
  { value: 'all', label: 'All stock' },
  { value: 'low', label: 'Low' },
  { value: 'out', label: 'Out' },
] as const
const statusFilterOptions = [
  { value: 'all', label: 'All status' },
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
] as const

function toProductPayload(values: ProductFormValues): ProductMutationPayload {
  const nullableText = (value: string) => value.trim() || null
  return {
    ...values,
    name: values.name.trim(),
    sku: values.sku.trim(),
    barcode: nullableText(values.barcode),
    brand: nullableText(values.brand),
    description: nullableText(values.description),
    supplier: nullableText(values.supplier),
  }
}

function productFormData(values: ProductFormValues, image: File | null, includeQuantity: boolean): FormData {
  const payload = toProductPayload(values)
  let productJson: ProductMutationPayload | Omit<ProductMutationPayload, 'quantity'> = payload
  if (!includeQuantity) {
    const { quantity: _quantity, ...metadata } = payload
    productJson = metadata
  }
  const formData = new FormData()
  formData.append('product', JSON.stringify(productJson))
  if (image) formData.append('image', image)
  return formData
}

function stockLabel(product: Product): string {
  if (product.quantity === 0) return 'Out of stock'
  if (product.stock_level === 'low') return 'Low stock'
  return 'Healthy'
}

function stockColor(product: Product): string {
  if (product.quantity === 0) return 'bg-red-50 text-red-700'
  if (product.stock_level === 'low') return 'bg-amber-50 text-amber-800'
  return 'bg-emerald-50 text-emerald-700'
}

export function ProductsPage({ search }: { search: string }) {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const canManageProducts = user?.canManageProducts ?? false
  const [formOpen, setFormOpen] = useState(false)
  const [categoryModalOpen, setCategoryModalOpen] = useState(false)
  const [categoryName, setCategoryName] = useState('')
  const [demoSeedOpen, setDemoSeedOpen] = useState(false)
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<Product | null>(null)
  const [stockProduct, setStockProduct] = useState<Product | null>(null)
  const [historyProduct, setHistoryProduct] = useState<Product | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [categoryFilter, setCategoryFilter] = useState<string>('__all__')
  const [stockFilter, setStockFilter] = useState<StockFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [productSearch, setProductSearch] = useState('')
  const [notice, setNotice] = useState('')

  const products = useQuery({
    queryKey: ['products', 'include-archived'],
    queryFn: () => apiRequest<Product[]>('/api/products?include_archived=true'),
    refetchInterval: 50 * 60 * 1000,
  })
  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => apiRequest<ProductCategory[]>('/api/categories'),
  })
  const invalidateCatalog = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['products'] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    ])
  }
  const createProduct = useMutation({
    mutationFn: (formData: FormData) =>
      apiRequest<ProductWriteResult>('/api/products', { method: 'POST', body: formData }),
    onSuccess: async () => {
      await invalidateCatalog()
      setFormOpen(false)
      setNotice('Product added.')
    },
  })
  const updateProduct = useMutation({
    mutationFn: ({ id, formData }: { id: string; formData: FormData }) =>
      apiRequest<ProductWriteResult>(`/api/products/${id}`, { method: 'PUT', body: formData }),
    onSuccess: async (result) => {
      await invalidateCatalog()
      setFormOpen(false)
      setEditingProduct(null)
      setNotice(result.warning ?? 'Product updated.')
    },
  })
  const createCategory = useMutation({
    mutationFn: (name: string) =>
      apiRequest<ProductCategory>('/api/categories', {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['categories'] })
    },
  })
  const demoSeed = useMutation({
    mutationFn: seedDemoData,
    onSuccess: async (result) => {
      await Promise.all([
        invalidateCatalog(),
        queryClient.invalidateQueries({ queryKey: ['categories'] }),
        queryClient.invalidateQueries({ queryKey: ['customers'] }),
      ])
      setDemoSeedOpen(false)
      setNotice(`Demo data ready: ${result.categories} categories, ${result.products} products with images, ${result.customers} customers, ${result.sales} sales, ${result.payments} payment, and ${result.discounts} discount requests.`)
    },
  })
  const archiveProduct = useMutation({
    mutationFn: (id: string) =>
      apiRequest<ProductWriteResult>(`/api/products/${id}/archive`, { method: 'POST' }),
    onSuccess: async () => {
      await invalidateCatalog()
      setArchiveTarget(null)
      setNotice('Product archived.')
    },
  })
  const stockMovement = useMutation({
    mutationFn: ({ productId, movement }: {
      productId: string
      movement: { movement_type: 'stock_in' | 'adjust'; qty: number; reason: string }
    }) => apiRequest<{ quantity: number }>(`/api/products/${productId}/stock-movements`, {
      method: 'POST',
      body: JSON.stringify(movement),
    }),
    onSuccess: async (_result, variables) => {
      await invalidateCatalog()
      await queryClient.invalidateQueries({ queryKey: ['stock-movements', variables.productId] })
      setStockProduct(null)
      setNotice('Stock movement recorded.')
    },
  })

  const categoryOptions: ComboboxOption<string>[] = [
    { value: '__all__', label: 'All categories' },
    ...(categories.data ?? []).map((category) => ({ value: category.id, label: category.name })),
  ]
  const filteredProducts = useMemo(() => {
    const query = `${search} ${productSearch}`.trim().toLocaleLowerCase()
    return (products.data ?? []).filter((product) => {
      const matchesSearch = !query ||
        `${product.name} ${product.sku} ${product.barcode ?? ''}`.toLocaleLowerCase().includes(query)
      const matchesCategory = categoryFilter === '__all__' || product.category_id === categoryFilter
      const matchesStock = stockFilter === 'all' ||
        (stockFilter === 'out' ? product.quantity === 0 : product.quantity > 0 && product.stock_level === 'low')
      const matchesStatus = statusFilter === 'all' || product.status === statusFilter
      return matchesSearch && matchesCategory && matchesStock && matchesStatus
    })
  }, [products.data, search, productSearch, categoryFilter, stockFilter, statusFilter])

  const openNewProduct = () => {
    createProduct.reset()
    updateProduct.reset()
    setEditingProduct(null)
    setFormOpen(true)
  }
  const openEditProduct = (product: Product) => {
    createProduct.reset()
    updateProduct.reset()
    setEditingProduct(product)
    setFormOpen(true)
  }
  const closeProductForm = () => {
    setFormOpen(false)
    setEditingProduct(null)
    createProduct.reset()
    updateProduct.reset()
  }
  const submitProduct = (values: ProductFormValues, image: File | null, removeImage: boolean) => {
    const formData = productFormData(values, image, !editingProduct)
    if (editingProduct) {
      if (removeImage) formData.append('remove_image', 'true')
      updateProduct.mutate({ id: editingProduct.id, formData })
    } else {
      createProduct.mutate(formData)
    }
  }
  const submitCategory = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    createCategory.mutate(categoryName.trim(), {
      onSuccess: () => {
        setCategoryName('')
        setCategoryModalOpen(false)
        setNotice('Category added.')
      },
    })
  }

  const downloadCsv = () => {
    const csv = `\uFEFF${exportProductsCsv(filteredProducts)}`
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'products.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  const importCsvRows = async (rows: readonly ProductCsvRow[]) => {
    const results = await Promise.all(rows.map(async (row) => {
      if (!row.values) return { line: row.line, sku: row.sku, error: 'Row data is invalid.' }
      try {
        await apiRequest<ProductWriteResult>('/api/products', {
          method: 'POST',
          body: productFormData(row.values, null, true),
        })
        return { line: row.line, sku: row.sku, error: null }
      } catch (error) {
        return {
          line: row.line,
          sku: row.sku,
          error: error instanceof Error ? error.message : 'Unable to import this product.',
        }
      }
    }))
    await invalidateCatalog()
    return results
  }

  const writeError = editingProduct ? updateProduct.error?.message : createProduct.error?.message
  const writePending = createProduct.isPending || updateProduct.isPending

  return (
    <div className="min-w-0 space-y-6">
      <PageHeading title="Products" description="Manage product details, pricing, images, and stock movements." />
      {notice && (
        <div role="status" className="flex min-w-0 items-center justify-between gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <span className="min-w-0">{notice}</span>
          <button type="button" aria-label="Dismiss message" onClick={() => setNotice('')} className="shrink-0 rounded-lg px-2 py-1 font-semibold hover:bg-emerald-100">×</button>
        </div>
      )}
      <section className="min-w-0 rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm md:p-5">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-extrabold text-slate-900">Product catalog</h2>
            <div className="flex min-w-0 flex-wrap gap-2">
              <button type="button" onClick={downloadCsv} disabled={!products.data?.length} className="soft-button inline-flex items-center gap-2 disabled:opacity-50">
                <ArrowDownToLine size={16} aria-hidden="true" /> Export CSV
              </button>
              {canManageProducts && (
                <>
                  <button type="button" onClick={() => setImportOpen(true)} className="soft-button inline-flex items-center gap-2">
                    <FileUp size={16} aria-hidden="true" /> Import CSV
                  </button>
                  <button type="button" onClick={() => {
                    createCategory.reset()
                    setCategoryName('')
                    setCategoryModalOpen(true)
                  }} className="soft-button inline-flex items-center gap-2">
                    <FolderPlus size={16} aria-hidden="true" /> Add category
                  </button>
                  <button type="button" onClick={openNewProduct} className="rounded-2xl bg-[#247BDB] px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700">
                    <span className="inline-flex items-center gap-2"><Plus size={16} aria-hidden="true" /> Add product</span>
                  </button>
                  {user?.role === 'owner' && (
                    <button type="button" onClick={() => {
                      demoSeed.reset()
                      setDemoSeedOpen(true)
                    }} className="soft-button inline-flex items-center gap-2">
                      <Sparkles size={16} aria-hidden="true" /> Load sample data
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
          <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="relative min-w-0">
              <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
              <input className="field-input pl-9" type="search" value={productSearch} onChange={(event) => setProductSearch(event.target.value)} placeholder="Search name, SKU, barcode" aria-label="Search products by name, SKU, or barcode" />
            </div>
            <Combobox options={categoryOptions} value={categoryFilter} onChange={setCategoryFilter} ariaLabel="Filter by product category" />
            <div className="flex min-w-0 items-center gap-2">
              <SlidersHorizontal size={16} className="shrink-0 text-slate-400" aria-hidden="true" />
              <SegmentedControl options={stockFilterOptions} value={stockFilter} onChange={setStockFilter} ariaLabel="Filter by stock level" />
            </div>
            <SegmentedControl options={statusFilterOptions} value={statusFilter} onChange={setStatusFilter} ariaLabel="Filter by product status" />
          </div>
          {!canManageProducts && <p className="text-xs text-slate-500">You have read-only product access.</p>}
        </div>
      </section>

      {products.isPending || categories.isPending ? <Loading /> : products.isError ? (
        <ErrorMessage message={products.error.message} />
      ) : categories.isError ? (
        <ErrorMessage message={categories.error.message} />
      ) : filteredProducts.length === 0 ? (
        <section className="rounded-[28px] border border-dashed border-slate-300 bg-white px-5 py-12 text-center">
          <Package className="mx-auto text-slate-400" size={32} aria-hidden="true" />
          <h3 className="mt-3 font-bold text-slate-900">No matching products</h3>
          <p className="mt-1 text-sm text-slate-500">Try another search or filter.</p>
        </section>
      ) : (
        <section className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filteredProducts.map((product) => (
            <article key={product.id} className="min-w-0 overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-sm">
              <div className="relative aspect-[4/3] min-w-0 overflow-hidden bg-slate-100">
                {product.image_url ? (
                  <img src={product.image_url} alt={product.name} className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-slate-400">
                    <Package size={44} strokeWidth={1.4} aria-hidden="true" />
                  </div>
                )}
                <div className="absolute left-3 top-3 flex flex-wrap gap-2">
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${stockColor(product)}`}>{stockLabel(product)}</span>
                  {product.status === 'archived' && <span className="rounded-full bg-slate-800/80 px-2.5 py-1 text-xs font-semibold text-white">Archived</span>}
                </div>
              </div>
              <div className="min-w-0 space-y-3 p-4">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <h3 className="min-w-0 break-words font-bold text-slate-900">{product.name}</h3>
                    <span className="shrink-0 text-sm font-bold text-slate-900">{formatLkr(databaseDecimalToCents(product.selling_price))}</span>
                  </div>
                  <p className="mt-1 min-w-0 truncate text-xs text-slate-500">{product.sku}{product.barcode ? ` · ${product.barcode}` : ''}</p>
                  <p className="mt-1 min-w-0 truncate text-sm text-slate-600">{product.category}{product.brand ? ` · ${product.brand}` : ''}</p>
                </div>
                <div className="grid min-w-0 grid-cols-2 gap-3 border-t border-slate-100 pt-3 text-sm">
                  <div className="min-w-0"><span className="block text-xs text-slate-500">Cost</span><span className="font-semibold text-slate-800">{formatLkr(databaseDecimalToCents(product.cost_price))}</span></div>
                  <div className="min-w-0"><span className="block text-xs text-slate-500">Quantity</span><span className="font-semibold text-slate-800">{product.quantity} <span className="font-normal text-slate-500">/ min {product.min_stock}</span></span></div>
                </div>
                <div className="flex min-w-0 flex-wrap gap-2 border-t border-slate-100 pt-3">
                  <button type="button" onClick={() => setHistoryProduct(product)} className="soft-button inline-flex items-center gap-1.5 px-3 py-2 text-xs">
                    <History size={14} aria-hidden="true" /> History
                  </button>
                  {canManageProducts && (
                    <>
                      <button type="button" onClick={() => openEditProduct(product)} className="soft-button inline-flex items-center gap-1.5 px-3 py-2 text-xs">
                        <Pencil size={14} aria-hidden="true" /> Edit
                      </button>
                      {product.status === 'active' && (
                        <>
                          <button type="button" onClick={() => setStockProduct(product)} className="soft-button inline-flex items-center gap-1.5 px-3 py-2 text-xs">
                            <Warehouse size={14} aria-hidden="true" /> Stock-in / Adjust
                          </button>
                          <button type="button" onClick={() => {
                            archiveProduct.reset()
                            setArchiveTarget(product)
                          }} className="soft-button inline-flex items-center gap-1.5 px-3 py-2 text-xs text-red-700">
                            <Archive size={14} aria-hidden="true" /> Archive
                          </button>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            </article>
          ))}
        </section>
      )}

      {formOpen && (
        <Modal
          open={formOpen}
          onClose={closeProductForm}
          title={editingProduct ? 'Edit product' : 'Add product'}
          description={editingProduct ? 'Update catalog details. Change stock using Stock-in / Adjust.' : 'Enter product details and opening quantity.'}
          footer={(
            <div className="flex min-w-0 justify-end gap-3">
              <button type="button" onClick={closeProductForm} className="soft-button">Cancel</button>
              <button type="submit" form="product-form" disabled={writePending || createCategory.isPending} className="rounded-2xl bg-[#247BDB] px-4 py-3 text-sm font-semibold text-white disabled:opacity-60">
                {writePending ? 'Saving…' : editingProduct ? 'Save changes' : 'Save product'}
              </button>
            </div>
          )}
        >
          <ProductForm
            key={editingProduct?.id ?? 'new'}
            product={editingProduct ?? undefined}
            categories={categories.data ?? []}
            pending={writePending}
            serverError={writeError}
            onCreateCategory={(name) => createCategory.mutateAsync(name)}
            onSubmit={submitProduct}
          />
        </Modal>
      )}

      <Modal
        open={categoryModalOpen}
        onClose={() => setCategoryModalOpen(false)}
        title="Add category"
        description="Create a category for organizing products in your catalog."
        footer={(
          <div className="flex min-w-0 justify-end gap-3">
            <button type="button" onClick={() => setCategoryModalOpen(false)} className="soft-button">Cancel</button>
            <button type="submit" form="category-form" disabled={createCategory.isPending || categoryName.trim().length < 2} className="rounded-2xl bg-[#247BDB] px-4 py-3 text-sm font-semibold text-white disabled:opacity-60">
              {createCategory.isPending ? 'Saving…' : 'Save category'}
            </button>
          </div>
        )}
      >
        <form id="category-form" onSubmit={submitCategory} className="space-y-4">
          <label htmlFor="category-name" className="block text-sm font-medium text-slate-700">Category name</label>
          <input id="category-name" autoFocus maxLength={100} minLength={2} required value={categoryName} onChange={(event) => setCategoryName(event.target.value)} className="field-input" placeholder="e.g. Earrings" />
          {createCategory.isError && <p role="alert" className="text-sm font-medium text-red-700">{createCategory.error.message}</p>}
        </form>
      </Modal>
      <Modal
        open={demoSeedOpen}
        onClose={() => {
          if (!demoSeed.isPending) setDemoSeedOpen(false)
        }}
        title="Load sample data"
        description="Add five synthetic customers, four categories, eight illustrated products, two sales (including an overdue installment agreement), a partial payment, and discount requests. Existing records are left unchanged; demo records are reused on retries."
        footer={(
          <div className="flex min-w-0 justify-end gap-3">
            <button type="button" disabled={demoSeed.isPending} onClick={() => setDemoSeedOpen(false)} className="soft-button disabled:opacity-60">Cancel</button>
            <button type="button" disabled={demoSeed.isPending} onClick={() => demoSeed.mutate()} className="rounded-2xl bg-[#247BDB] px-4 py-3 text-sm font-semibold text-white disabled:opacity-60">
              {demoSeed.isPending ? 'Adding sample data…' : 'Add sample data'}
            </button>
          </div>
        )}
      >
        {demoSeed.isError && <p role="alert" className="text-sm font-medium text-red-700">{demoSeed.error.message}</p>}
        {demoSeed.isPending && <p role="status" className="text-sm text-slate-600">Uploading images and saving records. Keep this page open until it finishes.</p>}
      </Modal>

      <Modal
        open={Boolean(archiveTarget)}
        onClose={() => setArchiveTarget(null)}
        title="Archive product"
        description={archiveTarget ? `Archive ${archiveTarget.name}? It will no longer be available for new sales or agreements.` : undefined}
        footer={(
          <div className="flex min-w-0 justify-end gap-3">
            <button type="button" onClick={() => setArchiveTarget(null)} className="soft-button">Cancel</button>
            <button type="button" disabled={archiveProduct.isPending || !archiveTarget} onClick={() => archiveTarget && archiveProduct.mutate(archiveTarget.id)} className="rounded-2xl bg-red-700 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60">
              {archiveProduct.isPending ? 'Archiving…' : 'Archive product'}
            </button>
          </div>
        )}
      >
        {archiveProduct.isError && <p role="alert" className="text-sm font-medium text-red-700">{archiveProduct.error.message}</p>}
      </Modal>
      {stockProduct && (
        <StockMovementModal
          key={stockProduct.id}
          product={stockProduct}
          open
          onClose={() => {
            setStockProduct(null)
            stockMovement.reset()
          }}
          pending={stockMovement.isPending}
          error={stockMovement.error?.message}
          onSubmit={(movement) => stockMovement.mutate({ productId: stockProduct.id, movement })}
        />
      )}
      {historyProduct && <StockHistoryModal product={historyProduct} open onClose={() => setHistoryProduct(null)} />}
      {importOpen && (
        <ProductImportModal
          open
          onClose={() => setImportOpen(false)}
          categories={categories.data ?? []}
          products={products.data ?? []}
          onImport={importCsvRows}
        />
      )}
    </div>
  )
}
