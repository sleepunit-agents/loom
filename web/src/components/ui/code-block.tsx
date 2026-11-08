"use client";

import * as React from "react";
import Prism from "prismjs";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-json";
import "prismjs/components/prism-bash";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Meta } from "@/components/ui/typography";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { Icon } from "@/components/ui/icon";
import {
  PatternBackground,
  type PatternBackgroundProps,
} from "@/components/ui/pattern-background";
import { cn } from "@/lib/utils";

/** The fallback stays inside the control's tree, including a modal focus scope. */
function copyWithSelection(code: string, trigger: HTMLButtonElement): boolean {
  const document = trigger.ownerDocument;
  const active = document.activeElement as HTMLElement | null;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) =>
        selection.getRangeAt(i).cloneRange(),
      )
    : [];
  const field =
    active?.tagName === "INPUT" || active?.tagName === "TEXTAREA"
      ? (active as HTMLInputElement | HTMLTextAreaElement)
      : null;
  const fieldSelection =
    field && field.selectionStart !== null
      ? ([
          field.selectionStart,
          field.selectionEnd,
          field.selectionDirection ?? undefined,
        ] as const)
      : null;
  const view = document.defaultView;
  const scroll = view ? { x: view.scrollX, y: view.scrollY } : null;
  const textarea = document.createElement("textarea");
  textarea.value = code;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.setAttribute("aria-hidden", "true");
  textarea.setAttribute("data-copy-fallback", "");
  textarea.style.cssText =
    "position:fixed;inset-block-start:0;inset-inline-start:-9999px;width:1px;height:1px;padding:0;border:0;font-size:16px;opacity:0;";
  (trigger.parentElement ?? document.body).append(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, code.length);
    return (
      typeof document.execCommand === "function" && document.execCommand("copy")
    );
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (active?.isConnected) active.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
    // Document selection restoration can reset a focused input's native range.
    if (field?.isConnected && fieldSelection) {
      field.setSelectionRange(...fieldSelection);
    }
    if (view && scroll) view.scrollTo(scroll.x, scroll.y);
  }
}

async function copyText(
  code: string,
  trigger: HTMLButtonElement,
): Promise<boolean> {
  try {
    const clipboard = trigger.ownerDocument.defaultView?.navigator.clipboard;
    if (clipboard?.writeText) {
      await clipboard.writeText(code);
      return true;
    }
  } catch {
    // An unavailable or denied Clipboard API can still allow a user-initiated copy.
  }
  return copyWithSelection(code, trigger);
}

export type CopyButtonProps = ButtonProps & {
  code: string;
  /** Reports the real copy outcome without exposing copied content. */
  onCopyResult?: (result: "success" | "failure") => void;
};

/** Copies exactly `code`; success is reported only after a copy mechanism succeeds. */
export function CopyButton({
  code,
  children,
  className,
  size = "sm",
  variant = "ghost",
  asChild = false,
  disabled,
  onClick,
  onCopyResult,
  ...props
}: CopyButtonProps) {
  const [result, setResult] = React.useState<{
    code: string;
    state: "copying" | "copied" | "error";
  } | null>(null);
  const pending = React.useRef(false);
  const statusId = React.useId();
  const state = result?.code === code ? result.state : "idle";
  const icon = (
    <AnimatedIcon
      name={
        state === "copied"
          ? "check"
          : state === "error"
            ? "triangle-alert"
            : state === "copying"
              ? "loader-circle"
              : "copy"
      }
      size="sm"
      aria-hidden="true"
    />
  );
  const content =
    asChild &&
    React.isValidElement<{ children?: React.ReactNode }>(children) ? (
      React.cloneElement(children, {}, icon, children.props.children)
    ) : (
      <>
        {icon}
        {children ?? "Copy"}
      </>
    );
  return (
    <span data-slot="copy-control" className="v-copy-control">
      <Button
        {...props}
        type="button"
        data-slot="copy-button"
        className={className}
        size={size}
        variant={variant}
        asChild={asChild}
        disabled={disabled}
        aria-disabled={
          disabled || state === "copying" || props["aria-disabled"]
        }
        aria-describedby={[props["aria-describedby"], statusId]
          .filter(Boolean)
          .join(" ")}
        aria-busy={state === "copying" || undefined}
        onClick={async (event) => {
          onClick?.(event);
          if (event.defaultPrevented || pending.current) return;
          const trigger = event.currentTarget;
          pending.current = true;
          setResult({ code, state: "copying" });
          let copied = false;
          try {
            copied = await copyText(code, trigger);
          } catch {
            // Preserve manual copying if the browser rejects both mechanisms.
          } finally {
            pending.current = false;
            setResult({ code, state: copied ? "copied" : "error" });
            try {
              onCopyResult?.(copied ? "success" : "failure");
            } catch {
              // Consumer instrumentation must not change truthful copy feedback.
            }
          }
        }}
      >
        {content}
      </Button>
      <Meta
        as="span"
        id={statusId}
        role="status"
        aria-live="polite"
        data-copy-state={state}
      >
        {state === "copied"
          ? "Copied to clipboard."
          : state === "error"
            ? "Copy unavailable. Select the text and copy it manually."
            : state === "copying"
              ? "Copying to clipboard."
              : ""}
      </Meta>
    </span>
  );
}

