import { z } from 'zod'

export type ParseOk<T> = { success: true; data: T }
export type ParseErr = { success: false; error: string }
export type ParseResult<T> = ParseOk<T> | ParseErr

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): ParseResult<T> {
  const result = schema.safeParse(body)
  if (result.success) return { success: true, data: result.data }
  return {
    success: false,
    error: result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; '),
  }
}

// --- Common request schemas ---

export const userSyncSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  avatarUrl: z.string().nullable().optional(),
})

export const telegramAlertSchema = z.object({
  message: z.string().min(1),
  botType: z.enum(['alert', 'draft']),
  chatId: z.string().optional(),
})

export const createLeagueSchema = z.object({
  name: z.string().trim().min(1).max(100),
})

export const updateLeagueSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    // config is the full LeagueConfig object. v1 trusts shape from the
    // client; tighter nested validation lands when the rule engine
    // grows constraints we care about enforcing server-side.
    config: z.any().optional(),
    keepersLocked: z.boolean().optional(),
  })
  .refine(
    (d) =>
      d.name !== undefined ||
      d.config !== undefined ||
      d.keepersLocked !== undefined,
    {
      message: 'Provide at least one of name, config, or keepersLocked',
    }
  )

export const setRookiePicksSchema = z
  .object({
    seasonYear: z.number().int().min(2020).max(2100),
    rounds: z.number().int().min(1).max(5),
    // Draft order for round 1; the same order repeats each round
    // (rookieOrderMethod 'manual' — no snaking).
    teamOrder: z.array(z.string().trim().min(1)).min(2).max(20),
  })
  .refine((d) => new Set(d.teamOrder).size === d.teamOrder.length, {
    message: 'teamOrder contains duplicate teams',
  })

export const bulkRosterRowSchema = z.object({
  playerName: z.string().trim().min(1),
  teamAbbrev: z.string().trim().min(1).max(6).toUpperCase().optional().nullable(),
  slot: z.enum(['active', 'bench', 'ir', 'redshirt', 'international']).optional(),
  position: z.string().trim().min(1).max(20).optional(),
  keeperPriorYearRound: z.number().int().min(1).max(20).nullable().optional(),
  isRookie: z.boolean().optional(),
})

export const bulkRosterImportSchema = z.object({
  rows: z.array(bulkRosterRowSchema).min(1).max(500),
})

export const updatePlayerSchema = z
  .object({
    teamId: z.string().nullable().optional(),
    slot: z.enum(['active', 'bench', 'ir', 'redshirt', 'international']).optional(),
    position: z.string().trim().min(1).max(20).optional(),
    keeperPriorYearRound: z.number().int().min(1).max(20).nullable().optional(),
    migratedKeeperRound: z.number().int().min(1).max(20).nullable().optional(),
    isRookie: z.boolean().optional(),
    intEligible: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: 'No fields to update',
  })

export const createTeamSchema = z.object({
  name: z.string().trim().min(1).max(50),
  abbrev: z.string().trim().min(1).max(6).toUpperCase(),
  // Optional: a team can exist before anyone owns it, and invites go
  // out only when the commissioner says so.
  ownerEmails: z
    .array(z.string().trim().toLowerCase().email())
    .max(5)
    .default([]),
  telegramUsername: z.string().trim().max(50).optional().nullable(),
})
