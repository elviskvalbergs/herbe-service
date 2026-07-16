import { z } from 'zod'

export const standardBooksConfigSchema = z.object({
  baseUrl: z.string().url(),
  companyNumber: z.string(),
  auth: z.object({
    kind: z.literal('basic'),
    username: z.string(),
    password: z.string(),
  }),
  // WS4 outbound slice, Decision 9/10: per-connection opt-in for the
  // WebExcellentAPI-gated invoiced-status readback (getrecordlinks). Absent
  // on every connection until an admin turns it on for a tenant confirmed to
  // have WebExcellentAPI.
  features: z
    .object({
      invoiceReadback: z.boolean().optional(),
    })
    .optional(),
})

export type StandardBooksConfig = z.infer<typeof standardBooksConfigSchema>
