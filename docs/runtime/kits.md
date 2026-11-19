# Kits

## Design

A kit answers a specific question: what may this agent use on this person's word? A project groups people who may ask for the same work. An owner approves the project roster, a kit defining the work, and the grant connecting the two. An owner can also grant a kit directly to a person. Rooms deliver mail. Joining a room, naming a project in a message or adopting a display name confers no access.

The job credential identifies the job. Its admitted mail supplies the asker. When tools are advertised, loom can explain the direct grant or project membership behind each tool. Advertisement is only a snapshot. Before every invocation, loom must resolve the job again and check the current definition, grant and membership. If any disappeared, the caller hears the reason. A kit must never elevate a held job to an owners' session.

Each tool definition gives an owner a program, the code revision, its argument template and the names of the credentials the program receives. Fixed arguments may include a tenant or dataset identifier. The helper must enforce the resulting data boundary. For user input, use narrowly typed fields and construct an argument vector without shell interpretation. Expose the smallest useful operation, such as a station lookup. The helper receives its own minimal environment. Errors and results cross back through a secret-byte check. Audit metadata identifies the asker, job, conversation, kit, tool, time and outcome. Keeping arguments or output in the audit would bypass conversation retention.

## Moving the Pond configuration

The former bridge project record has five fields. Its label belongs on the project. Its Discord channel is a route for conversation and digests. Its three repository paths describe where maintainers work. A read-only code lookup would need a separately defined tool and an explicit data scope. The epic and requests ids remain work-tracking references.

In the shuttle configuration, the Slack workspace identifies the account namespace. Its project-file pointer becomes roster and grant data. Its helper path identifies the program that needs adapting. The owner and agent identifiers stay household configuration. Slack credentials, the Discord token, forwarding route, send commands, channel notes and package watcher stay with their respective bridges. The runner, preferred model, working and state directories, inbox and now directories, command paths, extension, briefs and upgrade ignore list remain deployment or presentation settings. The secret lookup command is a legacy implementation detail. The always-deny and guest-deny lists express restrictions. Neither is a source of positive permission.

The old helper reads a staff-capable credential through a separate secret command, consults a conversation for data scope and includes staff promotion verbs. A Pond adapter should receive a dedicated read-only credential directly, bind a dataset in its approved definition and expose each permitted read as a separate tool. Project membership in loom establishes who can ask. It does not establish which Pond field deployments that person may see. Where deployments differ, use separate scoped tools and grants or an independently enforced service-side entitlement. Do not grant a general Pond kit that unions team members' distinct field scopes.
