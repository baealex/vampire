# Release process

Vampire is maintained directly on main. Working branches may be squashed
into main, but PRs are not the operating unit and releases do not use release
PRs or version inputs.

## Rules

- package.json is the only source of the release version.
- Update the version in package.json as part of the normal work on main.
- An annotated release tag must point to a commit already on main and contain
  the release notes.
- Pushing a vX.Y.Z tag starts one publish workflow:
  CI -> E2E -> Release.
- The tag is a release candidate until the final Release step succeeds.
- npm publish and the GitHub Release happen only after all earlier steps pass.

## Release notes

Write the GitHub Release body using the project convention in
[docs/RELEASE_NOTES.md](RELEASE_NOTES.md). Keep the note focused on
user-visible outcomes, use the exact versioned install commands, and include
the comparison link for the previous tag. Draft the final body locally in the
ignored `docs/RELEASE_DRAFT.md` file, then create the release tag with:

    git tag --annotate --cleanup=verbatim --file docs/RELEASE_DRAFT.md vX.Y.Z

The publish workflow validates the tag message and uses it verbatim instead of
generating release notes from commits. Delete the local draft after the
release succeeds.

## Release gate

When vX.Y.Z is pushed, Publish checks that the tag points to main and matches
package.json. CI runs type checks, unit tests, and the build. E2E starts only
after CI succeeds and tests the exact tag commit. Release then packs and
smoke-tests the exact npm artifact, requests approval from the npm
environment, publishes it, verifies the npm registry, and creates the GitHub
Release last.

Do not run npm publish or create a GitHub Release manually.

## Retry the same version

A failed pipeline does not require a new patch version.

If CI, E2E, package smoke, or the npm environment approval fails before
publishing, fix the problem on main and move the same candidate tag to the
new main commit. For example, to retry v0.13.0:

    VERSION=0.13.0
    git switch main
    git pull --ff-only origin main
    git tag -d "v$VERSION"
    git push origin ":refs/tags/v$VERSION"
    git tag --annotate --cleanup=verbatim --file docs/RELEASE_DRAFT.md "v$VERSION"
    git push origin "v$VERSION"

Only do this when vampire@0.13.0 has not been published and its GitHub
Release does not exist.

If publishing already succeeded and a later verification or GitHub Release
step failed, do not move the tag and do not bump the version. Re-run the
failed workflow for the same tag. The publish helper accepts the existing
version only when its registry integrity matches the verified artifact.

If the registry contains different contents for the same version, stop and
investigate. Never overwrite it by repeatedly incrementing patch versions.
