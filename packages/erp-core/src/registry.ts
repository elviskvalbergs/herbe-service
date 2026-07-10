import type { ErpAdapter, ErpAdapterFactory } from './types'

const adapters = new Map<string, ErpAdapterFactory>()

export function registerAdapter(type: string, factory: ErpAdapterFactory): void {
  adapters.set(type, factory)
}

export function getAdapter(type: string, config: unknown): ErpAdapter {
  const factory = adapters.get(type)
  if (!factory) {
    throw new Error(`No ERP adapter registered for type "${type}"`)
  }
  return factory(config)
}
