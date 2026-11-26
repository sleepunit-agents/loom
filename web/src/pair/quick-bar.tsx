import { useEffect, useId, useLayoutEffect, useRef, type FormEvent } from 'react';
import { ArrowUpIcon, XIcon } from 'lucide-react';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from './ui/input-group';

type Props = {
  id: string;
  open: boolean;
  label: string;
  question?: string;
  placeholder: string;
  value: string;
  maxLength?: number;
  action: string;
  busy: boolean;
  disabled: boolean;
  error?: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: (restoreFocus: boolean) => void;
};

export function QuickBar({ id, open, label, question, placeholder, value, maxLength, action,
  busy, disabled, error, onChange, onSubmit, onClose }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const inputId = useId();
  useLayoutEffect(() => {
    if (open) input.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!form.current?.contains(e.target as Node)) onClose(false);
    };
    const key = (e: KeyboardEvent) => {
      if (!e.isComposing && (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k'))) {
        e.preventDefault();
        onClose(true);
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
    };
  }, [open, onClose]);
  return (
    <form id={id} ref={form} inert={!open} aria-hidden={!open} aria-label={label}
      className="pair-prompt" data-question={question ? true : undefined} onSubmit={onSubmit}>
      {question && <label htmlFor={inputId} className="block px-1 pb-2 font-medium">{question}</label>}
      <InputGroup className="h-12 rounded-xl bg-popover has-[[data-slot=input-group-control]:focus-visible]:border-input has-[[data-slot=input-group-control]:focus-visible]:ring-0">
        <InputGroupInput ref={input} id={inputId} aria-label={question ? undefined : label}
          aria-invalid={error ? true : undefined} aria-describedby={error ? inputId+'-error' : undefined}
          value={value} placeholder={placeholder} maxLength={maxLength} readOnly={busy && !!question}
          onChange={e => onChange(e.target.value)} />
        <InputGroupAddon align="inline-end">
          <InputGroupButton type="submit" variant="default" size={question ? 'sm' : 'icon-sm'}
            className="focus-visible:bg-secondary focus-visible:text-secondary-foreground focus-visible:ring-0"
            aria-label={action} disabled={busy || disabled || !value.trim()}>
            {question ? action : <ArrowUpIcon />}
          </InputGroupButton>
          <InputGroupButton size="icon-sm" aria-label="Close quick bar" onClick={() => onClose(true)}
            className="focus-visible:bg-secondary focus-visible:ring-0"><XIcon /></InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {error && <p role="alert" id={inputId+'-error'} className="mt-2 text-sm text-destructive">{error}</p>}
    </form>
  );
}
