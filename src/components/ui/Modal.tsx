import {
  FloatingFocusManager,
  FloatingOverlay,
  FloatingPortal,
  useDismiss,
  useFloating,
  useInteractions,
} from '@floating-ui/react'
import { X } from 'lucide-react'
import { useCallback, useId, type ReactNode } from 'react'

type ModalProps = {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
}

export function Modal({ open, onClose, title, description, children, footer }: ModalProps) {
  const titleId = useId()
  const descriptionId = useId()
  const { refs, context } = useFloating({ open, onOpenChange: (nextOpen) => !nextOpen && onClose() })
  const dismiss = useDismiss(context, { escapeKey: true, outsidePress: true })
  const { getFloatingProps } = useInteractions([dismiss])
  const setFloating = useCallback((node: HTMLElement | null) => refs.setFloating(node), [refs])

  if (!open) return null

  return (
    <FloatingPortal>
      <FloatingOverlay
        lockScroll
        className="fixed inset-0 z-[100] flex items-end justify-center bg-slate-950/40 md:items-center md:p-4"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        <FloatingFocusManager context={context} modal>
          <section
            ref={setFloating}
            {...getFloatingProps()}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descriptionId : undefined}
            onClick={(event) => event.stopPropagation()}
            className="flex max-h-[90dvh] w-full min-w-0 flex-col overflow-hidden rounded-t-[28px] border border-slate-200 bg-white shadow-2xl md:w-[min(42rem,calc(100vw-2rem))] md:rounded-[28px]"
          >
            <header className="sticky top-0 z-10 flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 bg-white px-5 py-4 md:px-6">
              <div className="min-w-0">
                <h2 id={titleId} className="text-xl font-extrabold text-slate-900">{title}</h2>
                {description && <p id={descriptionId} className="mt-1 text-sm text-slate-500">{description}</p>}
              </div>
              <button type="button" aria-label="Close dialog" onClick={onClose} className="shrink-0 rounded-xl p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900">
                <X size={18} />
              </button>
            </header>
            <div className="min-h-0 overflow-y-auto overscroll-contain px-5 py-5 md:px-6">{children}</div>
            {footer && <footer className="sticky bottom-0 z-10 shrink-0 border-t border-slate-200 bg-white px-5 py-4 md:px-6">{footer}</footer>}
          </section>
        </FloatingFocusManager>
      </FloatingOverlay>
    </FloatingPortal>
  )
}
