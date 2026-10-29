"use client";
import { ReferenceField, type ReferenceFieldProps } from "@/lib/cojeev/reference-field";
export type StrandsProps = ReferenceFieldProps;
/** Layered sine ribbons move through a bounded field. */
export function Strands(props: StrandsProps) {
  return <ReferenceField {...props} kind="strands" />;
}
