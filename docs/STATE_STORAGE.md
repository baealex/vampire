# Vampire state ownership and migrations

Vampire groups persistent state by owner and lifecycle. The layout may change only through recorded forward migrations.

## Current layout (version 1)

```text
~/.vampire/
├── state-layout.json
├── registry.json
├── global/
│   ├── settings.json
│   ├── launch-profiles.json
│   ├── status-widgets.json
│   ├── terminal-input.json
│   └── composer-history.json
├── workspaces/
│   └── <workspace-key>/
│       ├── settings.json
│       ├── automations.json
│       ├── background.json
│       ├── note.md
│       └── composer-history.json
├── agent-support/
│   ├── guides/
│   └── requests/
│       ├── automations/
│       └── background/
├── backups/
│   └── 0001-organize-state-directory/
│       ├── manifest.json
│       └── legacy/
└── worktrees/
```

`registry.json` contains only workspace identity, connection, repository identity, and activity timestamps. Server-wide preferences live in `global/`; state owned by one workspace lives in its workspace directory. Unsafe workspace IDs are represented by a deterministic SHA-256 key, while the original ID remains inside the validated documents.

Legacy notes and Composer histories whose workspace is no longer registered are still copied below their previous workspace key. They remain outside the active registry and are ignored by normal workspace loading, but are not reduced to backup-only data; registering that same workspace ID again makes its note and history available at the expected paths.

`agent-support/` contains rebuildable guides and isolated request files, never the authoritative configuration an agent is asked to change. Git worktrees remain at the state root as a deliberate exception: their absolute paths and Git administrative links give them a different lifecycle, so a data-layout migration must not move them.

Locks, recovery journals, and staging directories are disposable runtime state. Backups are recovery state and are not read during normal operation.

## Cross-file commits

The workspace registry, global workspace settings, launch profiles, and every workspace's settings, automations, and Background favorites share one revision. A mutation follows this order:

1. validate and normalize the complete aggregate state;
2. atomically write a recovery journal containing the intended files and hashes;
3. atomically replace global and workspace-owned documents;
4. replace `registry.json` last as the commit point;
5. read and validate the committed revision across every file;
6. durably remove the recovery journal.

If the process stops between these steps, the next read or startup replays the journal idempotently. A malformed journal, mixed revisions, missing workspace document, symlink, or unexpected removal target fails closed instead of overwriting state.

The migration never exposes the aggregate registry documents to an agent. Structured agent-assisted changes, including Automation and Background favorites, use an isolated request file, server-side schema and conflict validation, a temporary output, and atomic application by the server. Feature-specific editable files such as notes and status widgets remain bounded by their own contracts and validators.

Background agent requests contain only a bounded snapshot of one workspace's saved commands and an editable `add`/`remove` operation. The generated apply command stages the request without editing `background.json`; the server rejects stale snapshots, duplicates, over-limit results, malformed commands, and recognizable inline secrets before committing the workspace documents. Applying favorites never creates a tmux process or runs a command. Worktrees inherit a copy of their source workspace's favorites when they are created and diverge independently afterward.

## Version ledger

`state-layout.json` is the authoritative migration ledger. Layout version 1 has this shape:

```json
{
  "formatVersion": 1,
  "layoutVersion": 1,
  "appliedMigrations": [
    {
      "name": "0001-organize-state-directory",
      "checksum": "<sha256>",
      "appliedAt": "<ISO-8601>"
    }
  ]
}
```

- `formatVersion` versions the ledger schema.
- `layoutVersion` is derived from the last applied migration.
- Applied migrations must be an exact ordered prefix of those shipped by the running build.
- Stable checksums prevent an applied migration from being silently renamed or changed.
- The ledger is flushed, atomically renamed, and recorded only after the migrated layout validates.
- The current layout is validated again at every startup even when nothing is pending.

Umzug provides migration ordering and pending/executed selection. Vampire provides the state-directory lock, checksummed atomic ledger storage, staging, backup, validation, and recovery behavior; Umzug's built-in JSON storage is not used.

## Migration source organization

Migration behavior is kept out of the runner and split into ordered source files:

```text
src/lib/server/
├── state-migrations.ts
└── state-migrations/
    ├── types.ts
    └── 0001-organize-state-directory.ts
```

`state-migrations.ts` owns only ordering, locking, the atomic ledger, and execution. Each numbered file owns one forward transformation and its resulting-layout validator. Once a numbered migration ships, its name, checksum input, and behavior are frozen. A later correction or layout change is a new numbered migration such as `0002-...`; it is not patched into an already applied step. Tests may exercise a numbered migration through the common runner, while reusable filesystem primitives remain outside the numbered files.

## Upgrade and recovery policy

Vampire guarantees forward upgrades. Automatic downgrade is unsupported because an older binary cannot safely interpret a newer multi-file layout. To go back, stop Vampire and restore the verified backup with the matching older application version.

`0001-organize-state-directory` validates the legacy v0.20-compatible files and then:

1. snapshots every known legacy state file into a private staging directory;
2. writes a checksum manifest and verifies every backup byte;
3. builds the complete version-1 layout in separate staging;
4. validates schemas, workspace ownership, IDs, revisions, notes, and histories;
5. installs ancillary files and commits the aggregate state through `registry.json`;
6. validates the live result;
7. removes legacy root copies only when they still match the verified backup;
8. records layout version 1.

The backup is immutable and retained at `backups/0001-organize-state-directory/legacy/`. A restart after interruption reuses and revalidates it, accepts already installed identical files, completes the remaining steps, and produces the same result. A changed source, conflicting target, damaged backup, or unreadable current layout stops migration without deleting the remaining legacy source.

## Isolated development snapshots

An installed Vampire can remain running while a development snapshot is prepared. The snapshot tool reads and hashes an allowlist of durable legacy or version-1 files, writes them to a private sibling staging directory, verifies the copy, reads the source again, and retries if an atomic source update overlapped the snapshot. Pending migrations run only inside staging. The completed directory receives a development marker and is then renamed to a previously nonexistent target.

The tool never writes to the source and never replaces an existing target. Git worktrees, process locks, agent requests, generated support files, backups, and temporary files are excluded. Development and tests use separate state paths and tmux socket namespaces. Development also disables automatic launch profiles, automations, and status-widget commands, though explicit actions can still affect the projects referenced by copied workspace paths.
