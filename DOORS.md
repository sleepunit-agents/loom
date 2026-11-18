# Machine inspection doors

| Operation | Caller and evidence | Result |
| --- | --- | --- |
| machine.read / machine_read | Current bound conversation job, on the agent's own or its owners' word, and current machine hosting permission or explicit owner grant | Bounded lines from the chosen worker, or a refusal |
| runtime.machineReadNext | Current authenticated worker for its own enrolled machine | Advertises a short-lived offer and takes one request |
| runtime.machineReadDone | Same machine and a live, already taken request ID | Completes one wait |
| machine.history | Current machine owner | Latest 100 metadata records |
| machine.proposeReader and machine.answerReader | Machine owner | File and decide an explicit read-grant card |

A guest job cannot use machine.read through either the named tool or the generic command. A machine worker cannot request a diagnostic on behalf of a body. Operator-selected programs are never accepted as diagnostic input. See [Machine reads](docs/runtime/machine-reads.md) for the catalog and journal disclosure boundary.
