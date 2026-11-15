import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { apiRequest } from '../../lib/api'
import { supabase, supabaseConfigurationError } from './supabase'
import { AuthContext, type AuthContextValue, type AuthUser } from './authContext'

async function loadProfile(): Promise<AuthUser> {
  return apiRequest<AuthUser>('/api/auth/me')
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [status, setStatus] = useState<AuthContextValue['status']>(
    supabase ? 'loading' : 'signed-out',
  )

  useEffect(() => {
    let active = true
    const client = supabase
    if (!client) {
      return () => {
        active = false
      }
    }

    const restoreSession = async () => {
      const { data, error } = await client.auth.getSession()
      if (error) {
        if (active) setStatus('signed-out')
        console.error('Unable to restore the authentication session.', error)
        return
      }
      if (!data.session) {
        if (active) setStatus('signed-out')
        return
      }
      try {
        const profile = await loadProfile()
        if (active) {
          setUser(profile)
          setStatus('signed-in')
        }
      } catch (reason) {
        await client.auth.signOut()
        if (active) setStatus('signed-out')
        console.error('Unable to load the signed-in user profile.', reason)
      }
    }

    const { data: authListener } = client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || !session) {
        setUser(null)
        setStatus('signed-out')
      } else if (event === 'SIGNED_IN') {
        window.setTimeout(() => {
          if (!active) return
          void loadProfile().then((profile) => {
            if (!active) return
            setUser(profile)
            setStatus('signed-in')
          }).catch((reason: unknown) => {
            console.error('Unable to load the signed-in user profile.', reason)
          })
        }, 0)
      }
    })
    void restoreSession()

    return () => {
      active = false
      authListener.subscription.unsubscribe()
    }
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    if (!supabase) throw new Error(supabaseConfigurationError)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw new Error(error.message)
    try {
      const profile = await loadProfile()
      setUser(profile)
      setStatus('signed-in')
    } catch (reason) {
      await supabase.auth.signOut()
      setUser(null)
      setStatus('signed-out')
      throw reason
    }
  }, [])

  const logout = useCallback(async () => {
    if (!supabase) throw new Error(supabaseConfigurationError)
    const { error } = await supabase.auth.signOut()
    if (error) throw new Error(error.message)
    setUser(null)
    setStatus('signed-out')
  }, [])

  const value = useMemo(() => ({ user, status, login, logout }), [user, status, login, logout])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
