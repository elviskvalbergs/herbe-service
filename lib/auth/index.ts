// lib/auth/index.ts
import NextAuth from 'next-auth'
import { authConfig } from './config'

export const { handlers, signIn, signOut, auth } = NextAuth(authConfig)
