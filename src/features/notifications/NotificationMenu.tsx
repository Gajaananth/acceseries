import { useQuery } from '@tanstack/react-query'
import { Bell, CircleAlert } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiRequest } from '../../lib/api'

type StoreNotification = {
  id: string
  type: 'due_today' | 'overdue' | 'low_stock'
  title: string
  description: string
  href: '/collections' | '/late-payments' | '/products'
  created_at: string
}
type NotificationData = {
  items: StoreNotification[]
  due_today_count: number
  overdue_count: number
  low_stock_count: number
}

export function NotificationMenu() {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: () => apiRequest<NotificationData>('/api/notifications'),
    refetchInterval: 60_000,
  })

  useEffect(() => {
    if (!open) return
    const handlePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', handlePointer)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('pointerdown', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  const data = notifications.data
  const count = (data?.due_today_count ?? 0) + (data?.overdue_count ?? 0) + (data?.low_stock_count ?? 0)
  return (
    <div ref={rootRef}>
      <button type="button" aria-label={`Notifications${count ? `, ${count} active` : ''}`} aria-expanded={open} onClick={() => setOpen((value) => !value)} className="relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-50">
        <Bell size={19} />
        {count > 0 && <span className="absolute -right-1 -top-1 inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">{count > 99 ? '99+' : count}</span>}
      </button>
      {open && createPortal(
        <section role="dialog" aria-label="Notifications" className="fixed right-4 top-[5.5rem] z-[120] flex max-h-[calc(100dvh-6.5rem)] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
          <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <h2 className="font-bold text-slate-900">Notifications</h2>
            <span className="text-xs text-slate-500">{count} active</span>
          </header>
          {notifications.isError ? (
            <p role="alert" className="m-4 rounded-xl bg-red-50 p-3 text-sm text-red-700">{notifications.error.message}</p>
          ) : notifications.isPending ? (
            <p role="status" className="p-6 text-center text-sm text-slate-500">Loading notifications…</p>
          ) : data?.items.length ? (
            <ul className="min-h-0 divide-y divide-slate-100 overflow-y-auto">
              {data.items.map((item) => (
                <li key={`${item.type}-${item.id}`}>
                  <Link to={item.href} onClick={() => setOpen(false)} className="flex min-w-0 gap-3 px-4 py-3 hover:bg-slate-50">
                    <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${item.type === 'low_stock' ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'}`}><CircleAlert size={18} /></span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-slate-800">{item.title}</span>
                      <span className="mt-0.5 block break-words text-xs text-slate-500">{item.description}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="p-8 text-center text-sm text-slate-500">You’re all caught up.</p>
          )}
        </section>,
        document.body,
      )}
    </div>
  )
}
