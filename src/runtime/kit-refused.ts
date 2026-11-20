/** Only this refusal may be carried from the worker to the model. Remote error
 * bodies can contain internal details and never enter a kit response. */
export class KitRefused extends Error {
  constructor(){super('This kit is no longer available for this job. Its grant, membership or approved tool changed. The tool did not run.');}
}
export class KitCapacity extends Error {
  constructor(){super('This job has more kit tools than its harness can advertise. Kit tools are unavailable on this run.');}
}
