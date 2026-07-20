"use client"

// Vendored shadcn primitive (Task 6 brief: "collapses to a mobile drawer
// under a breakpoint using shadcn's Sheet component"). Follows this repo's
// existing shadcn convention of importing from the combined "radix-ui"
// package (see components/ui/button.tsx's `import { Slot } from "radix-ui"`)
// rather than the individual `@radix-ui/react-dialog` package. No dedicated
// test file, same as button.tsx — this is vendored boilerplate, not
// project-specific logic; app/(office)/c/[companyId]/layout.test.tsx mocks
// this module wholesale (its own crash-under-forced-'react-server'-condition
// concern, same class of issue as next/navigation/lucide-react elsewhere in
// this repo — see components/locale-switcher.test.ts).
import * as React from "react"
import { Dialog as SheetPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger({ ...props }: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetPortal({ ...props }: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
    />
  )
}

function SheetContent({
  className,
  children,
  side = "right",
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: "top" | "right" | "bottom" | "left"
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          "fixed z-50 flex flex-col gap-4 bg-[var(--bg)] shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500",
          side === "left" &&
            "inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm",
          side === "right" &&
            "inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm",
          side === "top" && "inset-x-0 top-0 h-auto border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
          side === "bottom" &&
            "inset-x-0 bottom-0 h-auto border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
          className,
        )}
        {...props}
      >
        {children}
        {/* Plain "x" glyph, not a lucide-react icon — keeps this vendored
            primitive's own import surface from adding lucide-react as a
            transitive crash-under-test concern (see the module header
            comment) purely for a close button. */}
        <SheetPrimitive.Close className="absolute top-4 right-4 opacity-70 outline-none transition-opacity hover:opacity-100 focus:opacity-100">
          <span aria-hidden="true">×</span>
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPortal>
  )
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return <SheetPrimitive.Title data-slot="sheet-title" className={cn("font-semibold", className)} {...props} />
}

function SheetDescription({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-[var(--fg-muted)]", className)}
      {...props}
    />
  )
}

export { Sheet, SheetTrigger, SheetContent, SheetTitle, SheetDescription }
