/* eslint-disable react-refresh/only-export-components -- preview harness, never hot-reloaded */
// Preview harness: the real component, fixture data, no auth. Opened by
// scripts/preview-shots.sh, which screenshots it in both themes at phone
// width — the look-at-it step before anything ships.
import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import '../src/index.css'
import { KeeperPlanner } from '../src/components/KeeperPlanner'

const params = new URLSearchParams(location.search)
const theme = params.get('theme')
if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme)
const screen = params.get('screen') ?? 'keepers'
// Headless Chrome never lays out narrower than 500px; ?width=400 pins
// the page to a real phone width inside the window.
const width = Number(params.get('width') ?? 0)
if (width > 0) {
  const root = document.getElementById('root')!
  root.style.maxWidth = `${width}px`
  root.style.margin = '0 auto'
  root.style.outline = '1px dashed #888'
}

// A crash paints its message on the page, so a screenshot shows it.
class Crash extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) }
  }
  render() {
    if (this.state.error) {
      return <pre style={{ background: '#000', color: '#f66', font: '11px/1.3 monospace', padding: 8, whiteSpace: 'pre-wrap' }}>{this.state.error}</pre>
    }
    return this.props.children
  }
}
window.addEventListener('error', (e) => {
  const box = document.createElement('pre')
  box.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#000;color:#f66;font:11px/1.3 monospace;padding:6px;white-space:pre-wrap'
  box.textContent = `window error: ${e.message}`
  document.body.appendChild(box)
})

function Screen() {
  if (screen === 'keepers') return <KeeperPlanner leagueId="the-money-never-sleeps-2027-f9vz7d" teamName="Shamous Royals" />
  return <p className="mns-page py-6">Unknown screen: {screen}</p>
}
// ?tap=<aria-label> — after render, click the control with that label,
// so a screenshot can show what a tap opens (a player card, a confirm).
const tap = params.get('tap')
if (tap) {
  setTimeout(() => {
    const el = document.querySelector<HTMLElement>(`[aria-label="${tap.replace(/"/g, '')}"]`)
    if (el) el.click()
    else console.warn('preview: nothing labelled', tap)
  }, 1200)
}

// ?probe=1 — after render, list every element that sticks out past the
// viewport, painted at the top of the page so a screenshot carries it.
if (params.get('probe')) {
  setTimeout(() => {
    const vw = window.innerWidth
    const bad: string[] = []
    document.querySelectorAll<HTMLElement>('body *').forEach((el) => {
      const r = el.getBoundingClientRect()
      if (r.right > vw + 1 && r.width > 0) {
        bad.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 4).join('.')} right=${Math.round(r.right)} w=${Math.round(r.width)}`)
      }
    })
    const box = document.createElement('pre')
    box.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#000;color:#0f0;font:11px/1.3 monospace;padding:6px;white-space:pre-wrap;max-height:45vh;overflow:auto'
    box.textContent = `viewport ${vw} scrollWidth ${document.documentElement.scrollWidth}\n` + bad.slice(0, 40).join('\n')
    document.body.appendChild(box)
  }, 1500)
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MemoryRouter>
      <Crash>
        <Screen />
      </Crash>
    </MemoryRouter>
  </StrictMode>
)
