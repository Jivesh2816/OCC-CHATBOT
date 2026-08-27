import React from 'react'
import { cva } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10.5px] font-mono tracking-wide transition-colors",
  {
    variants: {
      variant: {
        default: "border-border text-muted-foreground",
        primary: "border-primary/50 text-primary",
        destructive: "border-destructive/50 text-destructive bg-destructive/10",
        solid: "border-transparent bg-accent text-accent-foreground"
      }
    },
    defaultVariants: { variant: 'default' }
  }
)

function Badge({ className, variant, ...props }) {
  return <div className={cn(badgeVariants({ variant, className }))} {...props} />
}

export { Badge, badgeVariants }
