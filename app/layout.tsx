import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { db } from "@/lib/db";
import { getVerifiedSession } from "@/lib/auth/session-guard";
import { getUserPrefs } from "@/lib/settings/user-prefs";
import "./globals.css";

export const metadata: Metadata = {
  title: "herbe.service",
  description: "Field service and dispatch app for herbe.app",
  manifest: "/manifest.json",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const messages = await getMessages();

  // Root layout renders for both authenticated and unauthenticated routes
  // (e.g. a future /login), so no session must not break rendering — it's
  // treated the same as displayScheme: 'standard' (no attribute set).
  const session = await getVerifiedSession(db);
  const displayScheme = session?.user?.id
    ? (await getUserPrefs(db, session.user.id)).displayScheme
    : "standard";

  // The 3-value union is mutually exclusive, so at most one of these is set.
  const themeAttrs: { "data-theme"?: string; "data-scheme"?: string } = {};
  if (displayScheme === "dark") themeAttrs["data-theme"] = "dark";
  if (displayScheme === "sunlight") themeAttrs["data-scheme"] = "sunlight";

  return (
    <html lang={locale} className="h-full antialiased" {...themeAttrs}>
      <body className="min-h-full flex flex-col">
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