export type CodeBlockProps = Omit<
  React.ComponentProps<"figure">,
  "children" | "title"
> & {
  code: string;
  language?: string;
  title?: string;
  wrap?: boolean;
  copyLabel?: string;
  /** Reports the real copy outcome without exposing copied content. */
  onCopyResult?: CopyButtonProps["onCopyResult"];
  /** Terminal adds window chrome and a decorative prompt; copied text stays exact. */
  variant?: "code" | "terminal";
  /** Use a containing viewer's header and copy action instead of nesting chrome. */
  embedded?: boolean;
  /** Plain by default to keep source text clear. Decorative patterns are opt-in. */
  pattern?: PatternBackgroundProps["variant"];
};

// Render tokens as React text nodes: source stays selectable and is never HTML.
function renderTokens(tokens: Array<string | Prism.Token>): React.ReactNode[] {
  return tokens.map((token, index) =>
    typeof token === "string" ? (
      token
    ) : (
      <span key={index} className={`token ${token.type}`}>
        {typeof token.content === "string"
          ? token.content
          : renderTokens(
              Array.isArray(token.content) ? token.content : [token.content],
            )}
      </span>
    ),
  );
}

/** Language-aware source, with exact copy text and a quiet Cojeev syntax palette. */
export function CodeBlock({
  code,
  language,
  title,
  wrap = false,
  copyLabel,
  onCopyResult,
  variant = "code",
  embedded = false,
  pattern,
  className,
  ...props
}: CodeBlockProps) {
  const highlighted = React.useMemo(() => {
    const aliases: Record<string, string> = {
      ts: "typescript",
      js: "javascript",
      html: "markup",
      sh: "bash",
      shell: "bash",
    };
    const name = (language ?? "").toLowerCase();
    const grammar = Prism.languages[aliases[name] ?? name];
    return grammar && code.length <= 100_000
      ? renderTokens(Prism.tokenize(code, grammar))
      : code;
  }, [code, language]);
  return (
    <figure
      {...props}
      data-slot="code-block"
      data-variant={variant}
      data-wrap={wrap || undefined}
      data-embedded={embedded || undefined}
      className={cn("v-code-block", className)}
    >
      {pattern && pattern !== "none" && (
        <PatternBackground variant={pattern} opacity={0.04} spacing={24} />
      )}
      {embedded && (
        <div data-slot="code-block-caption">
          <span>
            <Icon name="code" size="sm" aria-hidden="true" />
            {title ?? "Source"}
            <span>{language?.toUpperCase()}</span>
          </span>
          <span>{code.trimEnd().split("\n").length} lines</span>
        </div>
      )}
      {!embedded && (
        <figcaption data-slot="code-block-header">
          <span data-slot="code-block-label">
            {variant === "terminal" && (
              <>
                <span data-slot="terminal-window-marks" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <Icon
                  name="terminal"
                  size="sm"
                  aria-hidden="true"
                  feedback={false}
                />
              </>
            )}
            {(title || variant === "terminal") && (
              <span data-slot="code-block-title">{title ?? "Terminal"}</span>
            )}
            {language && (
              <Meta as="span" data-slot="code-block-language">
                {language}
              </Meta>
            )}
          </span>
          <CopyButton code={code} onCopyResult={onCopyResult}>{copyLabel}</CopyButton>
        </figcaption>
      )}
      <ScrollArea
        variant="plain"
        className="v-code-block__scroll"
        aria-label={
          variant === "terminal"
            ? `${title ?? "Terminal"} command`
            : title
              ? `${title} source code`
              : "Source code"
        }
        viewportWrapper={(viewport) => (
          <>
            {viewport}
            <ScrollBar orientation="horizontal" />
          </>
        )}
      >
        <pre>
          {variant === "terminal" && (
            <span data-slot="terminal-prompt" aria-hidden="true">
              $
            </span>
          )}
          <code>{highlighted}</code>
        </pre>
      </ScrollArea>
    </figure>
  );
}
