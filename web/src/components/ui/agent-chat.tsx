"use client";

import * as React from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { AgentState, type AgentStatus } from "@/components/ui/agent-state";
import { Button } from "@/components/ui/button";
import { Message, MessageContent, MessageDescription } from "@/components/ui/message";
import { MessageScroller, MessageScrollerJump, type MessageScrollerProps } from "@/components/ui/message-scroller";
import { Attachment, AttachmentType, AttachmentName, AttachmentMeta, AttachmentActions, AttachmentAction } from "@/components/ui/attachment";
import { Questionnaire, QuestionnaireQuestion, QuestionnaireOptions, QuestionnaireOption, QuestionnaireOptionBody } from "@/components/ui/questionnaire";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Input } from "@/components/ui/input";
import { MotionPresence, MotionSurface } from "@/components/ui/presence";
import { InputGroup, InputGroupAddon, InputGroupTextarea, InputGroupButton } from "@/components/ui/input-group";

export type AgentChatLayoutProps = React.ComponentProps<"div">;
/** Main work stays unconstrained; a dedicated conversation column sits beside it. */
export function AgentChatLayout({ className, ...props }: AgentChatLayoutProps) {
  return <div data-slot="agent-chat-layout" className={cn("v-agent-layout", className)} {...props} />;
}
export type AgentChatMainProps = React.ComponentProps<"div">;
export function AgentChatMain({ className, ...props }: AgentChatMainProps) {
  return <div data-slot="agent-chat-main" className={cn("v-agent-layout__main", className)} {...props} />;
}
export type AgentChatAsideProps = React.ComponentProps<"aside">;
export function AgentChatAside({ className, ...props }: AgentChatAsideProps) {
  return <aside data-slot="agent-chat-aside" className={cn("v-agent-layout__aside", className)} aria-label="Agent side chat" {...props} />;
}

export type AgentChatProps = React.ComponentProps<"section">;
/** A bounded conversation surface. Compose header, thread and composer as children. */
export function AgentChat({ className, ...props }: AgentChatProps) {
  return <section data-slot="agent-chat" className={cn("v-agent-chat", className)} aria-label="Agent conversation" {...props} />;
}

export type AgentChatHeaderProps = Omit<React.ComponentProps<"header">, "title"> & {
  title?: React.ReactNode;
  description?: React.ReactNode;
  status?: AgentStatus;
  statusLabel?: string;
  actions?: React.ReactNode;
};
export function AgentChatHeader({ title = "Cojeev", description, status = "idle", statusLabel, actions, className, children, ...props }: AgentChatHeaderProps) {
  return <header data-slot="agent-chat-header" className={cn("v-agent-chat__header", className)} {...props}>
    <div className="v-agent-chat__heading"><h2>{title}</h2>{description && <p>{description}</p>}</div>
    {actions && <div className="v-agent-chat__header-actions">{actions}</div>}
    <AgentState status={status} size="sm" label={statusLabel} />
    {children}
  </header>;
}

export type AgentChatThreadProps = MessageScrollerProps & { jumpLabel?: string };
/** Retains the reader's position while detached; exposes an explicit jump back. */
export function AgentChatThread({ className, children, jumpLabel = "Latest message", ...props }: AgentChatThreadProps) {
  return <Bubble as={MessageScroller} data-slot="agent-chat-thread" className={cn("v-agent-chat__thread", className)} role="log" aria-label="Conversation messages" aria-live="polite" aria-relevant="additions text" tabIndex={0} {...props}>
    {children}
    <MessageScrollerJump className="v-agent-chat__jump">{jumpLabel}</MessageScrollerJump>
  </Bubble>;
}

export type AgentChatMessageProps = React.ComponentProps<"div"> & {
  author?: string;
  avatar?: React.ReactNode;
  from?: "agent" | "user";
  meta?: React.ReactNode;
  actions?: React.ReactNode;
};
export function AgentChatMessage({ author = "Cojeev", from = "agent", avatar, meta, actions, className, children, ...props }: AgentChatMessageProps) {
  return <MotionSurface asChild preset="rise"><Message variant={from === "user" ? "me" : "default"} data-slot="agent-chat-message" data-from={from} className={cn("v-agent-chat__message", className)} {...props}>
    {avatar ?? <Avatar variant={from === "user" ? "blue" : "pink"} className="v-agent-chat__avatar" aria-hidden="true"><AvatarFallback>{author.split(/\s+/).map((part) => part[0]).slice(0, 2).join("")}</AvatarFallback></Avatar>}
    <MessageContent className="v-agent-chat__message-content">
      <MessageDescription className="v-agent-chat__author">{author}{meta && <span>{meta}</span>}</MessageDescription>
      <BubbleContent variant={from === "user" ? "me" : "default"} className="v-agent-chat__message-body">{children}</BubbleContent>
      {actions && <div className="v-agent-chat__message-actions">{actions}</div>}
    </MessageContent>
  </Message></MotionSurface>;
}

