import { describe, expect, it } from 'vitest'
import * as seed from './index'
import { PERSONAS } from './personas'
import { seedBaseline } from './scenarios/baseline'

describe('lib/seed barrel export', () => {
  it('re-exports the fixed personas', () => {
    expect(seed.PERSONAS).toBe(PERSONAS)
  })

  it('re-exports the baseline scenario', () => {
    expect(seed.seedBaseline).toBe(seedBaseline)
  })
})
