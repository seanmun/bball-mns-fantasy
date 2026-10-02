import { sport } from '../lib/sport/index'
import { useState } from 'react'
import { useAuth } from '@clerk/clerk-react'

const HUB = import.meta.env.VITE_PLATFORM_URL || 'https://mnsfantasy.com'

export const BUMP_SUGGESTIONS = [
  'Set my lineup for tonight',
  "What's my matchup score?",
  'Who are the best available players under the cap?',
]

// One conversation contract for both Bump surfaces — the phone sheet and
// the desktop panel. The agent runs in the hub, acts with this member's
// own session, and already knows which league is on screen. `acted`
// tells the surface that closing should reload, so the page tells the
// truth about anything Bump changed.
export function useBumper(leagueId: string) {
  const { getToken } = useAuth()
  const [acted, setActed] = useState(false)

  const tts = async (text: string): Promise<Blob | null> => {
    const token = await getToken()
    const res = await fetch(`${HUB}/api/tts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ text }),
    })
    return res.ok ? res.blob() : null
  }

  const send = async (messages: Array<{ role: 'user' | 'assistant'; content: string }>) => {
    const token = await getToken()
    const res = await fetch(`${HUB}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ messages, context: { game: sport.hub.chatGame, leagueId } }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`)
    setActed(true)
    return (body as { reply: string }).reply
  }

  return { send, tts, acted }
}
