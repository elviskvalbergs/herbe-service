import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const FIXTURES_DIR = path.resolve(fileURLToPath(import.meta.url), '../../../fixtures')

export function loadGoldenFixture<T>(register: string): T {
  const filePath = path.join(FIXTURES_DIR, `${register.toLowerCase()}.json`)
  return JSON.parse(readFileSync(filePath, 'utf8')) as T
}
