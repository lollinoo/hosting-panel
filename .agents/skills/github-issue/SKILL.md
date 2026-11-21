---
name: github-issue
description: >-
  Use when the user asks to open, file or draft a GitHub issue in this repository, or when
  a change is about to start without a tracking issue. Covers the sequential bracketed IDs
  ([BUG-NN], [FEAT-NN], [CI-NN], [OBS-NN], [DUP-NN], [DOCS-NN]), the title and body format,
  code line links, and the type / severity / svc labels.
---

# GitHub Issue Skill

Follow this workflow whenever creating or drafting a GitHub issue in this repository.

## 1. Determine Category Prefix & Next Sequential ID

Every issue title starts with a sequential bracketed identifier `[<PREFIX>-<NN>]`:

| Prefix | Category | Typical Labels |
| :--- | :--- | :--- |
| `BUG` | Functional defect, broken logic, UI/UX bug | `bug` (optional: `broken-code`) |
| `FEAT` | New feature, enhancement, or business rule addition | `enhancement` |
| `CI` | CI/CD pipelines, build, runtime, or dependency/security upgrades | `enhancement` or `refactor` |
| `OBS` | Dead/unreachable code, unused exports, obsolete tests | `refactor`, `obsolete-code` |
| `DUP` | Duplicated logic, handlers, or helpers | `refactor`, `duplicated-code` |
| `DOCS` | Documentation, agent rules, templates, or process changes | `documentation` |

Run the helper script to get the next available ID:

```bash
bash .agents/skills/github-issue/scripts/next-issue-id.sh [BUG|FEAT|CI|OBS|DUP|DOCS]
```

Before creating, check that no open issue already covers the work: `gh issue list --search "<keywords>"`.

## 2. Inspect Affected Code & Exact Line Numbers

Before writing the issue body:
1. Locate the exact files and line ranges causing the issue or requiring changes.
2. Link every file reference with a repository-relative Markdown link and line anchors, e.g.
   `[parser.rs](core/src/parser.rs#L94-L104)`.

## 3. Format Title & Body (Strictly in English)

Titles and descriptions are written **in English**. Keep UI copy in another language quoted or in backticks when referencing it.

### Title Pattern

```text
[<PREFIX>-<NN>] (<primary-scope>): <Concise Title in English> (`<pkg-1>`, `<pkg-2>`)
```

`<primary-scope>` and `<pkg-N>` are package names from `.devflow/packages`.

Example: `[BUG-05] (web): Window Scrolls Past the App Shell Showing a Grey Band (\`web\`)`

### Body Template

Choose the heading: `## Bug Finding`, `## Feature Request`, or `## Code Audit Finding`.

```markdown
## Bug Finding `<PREFIX>-<NN>`

- **Category:** <Short category, e.g., Input Validation / Race Condition>
- **Severity:** <Low | Medium | High>
- **Component:** `<package>` (`<affected file paths>`)
- **Primary Location:** [<file>](<repo-relative-path>#L<start>-L<end>)
- **Estimated Impact:** <1-2 sentences describing user/operational impact>

### Summary
<What happens today vs what should happen, and which views, endpoints or commands are affected.>

### Details & Current Behaviour
- **Root cause**:
  - <Technical explanation of why the bug occurs or what is missing>
- **Locations**:
  - [<file> — <symbol or element>](<repo-relative-path>#L<start>-L<end>)
- **Why it's an issue**:
  - <Concrete symptoms, measurements, or edge cases>

### Proposed Minimal Fix
1. **<Step 1 title>:** <Specific, minimal implementation change with file references>
2. **<Step 2 title>:** <Additional adjustments or edge-case guards>
3. **Verification / Tests:** <How to test it, and which tests to add>

### Acceptance Criteria
- [ ] <Criterion 1>
- [ ] <Criterion 2>
- [ ] The verify command (`VERIFY_CMD` in `.devflow/config`) passes.
```

## 4. Select Labels

Always attach:
1. **Type label:** `bug`, `enhancement`, `refactor`, `documentation`, `broken-code`, `obsolete-code`, `duplicated-code`, `performance`
2. **Severity label:** `severity: low`, `severity: medium`, or `severity: high`
3. **Package label(s):** `svc:<package>` for every affected package in `.devflow/packages`

A missing label means a package was added: run `bash scripts/devflow/labels.sh`.

## 5. Create & Verify the Issue via GitHub CLI

Use a heredoc (`--body-file -`) so backticks and quotes are never mangled by the shell:

```bash
gh issue create \
  --assignee @me \
  --title "[<PREFIX>-<NN>] (<scope>): <Summary> (\`<pkg>\`)" \
  --label "<type-label>" \
  --label "severity: <low|medium|high>" \
  --label "svc:<package>" \
  --body-file - <<'EOF'
<markdown body>
EOF
```

Then claim the ID, since another agent may have created an issue with the same one in the meantime:

```bash
bash .agents/skills/github-issue/scripts/next-issue-id.sh --claim <number>
```

It prints the final ID; when it differs, the issue was retitled. Verify with `gh issue view <number> --json number,title,url,labels,assignees`.

## 6. Next Step: Branch and Draft PR

The issue is step 1 of the mandatory workflow in `AGENTS.md`. Before implementing anything, start the work with `bash scripts/devflow/start.sh <number> "<type>(<scope>): <description>" [--worktree]`: it creates the branch and the draft PR (assignee, labels, Conventional Commit title, `Closes #<N>`).
