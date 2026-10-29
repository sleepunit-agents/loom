"use client";
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { useFlowGroup } from "@/lib/cojeev-motion/use-flow";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Label, type LabelProps } from "@/components/ui/label";
import {
  controlRadiusStyle,
  type ControlAppearanceProps,
} from "@/lib/cojeev/control-appearance";
const FieldContext = React.createContext<{
  id: string;
  invalid: boolean;
  descriptions: string[];
  registerDescription: (id: string) => () => void;
} | null>(null);
const fieldVariants = cva(
  "v-field grid gap-[var(--s-2)] [border:0] bg-transparent [box-shadow:none]",
  {
    variants: { variant: { default: "", invalid: "-invalid" } },
    defaultVariants: { variant: "default" },
  },
);
export type FieldProps = React.ComponentProps<"div"> &
  VariantProps<typeof fieldVariants> &
  ControlAppearanceProps & {
    invalid?: boolean;
    controlId?: string;
    /** Place supporting copy beside the control, or collect it in one well. */
    layout?: "stacked" | "inline" | "integrated";
  };
export function Field({
  radius,
  appearance,
  style,
  className,
  variant,
  invalid = variant === "invalid",
  controlId,
  layout,
  children,
  ...props
}: FieldProps) {
  const generatedId = React.useId();
  const [descriptions, setDescriptions] = React.useState<string[]>([]);
  const registerDescription = React.useCallback((id: string) => {
    setDescriptions((current) =>
      current.includes(id) ? current : [...current, id],
    );
    return () =>
      setDescriptions((current) => current.filter((value) => value !== id));
  }, []);
  return (
    <FieldContext.Provider
      value={{
        id: controlId ?? generatedId,
        invalid,
        descriptions,
        registerDescription,
      }}
    >
      <div
        data-slot="field"
        data-appearance={appearance}
        data-layout={layout}
        style={{ ...style, ...controlRadiusStyle(radius) }}
        data-part="root"
        data-state={invalid ? "error" : "rest"}
        className={cn(
          fieldVariants({ variant: invalid ? "invalid" : variant }),
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </FieldContext.Provider>
  );
}
export type FieldLabelProps = LabelProps;
export function FieldLabel(props: FieldLabelProps) {
  const field = React.useContext(FieldContext);
  return (
    <Label
      data-slot="field-label"
      data-part="label"
      htmlFor={field?.id}
      {...props}
    />
  );
}
export type FieldControlProps = React.ComponentProps<typeof Slot>;
export function FieldControl({ children, ...props }: FieldControlProps) {
  const field = React.useContext(FieldContext);
  return (
    <Slot
      data-part="input"
      id={field?.id}
      aria-invalid={field?.invalid || undefined}
      aria-describedby={
        field?.descriptions.length ? field.descriptions.join(" ") : undefined
      }
      {...props}
    >
      {children}
    </Slot>
  );
}
export type FieldDescriptionProps = React.ComponentProps<"p">;
export function FieldDescription({
  className,
  id: suppliedId,
  ...props
}: FieldDescriptionProps) {
  const field = React.useContext(FieldContext);
  const generatedId = React.useId();
  const id = suppliedId ?? `${field?.id ?? "field"}-message-${generatedId}`;
  const register = field?.registerDescription;
  React.useLayoutEffect(() => register?.(id), [register, id]);
  return (
    <p
      data-slot="field-description"
      data-part="message"
      id={id}
      className={cn(
        "v-help min-h-[1.3em] text-[length:var(--fs-meta)] text-[color:var(--v-text-2)]",
        className,
      )}
      {...props}
    />
  );
}
export type FieldErrorProps = FieldDescriptionProps & {
  errors?: Array<{ message?: string } | undefined>;
};
export function FieldError({ errors, children, ...props }: FieldErrorProps) {
  return (
    <FieldDescription role="alert" {...props}>
      {children ??
        [
          ...new Set(errors?.map((error) => error?.message).filter(Boolean)),
        ].join(" ")}
    </FieldDescription>
  );
}
export type FieldSetProps = React.ComponentProps<"fieldset">;
export function FieldSet({ ref, className, ...props }: FieldSetProps) {
  const flowRef = useFlowGroup<HTMLFieldSetElement>(ref);
  return (
    <fieldset
      ref={flowRef}
      data-flow-fields=""
      data-slot="field-set"
      className={cn("grid min-w-0 gap-[var(--s-5)] [border:0] p-0", className)}
      {...props}
    />
  );
}
export type FieldLegendProps = React.ComponentProps<"legend">;
export function FieldLegend({ className, ...props }: FieldLegendProps) {
  return (
    <legend
      data-slot="field-legend"
      className={cn(
        "v-label text-[length:var(--fs-lead)] font-semibold",
        className,
      )}
      {...props}
    />
  );
}
export type FieldGroupProps = React.ComponentProps<"div"> & {
  asChild?: boolean;
};
export function FieldGroup({
  ref,
  asChild,
  className,
  ...props
}: FieldGroupProps) {
  const flowRef = useFlowGroup<HTMLDivElement>(ref);
  const Comp = asChild ? Slot : "div";
  return (
    <Comp
      ref={flowRef}
      data-flow-fields=""
      data-slot="field-group"
      className={cn(!asChild && "grid gap-[var(--s-5)]", className)}
      {...props}
    />
  );
}
export { fieldVariants };
