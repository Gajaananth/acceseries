import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Modal } from '../../components/ui/Modal'
import { apiRequest } from '../../lib/api'
import { ErrorMessage, PageHeading } from '../dashboard/DashboardPage'

const staffPermissions = [
  { key: 'customers:read', label: 'View customers' },
  { key: 'customers:write', label: 'Create customers' },
  { key: 'products:read', label: 'View products' },
  { key: 'products:write', label: 'Manage products' },
  { key: 'sales:read', label: 'View sales' },
  { key: 'sales:create', label: 'Create sales' },
  { key: 'agreements:read', label: 'View installment agreements' },
  { key: 'agreements:create', label: 'Create installment agreements' },
  { key: 'payments:read', label: 'View collections' },
  { key: 'payments:write', label: 'Record payments' },
  { key: 'receipts:print', label: 'Print receipts' },
  { key: 'reports:sales', label: 'Sales report' },
  { key: 'reports:balances', label: 'Balances report' },
  { key: 'reports:late_fees', label: 'Late-fee report' },
  { key: 'reports:overdue', label: 'Overdue report' },
  { key: 'reports:collections', label: 'Collections report' },
  { key: 'reports:inventory', label: 'Inventory valuation report' },
  { key: 'reports:low_stock', label: 'Low-stock report' },
  { key: 'reports:staff', label: 'Staff performance report' },
  { key: 'reports:discounts', label: 'Discount approvals report' },
  { key: 'reports:expenses', label: 'Expenses report' },
  { key: 'reports:profit', label: 'Estimated profit report' },
] as const

type StaffMember = { id: string; email: string; full_name: string; created_at: string; permissions: string[] }

