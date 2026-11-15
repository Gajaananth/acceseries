import {
  FloatingFocusManager,
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
} from '@floating-ui/react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { useCallback, useId, useMemo, useRef, useState } from 'react'

export type ComboboxOption<Value extends string> = {
  label: string
  value: Value
}

type ComboboxProps<Value extends string> = {
  options: readonly ComboboxOption<Value>[]
  value: Value | null
  onChange: (value: Value) => void
  ariaLabel: string
  placeholder?: string
  searchPlaceholder?: string
  onSearchChange?: (query: string) => void
  emptyMessage?: string
  id?: string
  className?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
}

export function Combobox<Value extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  placeholder = 'Select an option',
  searchPlaceholder = 'Search…',
  onSearchChange,
  emptyMessage = 'No results.',
  id,
  className = '',
  ...ariaProps
}: ComboboxProps<Value>) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return options.filter((option) => option.label.toLocaleLowerCase().includes(normalizedQuery))
  }, [options, query])
  const selected = options.find((option) => option.value === value)
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange(nextOpen) {
      setOpen(nextOpen)
      setQuery('')
      if (nextOpen) {
        setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)))
      }
    },
    placement: 'bottom-start',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, availableWidth, elements }) {
          const anchorWidth = elements.reference.getBoundingClientRect().width
          Object.assign(elements.floating.style, {
            maxHeight: `${Math.max(0, availableHeight)}px`,
            maxWidth: `${Math.max(0, availableWidth)}px`,
            width: `${Math.max(0, Math.min(anchorWidth, availableWidth))}px`,
          })
        },
      }),
    ],
  })
  const click = useClick(context)
  const dismiss = useDismiss(context, { escapeKey: true, outsidePress: true })
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss])
  const setReference = useCallback((node: HTMLButtonElement | null) => refs.setReference(node), [refs])
  const setFloating = useCallback((node: HTMLDivElement | null) => refs.setFloating(node), [refs])

  const openList = () => {
    setQuery('')
    setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)))
    setOpen(true)
  }

  const choose = (option: ComboboxOption<Value>) => {
    onChange(option.value)
    setQuery('')
    setOpen(false)
  }

  return (
    <>
      <button
        {...getReferenceProps({
          onKeyDown(event) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              openList()
            }
          },
        })}
        ref={setReference}
        id={id}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className={`field-input flex items-center justify-between gap-2 text-left ${className}`}
        {...ariaProps}
      >
        <span className={`min-w-0 flex-1 truncate ${selected ? 'text-slate-900' : 'text-slate-500'}`}>{selected?.label ?? placeholder}</span>
        <ChevronDown size={16} className="shrink-0 text-slate-400" aria-hidden="true" />
      </button>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} initialFocus={searchRef} returnFocus>
            <div
              ref={setFloating}
              style={floatingStyles}
              className="z-[120] flex min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl"
              {...getFloatingProps()}
            >
              <div className="border-b border-slate-100 p-2">
                <div className="relative">
                  <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    ref={searchRef}
                    type="search"
                    inputMode="search"
                    value={query}
                    aria-controls={listId}
                    aria-activedescendant={filteredOptions[activeIndex] ? `${listId}-option-${activeIndex}` : undefined}
                    onChange={(event) => {
                      setQuery(event.target.value)
                      setActiveIndex(0)
                      onSearchChange?.(event.target.value)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowDown') {
                        event.preventDefault()
                        setActiveIndex((index) => Math.max(0, Math.min(index + 1, filteredOptions.length - 1)))
                      } else if (event.key === 'ArrowUp') {
                        event.preventDefault()
                        setActiveIndex((index) => Math.max(index - 1, 0))
                      } else if (event.key === 'Enter' && filteredOptions[activeIndex]) {
                        event.preventDefault()
                        choose(filteredOptions[activeIndex])
                      }
                    }}
                    placeholder={searchPlaceholder}
                    className="w-full max-w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-3 text-base text-slate-900 outline-none focus:border-blue-300"
                  />
                </div>
              </div>
              <ul id={listId} role="listbox" aria-label={ariaLabel} className="min-h-0 flex-1 overflow-y-auto p-1">
                {filteredOptions.map((option, index) => (
                  <li key={option.value} role="presentation">
                    <button
                      id={`${listId}-option-${index}`}
                      type="button"
                      role="option"
                      aria-selected={option.value === value}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => choose(option)}
                      className={`flex w-full min-w-0 items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left text-sm ${index === activeIndex ? 'bg-blue-50 text-blue-800' : 'text-slate-700 hover:bg-slate-50'}`}
                    >
                      <span className="min-w-0 truncate">{option.label}</span>
                      {option.value === value && <Check size={16} className="shrink-0 text-[#247BDB]" aria-hidden="true" />}
                    </button>
                  </li>
                ))}
                {filteredOptions.length === 0 && <li className="px-3 py-3 text-sm text-slate-500">{emptyMessage}</li>}
              </ul>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  )
}
