# Vampire

**A self-hosted browser workspace for persistent terminal workspaces.**

<table>
  <tr>
    <td width="78%" valign="top">
      <img src="docs/images/vampire-desktop.png" alt="Vampire desktop workspace" />
    </td>
    <td width="22%" valign="top">
      <img src="docs/images/vampire-mobile.png" alt="Vampire mobile workspace" />
    </td>
  </tr>
</table>

Vampire runs your terminal workspaces in tmux and lets you reconnect from a desktop or mobile browser. Your credentials, project files, and running processes stay on your machine.

## Features

- Persistent tmux-backed terminal workspaces for Codex, Claude Code, and any shell command.
- Browser workspaces for multiple projects, with desktop and mobile support.
- A singleton King workspace that coordinates every managed workspace through a structured local control plane.
- At-a-glance workspace status, so you can see what needs your attention.
- Local-first and self-hosted, with optional authenticated remote access.

## Quick start

Requirements:

- Node.js 22.18+
- tmux

Install tmux with your operating system's package manager, then run:

```bash
npx vampire
```

Open the printed URL, choose a project directory, and create a workspace. Start the CLI or shell you want to use inside it:

```bash
codex
# or
claude
```

Your workspace keeps running when you close the browser. Reopen the workspace whenever you want to continue.

## Vampire King

Create the King workspace from the workspace sidebar and choose the agent launch profile King should use. Vampire materializes a dependency-free Node package in `~/.vampire/king` with a versioned `KING.md` contract and a JSON CLI:

Vampire writes `KING.md` before launching the tmux session. Its bootstrap prompt is then delivered exactly once after the selected profile is recognized as an agent and its main terminal visibly reaches an input prompt; readiness is checked every 500 ms. `Shell only` intentionally leaves the bootstrap pending until a recognized agent is started manually, preventing the instructions from being executed as shell input while a profile is still starting.

```bash
cd ~/.vampire/king
npm run -s king -- workspaces list
npm run -s king -- workspace inspect <workspace-id>
npm run -s king -- workspace files <workspace-id> [path]
npm run -s king -- workspace read <workspace-id> <path>
npm run -s king -- workspace control request <workspace-id> --reason "why King needs the checkout"
npm run -s king -- run create --input run.json
npm run -s king -- decisions list --pending
```

King models a user goal as `Run → analysis Task → approved Plan → change/review Task → verified Result`. It first shortlists up to three candidates from compact workspace metadata. Local workspace agents inspect their own projects in read-only analysis Attempts and return bounded plans, so project source does not flood King's context. King approves a sound plan or asks the authenticated owner a focused question, then creates and dispatches explicit implementation Tasks. Workers report `started` and `result` through write-once files; Vampire watches those events, verifies submitted work automatically, and notifies King through its structured inbox.

A worker's Result is a claim, not completion. Vampire compares declared paths with the actual Git state, rejects forbidden or unexpected changes, reruns allowlisted verification commands without a shell, and applies the Task approval policy. Dirty baselines, event conflicts, workspace handoffs, and owner-gated Tasks surface from the crown control beside Background in the King header. The authenticated owner can act there in one click, adding an optional rationale when the default audit record is not enough.

An existing running workspace—including a linked Git worktree created outside Vampire—can be handed to King without cloning it again. King is deliberately not a workspace or agent factory: it cannot start a stopped workspace, launch a profile, create a worktree, create another terminal, or paste a Task into a shell. It can shortlist and assign only a workspace whose recognized main Codex or Claude agent is already running. The owner creates any desired worktrees and starts their agents through Vampire's ordinary controls, then delegates those prepared lanes to King. Vampire snapshots each delegated checkout's HEAD and dirty diff, leases it to a single writer, and delivers every Task to that workspace's existing main agent; coarse waiting/working inference does not change the dispatch lane. **Take control** interrupts active Attempts, preserves the partial diff for review, and returns the checkout to manual control. Vampire-owned worktrees may be deleted with their workspace; externally registered worktrees are only forgotten and remain untouched on disk.

Attempt delivery is bounded: Vampire escalates a delivered Task that does not report `started` within 2 minutes and a working Task that does not submit a Result within 60 minutes. King UI refreshes time out after 10 seconds, and control actions or CLI control calls fail visibly after 60 seconds instead of hanging forever. Vampire never silently resends an uncertain prompt. Removing the King workspace cancels active workflow state, returns every checkout to manual control, and retains the structured history for audit.

Each Attempt records the intended tmux session, terminal, and observed agent label. Start and Result events prove that the holder of that local Task packet reported those transitions; they are not cryptographic process identity because all local agents run as the same operating-system user. Vampire therefore never equates an event with success: it also requires an unchanged Git HEAD, an attributable diff, independent checks, and the configured approval boundary.

King receives compact workspace summaries by default and delegates project inspection to the corresponding local agent. Repository content, notes, plans, and worker output are treated as untrusted, workspace-scoped evidence; they do not become global preferences or cross-project instructions. The initial implementation intentionally keeps operational history structured instead of building an embedding-based personality memory, avoiding silent context bleed while the workflow and review evidence mature.

The CLI reads its generated `control.json` and reaches Vampire over a private Unix socket in a short, mode-`0700` per-user runtime directory. It does not require an MCP server, HTTP token, package install, or direct access to Vampire's workspace registry. App updates rematerialize the package and contract; each Run retains the contract revision with which it was created.

## Remote access

Vampire listens on localhost by default. To access it from another device, bind it to a reachable interface, set a token, and use HTTPS or a private network:

```bash
VAMPIRE_HOST=0.0.0.0 \
VAMPIRE_TOKEN="$(openssl rand -base64 32)" \
npx vampire
```

Never expose an unauthenticated instance to the public internet. See [SECURITY.md](SECURITY.md) for deployment guidance.

## Development

```bash
pnpm install
pnpm dev
pnpm check
pnpm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contributor workflow.

## License

MIT
