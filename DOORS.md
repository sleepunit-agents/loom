# Worker and house program doors

## Scheduled programs

| Entry | Caller and effect |
| --- | --- |
| `tempo.set` | An owner or agent on its own work sets an agent-owned time trigger with a fixed house program. |
| `tempoProgram(id: String!)` | The owner or the agent on permitted work reads program configuration and retained state. |
| `runtime.next` | An enrolled container worker advertises program support. The server claims one compatible job and returns its frozen assignment. |
| Private secret read and confirmation | The assigned starting worker receives each declared and granted house alias through the existing private binary channel. |
| `runtime.started`, `runtime.heartbeat`, `runtime.finish` | The assigned worker reports the attempt. Successful completion commits its state, wake mail and ruled bridge post with the operation receipt. |

## Machine inspection

| Operation | Caller and evidence | Result |
| --- | --- | --- |
| machine.read / machine_read | Current bound conversation job, on the agent's own or its owners' word, and current machine hosting permission or explicit owner grant | Bounded lines from the chosen worker, or a refusal |
| runtime.machineReadNext | Current authenticated worker for its own enrolled machine | Advertises a short-lived offer and takes one request |
| runtime.machineReadDone | Same machine and a live, already taken request ID | Completes one wait |
| machine.history | Current machine owner | Latest 100 metadata records |
| machine.proposeReader and machine.answerReader | Machine owner | File and decide an explicit read-grant card |

A guest job cannot use machine.read through either the named tool or the generic command. A machine worker cannot request a diagnostic on behalf of a body. Operator-selected programs are never accepted as diagnostic input. See [Machine reads](docs/runtime/machine-reads.md) for the catalog and journal disclosure boundary.

## Kits

A held job may discover its asker's granted kit tools and invoke them through the job-local socket. The worker rechecks the live grant with both credentials. The existing held-job restrictions apply to schedules, machine reads and changes to grants. See the [kit door inventory](docs/runtime/DOORS.md).
