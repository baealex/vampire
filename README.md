# Vampire

**Run coding agents in their original CLI, keep them alive in tmux, and check in from any browser.**

![Vampire showing several workspaces, a Git diff, and the repository drawer](docs/images/vampire-desktop.png)

Vampire is a small, self-hosted workspace for Codex, Claude Code, and ordinary project shells. Each workspace is a real tmux session on the machine running Vampire. The browser gives you a terminal, a compact view of all running work, a read-only repository viewer, and a short note for handoffs.

It is meant for the part of agent work that looks like this: start a few jobs, step away, check what changed, and send the next instruction from a laptop or phone.

## Design constraints

Vampire is built around six constraints:

- **Mobile must be useful.** You can check recent activity, see which process is in front, open the terminal, and send another instruction without reaching for a laptop.
- **Remote access must stay simple.** Vampire is one Node process backed by tmux. Put it behind your existing HTTPS reverse proxy, VPN, or private tunnel; no hosted relay is required.
- **The original CLI remains the runtime.** Codex, Claude Code, and shell tools run with their own configuration, authentication, updates, and output. Vampire does not replace them with an agent SDK.
- **Several repositories belong on one screen.** The workspace list keeps sessions from different projects—and multiple sessions from the same project—easy to find.
- **The middle layer must be understandable.** Vampire relays terminal input and output, reports small pieces of session metadata, and reads Git or workspace files for the repository viewer. It does not rewrite prompts or hide an orchestration protocol.
- **The UI should not spend agent tokens.** Vampire does not summarize conversations, replay transcripts, or inject repository context into the agent. File and diff views stay between your browser and your server unless you choose to send something to the CLI.

## What you get

- Persistent project shells backed by tmux
- A multi-project navigator with recent activity and manual ordering
- Foreground-process hints for Codex, Claude Code, shells, and other commands
- Desktop keyboard input and a mobile composer with common terminal controls
- A changes-first Git drawer with unified diffs
- A synchronized, read-only file tree with text and image previews
- A short note per workspace for intent, decisions, and next steps
- Browser image paste into supported CLI tools
- Stable `/sessions/{id}` URLs, reconnect snapshots, and keyboard shortcuts
- Explicit restart, stop, and remove actions for each workspace
- Token login, same-origin checks, signed cookies, rate limits, and a nonce-based content security policy

Activity indicators are deliberately modest. They tell you whether a session produced terminal output recently and which process appears to be in front; they do not claim that an agent is finished or waiting for input.

## How it works

```text
Browser
  │  terminal input, resize events, optional image paste
  │  terminal output, session metadata, file and Git reads
  ▼
Vampire
  │  tmux attach and ordinary terminal input
  ▼
tmux ── your shell ── Codex / Claude Code / other CLI
                         │
                         └── connects to its provider directly
```

The boundary is narrow and visible in the source:

- The browser sends terminal input, resize and activation events, and an optional image upload.
- Vampire returns terminal bytes, a reconnect snapshot, session activity hints, and requested file or Git data.
- tmux receives the input you initiated. Vampire adds no system prompt, model request, or hidden agent instruction.
- The CLI talks to its model provider directly with its own credentials and configuration.

There is no Vampire-specific agent runtime. If a command works in your shell, it works in a Vampire session. The CLI continues to own its model requests and local configuration; tmux owns the process lifetime; Vampire owns the browser connection and its small session registry.

## Mobile use

Open the same Vampire URL on a phone to review all workspaces, enter a session, and send text through the composer. Escape, Ctrl-C, Tab, Enter, arrow keys, image input, and font controls remain available without a hardware keyboard.

<p align="center">
  <img src="docs/images/vampire-mobile.png" width="320" alt="Vampire's mobile terminal and instruction composer">
</p>

## Repository viewer

The repository button beside the workspace note opens a secondary drawer. `Changes` comes first: choose a changed file to see its staged, working-tree, and untracked diff. `Files` shows the current workspace tree and opens UTF-8 text or supported images in the center.

The viewer is intentionally read-only. Editing remains in the shell or with the agent, while the drawer and the open document refresh from disk. Closing the drawer closes the document and returns the center to the terminal.

Reads are restricted to the workspace directory. Escaping symlinks, path traversal, binary text files, and oversized files are rejected. Text previews are limited to 1 MB; PNG, JPEG, GIF, WebP, and AVIF previews are limited to 10 MB.

## Requirements

- Node.js 22 or newer
- pnpm 10 through Corepack when running from source
- tmux on the computer running Vampire
- macOS or Linux; Windows is supported through WSL2

