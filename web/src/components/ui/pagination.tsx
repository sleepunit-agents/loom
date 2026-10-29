"use client";
import * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
export const paginationVariants = cva("v-pager");
export type PaginationProps = React.ComponentProps<"nav"> & {
  page?: number;
  defaultPage?: number;
  totalPages?: number;
  onPageChange?: (page: number) => void;
  /** Direct pages, a reading position, or exact entry for a large collection. */
  appearance?: "pages" | "chapter" | "jump";
};
export function Pagination({
  ref,
  className,
  page,
  defaultPage = 1,
  totalPages,
  onPageChange,
  children,
  appearance = "pages",
  ...props
}: PaginationProps) {
  const [local, setLocal] = React.useState(defaultPage);
  const total = Math.max(
    1,
    Math.floor(Number.isFinite(totalPages) ? totalPages! : 1),
  );
  const current = Math.min(
    total,
    Math.max(
      1,
      Math.floor(Number.isFinite(page ?? local) ? (page ?? local) : 1),
    ),
  );
  // A fixed seven-slot window does not move the next/previous hit targets.
  const pages: (number | "start-gap" | "end-gap")[] =
    total <= 7
      ? Array.from({ length: total }, (_, index) => index + 1)
      : current <= 4
        ? [1, 2, 3, 4, 5, "end-gap", total]
        : current >= total - 3
          ? [1, "start-gap", total - 4, total - 3, total - 2, total - 1, total]
          : [
              1,
              "start-gap",
              current - 1,
              current,
              current + 1,
              "end-gap",
              total,
            ];
  const change = (next: number) => {
    const clamped = Math.max(1, Math.min(total, next));
    if (page === undefined) setLocal(clamped);
    if (clamped !== current) onPageChange?.(clamped);
  };
  return (
    <nav
      ref={ref}
      data-slot="pagination"
      data-part="root"
      data-pager=""
      data-pages={total}
      data-page={current}
      data-appearance={appearance}
      data-composed={children == null || undefined}
      aria-label="Pagination"
      className={cn(paginationVariants(), className)}
      {...props}
    >
      {children ?? (
        <>
          <PaginationPrevious
            disabled={current === 1}
            onClick={() => change(current - 1)}
          />
          {appearance === "pages" ? (
            <div className="v-pager__pages">
              {pages.map((n) =>
                typeof n === "number" ? (
                  <PaginationLink
                    key={n}
                    isActive={n === current}
                    aria-label={`Page ${n}`}
                    onClick={() => change(n)}
                  >
                    {n}
                  </PaginationLink>
                ) : (
                  <PaginationEllipsis key={n} />
                ),
              )}
            </div>
          ) : appearance === "chapter" ? (
            <div className="v-pager__chapter" aria-hidden="true">
              <span>Chapter</span>
              <strong>
                {String(current).padStart(2, "0")}{" "}
                <small>/ {String(total).padStart(2, "0")}</small>
              </strong>
              <span className="v-pager__track">
                <span style={{ transform: `scaleX(${current / total})` }} />
              </span>
            </div>
          ) : (
            <PaginationJump current={current} total={total} onChange={change} />
          )}
          <PaginationNext
            disabled={current === total}
            onClick={() => change(current + 1)}
          />
          <span className="v-pager__info" aria-live="polite">
            Page {current} of {total}
          </span>
        </>
      )}
    </nav>
  );
}
function PaginationJump({
  current,
  total,
  onChange,
}: {
  current: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const input = React.useRef<HTMLInputElement>(null);
  const id = React.useId();
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    if (input.current) input.current.value = String(current);
  }, [current]);
  const submit = () => {
    const value = input.current?.valueAsNumber;
    if (!Number.isInteger(value) || value! < 1 || value! > total) {
      setError(`Choose a whole page from 1 to ${total}.`);
      input.current?.focus();
      return;
    }
    setError("");
    onChange(value!);
  };
  return (
    <div className="v-pager__jump">
      <label htmlFor={id}>Go to page</label>
      <div className="v-pager__entry">
        <Input
          ref={input}
          id={id}
          type="number"
          min={1}
          max={total}
          step={1}
          defaultValue={current}
          aria-invalid={!!error}
          aria-describedby={`${id}-hint`}
          onChange={() => setError("")}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />
        <span>of {total}</span>
        <Button variant="secondary" onClick={submit}>
          Go
        </Button>
      </div>
      <span id={`${id}-hint`} className="v-pager__hint" role="status">
        {error || "Enter an exact page number."}
      </span>
    </div>
  );
}
export type PaginationContentProps = React.ComponentProps<"ul">;
export function PaginationContent({
  className,
  ...props
}: PaginationContentProps) {
  return (
    <ul
      data-slot="pagination-content"
      className={cn("contents list-none", className)}
      {...props}
    />
  );
}
export type PaginationItemProps = React.ComponentProps<"li">;
export function PaginationItem({ className, ...props }: PaginationItemProps) {
  return (
    <li
      data-slot="pagination-item"
      className={cn("contents", className)}
      {...props}
    />
  );
}
export type PaginationLinkProps = React.ComponentProps<typeof Button> & {
  isActive?: boolean;
};
export function PaginationLink({
  className,
  isActive,
  variant,
  style,
  ...props
}: PaginationLinkProps) {
  return (
    <Button
      type="button"
      data-slot="pagination-link"
      data-stable-hit=""
      data-part="item"
      aria-current={isActive ? "page" : undefined}
      variant={variant ?? (isActive ? "accent" : "outline")}
      className={cn("v-pager__link", className)}
      style={{
        minWidth: 44,
        minHeight: 44,
        paddingInline: 10,
        transform: "none",
        ...style,
      }}
      {...props}
    />
  );
}
export type PaginationPreviousProps = PaginationLinkProps;
export function PaginationPrevious({
  children,
  ...props
}: PaginationPreviousProps) {
  return (
    <PaginationLink
      aria-label="Previous"
      data-pager-direction="previous"
      {...props}
    >
      {children ?? <Icon name="arrow-left" size="sm" aria-hidden="true" />}
    </PaginationLink>
  );
}
export type PaginationNextProps = PaginationLinkProps;
export function PaginationNext({ children, ...props }: PaginationNextProps) {
  return (
    <PaginationLink aria-label="Next" data-pager-direction="next" {...props}>
      {children ?? <Icon name="arrow-right" size="sm" aria-hidden="true" />}
    </PaginationLink>
  );
}
export type PaginationEllipsisProps = React.ComponentProps<"span">;
export function PaginationEllipsis({
  className,
  ...props
}: PaginationEllipsisProps) {
  return (
    <span
      data-slot="pagination-ellipsis"
      aria-hidden="true"
      className={cn(
        "v-ellipsis px-[var(--s-1)] text-[color:var(--muted-foreground)]",
        className,
      )}
      {...props}
    >
      …
    </span>
  );
}
