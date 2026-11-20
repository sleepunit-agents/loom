"use client"
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const MessageVariants=cva("v-msg [display:flex] [gap:var(--s-3)] [align-items:flex-end] [min-width:0]",{variants:{variant:{"default":"","me":"-me [flex-direction:row-reverse]"},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type MessageProps=React.ComponentProps<"div"> & VariantProps<typeof MessageVariants> & { as?:React.ElementType }
export function Message({as:Tag="div",className,variant,size,...props}:MessageProps){return <Tag data-slot="message" data-part="root" className={cn(MessageVariants({variant,size}),className)} {...props}/>}

const MessageContentVariants=cva("v-msg__stack [display:grid] [gap:var(--s-2)] [justify-items:start] [min-width:0]",{variants:{variant:{"default":""},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type MessageContentProps=React.ComponentProps<"div"> & VariantProps<typeof MessageContentVariants> & { as?:React.ElementType }
export function MessageContent({as:Tag="div",className,variant,size,...props}:MessageContentProps){return <Tag data-slot="message-content" data-part="content" className={cn(MessageContentVariants({variant,size}),className)} {...props}/>}

const MessageDescriptionVariants=cva("v-prov [font-size:var(--fs-caps)] [color:var(--muted-foreground)]",{variants:{variant:{"default":""},size:{"default":""}},defaultVariants:{variant:"default",size:"default"}})
export type MessageDescriptionProps=React.ComponentProps<"p"> & VariantProps<typeof MessageDescriptionVariants> & { as?:React.ElementType }
export function MessageDescription({as:Tag="p",className,variant,size,...props}:MessageDescriptionProps){return <Tag data-slot="message-description" data-part="description" className={cn(MessageDescriptionVariants({variant,size}),className)} {...props}/>}
