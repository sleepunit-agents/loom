import type { ComponentProps, ReactNode } from 'react';

/** One field of a form in a page: its plain words over its control (which they name), and an optional quiet hint
 * under it. The control is the kit's Input or Textarea, or a native select (controls.css draws all three). */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return <div className="loom-kit-field"><label><span className="loom-kit-field__label">{label}</span>{children}</label>{hint && <p className="loom-kit-field__hint">{hint}</p>}</div>;
}
/** The fields of one form, stacked; `disabled` holds them all while the form is being sent. */
export function Fields({ className = '', ...props }: ComponentProps<'fieldset'>) {
  return <fieldset {...props} className={`loom-kit-fields ${className}`} />;
}
