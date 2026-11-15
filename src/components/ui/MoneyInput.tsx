import { useState } from 'react'
import { parseLkrToCents } from '../../shared/business'

type MoneyInputProps = {
  id?: string
  cents: number | null
  onChange: (cents: number | null) => void
  placeholder?: string
  className?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
}

function centsToInput(cents: number | null): string {
  if (cents === null) return ''
  return `${Math.floor(cents / 100)}.${(cents % 100).toString().padStart(2, '0')}`
}

export function MoneyInput({
  id,
  cents,
  onChange,
  placeholder = '0.00',
  className = '',
  ...ariaProps
}: MoneyInputProps) {
  const [draftOverride, setDraftOverride] = useState<string>()
  const draft = draftOverride !== undefined && parseLkrToCents(draftOverride) === cents
    ? draftOverride
    : centsToInput(cents)

  const handleChange = (input: string) => {
    const digitsAndPoints = input.replace(/[^\d.]/g, '')
    const pointIndex = digitsAndPoints.indexOf('.')
    const sanitized = pointIndex < 0
      ? digitsAndPoints
      : `${digitsAndPoints.slice(0, pointIndex + 1)}${digitsAndPoints.slice(pointIndex + 1).replaceAll('.', '')}`
    setDraftOverride(sanitized)
    onChange(sanitized === '' || sanitized === '.' ? null : parseLkrToCents(sanitized))
  }
  return (
    <div className={`flex w-full max-w-full min-w-0 items-center rounded-2xl border border-[#dfeaf7] bg-slate-50/90 focus-within:border-[#92b8eb] focus-within:ring-4 focus-within:ring-blue-100 ${className}`}>
      <span className="shrink-0 pl-3 text-sm font-semibold text-slate-500" aria-hidden="true">LKR</span>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={draft}
        onChange={(event) => handleChange(event.target.value)}
        onBlur={() => {
          setDraftOverride(centsToInput(cents))
        }}
        placeholder={placeholder}
        className="min-w-0 w-full max-w-full bg-transparent px-3 py-3 text-right text-base text-slate-900 outline-none"
        {...ariaProps}
      />
    </div>
  )
}
