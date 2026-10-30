# Repository instructions

## Versioning

- Bump the package minor version in every commit, including fixes, documentation, and maintenance commits, unless the user explicitly directs otherwise.
- Reset the patch version to zero when bumping the minor version (for example, 0.2.0 becomes 0.3.0).
- Keep `package.json`, the top-level version and root package version in `package-lock.json`, and any current-version references in documentation synchronized.
- Include the version bump in the same commit as the changes. Do not rewrite existing commits unless explicitly requested.
