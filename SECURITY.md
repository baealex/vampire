# Security policy

Vampire exposes shell sessions over the network. Treat every authenticated browser as having the operating-system permissions of the Vampire server process.

## Supported versions

Until the project publishes versioned releases, security fixes are made on the latest revision of the default branch. Reproduce a report against that revision when practical.

## Reporting a vulnerability

Please use the repository's private vulnerability-reporting feature under the **Security** tab. Include:

- the affected revision and deployment platform;
- required network access and authentication state;
- clear reproduction steps or a minimal proof of concept;
- the impact you observed; and
- any suggested mitigation.

Do not include real access tokens, private terminal output, project files, or session-registry contents. Do not open a public issue until a maintainer confirms that disclosure is appropriate.

## Deployment expectations

- Bind to loopback unless remote binding is intentional and token authentication is enabled.
- Put Internet-reachable deployments behind HTTPS/WSS and an additional private-network or access-control layer.
- Run Vampire as an unprivileged user with access only to the projects it needs.
- Use a long, random, unique `VAMPIRE_TOKEN` and rotate it after suspected exposure.
- Keep the host operating system, Node.js, tmux, reverse proxy, and clipboard tools updated.
- Protect `~/.vampire` or `VAMPIRE_STATE_DIR`; it contains project paths, session metadata, and notes.

Vampire provides authentication and defense-in-depth controls, but it is not a sandbox, privilege boundary, or multi-tenant terminal service. Host compromise, malicious shell commands, exposed credentials, and insecure reverse-proxy configuration are outside the protection that the application alone can provide.

## Image clipboard considerations

Image paste temporarily changes the server computer's clipboard. Uploads are size- and type-limited, staged in an owner-only temporary directory, serialized, and removed after the paste attempt. Avoid enabling this feature on a shared graphical host when clipboard changes could cross trust boundaries.

## Repository viewer considerations

The repository viewer exposes files and Git diffs from every managed workspace to an authenticated browser. It is read-only, limits preview sizes, rejects path traversal, and resolves symlinks before checking that a target remains inside the workspace. These checks reduce accidental exposure; they do not make an untrusted workspace safe.

Do not add a workspace that contains secrets an authenticated Vampire user should not be able to read. Run Vampire with an operating-system account whose file permissions match the intended access boundary.
