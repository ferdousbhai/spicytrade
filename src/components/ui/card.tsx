import * as React from "react"

import { cn } from "#/lib/utils.ts"

// spicytrade's one card is the flat focus panel, so the flat treatment is the card's only style.
const CARD_CLASSES =
  "flex flex-col gap-(--card-spacing) overflow-hidden py-(--card-spacing) text-sm text-foreground [--card-spacing:--spacing(4)]"

function Card({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(CARD_CLASSES, className)}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "grid auto-rows-min items-start gap-1 px-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-(--card-spacing)", className)}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardContent,
}
