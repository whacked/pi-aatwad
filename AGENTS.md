# Repository instructions

## Versioning

- Bump the package patch version in every commit, including fixes, documentation, and maintenance commits, unless the user explicitly directs otherwise.
- Keep the major and minor versions unchanged when bumping the patch version (for example, 0.1.0 becomes 0.1.1).
- Keep `package.json`, the top-level version and root package version in `package-lock.json`, and any current-version references in documentation synchronized.
- Include the version bump in the same commit as the changes. Do not rewrite existing commits unless explicitly requested.

## Commit attribution

- Every commit going forward must include a Claude Code-style `Co-Authored-By:` trailer identifying the coding harness, provider, and model.
- Format: `Co-Authored-By: <harness> (<provider>/<model>)`, for example `Co-Authored-By: Pi (openai/gpt-6.1-sol)`.
- Use the actual harness and verified provider/model for that commit, not a hardcoded identity or a guessed model. In Pi, inspect `PI_PROVIDER` and `PI_MODEL` when available.
- This applies to all commits, including documentation, maintenance, and version-only commits. Do not rewrite prior commits merely to add attribution.
