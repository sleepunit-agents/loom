# The import: an export read into an empty agent, an outline

*2026-11-26. Status: **outline**. Not a spec yet: it has not been cold-reviewed as its own document and must not be
built from. It depends on [agent-export.md](agent-export.md) for the format and on
[memory-in-the-household.md](memory-in-the-household.md) having moved all four phases, so that an import is one
`loom.db` transaction.*

## Why

Today an agent moves between households by copying its directory. The memory merge ends that. An import is what
replaces it, and it is how an agent is rebuilt from its repository.

## The shape drafted

- `loom agent import --from <dir> --agent <id>`, for a household owner only.
- The agent must exist and have no records. Import is into nothing; merging into a live agent is not part of it.
- Everything is read and checked before anything is written.
- Search vectors are made before the transaction, since they are not in an export.
- One `loom.db` transaction inserts every record. Identity pages and attachments are files and are put in place
  around it.
- Round trip: an export, imported and exported again, has the same digest.

## Holes the first review found, to be closed by the spec

1. **Empty is checked too early.** Emptiness was checked before the slow embedding step, with no lock and no
   re-check inside the transaction, so a live agent could write a memory in between, or two imports could run at
   once. The check belongs inside the transaction, and the agent must be held while an import is in progress.
2. **Files written before the commit have no owner.** Attachments were written straight into the live attachment
   directory with nothing durable saying which import wrote them, so a failed import could not be cleaned up without
   risking a native agent's files. They need a staging directory named in a row written before any file.
3. **A copy inside one household.** Importing an agent's export under a second name in the same household puts the
   same uuids and refs in twice. The spec has to say whether they are unique per agent or per household.
4. **A rename changes the ids callers hold**, since they begin with the agent's name.
5. **Recall after a round trip.** Vectors are remade and every memory starts cold, so recall can order results
   differently. The check has to say what is compared.
6. **What an export does not carry is lost on a move:** deleted memories, volatile values, the agent's settings in
   the household, and its conversations.
7. **Cross-file checks before the transaction:** history that belongs to no record, a card reference to a card that
   is not there, two records with one uuid.

## Decisions for the owner

- Whether moving an agent should carry its conversations. Their words are sealed with the household's key and have
  their own keep-until; written so far as: they stay behind.
