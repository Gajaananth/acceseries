import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { FormField } from '../../components/ui/FormField'
import { Modal } from '../../components/ui/Modal'
import { apiRequest } from '../../lib/api'
import { formatLkr } from '../../shared/business'
import { ErrorMessage, Loading, PageHeading } from '../dashboard/DashboardPage'

type LatePayment = {
  schedule_id: string
  agreement_id: string
  customer_id: string
  customer_name: string
  phone: string
  installment_number: number
  due_date: string
  days_overdue: number
  principal_due_cents: number
  interest_due_cents: number
  late_fee_due_cents: number
}

function displayDate(value: string): string {
  return new Date(`${value}T00:00:00`).toLocaleDateString('en-LK', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export function LatePaymentsPage({ isOwner }: { isOwner: boolean }) {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<LatePayment | null>(null)
  const [reason, setReason] = useState('')
  const waiverKey = useRef<{ signature: string; key: string } | null>(null)
  const latePayments = useQuery({
    queryKey: ['late-payments'],
    queryFn: () => apiRequest<LatePayment[]>('/api/late-payments'),
  })
  const waiver = useMutation({
    mutationFn: ({ scheduleId, note, key }: { scheduleId: string; note: string; key: string }) =>
      apiRequest<{ id: string }>(`/api/late-payments/${scheduleId}/waive`, {
        method: 'POST',
        body: JSON.stringify({ reason: note }),
        headers: { 'Idempotency-Key': key },
      }),
    onSuccess: async () => {
      waiverKey.current = null
      setSelected(null)
      setReason('')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['late-payments'] }),
        queryClient.invalidateQueries({ queryKey: ['payment-summary'] }),
        queryClient.invalidateQueries({ queryKey: ['customer-collection'] }),
        queryClient.invalidateQueries({ queryKey: ['payments'] }),
      ])
    },
  })

  const submitWaiver = () => {
    if (!selected || reason.trim().length < 2) return
    const signature = `${selected.schedule_id}:${reason.trim()}`
    if (waiverKey.current?.signature !== signature) {
      waiverKey.current = { signature, key: crypto.randomUUID() }
    }
    waiver.mutate({
      scheduleId: selected.schedule_id,
      note: reason.trim(),
      key: waiverKey.current.key,
    })
  }

  return (
    <div className="min-w-0 space-y-6">
      <PageHeading
        title="Late payments"
        description="Overdue installments with principal, interest, and assessed late fees shown separately."
      />
      {latePayments.isPending ? <Loading /> : latePayments.isError ? <ErrorMessage message={latePayments.error.message} /> : (
        <section className="min-w-0 rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm md:p-6">
          <div className="mb-4 flex min-w-0 items-center justify-between gap-3">
            <h3 className="text-xl font-extrabold text-slate-900">Overdue installments</h3>
            <span className="rounded-full bg-amber-50 px-3 py-1 text-sm font-semibold text-amber-800">
              {(latePayments.data ?? []).length.toLocaleString('en-LK')}
            </span>
          </div>
          {(latePayments.data ?? []).length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">There are no overdue installments.</p>
          ) : (
            <div className="w-full min-w-0 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <th className="py-3 pr-4">Customer</th>
                    <th className="py-3 pr-4">Installment</th>
                    <th className="py-3 pr-4">Days overdue</th>
                    <th className="py-3 pr-4 text-right">Principal</th>
                    <th className="py-3 pr-4 text-right">Interest</th>
                    <th className="py-3 pr-4 text-right">Late fee</th>
                    {isOwner && <th className="py-3 text-right">Action</th>}
                  </tr>
                </thead>
                <tbody>
                  {(latePayments.data ?? []).map((row) => (
                    <tr key={row.schedule_id} className="border-b border-slate-100 last:border-0">
                      <td className="py-4 pr-4">
                        <p className="font-semibold text-slate-900">{row.customer_name}</p>
                        <p className="text-xs text-slate-500">{row.phone}</p>
                      </td>
                      <td className="py-4 pr-4 text-slate-700">
                        <p>#{row.installment_number}</p>
                        <p className="text-xs text-slate-500">Due {displayDate(row.due_date)}</p>
                      </td>
                      <td className="py-4 pr-4 font-semibold text-amber-800">{row.days_overdue}</td>
                      <td className="py-4 pr-4 text-right tabular-nums">{formatLkr(row.principal_due_cents)}</td>
                      <td className="py-4 pr-4 text-right tabular-nums">{formatLkr(row.interest_due_cents)}</td>
                      <td className="py-4 pr-4 text-right font-semibold tabular-nums">{formatLkr(row.late_fee_due_cents)}</td>
                      {isOwner && (
                        <td className="py-4 text-right">
                          <button
                            type="button"
                            onClick={() => { setSelected(row); setReason(''); waiver.reset() }}
                            disabled={row.late_fee_due_cents <= 0}
                            className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            Waive fee
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <Modal
        open={selected !== null}
        onClose={() => {
          setSelected(null)
          setReason('')
          waiver.reset()
        }}
        title="Waive late fee"
        description={selected ? `${selected.customer_name} · installment ${selected.installment_number} · ${formatLkr(selected.late_fee_due_cents)} outstanding` : undefined}
        footer={
          <div className="flex min-w-0 justify-end gap-3">
            <button type="button" className="soft-button" onClick={() => setSelected(null)}>Cancel</button>
            <button
              type="button"
              onClick={submitWaiver}
              disabled={reason.trim().length < 2 || waiver.isPending}
              className="rounded-2xl bg-[#247BDB] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
            >
              {waiver.isPending ? 'Saving…' : 'Confirm waiver'}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <FormField label="Reason" hint="A reason is required and recorded in the audit log.">
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              minLength={2}
              maxLength={500}
              rows={3}
              required
              className="field-input min-h-24 resize-y"
            />
          </FormField>
          {waiver.isError && <ErrorMessage message={waiver.error.message} />}
        </div>
      </Modal>
    </div>
  )
}
