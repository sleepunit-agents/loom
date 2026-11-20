import { useLayoutEffect, useRef, type ComponentPropsWithoutRef } from 'react';

/** Keep the platform picker, form value and accessible name on the native control. */
export function NativeSelect(props: ComponentPropsWithoutRef<'select'>) {
  if (props.multiple || props.size !== undefined || globalThis.CSS?.supports('appearance', 'base-select')) {
    return <select {...props} />;
  }
  return <WrappingSelect {...props} />;
}

function WrappingSelect(props: ComponentPropsWithoutRef<'select'>) {
  const control = useRef<HTMLSelectElement>(null);
  const caption = useRef<HTMLSpanElement>(null);

  function showSelection() {
    if (caption.current) caption.current.textContent = control.current?.selectedOptions[0]?.label ?? '';
  }

  // Read after React applies the value, default value and any changed option labels.
  useLayoutEffect(showSelection);
  useLayoutEffect(() => {
    const form = control.current?.form;
    // The browser restores its default selection after reset event listeners run.
    const afterReset = () => setTimeout(showSelection, 0);
    form?.addEventListener('reset', afterReset);
    return () => form?.removeEventListener('reset', afterReset);
  }, [props.form]);

  return <span className="loom-wrapping-select">
    <select {...props} ref={control} onChange={event => { props.onChange?.(event); queueMicrotask(showSelection); }} />
    <span ref={caption} aria-hidden="true" />
  </span>;
}
