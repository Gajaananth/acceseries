import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  LayoutDashboard,
  ClipboardList,
  ChartNoAxesCombined,
  LogOut,
  Menu,
  Percent,
  PanelLeftClose,
  PanelLeftOpen,
  PackageOpen,
  ReceiptText,
  Search,
  Settings,
  ShoppingCart,
  Siren,
  Users,
  UserRoundCog,
  Wallet,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './features/auth/AuthProvider'
import { useAuth } from './features/auth/authContext'
import { CustomersPage } from './features/customers/CustomersPage'
import { DashboardPage } from './features/dashboard/DashboardPage'
import { LoginPage } from './features/auth/LoginPage'
import { InstallmentsPage } from './features/installments/InstallmentsPage'
import { ProductsPage } from './features/products/ProductsPage'
import { SettingsPage } from './features/settings/SettingsPage'
import { SalesPage } from './features/sales/SalesPage'
import { PaymentCollectionPage } from './features/payments/PaymentCollectionPage'
import { LatePaymentsPage } from './features/late-payments/LatePaymentsPage'
import { DiscountsPage } from './features/discounts/DiscountsPage'
import { ReportsPage } from './features/reports/ReportsPage'
import { StaffPage } from './features/staff/StaffPage'
import { ActivityPage } from './features/activity/ActivityPage'
import { NotificationMenu } from './features/notifications/NotificationMenu'

const queryClient = new QueryClient()
const todayLabel = new Date().toLocaleDateString('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

const navigation = [
  { label: 'Overview', to: '/', icon: LayoutDashboard },
  { label: 'Customers', to: '/customers', icon: Users, permissions: ['customers:read'] },
  { label: 'Products', to: '/products', icon: PackageOpen, permissions: ['products:read', 'products:write'] },
  { label: 'Sales', to: '/sales', icon: ShoppingCart, permissions: ['sales:read', 'sales:create'] },
  { label: 'Installments', to: '/installments', icon: ReceiptText, permissions: ['agreements:read', 'agreements:create'] },
  { label: 'Collections', to: '/collections', icon: Wallet, permissions: ['payments:read'] },
  { label: 'Late payments', to: '/late-payments', icon: Siren, permissions: ['payments:read'] },
  { label: 'Discounts', to: '/discounts', icon: Percent, permissions: ['discounts:read', 'discounts:request', 'discounts:approve'] },
  { label: 'Reports', to: '/reports', icon: ChartNoAxesCombined, permissions: ['reports:sales', 'reports:balances', 'reports:late_fees', 'reports:overdue', 'reports:collections', 'reports:inventory', 'reports:low_stock', 'reports:staff', 'reports:discounts', 'reports:expenses', 'reports:profit'] },
  { label: 'Staff', to: '/staff', icon: UserRoundCog, ownerOnly: true },
  { label: 'Activity', to: '/activity', icon: ClipboardList, ownerOnly: true },
  { label: 'Settings', to: '/settings', icon: Settings, ownerOnly: true },
]

const unavailableRoutes = [
  '/inventory',
]

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <AppShell />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  )
}

function AppShell() {
  const { status } = useAuth()
  if (status === 'loading') {
    return <div className="flex min-h-[100dvh] items-center justify-center bg-slate-100 text-sm text-slate-600">Checking your session…</div>
  }
  return status === 'signed-in' ? <DashboardLayout /> : <LoginPage />
}

