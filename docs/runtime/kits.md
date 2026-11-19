# Kits

## Design

A kit answers a specific question: what may this agent use on this person's word? A project groups people who may ask for the same work. An owner approves the project roster, a kit defining the work, and the grant connecting the two. An owner can also grant a kit directly to a person. Rooms deliver mail. Joining a room, naming a project in a message or adopting a display name confers no access.

The job credential identifies the job. Its admitted mail supplies the asker. When tools are advertised, loom can explain the direct grant or project membership behind each tool. Advertisement is only a snapshot. Before every invocation, loom must resolve the job again and check the current definition, grant and membership. If any disappeared, the caller hears the reason. A kit must never elevate a held job to an owners' session.

Each tool definition gives an owner a program, the code revision, its argument template and the names of the credentials the program receives. Fixed arguments may include a tenant or dataset identifier. The helper must enforce the resulting data boundary. For user input, use narrowly typed fields and construct an argument vector without shell interpretation. Expose the smallest useful operation, such as a station lookup. The helper receives its own minimal environment. Errors and results cross back through a secret-byte check. Audit metadata identifies the asker, job, conversation, kit, tool, time and outcome. Keeping arguments or output in the audit would bypass conversation retention.

## Moving the Pond configuration

The former bridge project record has five fields. Its label belongs on the project. Its Discord channel is a route for conversation and digests. Its three repository paths describe where maintainers work. A read-only code lookup would need a separately defined tool and an explicit data scope. The epic and requests ids remain work-tracking references.

In the shuttle configuration, the Slack workspace identifies the account namespace. Its project-file pointer becomes roster and grant data. Its helper path identifies the program that needs adapting. The owner and agent identifiers stay household configuration. Slack credentials, the Discord token, forwarding route, send commands, channel notes and package watcher stay with their respective bridges. The runner, preferred model, working and state directories, inbox and now directories, command paths, extension, briefs and upgrade ignore list remain deployment or presentation settings. The secret lookup command is a legacy implementation detail. The always-deny and guest-deny lists express restrictions. Neither is a source of positive permission.

The old helper reads a staff-capable credential through a separate secret command, consults a conversation for data scope and includes staff promotion verbs. A Pond adapter should receive a dedicated read-only credential directly, bind a dataset in its approved definition and expose each permitted read as a separate tool. Project membership in loom establishes who can ask. It does not establish which Pond field deployments that person may see. Where deployments differ, use separate scoped tools and grants or an independently enforced service-side entitlement. Do not grant a general Pond kit that unions team members' distinct field scopes.

The proposed worker executor uses an ephemeral helper container. The worker selects the approved content-addressed house image, mounts nothing from the job, disables container logging and passes the credential envelope over attached stdin. The immutable program receives aliases in a clean child environment. Native shell access in an owner's body must confer no access to a helper's processes, working directory or credentials. The executor trusts the approved program, interpreter and image. An owner reviewing a pin also trusts their handling of output and outbound network access.

## Owner cards for Pond

The examples below show the three inputs to `household.propose`. Each input also takes a `why` in the outer envelope. First build and review a house containing a read-only adapter and provision its dedicated read-only credential. Replace the repository, full commit, image digest, deployment id and account ids below with measured values from that installation. These examples do not approve the old multi-purpose helper.

1. Define Art's kit by proposing `change: "kit"` with the following input. The example has no model-supplied arguments. The operator picks the Pond deployment during approval.

   ```json
   {
     "agent": "art", "kit": "pond-field",
     "tools": [{
       "name": "pond_status", "description": "Read station status in the approved Pond deployment.",
       "repository": "https://github.com/ORG/HOUSE.git",
       "commit": "<full house commit>", "image": "sha256:<image id>",
       "program": "bin/pond-kit-read", "args": ["status", "<deployment id>"],
       "parameters": {}, "secrets": {"KIT_POND_TOKEN": "pond-read-token"}
     }]
   }
   ```

2. Grant the kit to the project. Propose `change: "kitGrant"` with `{"agent":"art","kit":"pond-field","to":{"project":"pond"},"grant":true}`.
3. For an already known outside Slack account, propose `change: "projectOutsidePerson"` with `{"project":"pond","platform":"slack","workspace":"T02AYL3QM","user":"<user id>","on":true}`. If the account is linked to a household member, use the existing project member roster. Two accounts linked to the same member use that member's grants. Two unlinked outside accounts require separate approvals even if their labels match.

Each proposal needs an owner's answer. The existing quoted-word path can carry that answer. A later change of image, commit, program, argument template or credential name requires a new definition. Replace the grant's `true` with `false` to withdraw it, the roster entry's `true` with `false` to remove that person, or set `tools` to `null` to withdraw the entire definition.

## Inspecting access

A running body calls `kits.available` with an empty input. A person can ask the agent to explain the membership or direct grant behind its answer. Owners can inspect the definition and history through GraphQL. `uses` accepts optional kit, person and personKind filters, plus limit and offset. The history includes the job and conversation identifiers and the outcome. A worker that lost contact after authorization can leave an authorized use with no confirmed execution outcome.

```graphql
{
  kitCatalog(agent: "art") {
    definitions { kit tools }
    grants { kit project member outside { platform workspace user } }
    projects { project members outside { platform workspace user } }
    uses(kit: "pond-field", limit: 20) { at personKind person job conversation kit tool outcome }
  }
}
```

The old people file also contains individual standing instructions. A fleet setup permission and an action-level change permission describe writes. Neither belongs in the read-only Pond kit. Each would need a separately reviewed tool, named credential, explicit recipient and implementation of its resource limits. A restriction on writing to the work GitHub org stays a restriction. Never translate the absence of a prohibition into a kit grant.

The grant read describes what the owner allows. Compare it with the named tools advertised by the running body to find what this particular worker can execute. A newly granted tool may first appear in the next body. A revoked tool may still appear in a running body's list but its next invocation is refused. A missing approved image, a machine configured for nested Docker, or an unavailable worker socket can leave a permitted tool unusable. On a machine that can give a job the Docker socket, a second container would not isolate that job from another helper on the same engine; kit execution stays closed there.

For the old helper, `scope` maps to the job grant explanation plus the fixed deployment scope of the adapter. `status`, `alerts`, `box`, `camera` and `usb` are candidates for individual read tools. `camera` reports device and heartbeat status. `instrument` needs its own result filtering because its service query spans deployments. `grant-staff` changes roles, and `grant-watch` can change roles, update a watch file and send a Discord message. Neither operation belongs in this kit. The former bridge's channel notification, digest and task filing behavior needs separate decisions at its existing doors.

An owner reviewing a house should inspect every parameter's meaning to the helper and its dependencies. Fixed argument vectors prevent shell interpolation. They cannot make a general interpreter, arbitrary URL fetcher, or broad data query safe to give to a guest. The empty parameter list and fixed deployment in the example avoid all three.
