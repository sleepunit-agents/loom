"use client"
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { useMorph } from "@/lib/cojeev-motion/use-morph"

const KbdVariants=cva("v-kbd [display:inline-block] [padding:2px_var(--s-2)] [border-radius:var(--r-xs)] [background:var(--v-beige)] [border-bottom:2px_solid_var(--v-border)] [font-size:var(--fs-caps)] [font-weight:var(--fw-semibold)]",{variants:{variant:{"default":""},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type KbdProps=React.ComponentProps<"kbd"> & VariantProps<typeof KbdVariants> & { as?:React.ElementType }
export function Kbd({as:Tag="kbd",className,variant,size,ref,...props}:KbdProps){const ownedRef=useMorph<HTMLElement>("pills",ref);return <Tag ref={ownedRef} data-slot="kbd" data-part="root" className={cn(KbdVariants({variant,size}),className)} {...props}/>}
