import { supabase, supabaseConfigurationError } from '../features/auth/supabase'

const apiBaseUrl = import.meta.env.VITE_API_URL?.replace(/\/+$/, '')

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  authenticated = true,
): Promise<T> {
  if (!apiBaseUrl) throw new Error('API is not configured. Set VITE_API_URL and restart the frontend.')
  let accessToken: string | undefined
  if (authenticated) {
    if (!supabase) throw new Error(supabaseConfigurationError)
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
    if (sessionError) throw new Error('Unable to verify your sign-in session. Please sign in again.')
    accessToken = sessionData.session?.access_token
  }
  if (authenticated && !accessToken) throw new Error('Your session has expired. Please sign in again.')

  const headers = new Headers(options.headers)
  if (!(typeof FormData !== 'undefined' && options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }
  if (authenticated && accessToken) headers.set('Authorization', `Bearer ${accessToken}`)

  let response: Response
  try {
    response = await fetch(`${apiBaseUrl}${path}`, { ...options, headers })
  } catch {
    throw new Error('The API could not be reached. Check the backend URL and try again.')
  }

  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body &&
      typeof body.error === 'string'
      ? body.error
      : `Request failed (${response.status})`
    throw new Error(message)
  }
  return body as T
}
