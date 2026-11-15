import { cloneElement, useId, type ReactElement } from 'react'

type FieldControlProps = {
  id?: string
  className?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
}

type FormFieldProps = {
  label: string
  hint?: string
  error?: string
  children: ReactElement<FieldControlProps>
}

export function FormField({ label, hint, error, children }: FormFieldProps) {
  const generatedId = useId()
  const hintId = hint ? `${generatedId}-hint` : undefined
  const errorId = error ? `${generatedId}-error` : undefined
  const descriptionIds = [hintId, errorId].filter(Boolean).join(' ') || undefined

  const control = cloneElement(children, {
    id: children.props.id ?? generatedId,
    'aria-describedby': [children.props['aria-describedby'], descriptionIds].filter(Boolean).join(' ') || undefined,
    'aria-invalid': error ? true : children.props['aria-invalid'],
  })

  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={control.props.id} className="block text-sm font-medium text-slate-700">{label}</label>
      {control}
      {hint && <p id={hintId} className="text-xs text-slate-500">{hint}</p>}
      {error && <p id={errorId} role="alert" className="text-xs font-medium text-red-700">{error}</p>}
    </div>
  )
}
