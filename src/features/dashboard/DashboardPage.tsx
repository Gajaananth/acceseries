import { useQuery } from '@tanstack/react-query'
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import {
  Banknote, Boxes, CircleAlert, Coins, PackageOpen, ShoppingBag, Users, Wallet,
} from 'lucide-react'
import { useState } from 'react'
import { apiRequest } from '../../lib/api'
import { formatLkr } from '../../shared/business'
import { useAuth } from '../auth/authContext'

type DashboardMetric = {
  customer_count: number
  product_count: number
  inventory_value_cents: number
  low_stock_count: number
  today_sales_cents: number
  monthly_sales_cents: number
  today_collections_cents: number
  monthly_collections_cents: number
  outstanding_principal_cents: number
  outstanding_interest_cents: number
  overdue_count: number
}

type DashboardData = {
  metrics: DashboardMetric
  charts: {
    daily_sales: { date: string; sales_cents: number }[]
    monthly_revenue: { month: string; revenue_cents: number }[]
    sales_mix: { payment_type: 'cash' | 'installment'; amount_cents: number; count: number }[]
    collections_by_day: { period: string; amount_cents: number }[]
    collections_by_week: { period: string; amount_cents: number }[]
    collections_by_month: { period: string; amount_cents: number }[]
    product_sales: { product_name: string; quantity: number; sales_cents: number }[]
    inventory_by_category: { category: string; value_cents: number }[]
  }
  lists: {
    recent_sales: { id: string; invoice_number: string; customer_name: string | null; payment_type: string; total_cents: number; created_at: string }[]
    recent_payments: { id: string; receipt_number: string; customer_name: string | null; amount_cents: number; payment_method: string; collector: string; collected_at: string }[]
    upcoming_dues: { id: string; customer_name: string; installment_number: number; due_date: string; amount_cents: number }[]
    overdue_customers: { customer_id: string; customer_name: string; phone: string; installment_count: number; amount_cents: number; oldest_due_date: string }[]
    low_stock: { id: string; name: string; quantity: number; min_stock: number }[]
  }
}

type CollectionPeriod = 'day' | 'week' | 'month'

const EMPTY_CHART_DATA: DashboardData['charts'] = {
  daily_sales: [], monthly_revenue: [], sales_mix: [], collections_by_day: [],
  collections_by_week: [], collections_by_month: [], product_sales: [], inventory_by_category: [],
}
const EMPTY_LISTS: DashboardData['lists'] = {
  recent_sales: [], recent_payments: [], upcoming_dues: [], overdue_customers: [],
  low_stock: [],
}

const moneyTooltip = (value: unknown): string =>
  typeof value === 'number' ? formatLkr(value) : String(value ?? '')

function shortDate(value: string) {
  return new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString('en-LK', { day: 'numeric', month: 'short' })
}

