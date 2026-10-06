import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { useApi } from '../hooks/useApi'
import { useLeague } from '../contexts/LeagueContext'
import { Button, EmptyState } from '../ui/components'

interface Sent {
  id: string
  subject: string
  body: string
  recipients: number
  sent: number
  failed: number
  createdAt: string
}
interface Payload {
  recipients: number
  history: Sent[]
}

// Message the league: a subject, a plain message, one tap to send to
// every owner, and the record of what went out. Nothing fancy — the
// email shell does the styling, the commissioner does the words.
export function AdminMessage() {
  const { currentLeague, loading } = useLeague()
  const { apiFetch } = useApi()
  const [data, setData] = useState<Payload | null>(null)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const leagueId = currentLeague?.id

  const load = useCallback(() => {
    if (!leagueId) return
    apiFetch<Payload>(`/api/leagues/${leagueId}/message`)
      .then(setData)
      .catch((e: Error) => toast.error(e.message))
  }, [apiFetch, leagueId])
  useEffect(() => {
    load()
  }, [load])

  if (loading) return null
  if (!currentLeague) return <EmptyState title="No league selected">Pick a league first.</EmptyState>

  const send = async () => {
    setBusy(true)
    try {
      const r = await apiFetch<{ sent: number; failed: number; recipients: number }>(
        `/api/leagues/${currentLeague.id}/message`,
        { method: 'POST', body: JSON.stringify({ subject, body }) }
      )
      toast.success(
        r.failed === 0 ? `Sent to ${r.sent} owner${r.sent === 1 ? '' : 's'}.` : `Sent to ${r.sent}, ${r.failed} failed.`
      )
      setSubject('')
      setBody('')
      setConfirm(false)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Send failed')
    } finally {
      setBusy(false)
    }
  }
  const ready = subject.trim().length > 0 && body.trim().length > 0 && (data?.recipients ?? 0) > 0

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 pb-24">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Message</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {currentLeague.name} · goes to {data?.recipients ?? '…'} owner{data?.recipients === 1 ? '' : 's'} by email
          </p>
        </div>
        <Link
          to={`/league/${currentLeague.id}/lm`}
          className="text-sm text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] shrink-0"
        >
          ← Commissioner
        </Link>
      </div>

      <label className="block mb-3">
        <span className="block text-xs font-bold uppercase tracking-wider text-[var(--color-muted-foreground)] mb-1">
          Subject
        </span>
        <input
          value={subject}
          onChange={(e) => {
            setSubject(e.target.value)
            setConfirm(false)
          }}
          maxLength={120}
          placeholder="Trade deadline is Sunday"
          className="w-full px-3 py-2.5 min-h-[3rem] rounded-lg bg-mns-card border border-[var(--color-border-interactive)] text-[var(--color-foreground)] placeholder:text-[var(--color-muted-foreground)] focus:outline-none focus:border-[var(--color-accent)]"
        />
      </label>
      <label className="block mb-3">
        <span className="block text-xs font-bold uppercase tracking-wider text-[var(--color-muted-foreground)] mb-1">
          Message
        </span>
        <textarea
          value={body}
          onChange={(e) => {
            setBody(e.target.value)
            setConfirm(false)
          }}
          maxLength={4000}
          rows={7}
          placeholder="Plain words. Blank lines make paragraphs."
          className="w-full px-3 py-2.5 rounded-lg bg-mns-card border border-[var(--color-border-interactive)] text-[var(--color-foreground)] placeholder:text-[var(--color-muted-foreground)] focus:outline-none focus:border-[var(--color-accent)]"
        />
      </label>
      <div className="flex items-center gap-2">
        <Button
          variant={confirm ? 'danger' : 'primary'}
          disabled={!ready || busy}
          onClick={() => (confirm ? send() : setConfirm(true))}
        >
          {busy
            ? 'Sending…'
            : confirm
              ? `Yes — send to ${data?.recipients ?? 0} owner${data?.recipients === 1 ? '' : 's'}`
              : 'Send to the league'}
        </Button>
        {confirm ? (
          <Button variant="quiet" onClick={() => setConfirm(false)}>
            Not yet
          </Button>
        ) : null}
      </div>

      {data && data.history.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-lg font-bold mb-2">Sent</h2>
          <ul className="flex flex-col gap-2">
            {data.history.map((m) => (
              <li key={m.id} className="rounded-lg border border-[var(--color-border)] bg-mns-card px-3 py-2">
                <div className="flex items-baseline justify-between gap-3">
                  <b className="truncate">{m.subject}</b>
                  <span className="shrink-0 text-xs text-[var(--color-muted-foreground)] tabular-nums">
                    {new Date(m.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ·{' '}
                    {m.sent}/{m.recipients} sent{m.failed ? `, ${m.failed} failed` : ''}
                  </span>
                </div>
                <p className="mt-1 text-sm text-[var(--color-muted-foreground)] whitespace-pre-line line-clamp-3">{m.body}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
