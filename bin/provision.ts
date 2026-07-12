#!/usr/bin/env node
// bin/provision.ts
//
// Provisioning CLI shell (Task 18). Phase 0 scope only: `new` (create a
// per-tenant Supabase project) and `list` (enumerate existing projects).
// Fleet orchestration — forking the overlay repo, creating the Vercel
// project, env var wiring, customers.yaml inventory — and the
// rotate-secret/add-superadmin/verify subcommands are Phase 1 work (see
// docs/superpowers/plans/2026-07-08-phase-0-foundations.md, Task 18).
import { Command } from 'commander'
import crypto from 'node:crypto'
import { createSupabaseProvisioningClient } from '../lib/provisioning/supabase-client'

const REGION = 'eu-central-1'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing required env var: ${name}`)
    process.exit(1)
  }
  return value
}

const program = new Command()

program
  .command('new <slug>')
  .description('Create a Supabase project for a new tenant (customer-<slug>)')
  .option('--dry-run', 'print the plan without creating anything')
  .action(async (slug: string, opts: { dryRun?: boolean }) => {
    const client = createSupabaseProvisioningClient({ accessToken: requireEnv('SUPABASE_ACCESS_TOKEN') })
    const projectName = `customer-${slug}`

    const existing = await client.findProjectByName(projectName)
    if (existing) {
      console.log(`Project ${projectName} already exists (${existing.id})`)
      return
    }

    if (opts.dryRun) {
      console.log(`[dry-run] would create Supabase project "${projectName}" in ${REGION}`)
      return
    }

    const project = await client.createProject({
      name: projectName,
      organizationId: requireEnv('SUPABASE_ORG_ID'),
      region: REGION,
      dbPass: crypto.randomUUID(),
    })
    console.log(`Created ${project.name} (${project.id})`)
  })

program
  .command('list')
  .description('List existing Supabase projects')
  .action(async () => {
    const client = createSupabaseProvisioningClient({ accessToken: requireEnv('SUPABASE_ACCESS_TOKEN') })
    const projects = await client.listProjects()

    if (projects.length === 0) {
      console.log('No projects found.')
      return
    }
    for (const project of projects) {
      console.log(`${project.name}\t${project.id}\t${project.region}`)
    }
  })

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
