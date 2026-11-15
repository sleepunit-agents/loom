# Example household and rebuild measurement

Build with `npm run build`, then create an exclusively new home:

```sh
node scripts/example-home.mjs /tmp/loom-example-new
node dist/index.js serve --next --home /tmp/loom-example-new --port 8789
```

Open the one-time link printed by normal startup. Alex and Robin, Fern and Moss,
and the garden pump story are entirely fictitious. No GitHub, provider, worker,
or bridge is contacted by the example command. No body is launched.

The command uses the program's trusted application services, including its
normal encrypted Comms writer. It never writes rows itself. It refuses any
existing destination. `program.json` is the private normal-startup inventory;
`example.json` lists created records and any example-data gaps. Preserve the
whole directory while using it; the key is needed to read its conversation.

Current missing operations are deliberately visible: shared project setup and
machine enrollment cannot yet be populated through current application services.
The manifest reports these instead of inserting tables or invoking the retired
foundation. The model account is fictitious metadata with no provider login or
capacity. A sample PR is a local copy with no GitHub request.

After building, run the browser measurement with:

```sh
npx playwright-core install chromium
node scripts/rebuild-walkthrough.mjs /tmp/loom-walkthrough-report
```

`LOOM_TEST_CHROME` selects an existing Chromium binary. The walkthrough starts
`startSharedHome`, the same built entry used by `serve --next`, opens the normal
sign-in page, follows startup's one-time link, and discovers every launcher app.
It records each tile's actual text, screenshot, console/page/network errors and
GraphQL connection activity during that visit. Connection activity may also
include the shell and other open tiles; it is not proof of a specific app's query.
There are no injected sessions, mocked HTTP routes or sample UI components.
Screenshots and `walkthrough.json` are uploaded by the Rebuild walkthrough CI job.
App failures are measurements in that report; fatal startup/sign-in failures fail
the command. A green walkthrough job means evidence was collected, not that all
product promises are fulfilled.
