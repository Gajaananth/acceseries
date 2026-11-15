import { useState, type FormEvent } from 'react'
import { useAuth } from './authContext'
import { isSupabaseConfigured, supabaseConfigurationError } from './supabase'

export function LoginPage() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      await login(email, password)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sign in failed.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[radial-gradient(circle_at_top_left,_rgba(36,123,219,0.18),_transparent_30%),radial-gradient(circle_at_bottom_right,_rgba(107,169,237,0.2),_transparent_25%),#f7f9fc] p-4">
      <div className="glass-panel w-full max-w-5xl overflow-hidden rounded-[32px] shadow-[0_30px_80px_rgba(15,23,42,0.12)]">
        <div className="grid md:grid-cols-2">
          <div className="relative hidden bg-gradient-to-br from-blue-600 via-blue-500 to-blue-300 p-10 text-white md:flex md:flex-col md:justify-between">
            <div>
              <div className="mb-8 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/15 text-2xl font-extrabold">A</div>
              <p className="text-xs font-semibold uppercase tracking-[0.35em] text-blue-100">Acceseries</p>
              <h1 className="mt-6 text-4xl font-extrabold leading-tight">Retail operations in one place.</h1>
            </div>
            <p className="text-sm text-blue-50">Sign in with your store account.</p>
          </div>
          <div className="bg-white/70 p-6 md:p-10">
            <div className="mb-8">
              <p className="text-xs font-semibold uppercase tracking-[0.3em] text-blue-600">Welcome</p>
              <h2 className="mt-3 text-3xl font-extrabold text-slate-900">Sign in to Acceseries</h2>
            </div>
            <form onSubmit={handleSubmit} className="space-y-5">
              {!isSupabaseConfigured && (
                <p role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  Sign-in is unavailable. {supabaseConfigurationError}
                </p>
              )}
              <label className="block text-sm font-medium text-slate-700">Email
                <input autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} className="field-input mt-1.5" type="email" required />
              </label>
              <label className="block text-sm font-medium text-slate-700">Password
                <input autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="field-input mt-1.5" type="password" required />
              </label>
              {error && <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
              <button disabled={submitting || !isSupabaseConfigured} type="submit" className="w-full rounded-2xl bg-[#247BDB] px-4 py-3 text-base font-bold text-white transition hover:bg-blue-700 disabled:opacity-60">
                {submitting ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  )
}
