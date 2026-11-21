Closes #<!-- issue number (AGENTS.md: every PR starts from an issue) -->

## PR Purpose
<!-- Brief description of the problem solved or feature introduced -->

## Impacted Packages
<!-- Package names from .devflow/packages, plus docs / CI / scripts when touched -->
- [ ] `...`

## Pre-PR Verification
- [ ] PR title is a Conventional Commit (`<type>(<scope>): <description>`), since it becomes the squash commit that drives the version bump
- [ ] PR and linked issue are assigned and labelled (type + `svc:*`)
- [ ] The verify command (`VERIFY_CMD` in `.devflow/config`) passes
- [ ] No manual version bump and no `CHANGELOG.md` edit (the automated release runs post-merge on the main branch)
