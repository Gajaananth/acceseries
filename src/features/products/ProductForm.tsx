import { zodResolver } from '@hookform/resolvers/zod'
import { ImagePlus, Package, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { Combobox, type ComboboxOption } from '../../components/ui/Combobox'
import { FormField } from '../../components/ui/FormField'
import { MoneyInput } from '../../components/ui/MoneyInput'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { databaseDecimalToCents, formatLkr } from '../../shared/business'
import type { Product, ProductCategory, ProductFormValues } from './productTypes'
import { productFormSchema } from './productTypes'

const IMAGE_MAX_BYTES = 2 * 1024 * 1024
const ACCEPTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

type ProductFormProps = {
  product?: Product
  categories: readonly ProductCategory[]
  pending: boolean
  serverError?: string
  onCreateCategory: (name: string) => Promise<ProductCategory>
  onSubmit: (values: ProductFormValues, image: File | null, removeImage: boolean) => void
}

function resizeProductImage(file: File): Promise<File> {
  return new Promise((resolve, reject) => {
    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
      reject(new Error('Choose a JPEG, PNG, or WebP image.'))
      return
    }
    if (file.size > IMAGE_MAX_BYTES) {
      reject(new Error('The image must be 2 MB or smaller.'))
      return
    }
    if (typeof createImageBitmap !== 'function') {
      reject(new Error('Image resizing is not supported in this browser.'))
      return
    }

    createImageBitmap(file).then((bitmap) => {
      const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const context = canvas.getContext('2d')
      if (!context) {
        bitmap.close()
        reject(new Error('Unable to resize this image.'))
        return
      }
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      bitmap.close()
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Unable to resize this image.'))
          return
        }
        if (blob.size > IMAGE_MAX_BYTES) {
          reject(new Error('The resized image is larger than 2 MB. Choose a smaller image.'))
          return
        }
        const extension = file.type === 'image/jpeg' ? 'jpg' : file.type.split('/')[1]
        resolve(new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.${extension}`, { type: file.type }))
      }, file.type, file.type === 'image/png' ? undefined : 0.9)
    }).catch(() => reject(new Error('Unable to read this image file.')))
  })
}

function emptyValues(product?: Product): ProductFormValues {
  return {
    name: product?.name ?? '',
    sku: product?.sku ?? '',
    barcode: product?.barcode ?? '',
    category_id: product?.category_id ?? '',
    brand: product?.brand ?? '',
    description: product?.description ?? '',
    cost_price_cents: product ? databaseDecimalToCents(product.cost_price) : 0,
    selling_price_cents: product ? databaseDecimalToCents(product.selling_price) : 0,
    quantity: product?.quantity ?? 0,
    min_stock: product?.min_stock ?? 10,
    supplier: product?.supplier ?? '',
    status: product?.status ?? 'active',
  }
}

export function ProductForm({
  product,
  categories,
  pending,
  serverError,
  onCreateCategory,
  onSubmit,
}: ProductFormProps) {
  const [image, setImage] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const imagePreviewRef = useRef<string | null>(null)
  const [removeImage, setRemoveImage] = useState(false)
  const [imageError, setImageError] = useState('')
  const [categoryDraft, setCategoryDraft] = useState('')
  const [categoryError, setCategoryError] = useState('')
  const [categoryPending, setCategoryPending] = useState(false)
  useEffect(() => () => {
    if (imagePreviewRef.current) URL.revokeObjectURL(imagePreviewRef.current)
  }, [])
  const form = useForm<ProductFormValues>({
    resolver: zodResolver(productFormSchema),
    defaultValues: emptyValues(product),
  })
  const categoryOptions: ComboboxOption<string>[] = [
    ...categories.map((category) => ({ value: category.id, label: category.name })),
    { value: '__create_category__', label: '+ Create category' },
  ]
  const previewUrl = imagePreview ?? (!removeImage ? product?.image_url ?? null : null)
  const statusOptions = [
    { value: 'active', label: 'Active' },
    { value: 'archived', label: 'Archived' },
  ] as const

  const receiveImage = async (file: File | undefined) => {
    if (!file) return
    setImageError('')
    try {
      const resized = await resizeProductImage(file)
      if (imagePreviewRef.current) URL.revokeObjectURL(imagePreviewRef.current)
      imagePreviewRef.current = URL.createObjectURL(resized)
      setImagePreview(imagePreviewRef.current)
      setImage(resized)
      setRemoveImage(false)
    } catch (error) {
      setImageError(error instanceof Error ? error.message : 'Unable to process this image.')
    }
  }

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    void receiveImage(event.dataTransfer.files[0])
  }

  const handleCreateCategory = async () => {
    const name = categoryDraft.trim()
    if (name.length < 2) {
      setCategoryError('Enter a category name with at least two characters.')
      return
    }
    setCategoryPending(true)
    setCategoryError('')
    try {
      const category = await onCreateCategory(name)
      form.setValue('category_id', category.id, { shouldValidate: true, shouldDirty: true })
      setCategoryDraft('')
    } catch (error) {
      setCategoryError(error instanceof Error ? error.message : 'Unable to create category.')
    } finally {
      setCategoryPending(false)
    }
  }

  const submit = (values: ProductFormValues) => onSubmit(values, image, removeImage)

  return (
    <form id="product-form" className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2" onSubmit={(event: FormEvent<HTMLFormElement>) => void form.handleSubmit(submit)(event)}>
      <FormField label="Product name" error={form.formState.errors.name?.message}>
        <input {...form.register('name')} className="field-input" autoComplete="off" />
      </FormField>
      <FormField label="SKU" error={form.formState.errors.sku?.message ?? (serverError?.toLowerCase().includes('sku') ? serverError : undefined)}>
        <input {...form.register('sku')} className="field-input" autoComplete="off" />
      </FormField>
      <FormField label="Barcode" error={form.formState.errors.barcode?.message}>
        <input {...form.register('barcode')} className="field-input" autoComplete="off" />
      </FormField>
      <Controller
        control={form.control}
        name="category_id"
        render={({ field }) => (
          <FormField label="Category" error={form.formState.errors.category_id?.message}>
            <Combobox
              options={categoryOptions}
              value={field.value || null}
              onChange={(value) => {
                if (value === '__create_category__') {
                  setCategoryError('')
                  return
                }
                field.onChange(value)
              }}
              ariaLabel="Product category"
              placeholder="Choose a category"
              searchPlaceholder="Search categories"
              emptyMessage="No categories found."
            />
          </FormField>
        )}
      />
      <div className="min-w-0 md:col-span-2">
        <label className="mb-1.5 block text-sm font-medium text-slate-700" htmlFor="new-category-name">Create category</label>
        <div className="flex min-w-0 gap-2">
          <input id="new-category-name" className="field-input min-w-0 flex-1" value={categoryDraft} onChange={(event) => setCategoryDraft(event.target.value)} placeholder="Category name" />
          <button type="button" disabled={categoryPending} onClick={() => void handleCreateCategory()} className="shrink-0 rounded-xl border border-slate-200 px-3 text-sm font-semibold text-slate-700 disabled:opacity-50">
            {categoryPending ? 'Saving…' : 'Add'}
          </button>
        </div>
        {categoryError && <p role="alert" className="mt-1 text-xs font-medium text-red-700">{categoryError}</p>}
      </div>
      <FormField label="Brand" error={form.formState.errors.brand?.message}>
        <input {...form.register('brand')} className="field-input" />
      </FormField>
      <FormField label="Supplier" error={form.formState.errors.supplier?.message}>
        <input {...form.register('supplier')} className="field-input" />
      </FormField>
      <Controller
        control={form.control}
        name="cost_price_cents"
        render={({ field }) => (
          <FormField label="Cost price" error={form.formState.errors.cost_price_cents?.message}>
            <MoneyInput cents={field.value ?? null} onChange={(value) => field.onChange(value)} />
          </FormField>
        )}
      />
      <Controller
        control={form.control}
        name="selling_price_cents"
        render={({ field }) => (
          <FormField label="Selling price" error={form.formState.errors.selling_price_cents?.message}>
            <MoneyInput cents={field.value ?? null} onChange={(value) => field.onChange(value)} />
          </FormField>
        )}
      />
      <FormField label={product ? 'Current quantity' : 'Initial quantity'} hint={product ? 'Use Stock-in / Adjust to change quantity.' : undefined} error={form.formState.errors.quantity?.message}>
        <input {...form.register('quantity', { valueAsNumber: true })} className="field-input" type="number" min="0" step="1" readOnly={Boolean(product)} />
      </FormField>
      <FormField label="Minimum stock" error={form.formState.errors.min_stock?.message}>
        <input {...form.register('min_stock', { valueAsNumber: true })} className="field-input" type="number" min="0" step="1" />
      </FormField>
      <Controller
        control={form.control}
        name="status"
        render={({ field }) => (
          <FormField label="Status">
            <SegmentedControl options={statusOptions} value={field.value} onChange={field.onChange} ariaLabel="Product status" />
          </FormField>
        )}
      />
      <FormField label="Description" error={form.formState.errors.description?.message}>
        <textarea {...form.register('description')} className="field-input min-h-24 resize-y" rows={3} />
      </FormField>
      <div className="min-w-0 md:col-span-2">
        <p className="mb-1.5 text-sm font-medium text-slate-700">Product image</p>
        <label
          htmlFor="product-image"
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
          className="flex min-w-0 cursor-pointer items-center justify-center overflow-hidden rounded-2xl border border-dashed border-slate-300 bg-slate-50"
        >
          {previewUrl ? (
            <img src={previewUrl} alt="Product preview" className="aspect-[4/3] w-full object-cover" />
          ) : (
            <span className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 text-sm text-slate-500">
              <ImagePlus size={28} aria-hidden="true" />
              Choose or drop a JPEG, PNG, or WebP (max 2 MB)
            </span>
          )}
          <input id="product-image" className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void receiveImage(event.target.files?.[0])} />
        </label>
        <div className="mt-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
          {product && <span className="text-xs text-slate-500">{product.image_path ? 'Current image saved in product storage.' : 'No image saved.'}</span>}
          {previewUrl && (
            <button type="button" onClick={() => {
              setImage(null)
              if (imagePreviewRef.current) URL.revokeObjectURL(imagePreviewRef.current)
              imagePreviewRef.current = null
              setImagePreview(null)
              setRemoveImage(Boolean(product?.image_path))
              setImageError('')
            }} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-medium text-red-700 hover:bg-red-50">
              <Trash2 size={15} aria-hidden="true" /> Remove image
            </button>
          )}
          {!previewUrl && product?.image_path && removeImage && <span className="text-xs text-amber-700">Image will be removed when saved.</span>}
        </div>
        {imageError && <p role="alert" className="mt-1 text-xs font-medium text-red-700">{imageError}</p>}
      </div>
      {product && (
        <p className="flex items-center gap-2 text-sm text-slate-500 md:col-span-2">
          <Package size={16} aria-hidden="true" />
          Current selling price: {formatLkr(databaseDecimalToCents(product.selling_price))}
        </p>
      )}
      {serverError && !serverError.toLowerCase().includes('sku') && (
        <p role="alert" className="text-sm font-medium text-red-700 md:col-span-2">{serverError}</p>
      )}
      <div className="hidden" aria-hidden="true" />
      <button className="sr-only" type="submit" disabled={pending}>Save product</button>
    </form>
  )
}
