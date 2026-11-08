"use client";
import * as React from "react";
import {motion,useTransform,type MotionValue} from "motion/react";
import {cva,type VariantProps} from "class-variance-authority";
import {cn} from "@/lib/utils";
import {assignMotionRef} from "@/lib/cojeev-motion/refs";
import {useMotionVisibility} from "@/lib/cojeev-motion/use-motion-visibility";
import {useOrganicValue,usePaintSize} from "@/lib/cojeev-motion/use-organic-value";
import {organicBandPath,organicLinePath,organicOrbitPath,progressRatio,segmentCount} from "@/lib/cojeev-motion/progress-geometry";

const ProgressVariants=cva("v-track",{variants:{variant:{default:"",cream:"-cream",unavail:"-unavail"},size:{default:"",lg:"-lg",sm:"-sm"}},defaultVariants:{variant:"default",size:"default"}});
export type ProgressAppearance="organic"|"line"|"segmented"|"orbit";
export type ProgressProps=React.ComponentProps<"div"> & VariantProps<typeof ProgressVariants> & {value?:number|null;max?:number;appearance?:ProgressAppearance;segments?:number};
function Segment({index,count,width,height,position,energy}:{index:number;count:number;width:MotionValue<number>;height:MotionValue<number>;position:MotionValue<number>;energy:MotionValue<number>}){
 const background=useTransform([width,height],([w,h])=>organicBandPath(Math.max(0,Number(w)/count-3),Number(h)));
 const fill=useTransform([width,height,position,energy],([w,h,p,e])=>organicBandPath(Math.max(0,Number(w)/count-3),Number(h),Math.max(0,Math.min(1,Number(p)*count-index)),Number(e)));
 const x=useTransform(width,w=>w/count*index);
 return <motion.g style={{x}}><motion.path d={background} className="v-progress__track"/><motion.path d={fill} className="v-progress__fill"/></motion.g>;
}
function ProgressPaint({position,energy,appearance,segments}:{position:MotionValue<number>;energy:MotionValue<number>;appearance:ProgressAppearance;segments:number}){
 const ref=React.useRef<SVGSVGElement|null>(null),{width,height}=usePaintSize(ref);
 const box=useTransform([width,height],([w,h])=>`0 0 ${w} ${h}`);
 const track=useTransform([width,height],([w,h])=>appearance==="line"?organicLinePath(Number(w),Number(h)):organicBandPath(Number(w),Number(h)));
 const fill=useTransform([width,height,position,energy],([w,h,p,e])=>appearance==="line"?organicLinePath(Number(w),Number(h),Number(p),Number(e)):organicBandPath(Number(w),Number(h),Number(p),Number(e)));
 const arc=useTransform([position,energy],([p,e])=>organicOrbitPath(Number(p),Number(e)));
 const opacity=useTransform(position,p=>p<=0?0:1);
 if(appearance==="orbit")return <svg className="v-progress__paint" viewBox="0 0 100 100" aria-hidden="true"><path className="v-progress__track" d={organicOrbitPath(1)}/><motion.path className="v-progress__fill" d={arc} style={{opacity}}/></svg>;
 return <motion.svg ref={ref} className="v-progress__paint" viewBox={box} preserveAspectRatio="none" aria-hidden="true">{appearance==="segmented"?Array.from({length:segments},(_,index)=><Segment key={index} {...{index,count:segments,width,height,position,energy}}/>):<><motion.path className="v-progress__track" d={track}/><motion.path className="v-progress__fill" d={fill} style={{opacity}}/></>}</motion.svg>;
}
export function Progress({ref,className,variant,size,value,max=100,appearance="organic",segments=12,children,style,...props}:ProgressProps){
 const total=Number.isFinite(max)&&max>0?max:100,supplied=value??props["aria-valuenow"],current=typeof supplied==="number"&&Number.isFinite(supplied)?Math.max(0,Math.min(supplied,total)):undefined;
 const unavailable=variant==="unavail"||current===undefined,ratio=unavailable?0:progressRatio(current,total);
 const host=React.useRef<HTMLDivElement|null>(null),{enabled,inView}=useMotionVisibility(host);
 const attach=React.useCallback((node:HTMLDivElement|null)=>{host.current=node;const release=assignMotionRef(ref,node);return()=>{host.current=null;release()}},[ref]);
 const {position,energy}=useOrganicValue(ratio,!enabled||!inView||unavailable||children!==undefined);
 return <div {...props} ref={attach} data-slot="progress" data-part="root" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={unavailable?undefined:current} aria-valuetext={props["aria-valuetext"]??(unavailable?"Unavailable":undefined)} data-state={unavailable?"unavailable":"determinate"} data-appearance={appearance} data-custom={children!==undefined||undefined} className={cn(ProgressVariants({variant:unavailable?"unavail":variant,size}),className)} style={style}>{children??<><i data-slot="progress-indicator" data-part="indicator" data-organic="true"><ProgressPaint key={appearance} {...{position,energy,appearance,segments:segmentCount(segments)}}/></i>{appearance==="orbit"&&<span className="v-progress__value" aria-hidden="true">{unavailable?"—":`${Math.round(ratio*100)}%`}</span>}</>}</div>;
}
/** Custom indicators retain their original --p width / --c color composition API. */
export type ProgressIndicatorProps=React.ComponentProps<"i">;
export function ProgressIndicator(props:ProgressIndicatorProps){return <i data-slot="progress-indicator" data-part="indicator" {...props}/>}
