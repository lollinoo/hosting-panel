# AGENTS.md

The project's operating contract (boundaries, forbidden actions, verification protocol) is `HARNESS.md`; the active task and owner decisions are in `.agents/brain/`. The workflow below decides how that work reaches `main`.

<!-- devflow:start -->
## Development Workflow (devflow)

This section is managed by the devflow installer, which replaces it on every update. Project-specific rules go outside the markers.

### Issue-first (mandatory for every change)
No code, docs or config change starts without a tracking issue and an open draft PR. This covers features, bug fixes, refactors, chores and ad-hoc user requests, one-line fixes included, whether a human or an AI agent does the work. Agents must not skip or reorder these steps.

1. **Issue first:** before touching any file, open an issue with the `github-issue` skill ([`.agents/skills/github-issue/SKILL.md`](.agents/skills/github-issue/SKILL.md)): its sequential title ID, its body template, and its labels (type + `severity: *` + `svc:*`). If an open issue already covers the work (`gh issue list --search "<keywords>"`), reuse it, unless it already has an open PR (see "Parallel agents").
2. **Start, before implementing:** `bash scripts/devflow/start.sh <N> "<type>(<scope>): <description>" [--worktree]`. In one step it refuses an issue that already has an open PR, creates the branch `<type>/<scope>-<description>` from the freshly fetched main branch (in a sibling worktree with `--worktree`), pushes an empty start commit, opens the draft PR with the issue's type and `svc:*` labels and `Closes #<N>`, and assigns the PR and the issue to you (`@me`: an agent works as the operator of its session).
   - **The second argument is the PR title and must be a Conventional Commit.** PRs are squash-merged, so the PR title becomes the commit subject on the main branch and decides the version bump: `feat` → minor, `type!:` or `BREAKING CHANGE` → major, anything else → patch. Choose the type for the release impact, not the effort.
   - The PR body is `.github/PULL_REQUEST_TEMPLATE.md` after `Closes #<N>`: fill it in with `gh pr edit <PR> --body-file <file>`, keeping the `Closes` line.
3. **Implement** in small atomic Conventional Commits, one logical step each, pushing after each one. If the scope changes, update the issue body. Put out-of-scope findings in a new issue, not in this PR.
4. **Ready for review:** after the verify command passes, tick the template checkboxes, post the final summary as a PR comment (`gh pr comment`), then run `gh pr ready`.
5. **Merge & close:** squash merge only, with a Conventional PR title. Then delete the branch (and its worktree: `git worktree remove <dir>`). If the PR is abandoned, close it with a comment explaining why, then either unassign the issue and leave it open or close it with `gh issue close <N> --reason "not planned"`.

One PR per issue. A PR may close several issues only when they cannot ship separately; list one `Closes #<N>` per issue.

### Parallel agents
Several agents (or people) may work on the repository at once. The issue and its PR are the only shared state: nothing another agent needs may live only in a local checkout.
- **One issue, one branch, one PR, one worktree.** Start with `start.sh ... --worktree` so each agent has its own checkout; never switch branches in a checkout another agent is using.
- **An open PR claims its issue.** `start.sh` refuses an issue that already has one: pick another issue, or continue on that PR only when it is handed over to you.
- **Unique issue IDs:** right after `gh issue create`, run `bash .agents/skills/github-issue/scripts/next-issue-id.sh --claim <N>`; when two issues got the same ID at the same time, it retitles the newer one.
- **Branch only from `origin/<main>`** (`start.sh` does it). A local main branch may be stale, and the release amends merge commits, so it can diverge from origin.
- **Update a pushed branch by merging,** never by rebasing and force-pushing (another agent or a reviewer may have it checked out): `git fetch origin && git merge origin/<main>`. Merge also when the PR diff shows changes that are not yours: the branch started from a merge commit the release amended afterwards.
- **Hand-off:** whoever continues or reviews the work reads the issue body, the PR body and the PR comments, so keep them current.

### Branches & commits
- Never commit directly to the main branch (blocked by `.githooks/pre-commit`). `ALLOW_MAIN_COMMIT=1` overrides the block and is reserved for the release automation and for repairs the user asked for.
- Branch names: `<type>/<scope>-<description>`, lowercase. Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `style`, `test`, `chore`, `ci`, `build`.
- Commit subjects, PR titles and PR descriptions: Conventional Commits `<type>(<scope>): <concise description>`, in English (enforced by `.githooks/commit-msg` and by the PR check).

### Versions & releases (fully automatic)
- **Never bump a version or edit `CHANGELOG.md` on a branch** (blocked by `.githooks/pre-commit` and by the PR check), so parallel PRs never conflict. Do not run `bump-version.sh` on a branch, except with `--dry-run`.
- After every merge on the main branch, CI runs `scripts/devflow/release-main.sh`: it bumps each package touched since the last release (list in `.devflow/packages`), prepends the entry to `CHANGELOG.md`, amends the merge commit in place keeping its author, and publishes a GitHub Release tagged by `RELEASE_TAG` in `.devflow/config` (`YYYYMMDD-HHMM` when it is empty). Merges landing in quick succession are released together by the newest run.
- Because that commit is amended, a local main branch can diverge from origin and `git pull` then fails: refresh it with `git fetch origin && git switch -C <main> origin/<main>` (nobody commits on it, so nothing is lost).
- Preview the next bump at any time: `bash scripts/devflow/bump-version.sh --dry-run`.

### Setup & verification
- First clone: `bash scripts/devflow/setup.sh` (activates the git hooks and checks the version files).
- Before a push and before marking a PR ready, the verify command (`VERIFY_CMD` in `.devflow/config`) must pass; `.githooks/pre-push` runs it on every push.
- New package: add it to `.devflow/packages`, then run `bash scripts/devflow/setup.sh` and `bash scripts/devflow/labels.sh`.
<!-- devflow:end -->
