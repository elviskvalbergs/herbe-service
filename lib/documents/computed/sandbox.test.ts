// lib/documents/computed/sandbox.test.ts
//
// WS12 Task 7 (part B): the WS6 computed-fields sandbox is STUBBED, not built
// (plan decision 12). These tests pin the seam's two only behaviors: no
// definitions -> {}; any definitions -> a loud throw rather than a silent
// no-op.
import { describe, expect, it } from 'vitest'
import {
  applyComputedFields,
  ComputedSandboxNotImplementedError,
  type ComputedFieldDefinition,
} from './sandbox'

describe('applyComputedFields (WS6 stub)', () => {
  it('returns {} when no definitions are passed', () => {
    expect(applyComputedFields({ order: { number: 'SR-1' } })).toEqual({})
  })

  it('returns {} when an empty definitions array is passed', () => {
    expect(applyComputedFields({}, [])).toEqual({})
  })

  it('throws ComputedSandboxNotImplementedError when any definition is passed', () => {
    const defs: ComputedFieldDefinition[] = [{ name: 'totalWithVat' }]
    expect(() => applyComputedFields({}, defs)).toThrow(ComputedSandboxNotImplementedError)
  })
})
