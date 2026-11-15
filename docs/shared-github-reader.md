# GitHub reads on normal shared startup

Normal shared startup can read project pull requests with its owned Secret
holder. In the private `program.json`, `githubBindings` maps each GitHub owner
to the name of an existing Secret, for example:

```json
{"githubBindings":{"sleepunit-agents":"GITHUB_READ_TOKEN"}}
```

Write the token through the Owner's Secrets operation. Only names belong in
this configuration. Configure each project's GitHub repositories through
household project setup. Restart after changing the bindings. Token replacements
take effect on the next read without restarting. There is no token discovery,
agent grant, or internal service grant.

The existing Changes reader makes read-only requests to GitHub's fixed GraphQL
endpoint, publishes the cache through normal scoped queries and live updates,
and retains the previous cache with a failed-read indicator when upstream fails.
Manual refresh shares an active scheduled read. Shutdown joins an active read
before closing the database and prevents further default GitHub requests.

An explicit trusted `changes` adapter takes precedence over these bindings.
Without that adapter, bindings require the owned holder or an explicit trusted
`secretInputs.source`. Missing credentials fail the read without exposing their
values. Bindings are optional; omitting them leaves the GitHub reader disabled.
