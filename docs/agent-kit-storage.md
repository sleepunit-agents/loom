# Agent kit approvals

A household owner answers a household change card to define or withdraw one agent's named kit, grant or withdraw that kit for a project or person, or add or remove an outside person on a project. Each change always asks. Answering through an agent uses the existing owner-word checks for these cards. A standing rule cannot approve one.

The definition stores a fixed tool manifest and secret names. The fresh schema and upgrade add empty tables, so existing people and projects acquire no access. Foreign keys tie grants to their kit and project or member. Outside identities use the exact platform, workspace and user tuple. Deleting a kit removes its grants. Audit rows remain tied to the job after withdrawal.

Kit grants to projects follow current project membership. Before allowing a grant, the owner can inspect its current definition and roster. An outside roster card shows the project's current kits. A change to those facts while a card waits requires a fresh card. Kit definition cards also show the current recipients. A linked outside account uses its household member identity. An outside roster addition requires an existing tier for a live agent, and a direct outside grant requires the tier for the agent giving the kit.

Merging either project requires first withdrawing its project kit grants. Outside identities stay on the project the owner named. A retired or removed project's grants are dormant. Restoring or reviving a project with kit grants, or editing its roster, waits for an owner.

A household owner can file the cards directly. For an outside roster card with no single agent, loom uses the household's live default agent, falling back to the first live agent in roster order for attribution.