function DashboardLayout() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.localStorage.getItem('acceseries-sidebar-collapsed') === 'true',
  )
  const [search, setSearch] = useState('')
  const { logout, user } = useAuth()
  const [logoutError, setLogoutError] = useState('')
  const visibleNavigation = navigation.filter((item) => {
    if ('ownerOnly' in item && item.ownerOnly) return user?.role === 'owner'
    if ('permissions' in item && item.permissions) {
      return item.permissions.some((permission) => user?.permissions.includes(permission))
    }
    return true
  })

  useEffect(() => {
    window.localStorage.setItem('acceseries-sidebar-collapsed', String(sidebarCollapsed))
  }, [sidebarCollapsed])

  const handleLogout = async () => {
    queryClient.clear()
    setLogoutError('')
    try {
      await logout()
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : 'Unable to sign out.')
    }
  }

  return (
    <div className="min-h-[100dvh] bg-slate-100 text-slate-900">
      <div className="flex min-h-[100dvh]">
        {mobileNavOpen && (
          <button type="button" className="fixed inset-0 z-[60] bg-slate-950/30 md:hidden" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />
        )}
        <aside className={`fixed inset-y-0 left-0 z-[70] flex w-72 shrink-0 flex-col border-r border-slate-200 bg-white p-5 shadow-xl transition-all duration-300 md:static md:z-auto ${sidebarCollapsed ? 'md:w-20' : 'md:w-72'} ${mobileNavOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
          <div className={`mb-8 flex min-w-0 items-center ${sidebarCollapsed ? 'md:justify-center' : 'justify-between'}`}>
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-600 to-blue-400 text-lg font-extrabold text-white">A</div>
              <div className={sidebarCollapsed ? 'md:hidden' : ''}>
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-blue-600">Acceseries</p>
                <h1 className="text-xl font-extrabold text-slate-900">Operations</h1>
              </div>
            </div>
            <button type="button" aria-label="Close navigation" className="rounded-xl border border-slate-200 bg-white/60 p-2 text-slate-600 md:hidden" onClick={() => setMobileNavOpen(false)}>
              <X size={18} />
            </button>
          </div>
          <button type="button" aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} className="mb-4 hidden self-end rounded-xl border border-slate-200 p-2 text-slate-600 hover:bg-slate-50 md:block" onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}>
            {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
          <nav className="space-y-1.5">
            {visibleNavigation.map(({ label, to, icon: Icon }) => (
              <NavLink key={to} to={to} end={to === '/'} title={sidebarCollapsed ? label : undefined} className={({ isActive }) => `sidebar-link group relative ${isActive ? 'active' : ''} ${sidebarCollapsed ? 'md:justify-center md:px-0' : ''}`} onClick={() => setMobileNavOpen(false)}>
                <Icon size={18} /><span className={sidebarCollapsed ? 'md:sr-only' : ''}>{label}</span>
                {sidebarCollapsed && <span aria-hidden="true" className="pointer-events-none absolute left-full top-1/2 z-50 ml-3 hidden -translate-y-1/2 whitespace-nowrap rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-white shadow md:group-hover:block md:group-focus-visible:block">{label}</span>}
              </NavLink>
            ))}
          </nav>
          <div className={`mt-auto min-w-0 rounded-3xl border border-slate-200 bg-slate-50 p-4 ${sidebarCollapsed ? 'md:flex md:flex-col md:items-center md:p-2' : ''}`}>
            <p className={`truncate text-sm font-semibold text-slate-900 ${sidebarCollapsed ? 'md:hidden' : ''}`}>{user?.name || user?.email}</p>
            <p className={`truncate text-xs text-slate-500 ${sidebarCollapsed ? 'md:hidden' : ''}`}>{user?.email}</p>
            <button type="button" title={sidebarCollapsed ? 'Sign out' : undefined} onClick={handleLogout} className={`mt-4 inline-flex min-w-0 items-center gap-2 text-sm font-semibold text-red-600 hover:text-red-700 ${sidebarCollapsed ? 'md:mt-2 md:justify-center' : ''}`}>
              <LogOut size={16} /><span className={sidebarCollapsed ? 'md:sr-only' : ''}>Sign out</span>
            </button>
          </div>
        </aside>
        <main className="min-w-0 flex-1">
          <header className="relative z-10 min-w-0 border-b border-slate-200/80 bg-white px-4 py-4 md:px-8">
            <div className="flex min-w-0 flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div className="flex items-center gap-3">
                <button type="button" aria-label="Open navigation" className="rounded-xl border border-slate-200 bg-white/70 p-2 text-slate-700 md:hidden" onClick={() => setMobileNavOpen(true)}><Menu size={18} /></button>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.26em] text-slate-400">Today</p>
                  <h2 className="text-2xl font-extrabold tracking-tight text-slate-900">{todayLabel}</h2>
                </div>
              </div>
              <label className="relative block w-full min-w-0 max-w-md">
                <Search className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                <input value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search customers and products" placeholder="Search customers and products…" className="w-full max-w-full rounded-2xl border border-slate-200 bg-slate-50/80 py-3 pl-11 pr-4 text-base text-slate-700 outline-none focus:border-blue-300 focus:bg-white focus:ring-4 focus:ring-blue-100 md:text-sm" />
              </label>
              <NotificationMenu />
            </div>
          </header>
          <div className="p-4 md:p-8">
            {logoutError && <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{logoutError}</p>}
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/customers" element={<CustomersPage search={search} />} />
              <Route path="/products" element={<ProductsPage search={search} />} />
              <Route path="/sales" element={<SalesPage search={search} />} />
              <Route path="/installments" element={<InstallmentsPage />} />
              <Route path="/collections" element={user?.permissions.includes('payments:read') ? <PaymentCollectionPage isOwner={user.role === 'owner'} canRecordPayments={user.permissions.includes('payments:write')} canPrintReceipts={user.permissions.includes('receipts:print')} /> : <Navigate to="/" replace />} />
              <Route path="/late-payments" element={user?.permissions.includes('payments:read') ? <LatePaymentsPage isOwner={user.role === 'owner'} /> : <Navigate to="/" replace />} />
              <Route path="/discounts" element={user?.permissions.some((permission) => ['discounts:read', 'discounts:request', 'discounts:approve'].includes(permission)) ? <DiscountsPage isOwner={user.role === 'owner'} /> : <Navigate to="/" replace />} />
              <Route path="/reports" element={user?.role === 'owner' || user?.permissions.some((permission) => permission.startsWith('reports:')) ? <ReportsPage /> : <Navigate to="/" replace />} />
              <Route path="/staff" element={user?.role === 'owner' ? <StaffPage /> : <Navigate to="/" replace />} />
              <Route path="/activity" element={user?.role === 'owner' ? <ActivityPage /> : <Navigate to="/" replace />} />
              <Route path="/settings" element={user?.role === 'owner' ? <SettingsPage /> : <Navigate to="/" replace />} />
              {unavailableRoutes.map((path) => <Route key={path} path={path} element={<Navigate to="/" replace />} />)}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </main>
      </div>
    </div>
  )
}

export default App
