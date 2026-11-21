import { usePendingRead } from '../data/loading';
export function Loading({ label = 'Loading…' }: { label?: string }) { usePendingRead(true); return <p className="loom-kit-state" role="status" aria-live="polite">{label}</p>; }
