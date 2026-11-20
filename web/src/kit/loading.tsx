export function Loading({ label = 'Loading…' }: { label?: string }) { return <p className="loom-kit-state" role="status" aria-live="polite">{label}</p>; }
