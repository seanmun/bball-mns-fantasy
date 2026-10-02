import { sport } from '../src/lib/sport/index.js'
import { esc } from './_email.js'

// The MNS email look, ported from ncaa's email-templates/results.html:
// dark cards, bulletproof tables, Arial for words and Courier for
// numbers, the green wordmark up top. Kept as TS string builders rather
// than .html files on disk — runtime readFileSync is exactly the
// vercel.json packaging trap that took the API down on 2026-08-15, and
// a template that ships inside the bundle cannot go missing.
//
// Every email still gets a plain-text twin at the call site; these
// builders only make the html half.

const BG = '#080b10'
const CARD = '#111827'
const BORDER = '#1f2937'
const TEXT = '#f0f4f8'
const MUTED = '#8b949e'
const FAINT = '#6b7280'
const GREEN = '#00ff87'
const CYAN = '#00e5ff'
const AMBER = '#ffb000'
const RED = '#ff453a'

export const emailColors = { GREEN, CYAN, AMBER, RED, MUTED, TEXT }

const FONT = "Arial, sans-serif"
const MONO = "'Courier New', monospace"

// One uppercase section label, green like the app's eyebrows.
export function emailSection(label: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 20px 0 8px 0;">
    <tr><td style="padding: 0 24px;">
      <p style="color: ${GREEN}; font-family: ${FONT}; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; margin: 0;">${esc(label)}</p>
    </td></tr>
  </table>`
}

// A dark rounded card wrapping pre-built <tr> rows.
export function emailCard(rowsHtml: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td style="padding: 0 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: ${CARD}; border-radius: 12px; border: 1px solid ${BORDER};" bgcolor="${CARD}">
        ${rowsHtml}
      </table>
    </td></tr>
  </table>`
}

// One card row: title + optional sub on the left, an optional big mono
// value + small caption on the right. `last` drops the divider.
export function emailRow(opts: {
  title: string
  sub?: string
  value?: string
  valueColor?: string
  caption?: string
  last?: boolean
}): string {
  const border = opts.last ? '' : `border-bottom: 1px solid ${BORDER};`
  const right =
    opts.value != null
      ? `<td style="padding: 0; text-align: right; white-space: nowrap;">
          <p style="color: ${opts.valueColor ?? TEXT}; font-family: ${MONO}; font-size: 16px; font-weight: 700; margin: 0;">${opts.value}</p>
          ${opts.caption ? `<p style="color: ${MUTED}; font-family: ${FONT}; font-size: 10px; margin: 2px 0 0 0; text-transform: uppercase; letter-spacing: 1px;">${esc(opts.caption)}</p>` : ''}
        </td>`
      : ''
  return `<tr><td style="padding: 12px 16px; ${border}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="padding: 0;">
          <p style="color: ${TEXT}; font-family: ${FONT}; font-size: 14px; font-weight: 600; margin: 0;">${opts.title}</p>
          ${opts.sub ? `<p style="color: ${MUTED}; font-family: ${FONT}; font-size: 12px; margin: 2px 0 0 0;">${opts.sub}</p>` : ''}
        </td>
        ${right}
      </tr>
    </table>
  </td></tr>`
}

// A free-standing paragraph between cards.
export function emailNote(html: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td style="padding: 12px 24px 0 24px;">
      <p style="color: ${MUTED}; font-family: ${FONT}; font-size: 13px; line-height: 1.6; margin: 0;">${html}</p>
    </td></tr>
  </table>`
}

// The full document. `bodyHtml` is a stack of emailSection / emailCard /
// emailNote blocks; the shell adds wordmark, heading, CTA and footer.
export function emailShell(opts: {
  preheader: string
  heading: string
  subheading?: string
  bodyHtml: string
  ctaLabel?: string
  ctaUrl?: string
  footerLine: string
}): string {
  const cta =
    opts.ctaLabel && opts.ctaUrl
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="padding: 28px 24px 8px 24px; text-align: center;">
            <a href="${opts.ctaUrl}" style="display: inline-block; padding: 14px 32px; background-color: ${GREEN}; color: ${BG}; font-family: ${FONT}; font-size: 15px; font-weight: 700; text-decoration: none; border-radius: 12px;">${esc(opts.ctaLabel)}</a>
          </td></tr>
        </table>`
      : ''
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>${esc(opts.heading)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${BG};" bgcolor="${BG}">
  <div style="display: none; max-height: 0; overflow: hidden;">${esc(opts.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: ${BG};" bgcolor="${BG}">
    <tr><td align="center" style="padding: 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px;">

        <tr><td style="padding: 32px 24px 8px 24px; text-align: center;">
          <p style="color: ${TEXT}; font-family: ${FONT}; font-size: 22px; font-weight: 800; letter-spacing: 1px; margin: 0;">MNS<span style="color: ${GREEN};">${sport.leagueLabel}</span></p>
        </td></tr>

        <tr><td style="padding: 8px 24px 4px 24px;">
          <h1 style="color: ${TEXT}; font-family: ${FONT}; font-size: 22px; font-weight: 800; line-height: 1.25; margin: 0;">${opts.heading}</h1>
          ${opts.subheading ? `<p style="color: ${MUTED}; font-family: ${FONT}; font-size: 14px; margin: 6px 0 0 0;">${opts.subheading}</p>` : ''}
        </td></tr>

        <tr><td style="padding: 0;">${opts.bodyHtml}</td></tr>

        <tr><td style="padding: 0;">${cta}</td></tr>

        <tr><td style="padding: 24px 24px 40px 24px; text-align: center; border-top: 1px solid ${BORDER};">
          <p style="color: ${MUTED}; font-family: ${FONT}; font-size: 12px; line-height: 1.6; margin: 16px 0 0 0;">${opts.footerLine}</p>
          <p style="color: ${FAINT}; font-family: ${FONT}; font-size: 11px; margin: 12px 0 0 0;">&copy; ${new Date().getFullYear()} MNS Fantasy</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`
}

// Home-perspective number rendered for humans: "+3.5", "-3.5",
// "pick 'em", or "off the board".
export function fmtSpread(spread: number | null): string {
  if (spread == null) return 'off the board'
  if (spread === 0) return "pick 'em"
  return spread > 0 ? `+${spread}` : `${spread}`
}
