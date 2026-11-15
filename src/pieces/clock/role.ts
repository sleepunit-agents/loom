/** Runtime consumes Clock routing only through the owning piece role. */
export { clockRoute, type ClockDestinationReader, type ClockDestination, type ClockRoute } from './destination.js';

export { clockDispatchSource, clockDispatchWithdrawn } from './dispatch-source.js';

export type { Wake } from './store.js';
