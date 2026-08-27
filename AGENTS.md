# Repository agent instructions

Before adding, moving, or importing application code, read `docs/ARCHITECTURE.md` completely.

- Treat this repository as SvelteKit-first domain modules, not strict Feature-Sliced Design.
- Prefer SvelteKit's real browser/server boundary over visual directory symmetry.
- Put cross-domain Node-only infrastructure in `src/lib/server`.
- Name production modules in `src/lib/app/server` and `src/lib/features/*/server` with a `*.server.ts`-style suffix. Colocated test files are the exception.
- Keep shared contracts runtime-neutral and keep routes as thin adapters.
- Do not bypass peer-feature rules by moving domain behavior into `shared`; use app-level orchestration or a genuinely neutral contract.
- Run `pnpm check:architecture` after changing module placement or imports, and run `pnpm check` before handing off code changes.

If a new architecture exception is necessary, document it in `docs/ARCHITECTURE.md` and add a fixture to `tools/architecture.test.ts` in the same change.
