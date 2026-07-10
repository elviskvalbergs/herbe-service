import { z } from 'zod'

export const standardBooksConfigSchema = z.object({
  baseUrl: z.string().url(),
  companyNumber: z.string(),
  auth: z.object({
    kind: z.literal('basic'),
    username: z.string(),
    password: z.string(),
  }),
})

export type StandardBooksConfig = z.infer<typeof standardBooksConfigSchema>
