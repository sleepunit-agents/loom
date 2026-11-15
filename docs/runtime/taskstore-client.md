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

The server validates the action and supplies the authenticated actor. Each
invocation uses one operation ID across transport retries. Results are JSON;
failed or refused requests exit nonzero. Issuing a credential remains a separate
sign-in operation.