export function StaffPage() {
  const queryClient = useQueryClient()
  const staff = useQuery({ queryKey: ['staff'], queryFn: () => apiRequest<StaffMember[]>('/api/staff') })
  const [inviteOpen, setInviteOpen] = useState(false)
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [permissions, setPermissions] = useState<string[]>([])
  const [drafts, setDrafts] = useState<Record<string, string[]>>({})
  const [notice, setNotice] = useState('')

  const invite = useMutation({
    mutationFn: () => apiRequest<{ id: string; email: string }>('/api/staff/invite', {
      method: 'POST',
      body: JSON.stringify({ full_name: fullName, email, permissions }),
    }),
    onSuccess: async (result) => {
      setNotice(`Invitation sent to ${result.email}.`)
      setFullName('')
      setEmail('')
      setPermissions([])
      setInviteOpen(false)
      await queryClient.invalidateQueries({ queryKey: ['staff'] })
    },
  })

  const savePermissions = useMutation({
    mutationFn: ({ staffId, permissionKeys }: { staffId: string; permissionKeys: string[] }) =>
      apiRequest(`/api/staff/${staffId}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ permissions: permissionKeys }),
      }),
    onSuccess: async (_result, variables) => {
      setDrafts((previous) => {
        const next = { ...previous }
        delete next[variables.staffId]
        return next
      })
      setNotice('Staff permissions saved.')
      await queryClient.invalidateQueries({ queryKey: ['staff'] })
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })

  const toggle = (values: string[], key: string) =>
    values.includes(key) ? values.filter((value) => value !== key) : [...values, key]

  return (
    <div className="space-y-6">
      <PageHeading title="Staff" description="Invite staff and set the specific areas each account can access." />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-slate-500">Discount approval, fee waivers, settlement approval, settings, and activity-log access remain owner-only.</p>
        <button type="button" onClick={() => { invite.reset(); setInviteOpen(true) }} className="primary-button min-h-11 px-4">Invite staff</button>
      </div>
      {notice && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</p>}
      {staff.isPending && <div className="grid animate-pulse gap-4 md:grid-cols-2"><div className="h-52 rounded-[26px] bg-slate-200" /><div className="h-52 rounded-[26px] bg-slate-200" /></div>}
      {staff.isError && <ErrorMessage message={staff.error.message} />}
      {staff.data?.length === 0 && <p className="rounded-2xl bg-slate-50 p-8 text-center text-sm text-slate-500">No staff accounts yet. Invite a staff member to get started.</p>}
      <section className="grid min-w-0 gap-4 xl:grid-cols-2">
        {staff.data?.map((member) => {
          const current = drafts[member.id] ?? member.permissions
          const changed = [...current].sort().join('|') !== [...member.permissions].sort().join('|')
          return (
            <article key={member.id} className="glass-panel min-w-0 rounded-[26px] p-5">
              <div className="mb-4 flex min-w-0 flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate font-bold text-slate-900">{member.full_name || member.email}</h3>
                  <p className="truncate text-sm text-slate-500">{member.email}</p>
                  <p className="mt-1 text-xs text-slate-400">Added {new Date(member.created_at).toLocaleDateString('en-LK')}</p>
                </div>
                <button
                  type="button"
                  disabled={!changed || savePermissions.isPending}
                  onClick={() => savePermissions.mutate({ staffId: member.id, permissionKeys: current })}
                  className="soft-button min-h-10 disabled:opacity-50"
                >
                  Save access
                </button>
              </div>
              <fieldset className="grid min-w-0 gap-2 sm:grid-cols-2">
                <legend className="sr-only">Permissions for {member.full_name}</legend>
                {staffPermissions.map(({ key, label }) => (
                  <label key={key} className="flex min-w-0 items-start gap-2 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700">
                    <input type="checkbox" checked={current.includes(key)} onChange={() => setDrafts((previous) => ({ ...previous, [member.id]: toggle(current, key) }))} className="mt-0.5 h-4 w-4 shrink-0 accent-blue-600" />
                    <span className="min-w-0">{label}</span>
                  </label>
                ))}
              </fieldset>
            </article>
          )
        })}
      </section>
      {(invite.isError || savePermissions.isError) && <ErrorMessage message={(invite.error ?? savePermissions.error)?.message ?? 'Unable to save staff changes.'} />}
      <Modal open={inviteOpen} onClose={() => setInviteOpen(false)} title="Invite staff">
        <form onSubmit={(event) => { event.preventDefault(); invite.mutate() }} className="space-y-5">
          <div className="grid min-w-0 gap-4 md:grid-cols-2">
            <label className="grid min-w-0 gap-1.5 text-sm font-medium text-slate-700">Full name<input required minLength={2} maxLength={200} value={fullName} onChange={(event) => setFullName(event.target.value)} className="w-full max-w-full rounded-xl border border-slate-200 px-3 py-2.5 text-base" /></label>
            <label className="grid min-w-0 gap-1.5 text-sm font-medium text-slate-700">Email<input required type="email" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} className="w-full max-w-full rounded-xl border border-slate-200 px-3 py-2.5 text-base" /></label>
          </div>
          <fieldset className="grid min-w-0 gap-2 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-semibold text-slate-800">Initial permissions</legend>
            {staffPermissions.map(({ key, label }) => (
              <label key={key} className="flex min-w-0 items-start gap-2 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700">
                <input type="checkbox" checked={permissions.includes(key)} onChange={() => setPermissions((current) => toggle(current, key))} className="mt-0.5 h-4 w-4 shrink-0 accent-blue-600" />
                <span className="min-w-0">{label}</span>
              </label>
            ))}
          </fieldset>
          {invite.isError && <p role="alert" className="text-sm text-red-700">{invite.error.message}</p>}
          <div className="flex flex-col-reverse justify-end gap-2 sm:flex-row">
            <button type="button" onClick={() => setInviteOpen(false)} className="soft-button min-h-11">Cancel</button>
            <button type="submit" disabled={invite.isPending} className="primary-button min-h-11 px-5 disabled:opacity-50">{invite.isPending ? 'Sending…' : 'Send invitation'}</button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
