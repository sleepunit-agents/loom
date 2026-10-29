import { useMorph } from "@/lib/cojeev-motion/use-morph";
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { cardVariants } from "@/components/ui/card"

const EmptyVariants=cva("v-empty [display:grid] [justify-items:center] [text-align:center] [gap:var(--s-3)] [padding:var(--s-12)_var(--s-6)]",{variants:{variant:{"default":""},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type EmptyProps=React.ComponentProps<"div"> & VariantProps<typeof EmptyVariants> & { as?:React.ElementType }
export function Empty({ref: externalMorphRef, as:Tag="div",className,variant,size,...props}:EmptyProps){const ownedMorphRef = useMorph<HTMLDivElement>("cards", externalMorphRef);
  return <Tag ref={ownedMorphRef} data-slot="empty" data-part="root" className={cn(className?.split(/\s+/).includes("v-card")&&cardVariants(),EmptyVariants({variant,size}),className)} {...props}/>}

const EmptyTitleVariants=cva("v-empty__title [font-family:var(--font-display)] [font-size:var(--fs-section)] [font-weight:var(--fw-medium)]",{variants:{variant:{"default":""},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type EmptyTitleProps=React.ComponentProps<"h3"> & VariantProps<typeof EmptyTitleVariants> & { as?:React.ElementType }
export function EmptyTitle({as:Tag="h3",className,variant,size,...props}:EmptyTitleProps){return <Tag data-slot="empty-title" data-part="title" className={cn(EmptyTitleVariants({variant,size}),className)} {...props}/>}

const EmptyDescriptionVariants=cva("v-empty__text [color:var(--muted-foreground)] [max-width:36ch]",{variants:{variant:{"default":""},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type EmptyDescriptionProps=React.ComponentProps<"p"> & VariantProps<typeof EmptyDescriptionVariants> & { as?:React.ElementType }
export function EmptyDescription({as:Tag="p",className,variant,size,...props}:EmptyDescriptionProps){return <Tag data-slot="empty-description" data-part="description" className={cn(EmptyDescriptionVariants({variant,size}),className)} {...props}/>}

const EmptyStateVariants=cva("v-state [display:grid] [gap:var(--s-3)] [padding:var(--s-6)] [border-radius:var(--r-card)] [background:var(--card)] [align-content:center] [justify-items:start] [min-height:160px]",{variants:{variant:{"default":"","partial":"-partial [--muted-foreground:var(--muted-foreground-tinted)] [background:var(--v-yellow-soft)]","error":"-error [background:var(--status-danger-bg)]","filtered":"-filtered [background:transparent] [border:1px_dashed_var(--v-border)]"},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type EmptyStateProps=React.ComponentProps<"div"> & VariantProps<typeof EmptyStateVariants> & { as?:React.ElementType }
export function EmptyState({ref: externalMorphRef, as:Tag="div",className,variant,size,...props}:EmptyStateProps){const ownedMorphRef = useMorph<HTMLDivElement>("cards", externalMorphRef);
  return <Tag ref={ownedMorphRef} data-slot="empty-state" data-part="state" className={cn(EmptyStateVariants({variant,size}),className)} {...props}/>}

const EmptyStateTitleVariants=cva("v-state__word [font-weight:var(--fw-semibold)] [display:flex] [align-items:center] [gap:var(--s-2)]",{variants:{variant:{"default":""},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type EmptyStateTitleProps=React.ComponentProps<"div"> & VariantProps<typeof EmptyStateTitleVariants> & { as?:React.ElementType }
export function EmptyStateTitle({as:Tag="div",className,variant,size,...props}:EmptyStateTitleProps){return <Tag data-slot="empty-state-title" data-part="state-title" className={cn(EmptyStateTitleVariants({variant,size}),className)} {...props}/>}

const EmptyStateDescriptionVariants=cva("v-state__why [color:var(--muted-foreground)] [font-size:var(--fs-control)] [max-width:44ch]",{variants:{variant:{"default":""},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type EmptyStateDescriptionProps=React.ComponentProps<"p"> & VariantProps<typeof EmptyStateDescriptionVariants> & { as?:React.ElementType }
export function EmptyStateDescription({as:Tag="p",className,variant,size,...props}:EmptyStateDescriptionProps){return <Tag data-slot="empty-state-description" data-part="state-description" className={cn(EmptyStateDescriptionVariants({variant,size}),className)} {...props}/>}
