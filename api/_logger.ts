import { sport } from '../src/lib/sport/index.js'
type LogLevel = 'info' | 'warn' | 'error' | 'critical'

type LogContext = Record<string, unknown>

async function sendAlertToTelegram(message: string, ctx?: LogContext): Promise<void> {
  const token = process.env.TELEGRAM_ALERT_BOT_TOKEN
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID
  if (!token || !chatId) return
  try {
    const lines = [`🚨 *${sport.appName} CRITICAL (api)*`, ``, `\`${message}\``]
    if (ctx && Object.keys(ctx).length > 0) {
      lines.push('', JSON.stringify(ctx))
    }
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: lines.join('\n'),
        parse_mode: 'Markdown',
      }),
    })
  } catch {
    // never throw from logger
  }
}

function log(level: LogLevel, message: string, ctx?: LogContext) {
  const ts = new Date().toISOString()
  const ctxStr = ctx ? ' ' + JSON.stringify(ctx) : ''
  const line = `[${ts}] [${level.toUpperCase()}] ${message}${ctxStr}`
  if (level === 'error' || level === 'critical') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)

  if (level === 'critical') {
    void sendAlertToTelegram(message, ctx)
  }
}

export const logger = {
  info: (m: string, ctx?: LogContext) => log('info', m, ctx),
  warn: (m: string, ctx?: LogContext) => log('warn', m, ctx),
  error: (m: string, ctx?: LogContext) => log('error', m, ctx),
  critical: (m: string, ctx?: LogContext) => log('critical', m, ctx),
}
