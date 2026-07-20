// lib/documents/computed/sandbox.ts
//
// WS6 computed-fields sandbox SEAM (docs/12-documents-templates.md §Computed
// fields; docs/superpowers/plans/2026-07-20-service-phase1-ws12-documents.md
// decision 12 "Not in this slice"). This is the shared JS sandbox interface
// WS6 will implement against — the SAME engine as WS6's REST transform hooks.
// WS6 owns the real sandboxed-JS implementation; herbe.service ships with ZERO
// computed-field definitions today, so this module is a deliberate stub, not a
// working sandbox.
//
// The stub throws (rather than silently no-op'ing) the moment any definition is
// actually passed, so a future WS6 wiring that forgets to swap this out can
// never silently drop real computed fields.

/** One computed-field definition. WS6 fills in the rest (source code to run in
 *  the sandbox, display rule); the name is the key it writes into `computed`. */
export interface ComputedFieldDefinition {
  name: string
  /* WS6 fills in: source code, display rule */
}

/** Output of a computed-fields run: the merged `computed` map that becomes
 *  OrderReportContext.computed. */
export interface ComputedFieldsResult {
  computed: Record<string, unknown>
}

export class ComputedSandboxNotImplementedError extends Error {
  constructor(count: number) {
    super(
      `computed-field sandbox not implemented: ${count} definition(s) passed, ` +
        `but WS6's sandboxed-JS engine has not landed yet — herbe.service ships ` +
        `with zero computed-field definitions (plan decision 12)`,
    )
    this.name = 'ComputedSandboxNotImplementedError'
  }
}

/**
 * STUB. Returns `{}` when there are no definitions (the only case in Phase 1),
 * and throws ComputedSandboxNotImplementedError if any definitions are passed,
 * so real definitions can never be silently ignored before WS6 wires the real
 * sandbox in behind this same signature.
 */
export function applyComputedFields(
  _context: object,
  definitions: ComputedFieldDefinition[] = [],
): Record<string, unknown> {
  if (definitions.length > 0) {
    throw new ComputedSandboxNotImplementedError(definitions.length)
  }
  return {}
}
