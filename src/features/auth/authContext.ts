import { createContext, useContext } from 'react'

export type AuthUser = {
  id: string
  email: string
  name: string | null
  role: 'owner' | 'staff'
  canManageProducts: boolean
  permissions: string[]
}

export type AuthContextValue = {
  user: AuthUser | null
  status: 'loading' | 'signed-in' | 'signed-out'
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider.')
  return context
}
