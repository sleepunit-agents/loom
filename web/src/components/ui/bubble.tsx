"use client"
import { motion } from "motion/react"
import { useMotionVisibility } from "@/lib/cojeev-motion/use-motion-visibility"
import { useChoreography } from "@/lib/cojeev-motion/choreography"
import { assignMotionRef } from "@/lib/cojeev-motion/refs"
import { Button, type ButtonProps } from "@/components/ui/button"
import { useMorph } from "@/lib/cojeev-motion/use-morph";
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const BubbleVariants=cva("v-chat [display:grid] [gap:var(--s-1)] [padding:var(--s-5)_var(--s-5)_var(--s-4)] [border-radius:var(--r-panel)] [background:var(--v-beige)] [--bubble-surface:var(--v-beige)]",{variants:{variant:{"default":""},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type BubbleProps=React.ComponentProps<"div"> & VariantProps<typeof BubbleVariants> & { as?:React.ElementType }
export function Bubble({as:Tag="div",className,variant,size,...props}:BubbleProps){return <Tag data-slot="bubble" data-part="root" className={cn(BubbleVariants({variant,size}),className)} {...props}/>}

const BubbleRowVariants=cva("v-chat__row [display:flex] [align-items:flex-end] [gap:var(--s-3)] [max-width:82%] [justify-self:start]",{variants:{variant:{"default":"","me":"-me [justify-self:end] [flex-direction:row-reverse]"},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type BubbleRowProps=React.ComponentProps<"div"> & VariantProps<typeof BubbleRowVariants> & { as?:React.ElementType }
export function BubbleRow({as:Tag="div",className,variant,size,...props}:BubbleRowProps){return <Tag data-slot="bubble-item" data-part="item" className={cn(BubbleRowVariants({variant,size}),className)} {...props}/>}

const BubbleContentVariants=cva("v-bubble [display:inline-block] [max-width:min(80%,52ch)] [padding:var(--s-3)_var(--s-4)_var(--s-3)] [border-radius:var(--r-card)_var(--r-card)_var(--r-card)_var(--r-xs)] [background:var(--v-canvas)] [color:var(--v-text)] [font-size:var(--fs-control)] [line-height:1.4] [overflow-wrap:anywhere] [position:relative]",{variants:{variant:{"default":"","me":"-me [background:var(--v-pink)] [border-radius:var(--r-card)_var(--r-card)_var(--r-xs)_var(--r-card)] [color:var(--v-on-accent)]","tail":"-tail [border-bottom-left-radius:var(--r-card)]"},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type BubbleContentProps=React.ComponentProps<"div"> & VariantProps<typeof BubbleContentVariants> & { as?:React.ElementType }
export function BubbleContent({ref: externalMorphRef, as:Tag="div",className,variant,size,...props}:BubbleContentProps){const ownedMorphRef = useMorph<HTMLDivElement>("pills", externalMorphRef);
  return <Tag ref={ownedMorphRef} data-slot="bubble-content" data-part="content" className={cn(BubbleContentVariants({variant,size}),className)} {...props}/>}

const BubbleGapVariants=cva("v-chat__gap [height:10px]",{variants:{variant:{"default":""},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type BubbleGapProps=React.ComponentProps<"div"> & VariantProps<typeof BubbleGapVariants> & { as?:React.ElementType }
export function BubbleGap({as:Tag="div",className,variant,size,...props}:BubbleGapProps){return <Tag data-slot="bubble-gap" data-part="gap" className={cn(BubbleGapVariants({variant,size}),className)} {...props}/>}

const BubbleTimeVariants=cva("v-chat__time [font-size:var(--fs-caps)] [color:var(--v-text-2)] [padding:var(--s-2)_0_2px_38px] [font-variant-numeric:tabular-nums]",{variants:{variant:{"default":""},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type BubbleTimeProps=React.ComponentProps<"div"> & VariantProps<typeof BubbleTimeVariants> & { as?:React.ElementType }
export function BubbleTime({as:Tag="div",className,variant,size,...props}:BubbleTimeProps){return <Tag data-slot="bubble-time" data-part="time" className={cn(BubbleTimeVariants({variant,size}),className)} {...props}/>}

/** A real caller-owned reaction action. Supply its accessible name and count. */
export type BubbleReactionProps=ButtonProps & { "aria-label": string }
export function BubbleReaction({className,variant="secondary",size="sm",...props}:BubbleReactionProps){
  return <Button variant={variant} size={size} {...props} data-slot="bubble-reaction" className={cn("v-bubble__reaction",className)}/>
}
export type BubbleTypingProps=React.ComponentProps<"span"> & { label?:string }
/** Render only while the caller has an actual typing state. */
export function BubbleTyping({label="Typing",className,ref,...props}:BubbleTypingProps){
  const host=React.useRef<HTMLSpanElement>(null)
  const attach=React.useCallback((node:HTMLSpanElement|null)=>{host.current=node;const release=assignMotionRef(ref,node);return ()=>{host.current=null;release()}},[ref])
  const {enabled,inView}=useMotionVisibility(host)
  const {quiet}=useChoreography()
  const active=enabled&&inView&&!quiet
  return <span {...props} ref={attach} data-slot="bubble-typing" className={cn("v-bubble__typing",className)} role="status" aria-label={label}>
    {[0,1,2].map(index=><motion.span key={index} aria-hidden="true" className="v-bubble__typing-dot" initial={false} animate={active?{y:[0,-3,0],scale:[1,1.14,1],opacity:[.45,1,.45]}:{y:0,scale:1,opacity:.65}} transition={active?{duration:1.2,delay:index*.14,repeat:Infinity,ease:"easeInOut"}:{duration:0}}/>)}
  </span>
}
