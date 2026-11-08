"use client"
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const TypographyVariants=cva("v-prose [max-width:70ch] [display:grid] [gap:var(--s-4)]",{variants:{variant:{"default":""},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type TypographyProps=React.ComponentProps<"div"> & VariantProps<typeof TypographyVariants> & { as?:React.ElementType }
export function Typography({as:Tag="div",className,variant,size,...props}:TypographyProps){return <Tag data-slot="typography" data-part="root" className={cn(TypographyVariants({variant,size}),className)} {...props}/>}

const HeroVariants=cva("v-hero [font-family:var(--font-display)] [font-size:var(--fs-hero)] [line-height:var(--lh-hero)] [font-weight:var(--fw-display)] [letter-spacing:var(--ls-hero)] [text-wrap:nowrap] [white-space:nowrap]",{variants:{variant:{"default":""},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type HeroProps=React.ComponentProps<"h1"> & VariantProps<typeof HeroVariants> & { as?:React.ElementType }
export function Hero({as:Tag="h1",className,variant,size,...props}:HeroProps){return <Tag data-slot="typography-hero" data-part="hero" className={cn(HeroVariants({variant,size}),className)} {...props}/>}

const DisplayVariants=cva("v-display [font-family:var(--font-display)] [font-size:var(--fs-display)] [line-height:var(--lh-display)] [font-weight:var(--fw-display)] [letter-spacing:var(--ls-display)] [text-wrap:balance]",{variants:{variant:{"default":""},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type DisplayProps=React.ComponentProps<"h1"> & VariantProps<typeof DisplayVariants> & { as?:React.ElementType }
export function Display({as:Tag="h1",className,variant,size,...props}:DisplayProps){return <Tag data-slot="typography-display" data-part="display" className={cn(DisplayVariants({variant,size}),className)} {...props}/>}

const SectionTitleVariants=cva("v-section [font-family:var(--font-display)] [font-size:var(--fs-section)] [line-height:1.1] [font-weight:var(--fw-display)] [letter-spacing:-.01em]",{variants:{variant:{"default":""},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type SectionTitleProps=React.ComponentProps<"h2"> & VariantProps<typeof SectionTitleVariants> & { as?:React.ElementType }
export function SectionTitle({as:Tag="h2",className,variant,size,...props}:SectionTitleProps){return <Tag data-slot="typography-section" data-part="section" className={cn(SectionTitleVariants({variant,size}),className)} {...props}/>}

const TitleVariants=cva("v-title [font-size:var(--fs-title)] [line-height:1.25] [font-weight:var(--fw-title)] [letter-spacing:-.005em]",{variants:{variant:{"default":""},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type TitleProps=React.ComponentProps<"h3"> & VariantProps<typeof TitleVariants> & { as?:React.ElementType }
export function Title({as:Tag="h3",className,variant,size,...props}:TitleProps){return <Tag data-slot="typography-title" data-part="title" className={cn(TitleVariants({variant,size}),className)} {...props}/>}

const LeadVariants=cva("v-lead [font-size:var(--fs-lead)] [line-height:1.3] [font-weight:var(--fw-title)]",{variants:{variant:{"default":""},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type LeadProps=React.ComponentProps<"p"> & VariantProps<typeof LeadVariants> & { as?:React.ElementType }
export function Lead({as:Tag="p",className,variant,size,...props}:LeadProps){return <Tag data-slot="typography-lead" data-part="lead" className={cn(LeadVariants({variant,size}),className)} {...props}/>}

const BodyVariants=cva("v-body [font-size:var(--fs-reading)] [line-height:1.5]",{variants:{variant:{"default":""},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type BodyProps=React.ComponentProps<"p"> & VariantProps<typeof BodyVariants> & { as?:React.ElementType }
export function Body({as:Tag="p",className,variant,size,...props}:BodyProps){return <Tag data-slot="typography-body" data-part="body" className={cn(BodyVariants({variant,size}),className)} {...props}/>}

const BodySecondaryVariants=cva("v-body-2 [font-size:var(--fs-body)] [line-height:1.5] [color:var(--muted-foreground)]",{variants:{variant:{"default":""},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type BodySecondaryProps=React.ComponentProps<"p"> & VariantProps<typeof BodySecondaryVariants> & { as?:React.ElementType }
export function BodySecondary({as:Tag="p",className,variant,size,...props}:BodySecondaryProps){return <Tag data-slot="typography-body-secondary" data-part="body-secondary" className={cn(BodySecondaryVariants({variant,size}),className)} {...props}/>}

const ControlTextVariants=cva("v-control [font-size:var(--fs-control)] [line-height:var(--lh-control)] [font-weight:var(--fw-control)]",{variants:{variant:{"default":""},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type ControlTextProps=React.ComponentProps<"span"> & VariantProps<typeof ControlTextVariants> & { as?:React.ElementType }
export function ControlText({as:Tag="span",className,variant,size,...props}:ControlTextProps){return <Tag data-slot="typography-control" data-part="control" className={cn(ControlTextVariants({variant,size}),className)} {...props}/>}

const MetaVariants=cva("v-meta [font-size:var(--fs-meta)] [line-height:1.3] [color:var(--muted-foreground)]",{variants:{variant:{"default":""},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type MetaProps=React.ComponentProps<"span"> & VariantProps<typeof MetaVariants> & { as?:React.ElementType }
export function Meta({as:Tag="span",className,variant,size,...props}:MetaProps){return <Tag data-slot="typography-meta" data-part="meta" className={cn(MetaVariants({variant,size}),className)} {...props}/>}

const CapsVariants=cva("v-caps [font-size:var(--fs-caps)] [line-height:1.2] [font-weight:var(--fw-medium)] [letter-spacing:.075em] [text-transform:uppercase] [color:var(--muted-foreground)]",{variants:{variant:{"default":""},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type CapsProps=React.ComponentProps<"span"> & VariantProps<typeof CapsVariants> & { as?:React.ElementType }
export function Caps({as:Tag="span",className,variant,size,...props}:CapsProps){return <Tag data-slot="typography-caps" data-part="caps" className={cn(CapsVariants({variant,size}),className)} {...props}/>}

const ValueVariants=cva("v-value [font-size:var(--fs-body)] [font-weight:var(--fw-value)] [font-variant-numeric:tabular-nums_lining-nums]",{variants:{variant:{"default":""},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type ValueProps=React.ComponentProps<"span"> & VariantProps<typeof ValueVariants> & { as?:React.ElementType }
export function Value({as:Tag="span",className,variant,size,...props}:ValueProps){return <Tag data-slot="typography-value" data-part="value" className={cn(ValueVariants({variant,size}),className)} {...props}/>}

const IdentifierVariants=cva("v-id [font-variant-numeric:tabular-nums] [letter-spacing:.02em]",{variants:{variant:{"default":""},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type IdentifierProps=React.ComponentProps<"code"> & VariantProps<typeof IdentifierVariants> & { as?:React.ElementType }
export function Identifier({as:Tag="code",className,variant,size,...props}:IdentifierProps){return <Tag data-slot="typography-identifier" data-part="identifier" className={cn(IdentifierVariants({variant,size}),className)} {...props}/>}
