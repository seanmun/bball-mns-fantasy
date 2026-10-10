import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

// A sliding area on desktop always has its own arrows: anything wider
// than the screen (a stats table, a strip of teams) pages sideways
// with ‹ › and the arrows grey out at either end. Phones swipe.
export function Slider({ children, label = 'Scroll', className = '' }: { children: ReactNode; label?: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [edge, setEdge] = useState({ left: true, right: true })
  const sync = useCallback(() => {
    const el = ref.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    setEdge({ left: el.scrollLeft <= 1, right: el.scrollLeft >= max - 1 })
  }, [])
  useEffect(() => {
    sync()
    const el = ref.current
    if (!el) return
    el.addEventListener('scroll', sync, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null
    ro?.observe(el)
    return () => {
      el.removeEventListener('scroll', sync)
      ro?.disconnect()
    }
  }, [sync, children])
  const page = (dir: -1 | 1) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.7, behavior: 'smooth' })
  const both = edge.left && edge.right
  return (
    <div className={className}>
      {!both ? (
        <div className="hidden lg:flex justify-end gap-1 px-2 pt-2">
          <button
            onClick={() => page(-1)}
            disabled={edge.left}
            aria-label={`${label} left`}
            className="min-h-[2.25rem] min-w-[2.25rem] inline-flex items-center justify-center rounded-lg border border-[var(--color-border-interactive)] bg-mns-card text-[var(--color-foreground)] disabled:opacity-35"
          >
            <ChevronLeft aria-hidden className="w-4 h-4" />
          </button>
          <button
            onClick={() => page(1)}
            disabled={edge.right}
            aria-label={`${label} right`}
            className="min-h-[2.25rem] min-w-[2.25rem] inline-flex items-center justify-center rounded-lg border border-[var(--color-border-interactive)] bg-mns-card text-[var(--color-foreground)] disabled:opacity-35"
          >
            <ChevronRight aria-hidden className="w-4 h-4" />
          </button>
        </div>
      ) : null}
      <div ref={ref} className="overflow-x-auto">
        {children}
      </div>
    </div>
  )
}
