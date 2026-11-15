import { zodResolver } from '@hookform/resolvers/zod'
import { useState, type FormEvent } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { FormField } from '../../components/ui/FormField'
import { Modal } from '../../components/ui/Modal'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { apiRequest } from '../../lib/api'
import type { Product, ProductCategory, StockMovement } from './productTypes'
import { parseProductCsv, type ProductCsvRow } from './productCsv'

type StockMovementValues = {
  movement_type: 'stock_in' | 'adjust'
  qty: number
  reason: string
}

const stockMovementSchema = z.object({
  movement_type: z.enum(['stock_in', 'adjust']),
  qty: z.number().int().min(-2_147_483_647).max(2_147_483_647).refine((quantity) => quantity !== 0, 'Quantity cannot be zero.'),
  reason: z.string().trim().min(2, 'Enter a reason.').max(500),
}).superRefine((values, context) => {
  if (values.movement_type === 'stock_in' && values.qty < 1) {
    context.addIssue({ code: 'custom', path: ['qty'], message: 'Stock-in quantity must be positive.' })
  }
})
const movementTypeOptions = [
  { value: 'stock_in', label: 'Stock-in' },
  { value: 'adjust', label: 'Adjust' },
] as const

export function StockMovementModal({
  product,
  open,
  onClose,
  pending,
  error,
  onSubmit,
}: {
  product: Product
  open: boolean
  onClose: () => void
  pending: boolean
  error?: string
  onSubmit: (values: StockMovementValues) => void
}) {
  const form = useForm<StockMovementValues>({
    resolver: zodResolver(stockMovementSchema),
    defaultValues: { movement_type: 'stock_in', qty: 1, reason: '' },
  })
  const movementType = useWatch({ control: form.control, name: 'movement_type' })
  const submitForm = (event: FormEvent<HTMLFormElement>) => {
    void form.handleSubmit(onSubmit)(event)
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Stock-in / Adjust"
      description={`${product.name} · current quantity ${product.quantity}`}
      footer={(
        <div className="flex min-w-0 justify-end gap-3">
          <button type="button" onClick={onClose} className="soft-button">Cancel</button>
          <button type="submit" form="stock-movement-form" disabled={pending} className="rounded-2xl bg-[#247BDB] px-4 py-3 text-sm font-semibold text-white disabled:opacity-60">
            {pending ? 'Saving…' : 'Save movement'}
          </button>
        </div>
      )}
    >
      <form id="stock-movement-form" className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2" onSubmit={submitForm}>
        <div className="md:col-span-2">
          <FormField label="Movement type">
            <SegmentedControl
              value={movementType}
              options={movementTypeOptions}
              onChange={(value) => form.setValue('movement_type', value, { shouldValidate: true })}
              ariaLabel="Stock movement type"
            />
          </FormField>
        </div>
        <FormField
          label={movementType === 'stock_in' ? 'Quantity to add' : 'Adjustment (+/-)'}
          hint={movementType === 'adjust' ? 'Use a negative number to reduce stock.' : undefined}
          error={form.formState.errors.qty?.message}
        >
          <input {...form.register('qty', { valueAsNumber: true })} className="field-input" type="number" step="1" />
        </FormField>
        <FormField label="Reason" error={form.formState.errors.reason?.message}>
          <input {...form.register('reason')} className="field-input" maxLength={500} />
        </FormField>
        {error && <p role="alert" className="text-sm font-medium text-red-700 md:col-span-2">{error}</p>}
      </form>
    </Modal>
  )
}