export function DashboardPage() {
  const [collectionPeriod, setCollectionPeriod] = useState<CollectionPeriod>('day')
  const { user } = useAuth()
  const summary = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => apiRequest<DashboardData>('/api/dashboard'),
  })

  if (summary.isPending) {
    return <div className="space-y-6"><PageHeading title="Overview" description="Live sales, collections, receivables and inventory activity." /><DashboardSkeleton /></div>
  }
  if (summary.isError) {
    return <div className="space-y-6"><PageHeading title="Overview" description="Live sales, collections, receivables and inventory activity." /><ErrorMessage message={summary.error.message} /></div>
  }

  const { metrics } = summary.data
  const charts = summary.data.charts ?? EMPTY_CHART_DATA
  const lists = summary.data.lists ?? EMPTY_LISTS
  const can = (...permissions: string[]) =>
    user?.role === 'owner' || permissions.some((permission) => user?.permissions.includes(permission))
  const metricCards = [
    { label: 'Customers', value: metrics.customer_count.toLocaleString('en-LK'), Icon: Users, permissions: ['customers:read'] },
    { label: 'Active products', value: metrics.product_count.toLocaleString('en-LK'), Icon: PackageOpen, permissions: ['products:read', 'products:write'] },
    { label: 'Inventory value', value: formatLkr(metrics.inventory_value_cents), Icon: Boxes, permissions: ['products:read', 'products:write'] },
    { label: 'Low stock', value: metrics.low_stock_count.toLocaleString('en-LK'), Icon: CircleAlert, permissions: ['products:read', 'products:write'] },
    { label: "Today's sales", value: formatLkr(metrics.today_sales_cents), Icon: ShoppingBag, permissions: ['sales:read'] },
    { label: 'Sales this month', value: formatLkr(metrics.monthly_sales_cents), Icon: Coins, permissions: ['sales:read'] },
    { label: "Today's collections", value: formatLkr(metrics.today_collections_cents), Icon: Banknote, permissions: ['payments:read'] },
    { label: 'Collections this month', value: formatLkr(metrics.monthly_collections_cents), Icon: Wallet, permissions: ['payments:read'] },
    { label: 'Outstanding principal', value: formatLkr(metrics.outstanding_principal_cents), Icon: Coins, permissions: ['payments:read'] },
    { label: 'Outstanding interest', value: formatLkr(metrics.outstanding_interest_cents), Icon: Coins, permissions: ['payments:read'] },
    { label: 'Overdue installments', value: metrics.overdue_count.toLocaleString('en-LK'), Icon: CircleAlert, permissions: ['payments:read'] },
  ].filter((card) => can(...card.permissions))
  const collectionChart = collectionPeriod === 'day'
    ? charts.collections_by_day
    : collectionPeriod === 'week' ? charts.collections_by_week : charts.collections_by_month
  const canViewSales = can('sales:read')
  const canViewPayments = can('payments:read')
  const canViewProducts = can('products:read', 'products:write')

  return (
    <div className="space-y-6">
      <PageHeading title="Overview" description="Live sales, collections, receivables and inventory activity." />
      <section aria-label="Store metrics" className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metricCards.map(({ label, value, Icon }) => (
          <div key={label} className="glass-panel min-w-0 rounded-[26px] p-5">
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-50 text-[#247BDB]"><Icon size={20} /></div>
            <p className="text-sm text-slate-500">{label}</p>
            <p className="mt-2 break-words text-2xl font-extrabold tracking-tight text-slate-900">{value}</p>
          </div>
        ))}
      </section>

      <section className="grid min-w-0 gap-4 xl:grid-cols-2">
        {canViewSales && <ChartCard title="Daily sales" empty={charts.daily_sales.length === 0}>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={charts.daily_sales}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" tickFormatter={shortDate} />
              <YAxis tickFormatter={(value: number) => `${Math.round(value / 100_000)}k`} />
              <Tooltip formatter={moneyTooltip} labelFormatter={(value) => shortDate(String(value))} />
              <Line type="monotone" dataKey="sales_cents" name="Sales" stroke="#247BDB" strokeWidth={3} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>}
        {canViewSales && <ChartCard title="Monthly sales revenue" empty={charts.monthly_revenue.length === 0}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={charts.monthly_revenue}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="month" />
              <YAxis tickFormatter={(value: number) => `${Math.round(value / 100_000)}k`} />
              <Tooltip formatter={moneyTooltip} />
              <Bar dataKey="revenue_cents" name="Sales revenue" fill="#247BDB" radius={[8, 8, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>}
        {canViewSales && <ChartCard title="Cash vs installment sales" empty={charts.sales_mix.length === 0}>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={charts.sales_mix} dataKey="amount_cents" nameKey="payment_type" innerRadius={62} outerRadius={92} paddingAngle={4}>
                {charts.sales_mix.map((entry) => <Cell key={entry.payment_type} fill={entry.payment_type === 'cash' ? '#247BDB' : '#22A06B'} />)}
              </Pie>
              <Tooltip formatter={moneyTooltip} />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex flex-wrap justify-center gap-4 text-sm text-slate-600">
            {charts.sales_mix.map((item) => <span key={item.payment_type}>{item.payment_type}: {formatLkr(item.amount_cents)} ({item.count})</span>)}
          </div>
        </ChartCard>}
        {canViewPayments && <ChartCard title="Collections">
          <div className="mb-3 flex flex-wrap gap-2">
            {(['day', 'week', 'month'] as const).map((period) => (
              <button key={period} type="button" onClick={() => setCollectionPeriod(period)} aria-pressed={collectionPeriod === period} className={`rounded-full px-3 py-1.5 text-sm font-semibold capitalize ${collectionPeriod === period ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                By {period}
              </button>
            ))}
          </div>
          {collectionChart.length === 0 ? <EmptyState label="No collections in this period." /> : (
            <ResponsiveContainer width="100%" height={228}>
              <BarChart data={collectionChart}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="period" tickFormatter={shortDate} />
                <YAxis tickFormatter={(value: number) => `${Math.round(value / 100_000)}k`} />
                <Tooltip formatter={moneyTooltip} labelFormatter={(value) => shortDate(String(value))} />
                <Bar dataKey="amount_cents" name="Collections" fill="#22A06B" radius={[8, 8, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>}
        {canViewSales && <ChartCard title="Top products by sales" empty={charts.product_sales.length === 0}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={charts.product_sales} layout="vertical" margin={{ left: 12 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tickFormatter={(value: number) => `${Math.round(value / 100_000)}k`} />
              <YAxis type="category" dataKey="product_name" width={110} />
              <Tooltip formatter={moneyTooltip} />
              <Bar dataKey="sales_cents" name="Sales" fill="#247BDB" radius={[0, 8, 8, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>}
        {canViewProducts && <ChartCard title="Inventory value by category" empty={charts.inventory_by_category.length === 0}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={charts.inventory_by_category}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="category" />
              <YAxis tickFormatter={(value: number) => `${Math.round(value / 100_000)}k`} />
              <Tooltip formatter={moneyTooltip} />
              <Bar dataKey="value_cents" name="Inventory value" fill="#8B6CE8" radius={[8, 8, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>}
      </section>

      <section className="grid min-w-0 gap-4 xl:grid-cols-2">
        {canViewSales && <DataList title="Recent sales" empty="No sales yet." href="/sales" linkLabel="Sales">
          {lists.recent_sales.map((sale) => (
            <ListRow key={sale.id} primary={`${sale.invoice_number} · ${sale.customer_name ?? 'Walk-in'}`} secondary={`${sale.payment_type} · ${new Date(sale.created_at).toLocaleDateString('en-LK')}`} value={formatLkr(sale.total_cents)} />
          ))}
        </DataList>}
        {canViewPayments && <DataList title="Recent payments" empty="No payments yet." href="/collections" linkLabel="Collections">
          {lists.recent_payments.map((payment) => (
            <ListRow key={payment.id} primary={`${payment.receipt_number} · ${payment.customer_name ?? 'Customer'}`} secondary={`${payment.payment_method} · ${payment.collector}`} value={formatLkr(payment.amount_cents)} />
          ))}
        </DataList>}
        {canViewPayments && <DataList title="Upcoming dues" empty="No dues in the next 7 days." href="/collections" linkLabel="Collections">
          {lists.upcoming_dues.map((due) => (
            <ListRow key={due.id} primary={`${due.customer_name} · installment ${due.installment_number}`} secondary={shortDate(due.due_date)} value={formatLkr(due.amount_cents)} />
          ))}
        </DataList>}
        {canViewPayments && <DataList title="Overdue customers" empty="No overdue customers." href="/late-payments" linkLabel="Late payments">
          {lists.overdue_customers.map((customer) => (
            <ListRow key={customer.customer_id} primary={`${customer.customer_name} · ${customer.phone}`} secondary={`${customer.installment_count} overdue · since ${shortDate(customer.oldest_due_date)}`} value={formatLkr(customer.amount_cents)} />
          ))}
        </DataList>}
        {canViewProducts && <DataList title="Low stock" empty="No products below minimum stock." href="/products" linkLabel="Products">
          {lists.low_stock.map((product) => (
            <ListRow key={product.id} primary={product.name} secondary={`On hand ${product.quantity} · minimum ${product.min_stock}`} />
          ))}
        </DataList>}
      </section>
    </div>
  )
}

export function PageHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-blue-600">Acceseries</p>
        <h2 className="mt-2 text-3xl font-extrabold tracking-tight text-slate-900">{title}</h2>
      </div>
      <p className="max-w-xl text-sm text-slate-500">{description}</p>
    </div>
  )
}

export function Loading() {
  return <p role="status" className="text-sm text-slate-500">Loading store data…</p>
}

export function ErrorMessage({ message }: { message: string }) {
  return <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{message}</p>
}

function DashboardSkeleton() {
  return <div className="grid animate-pulse gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 8 }, (_, index) => <div key={index} className="h-32 rounded-[26px] bg-slate-200" />)}</div>
}

function ChartCard({ title, children, empty = false }: { title: string; children: ReactNode; empty?: boolean }) {
  return (
    <div className="glass-panel min-w-0 rounded-[26px] p-5">
      <h3 className="mb-4 font-bold text-slate-900">{title}</h3>
      {empty ? <EmptyState label="No data for this period." /> : children}
    </div>
  )
}

function DataList({ title, empty, href, linkLabel, children }: { title: string; empty: string; href: string; linkLabel: string; children: ReactNode }) {
  const isEmpty = !Array.isArray(children) || children.length === 0
  return (
    <div className="glass-panel min-w-0 rounded-[26px] p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="font-bold text-slate-900">{title}</h3>
        <Link className="text-sm font-semibold text-blue-700 hover:text-blue-800" to={href}>{linkLabel}</Link>
      </div>
      {isEmpty ? <EmptyState label={empty} /> : <div className="divide-y divide-slate-100">{children}</div>}
    </div>
  )
}

function ListRow({ primary, secondary, value }: { primary: string; secondary: string; value?: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-slate-800">{primary}</p>
        <p className="truncate text-xs text-slate-500">{secondary}</p>
      </div>
      {value && <span className="shrink-0 text-sm font-bold text-slate-800">{value}</span>}
    </div>
  )
}

function EmptyState({ label }: { label: string }) {
  return <p className="rounded-2xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">{label}</p>
}
