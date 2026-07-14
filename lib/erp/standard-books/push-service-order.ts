// Task 13: the one Phase-0 outbound round-trip — Service Order (SVOVc) create.
//
// Confirmed real-ERP finding (docs/19-demo-probe-results.md §10,
// "Persistence-verification rule"): a bare SVOVc POST can return HTTP 200 with
// the payload echoed back and no <error>, yet nothing was persisted (an
// exhausted/blank NextSerNr). "200, no error" is therefore not proof of a
// write — only a real assigned SerNr/@url id is. adapter.pushCreate returns
// whatever id was (or wasn't) assigned; this function is what classifies an
// empty one as a retryable transient failure rather than silently reporting
// success.
import { ErpTransientError, type ErpAdapter } from '@herbe/erp-core'

export interface ServiceOrderCreatePayload {
  custCode: string
  transDate: string
  rows: Array<{ artCode: string; quant: number; serialNr?: string }>
}

export async function pushServiceOrderCreate(
  adapter: ErpAdapter,
  payload: ServiceOrderCreatePayload,
): Promise<{ erpRef: string }> {
  const result = await adapter.pushCreate('SVOVc', payload as unknown as Record<string, unknown>)

  if (!result.erpRef) {
    throw new ErpTransientError(
      'SVOVc create returned no assigned SerNr — ERP may have echoed the payload without persisting (confirmed demo-probe behavior); retry or read back to confirm',
    )
  }

  return result
}