export function StockHistoryModal({ product, open, onClose }: {
  product: Product
  open: boolean
  onClose: () => void
}) {
  const history = useQuery({
    queryKey: ['stock-movements', product.id],
    queryFn: () => apiRequest<StockMovement[]>(`/api/products/${product.id}/stock-movements`),
    enabled: open,
    refetchOnMount: 'always',
  })
  const rows = history.data ?? []
  return (
    <Modal open={open} onClose={onClose} title="Stock movement history" description={product.name}>
      {history.isPending ? <p className="text-sm text-slate-500">Loading movements…</p> : history.isError ? (
        <p role="alert" className="text-sm font-medium text-red-700">{history.error.message}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-500">No stock movements recorded.</p>
      ) : (
        <div className="w-full min-w-0 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead><tr className="border-b border-slate-200 text-slate-500">
              <th className="py-2 pr-4 font-medium">Date</th>
              <th className="py-2 pr-4 font-medium">Type</th>
              <th className="py-2 pr-4 font-medium">Quantity</th>
              <th className="py-2 pr-4 font-medium">Reason / User</th>
            </tr></thead>
            <tbody>{rows.map((movement) => (
              <tr key={movement.id} className="border-b border-slate-100 last:border-0">
                <td className="py-3 pr-4 whitespace-nowrap">{new Date(movement.created_at).toLocaleString()}</td>
                <td className="py-3 pr-4">{movement.movement_type === 'stock_in' ? 'Stock-in' : 'Adjustment'}</td>
                <td className="py-3 pr-4">{movement.qty > 0 ? `+${movement.qty}` : movement.qty}</td>
                <td className="py-3 pr-4">
                  <p>{movement.reason}</p>
                  <p className="mt-1 text-xs text-slate-500">{movement.user_id ? `User ${movement.user_id}` : 'Legacy / system entry'}</p>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}

type ImportResult = { line: number; sku: string; error: string | null }

export function ProductImportModal({
  open,
  onClose,
  categories,
  products,
  onImport,
}: {
  open: boolean
  onClose: () => void
  categories: readonly ProductCategory[]
  products: readonly Product[]
  onImport: (rows: readonly ProductCsvRow[]) => Promise<ImportResult[]>
}) {
  const [preview, setPreview] = useState<ReturnType<typeof parseProductCsv> | null>(null)
  const [fileName, setFileName] = useState('')
  const [pending, setPending] = useState(false)
  const [results, setResults] = useState<ImportResult[] | null>(null)
  const [importError, setImportError] = useState('')

  const readFile = async (file: File | undefined) => {
    if (!file) return
    setFileName(file.name)
    setResults(null)
    setImportError('')
    try {
      setPreview(parseProductCsv(await file.text(), categories, products))
    } catch {
      setPreview({ rows: [], errors: ['Unable to read the selected CSV file.'] })
    }
  }
  const importRows = preview?.rows.filter((row) => row.values && row.errors.length === 0) ?? []
  const handleImport = async () => {
    if (importRows.length === 0) return
    setPending(true)
    try {
      setResults(await onImport(importRows))
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'Unable to import the CSV rows.')
    } finally {
      setPending(false)
    }
  }
  const resultByLine = new Map((results ?? []).map((result) => [result.line, result]))
  const importedCount = results?.filter((result) => result.error === null).length ?? 0

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import products from CSV"
      description="Review every row before importing. Invalid rows are reported and not skipped."
      footer={(
        <div className="flex min-w-0 flex-wrap justify-end gap-3">
          <button type="button" onClick={onClose} className="soft-button">Close</button>
          <button type="button" onClick={() => void handleImport()} disabled={pending || importRows.length === 0 || results !== null} className="rounded-2xl bg-[#247BDB] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">
            {pending ? 'Importing…' : `Import ${importRows.length} valid row${importRows.length === 1 ? '' : 's'}`}
          </button>
        </div>
      )}
    >
      <div className="min-w-0 space-y-4">
        <FormField label="CSV file" hint="Required columns: sku, name, category, selling_price, quantity, min_stock. Prices use LKR decimal values.">
          <input className="field-input" type="file" accept=".csv,text/csv" onChange={(event) => void readFile(event.target.files?.[0])} />
        </FormField>
        {fileName && <p className="text-xs text-slate-500">Selected: {fileName}</p>}
        {preview?.errors.map((error) => <p key={error} role="alert" className="text-sm font-medium text-red-700">{error}</p>)}
        {importError && <p role="alert" className="text-sm font-medium text-red-700">{importError}</p>}
        {preview && preview.rows.length > 0 && (
          <div className="w-full min-w-0 overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full text-left text-sm">
              <thead><tr className="bg-slate-50 text-slate-600">
                <th className="px-3 py-2 font-medium">Line</th>
                <th className="px-3 py-2 font-medium">SKU</th>
                <th className="px-3 py-2 font-medium">Product</th>
                <th className="px-3 py-2 font-medium">Result</th>
              </tr></thead>
              <tbody>{preview.rows.map((row) => {
                const result = resultByLine.get(row.line)
                const issue = result?.error ?? (row.errors.length ? row.errors.join(' ') : null)
                return (
                  <tr key={row.line} className="border-t border-slate-100 align-top">
                    <td className="px-3 py-2">{row.line}</td>
                    <td className="px-3 py-2">{row.sku || '—'}</td>
                    <td className="px-3 py-2">{row.name || '—'}</td>
                    <td className={`px-3 py-2 ${issue ? 'text-red-700' : result ? 'text-emerald-700' : 'text-slate-500'}`}>
                      {issue ?? (result ? 'Imported' : 'Ready')}
                    </td>
                  </tr>
                )
              })}</tbody>
            </table>
          </div>
        )}
        {results && (
          <p role="status" className="text-sm font-medium text-slate-700">
            Imported {importedCount} of {results.length} valid rows. Review any row errors above.
          </p>
        )}
      </div>
    </Modal>
  )
}
