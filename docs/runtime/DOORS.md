# Kit access for a held job

| Door | Caller | What crosses it |
| --- | --- | --- |
| `household.propose` / `approvals.answer` | Existing household proposal and owner-answer paths | Definition, grant, or named outside account on a project. Held jobs cannot propose or answer. |
| GraphQL `kitCatalog` | Household owner, agent owner, or the agent acting on its own or its owners' word | Definitions, grants, people and metadata-only use history. |
| `kits.available` | The running job's body credential | Asker, projects and available tools with their grant reasons. No values. |
| Job-local kit socket | Body in the assigned house | Advertised model tool name, typed arguments and screened result. |
| `/api/kits/private/{list,authorize,finish}` | The assigned runner credential together with the running job's body credential | Worker-only manifest, per-invocation credentials and use receipt. |
| Helper process | Worker using an approved immutable image | Fixed executable and argument vector, child-only credential aliases and bounded stdout. |

The body cannot choose the worker, job, person, membership, image, program or secret name at invocation. A denial in the agent's tool policy still applies. A different house image cannot run the old definition. The pinned helper is trusted to restrict its reads, use its service credential appropriately, and avoid returning sensitive data.

Existing checks for shell and file tools, general secret requests, startup secrets, saved sessions, other agents, approvals, schedules and outward messages continue to apply. A named kit does not change the job's word. A tool result in a shared conversation can be read by other participants in that conversation. Project membership controls the invocation. The service and helper must also enforce the intended audience for data they return.