Only the server computer needs tmux. Browsers and phones do not.

Vampire detects a missing tmux installation and shows platform-specific guidance. It never runs a package manager or `sudo` automatically.

```sh
# macOS
brew install tmux

# Debian or Ubuntu
sudo apt-get update && sudo apt-get install -y tmux

# Fedora or RHEL-like systems
sudo dnf install -y tmux
```

## Quick start

Run Vampire without installing it globally:

```sh
npx vampire
```

Or install the command once:

```sh
npm install --global vampire
vampire
```

Open `http://127.0.0.1:7677`, add an absolute project directory, and start the CLI you already use:

```sh
codex
# or
claude
```

Without `VAMPIRE_TOKEN`, Vampire runs in local-only mode with no login screen. It refuses to bind to a non-loopback address unless a token is configured.

For remote access, set a token before starting the installed command:

```sh
VAMPIRE_TOKEN="$(openssl rand -base64 32)" vampire
```

### Run from source

From a clone of this repository:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

For a production build:

```sh
pnpm build
VAMPIRE_TOKEN="$(openssl rand -base64 32)" pnpm start
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `VAMPIRE_HOST` | `127.0.0.1` | Address used by the Node server |
| `VAMPIRE_PORT` | `7677` | Port used by the Node server |
| `VAMPIRE_TOKEN` | unset | Enables token authentication and non-loopback binding |
| `VAMPIRE_STATE_DIR` | `~/.vampire` | Stores the managed-session registry and notes |
| `VAMPIRE_ADAPTER_ORIGIN` | unset | Public HTTPS origin used behind a reverse proxy |

Session state is written atomically to `sessions.json` inside the state directory with owner-only permissions. Shell history and running processes remain in tmux.

## Remote access

Vampire does not provide a hosted relay. Keep it on a network you control and provide HTTPS/WSS through a same-host reverse proxy or private tunnel:

```text
Browser ── HTTPS/WSS ── Caddy or nginx ── HTTP/WS on 127.0.0.1 ── Vampire
```

Example production command:

```sh
VAMPIRE_TOKEN="your-long-random-token" \
VAMPIRE_ADAPTER_ORIGIN="https://vampire.example.com" \
vampire
```

Minimal Caddy configuration:

```caddyfile
vampire.example.com {
	reverse_proxy 127.0.0.1:7677
}
```

The proxy must preserve the external `Host` header and support WebSocket upgrades. If the proxy and Vampire run on different computers, encrypt that hop as well. A VPN, firewall allowlist, or identity-aware proxy is recommended for an Internet-reachable deployment.

Vampire is a remote shell interface. Anyone who can authenticate can act with the operating-system permissions of the Vampire process. It is intended for one trusted person or a small trusted environment, not as a multi-tenant isolation boundary.

## Session lifetime

When you start a workspace, Vampire:

1. validates the absolute project directory;
2. records the session in its local registry;
3. asks tmux to open the configured shell in that directory; and
4. attaches the browser to tmux over an authenticated WebSocket.

A Vampire restart does not terminate the shell. tmux keeps the session and its child processes alive; the next server process reconciles the registry with `tmux list-sessions` and reconnects to what is still running.

Vampire currently attaches to the active pane of each managed tmux session. Pane selection and durable terminal-log search are not implemented.

## Image paste

Paste an image while the terminal is focused, or use the image button beside the composer. Vampire temporarily stages the upload, writes it to the server computer's clipboard, sends the paste keystroke to tmux, and removes the temporary file.

- macOS uses the system clipboard through `osascript`.
- Linux uses `wl-copy` on Wayland or `xclip` on X11.
- PNG, JPEG, GIF, WebP, and AVIF files up to 10 MB are accepted.
- Native Windows hosts are not supported; use WSL2 for the server runtime.

Because the host clipboard is shared state, concurrent image pastes are serialized.

## Development

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev      # development server with terminal WebSocket support
pnpm check    # Svelte and TypeScript diagnostics
pnpm test     # diagnostics, Node tests, and production build
```

Development uses the same tmux attachment path as production. See [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change.

## Project status

Vampire is an early, pre-1.0 release for trusted personal use and small private environments. Configuration, storage, and APIs may change before 1.0; incompatible changes will be documented with migration notes.

## Security

Read [SECURITY.md](SECURITY.md) before deploying Vampire or reporting a vulnerability. Do not place a token in source control, browser URLs, screenshots, or issue reports.

## License

Vampire is available under the [MIT License](LICENSE).
