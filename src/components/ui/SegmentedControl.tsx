import { useId, type KeyboardEvent } from 'react'

export type SegmentOption<Value extends string> = {
  label: string
  value: Value
}

type SegmentedControlProps<Value extends string> = {
  value: Value
  options: readonly SegmentOption<Value>[]
  onChange: (value: Value) => void
  ariaLabel: string
  disabled?: boolean
  id?: string
  className?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
}

export function SegmentedControl<Value extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  id: groupId,
  className = '',
  ...ariaProps
}: SegmentedControlProps<Value>) {
  const id = useId()

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (options.length === 0) return
    let nextIndex: number | undefined
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % options.length
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + options.length) % options.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = options.length - 1
    if (nextIndex === undefined) return

    event.preventDefault()
    onChange(options[nextIndex].value)
    document.getElementById(`${id}-${nextIndex}`)?.focus()
  }

  return (
    <div id={groupId} role="radiogroup" aria-label={ariaLabel} className={`flex w-full min-w-0 gap-1 rounded-2xl border border-slate-200 bg-slate-100 p-1 ${className}`} {...ariaProps}>
      {options.map((option, index) => {
        const selected = value === option.value
        return (
          <button
            key={option.value}
            id={`${id}-${index}`}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={`min-w-0 flex-1 rounded-xl px-2 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${selected ? 'bg-white text-[#247BDB] shadow-sm' : 'text-slate-600 hover:bg-white/70'}`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