export type AgentChatAttachment = { id: string; name: string; type?: string; detail?: string };
export type AgentChatComposerProps = Omit<React.ComponentProps<"form">, "onSubmit" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
  onSend: () => void;
  status?: AgentStatus;
  onStop?: () => void;
  attachments?: readonly AgentChatAttachment[];
  onAttach?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  accept?: string;
  disabled?: boolean;
  placeholder?: string;
  label?: string;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  onRetry?: () => void;
  maxLength?: number;
};
/** Controlled draft and attachments; the host clears them only after accepting send. */
export function AgentChatComposer({ value, onValueChange, onSend, status = "idle", onStop, attachments = [], onAttach, onRemoveAttachment, accept, disabled = false, placeholder = "Ask, explore, or make something…", label = "Message Cojeev", hint, error, onRetry, maxLength = 12000, className, children, ...props }: AgentChatComposerProps) {
  const id = React.useId();
  const input = React.useRef<HTMLInputElement>(null);
  const textarea = React.useRef<HTMLTextAreaElement>(null);
  const running = status === "thinking" || status === "working";
  const canSend = !disabled && !running && (value.trim().length > 0 || attachments.length > 0) && value.length <= maxLength;
  const wasRunning = React.useRef(running);
  const restoreDraftFocus = React.useRef(false);
  const stopRef = React.useCallback((node: HTMLButtonElement | HTMLAnchorElement | null) => {
    if (!node) return;
    // Capture focus before React replaces Stop or disables it as the Send control.
    return () => { restoreDraftFocus.current = node.ownerDocument.activeElement === node; };
  }, []);
  React.useLayoutEffect(() => {
    if (wasRunning.current && !running && restoreDraftFocus.current) textarea.current?.focus();
    restoreDraftFocus.current = false;
    wasRunning.current = running;
  }, [running]);
  return <form data-slot="agent-chat-composer" className={cn("v-agent-chat__composer", className)} onSubmit={(event) => { event.preventDefault(); if (canSend) { textarea.current?.focus(); onSend(); } }} {...props}>
    <label className="v-agent-chat__sr-only" htmlFor={`${id}-draft`}>{label}</label>
    <MotionPresence>
      {attachments.length > 0 && <MotionSurface key="attachments" preset="rise" data-slot="agent-chat-attachments" className="v-agent-chat__attachments">
        <MotionPresence>
        {attachments.map((file) => <MotionSurface key={file.id} preset="scale" asChild><Attachment className="v-agent-chat__attachment">
          <AttachmentType>{file.type ?? <Icon name="file-text" style={{width:16,height:16}} />}</AttachmentType>
          <AttachmentName title={file.name}>{file.name}{file.detail && <AttachmentMeta>{file.detail}</AttachmentMeta>}</AttachmentName>
          {onRemoveAttachment && <AttachmentActions><AttachmentAction disabled={disabled || running} onClick={() => onRemoveAttachment(file.id)} aria-label={`Remove ${file.name}`}><Icon name="x" style={{width:16,height:16}} aria-hidden="true" /></AttachmentAction></AttachmentActions>}
        </Attachment></MotionSurface>)}
        </MotionPresence>
      </MotionSurface>}
    </MotionPresence>
    <MotionPresence>{error && <MotionSurface key="error" preset="rise" className="v-agent-chat__error" id={`${id}-error`} role="alert"><span>{error}</span>{onRetry && <Button variant="secondary" size="sm" onClick={onRetry} disabled={disabled || running}>Retry</Button>}</MotionSurface>}</MotionPresence>
    <InputGroup className="v-agent-chat__draft">
      <InputGroupTextarea ref={textarea} id={`${id}-draft`} className="v-agent-chat__input" rows={3} value={value} maxLength={maxLength} disabled={disabled} placeholder={placeholder} aria-invalid={error ? true : undefined} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`} onChange={(event) => onValueChange(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing && canSend) {
          event.preventDefault(); onSend();
        }
      }} />
      <InputGroupAddon className="v-agent-chat__composer-bar">
        {onAttach && <><Input ref={input} className="v-agent-chat__sr-only" type="file" tabIndex={-1} aria-hidden="true" accept={accept} multiple disabled={disabled || running} onChange={(event) => {
          const files = Array.from(event.target.files ?? []); if (files.length) onAttach(files); event.target.value = "";
        }} /><InputGroupButton variant="ghost" className="v-agent-chat__attach-button" disabled={disabled || running} onClick={() => input.current?.click()} aria-label="Attach files"><Icon name="paperclip" style={{width:18,height:18}} aria-hidden="true" /></InputGroupButton></>}
        <span className="v-agent-chat__composer-note">{running ? "You can prepare your next message" : "A little context goes a long way"}</span>
        {running ? <InputGroupButton key="stop" ref={stopRef} className="v-agent-chat__send" data-agent-stop="true" variant="secondary" disabled={disabled || !onStop} aria-label="Stop generation" onClick={() => { onStop?.(); textarea.current?.focus(); }}><Icon name="square" style={{width:14,height:14,fill:"currentColor"}} aria-hidden="true" /><span>Stop</span></InputGroupButton> : <InputGroupButton key="send" className="v-agent-chat__send" type="submit" disabled={!canSend} aria-label="Send message"><Icon name="arrow-up" style={{width:18,height:18}} aria-hidden="true" /><span>Send</span></InputGroupButton>}
      </InputGroupAddon>
    </InputGroup>
    <p className="v-agent-chat__hint" id={`${id}-hint`}>{hint ?? <><Icon name="corner-down-left" style={{width:12,height:12}} /> Enter for a new line · ⌘ / Ctrl + Enter to send</>}</p>
    {children}
  </form>;
}

export type AgentChatPermissionProps = Omit<React.ComponentProps<"div">, "title"> & {
  title: React.ReactNode;
  description: React.ReactNode;
  scope?: React.ReactNode;
  decision?: "pending" | "allowed" | "denied";
  onDecision: (decision: "allowed" | "denied") => void;
  disabled?: boolean;
  allowLabel?: string;
  denyLabel?: string;
};
/** No implied consent: pending permissions require a deliberate allow or deny. */
export function AgentChatPermission({ title, description, scope, decision = "pending", onDecision, disabled, allowLabel = "Allow once", denyLabel = "Deny", className, ...props }: AgentChatPermissionProps) {
  const id = React.useId();
  return <div data-slot="agent-chat-permission" data-decision={decision} className={cn("v-agent-chat__permission", className)} role="group" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} {...props}>
    <div className="v-agent-chat__decision-title"><Icon name="shield-check" style={{width:19,height:19}} aria-hidden="true" /><h3 id={`${id}-title`}>{title}</h3></div>
    <p id={`${id}-description`}>{description}</p>
    {scope && <div className="v-agent-chat__scope">{scope}</div>}
    <MotionPresence mode="wait">{decision === "pending" ? <MotionSurface key="pending" preset="fade" className="v-agent-chat__decision-actions"><Button variant="secondary" onClick={() => onDecision("denied")} disabled={disabled}>{denyLabel}</Button><Button onClick={() => onDecision("allowed")} disabled={disabled}>{allowLabel}</Button></MotionSurface> : <MotionSurface key={decision} preset="fade" asChild><p className="v-agent-chat__receipt" role="status">{decision === "allowed" ? <Icon name="check" style={{width:16,height:16}} aria-hidden="true" /> : <Icon name="x" style={{width:16,height:16}} aria-hidden="true" />}{decision === "allowed" ? "Permission allowed once" : "Permission denied"}</p></MotionSurface>}</MotionPresence>
  </div>;
}

export type AgentChatOption = { value: string; label: string; description?: string; disabled?: boolean };
export type AgentChatOptionsProps = Omit<React.ComponentProps<"div">, "title"> & {
  title: string;
  options: readonly AgentChatOption[];
  value?: string;
  onValueChange: (value: string) => void;
  onConfirm: (value: string) => void;
  disabled?: boolean;
  confirmLabel?: string;
};
export function AgentChatOptions({ title, options, value, onValueChange, onConfirm, disabled, confirmLabel = "Continue", className, ...props }: AgentChatOptionsProps) {
  const id = React.useId();
  const valid = options.some((option) => option.value === value && !option.disabled);
  return <Questionnaire data-slot="agent-chat-options" className={cn("v-agent-chat__options", className)} {...props}>
    <QuestionnaireQuestion disabled={disabled}>
      <legend id={`${id}-title`}>{title}</legend>
      <QuestionnaireOptions name={id} value={value ?? ""} onValueChange={onValueChange} aria-labelledby={`${id}-title`}>
        <MotionPresence>{options.map((option) => <MotionSurface key={option.value} asChild preset="rise"><QuestionnaireOption value={option.value} disabled={disabled || option.disabled}>
          <QuestionnaireOptionBody><b>{option.label}</b>{option.description && <small>{option.description}</small>}</QuestionnaireOptionBody>
        </QuestionnaireOption></MotionSurface>)}</MotionPresence>
      </QuestionnaireOptions>
    </QuestionnaireQuestion>
    <Button disabled={disabled || !valid} onClick={() => { if (valid && value !== undefined) onConfirm(value); }}>{confirmLabel}</Button>
  </Questionnaire>;
}

export type AgentChatStep = { id: string; label: string; detail?: string; status: "pending" | "current" | "complete" | "error" };
export type AgentChatProgressProps = React.ComponentProps<"ol"> & { steps: readonly AgentChatStep[] };
export function AgentChatProgress({ steps, className, ...props }: AgentChatProgressProps) {
  return <ol data-slot="agent-chat-progress" className={cn("v-agent-chat__progress", className)} aria-label="Work progress" {...props}>
    <MotionPresence>{steps.map((step, index) => <MotionSurface key={step.id} asChild preset="rise"><li data-state={step.status} aria-current={step.status === "current" ? "step" : undefined}>
      <span className="v-agent-chat__step-mark" aria-hidden="true">{step.status === "complete" ? <Icon name="check" style={{width:13,height:13}} /> : step.status === "error" ? <Icon name="x" style={{width:13,height:13}} /> : index + 1}</span>
      <span><span className="v-agent-chat__sr-only">{step.status}: </span><b>{step.label}</b>{step.detail && <small>{step.detail}</small>}</span>
    </li></MotionSurface>)}</MotionPresence>
  </ol>;
}
