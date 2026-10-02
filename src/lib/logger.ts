import { sport } from './sport/index.js'
import * as Sentry from '@sentry/react'

type LogLevel = 'info' | 'warn' | 'error' | 'critical'

interface LogContext {
  [key: string]: unknown
}

function formatContext(ctx?: LogContext): string {
  if (!ctx || Object.keys(ctx).length === 0) return ''
  return ' ' + JSON.stringify(ctx)
}

function formatTelegramMessage(
  level: LogLevel,
  message: string,
  error?: unknown,
  ctx?: LogContext
): string {
  const emoji = level === 'critical' ? '🚨' : '⚠️'
  const lines = [`${emoji} *${sport.appName} ${level.toUpperCase()}*`, ``, `\`${message}\``]

  if (error instanceof Error) {
    lines.push(``, `Error: \`${error.message}\``)
  }

  if (ctx) {
    const entries = Object.entries(ctx)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n')
    if (entries) lines.push(``, entries)
  }

  if (typeof window !== 'undefined') {
    lines.push(``, `Page: ${window.location.pathname}`)
  }

  return lines.join('\n')
}

async function sendAlertToTelegram(message: string): Promise<void> {
  if (typeof window === 'undefined') return
  if (window.location.hostname === 'localhost') return
  try {
    await fetch('/api/notifications/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, botType: 'alert' }),
    })
  } catch {
    // never throw from the logger
  }
}

export const logger = {
  info(message: string, ctx?: LogContext) {
    console.log(`[MNS] ${message}${formatContext(ctx)}`)
  },

  warn(message: string, ctx?: LogContext) {
    console.warn(`[MNS] ${message}${formatContext(ctx)}`)
  },

  error(message: string, error?: unknown, ctx?: LogContext) {
    console.error(`[MNS] ${message}`, error || '', ctx || '')
    if (error instanceof Error) {
      Sentry.captureException(error, { extra: { message, ...ctx } })
    } else if (error) {
      Sentry.captureMessage(message, { level: 'error', extra: { error, ...ctx } })
    }
  },

  critical(message: string, error?: unknown, ctx?: LogContext) {
    console.error(`[MNS CRITICAL] ${message}`, error || '', ctx || '')
    if (error instanceof Error) {
      Sentry.captureException(error, { level: 'fatal', extra: { message, ...ctx } })
    } else {
      Sentry.captureMessage(message, { level: 'fatal', extra: { error, ...ctx } })
    }
    sendAlertToTelegram(formatTelegramMessage('critical', message, error, ctx))
  },
}
