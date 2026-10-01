// The tip-off lock. A player's day locks the moment their own game
// tips — in whatever slot they hold, on whatever team holds them —
// until tomorrow. Active stays active, bench stays bench, and nobody
// gets dropped mid-game. Everyone whose game has not started is still
// in play. Pure, so the screen and the API judge the same way.

export interface GameAtTip {
  tip: string // ISO kickoff
  state: 'pre' | 'in' | 'post'
}

export function playerLocked(game: GameAtTip | null | undefined, now = new Date()): boolean {
  if (!game) return false
  if (game.state !== 'pre') return true
  const tip = Date.parse(game.tip)
  return Number.isFinite(tip) && now.getTime() >= tip
}

export function tipClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function lockReason(name: string, game: GameAtTip): string {
  return `${name}'s game tipped at ${tipClock(game.tip)} ET — locked in place until tomorrow.`
}
