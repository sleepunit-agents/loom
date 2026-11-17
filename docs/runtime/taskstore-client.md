# Tasks command-line client

Set `LOOM_URL` to the household origin and `LOOM_TOKEN_FILE` to the credential
file. `loom-taskstore ready`, `list`, `show <id>` and `search <words>` read the
generated Tasks query with the caller's current visibility. Ready uses the
server's computed eligibility, including blockers the caller cannot see.

Writes use the canonical Tasks action object:

```sh
loom-taskstore command '{"action":"claim","id":"t-example"}'
loom-taskstore command --file task-action.json
loom-taskstore command --file - < task-action.json
```

`move` places one task in the hand-kept order. `moveToProject` moves up to 500
tasks to another project, or with `"project": null` out of every project:

```sh
loom-taskstore command '{"action":"moveToProject","ids":["t-12","t-15"],"project":"pond"}'
```

You must be able to act on each task where it is, and be on the project they go
to (or be a household owner). Out of every project a task is its owner's alone,
so only its owner or a household owner may do that. Every task named moves or
none does, and a removed project is refused. The answer lists the tasks that
moved (`moved`); one already there is left alone. Each moved task gets a comment
by the mover saying from where to where. Its links and comments stay, and mail
filed under the task's own labels goes with it. An `edit` that names another
project is the same move for one task, by the same rule and with the same record.

To split a project: make the new project (a household owner, or an agent through
`household.propose` with `change: "project"`), then `moveToProject` the chosen
tasks into it. To merge two projects, an agent proposes `change: "projectMerge"`
with `{"from":"<id>","into":"<id>"}`, and a household owner allows and confirms
the card by hand: a merge cannot be undone, and no standing rule answers it.

The server validates the action and supplies the authenticated actor. Each
invocation uses one operation ID across transport retries. Results are JSON;
failed or refused requests exit nonzero. Issuing a credential remains a separate
sign-in operation.

Use HTTPS for remote origins. An explicitly configured HTTP origin is also accepted,
including the disposable loopback household used by the checks.

Show returns the task record; comments and dependency links remain available
through the generated data API and the Tasks app. A failed or timed-out write may
already have committed: the client retries with its original operation ID only
within that invocation. It does not automatically repeat the command in a new
invocation. Refusals use generic diagnostics to avoid exposing daemon error text.

The built-client boundary check needs npm run build before npm test.
