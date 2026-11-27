# The household backup: an outline

*2026-11-26. Status: **outline**. Not a spec yet: it has not been cold-reviewed as its own document and must not be
built from. It records what was drafted on 2026-11-26 and the holes a first cold review found in that draft, so the
spec that follows starts from them.*

## Why

The household stores where backups go, when, how many to keep and which keys to lock them to
(`household.backup_target`, `backup_at`, `backup_keep`, `backup_recipients`). No code in loom acts on them. The owner's household is backed up from outside loom today: `bin/loom-new-backup` in ~/Art (t-2312) runs nightly, takes every SQLite file by online backup into an encrypted restic repository on another disk, and sends an age-encrypted copy offsite, each followed by a restore drill. This outline is about loom doing that itself; that script is the working reference for it.
`docs/specs/household.md` ("Export and restore") describes `loom export` and `loom restore`; those commands were
removed with the older program and not replaced. The owner, 2026-11-26: "we need to solve backup here too for sure."

## The shape drafted

- Each day at `backup_at`, if a target and at least one recipient are set, one **bundle** is written: every SQLite
  database in the home by SQLite's online backup, every other file the household needs (`program.json`, the Comms
  key, identity pages, note attachments), and a list of all of them with their digests.
- The bundle is one tar, encrypted with age to every recipient, written as `.partial`, synced and renamed.
- Bundles beyond `backup_keep` are deleted.
- Every attempt is a row in `loom.db`. A failed or late backup puts an item in front of every household owner.
- `loom restore` is an offline command that decrypts into an empty directory, checks every file, and only then
  puts the home in place.

## Holes the first review found, to be closed by the spec

1. **The bundle is not one moment.** Each database is copied at a different time and the plain files after them, so
   a note row can be in the bundle without its attachment. The spec needs one write lock held across the whole copy,
   or a stated order with a check that makes a mismatch a failed backup.
2. **A backup that never ran is never reported.** Lateness was measured from the newest successful backup, so a
   household that has never had one, or whose schedule never fires, hears nothing. Lateness has to be measured from
   when the target was set.
3. **One notice ever.** A failure that persists was reported once. The spec needs a repeat rule.
4. **A restored copy backs up over the real one.** A trial restore on the same machine keeps the backup settings, and
   its first start would write into, and prune, the live household's backups. A restored home must start with
   backups off until the owner turns them on.
5. **A target inside the home** puts every earlier bundle in each new one.
6. **Names and counts.** The time in a bundle's name needs a format and a rule for two in one second; what "newest"
   means for pruning; `backup_keep` at its lowest.
7. **Leftovers.** Only loom's own `.partial` files may be deleted from the target. A killed restore needs a rule for
   what it left.
8. **Which files are databases**, and whether the vector index is one of them. It is derived and should be left out
   and rebuilt after a restore.
9. **The merge's safety copies** (`*.moved-*`, `loom.db.before-*`) are not in a bundle; say so under what is given
   up.

## Decisions for the owner

- Where bundles go: a directory path that the owner gets offsite, or loom sending them somewhere itself.
- How often: daily and whole, or something more frequent and smaller as well.
