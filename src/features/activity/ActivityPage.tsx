import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { apiRequest } from '../../lib/api'
import { ErrorMessage, PageHeading } from '../dashboard/DashboardPage'

type ActivityLog = {
  id: string
  action: string
  entity_type: string
  entity_id: string | null
  details: Record<string, unknown>
  created_at: string
  user_id: string | null
  actor: string
}
type StaffMember = { id: string; email: string; full_name: string; created_at: string; permissions: string[] }

function localDate(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

export function ActivityPage() {
  const [from, setFrom] = useState(() => {
    const today = new Date()
    return localDate(new Date(today.getFullYear(), today.getMonth(), 1))
  })
  const [to, setTo] = useState(() => localDate(new Date()))
  const [actorId, setActorId] = useState('')
  const [action, setAction] = useState('')
  const staff = useQuery({ queryKey: ['staff'], queryFn: () => apiRequest<StaffMember[]>('/api/staff') })
  const query = useMemo(() => {
    const params = new URLSearchParams({ from, to })
    if (actorId) params.set('actor_id', actorId)
    if (action.trim()) params.set('action', action.trim())
    return params.toString()
  }, [from, to, actorId, action])
  const logs = useQuery({
    queryKey: ['activity-logs', query],
    queryFn: () => apiRequest<ActivityLog[]>(`/api/activity-logs?${query}`),
    enabled: from <= to,
  })

  return (
    <div className="space-y-6">
      <PageHeading title="Activity log" description="Owner-only record of actions performed in the store." />
      <section className="glass-panel grid min-w-0 gap-4 rounded-[26px] p-5 sm:grid-cols-2 xl:grid-cols-4">
        <label className="grid gap-1.5 text-sm font-medium text-slate-700">From<input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-base" /></label>
        <label className="grid gap-1.5 text-sm font-medium text-slate-700">To<input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-base" /></label>
        <label className="grid gap-1.5 text-sm font-medium text-slate-700">Staff member
          <select value={actorId} onChange={(event) => setActorId(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-base">
            <option value="">All users</option>
            {staff.data?.map((member) => <option key={member.id} value={member.id}>{member.full_name || member.email}</option>)}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium text-slate-700">Exact action<input value={action} onChange={(event) => setAction(event.target.value)} maxLength={100} placeholder="e.g. sale.created" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-base" /></label>
      </section>
      {from > to && <p role="alert" className="text-sm text-red-700">Choose a valid date range.</p>}
      {staff.isError && <ErrorMessage message={staff.error.message} />}
      {logs.isPending && <div className="h-52 animate-pulse rounded-[26px] bg-slate-200" />}
      {logs.isError && <ErrorMessage message={logs.error.message} />}
      {logs.data && (
        <section className="glass-panel min-w-0 rounded-[26px] p-5">
          <h3 className="mb-4 font-bold text-slate-900">Activity · {logs.data.length} records</h3>
          {logs.data.length === 0 ? <p className="rounded-2xl bg-slate-50 p-8 text-center text-sm text-slate-500">No activity matches these filters.</p> : (
            <div className="w-full min-w-0 overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full min-w-[720px] border-collapse text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">When</th><th className="px-4 py-3">Who</th><th className="px-4 py-3">Action</th><th className="px-4 py-3">Entity</th><th className="px-4 py-3">Details</th></tr></thead>
                <tbody className="divide-y divide-slate-100">{logs.data.map((log) => <tr key={log.id} className="bg-white align-top">
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">{new Date(log.created_at).toLocaleString('en-LK')}</td>
                  <td className="px-4 py-3 font-medium text-slate-800">{log.actor}</td>
                  <td className="px-4 py-3 text-slate-700">{log.action}</td>
                  <td className="px-4 py-3 text-slate-600">{log.entity_type}{log.entity_id ? ` · ${log.entity_id.slice(0, 8)}` : ''}</td>
                  <td className="max-w-sm whitespace-pre-wrap break-words px-4 py-3 text-xs text-slate-500">{JSON.stringify(log.details)}</td>
                </tr>)}</tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
