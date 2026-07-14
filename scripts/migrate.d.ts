// Type declaration for migrate.mjs — tsc's "bundler" module resolution does
// not probe the .mjs extension for extensionless imports (unlike Vite/Node),
// so this sibling .d.ts is needed purely for typechecking. Runtime resolution
// (Vitest, Next.js, `node scripts/migrate.mjs`) is unaffected: it loads the
// .mjs file directly and ignores this declaration-only file.
export declare function runMigrations(connectionString?: string, migrationsDir?: string): Promise<void>
export declare function splitSqlStatements(input: string): string[]
