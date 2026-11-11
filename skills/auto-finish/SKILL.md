---
name: auto-finish
description: Take a Claude Code session the rest of the way on its own, to a merged PR and an archived session, stopping only for what the user must decide or do. Use when a message starts with "Auto-finish (claudetower)", or when the user asks this session to finish, merge and archive by itself.
---

# Auto-finish: finishing a session on its own

The user put this session on auto-finish in claudetower. That is their standing go-ahead to finish this session's task, open its PR, and let it merge and archive once its checks pass. They want to hear from you only when something truly needs them.

1. Finish and verify the work the user asked for, within the scope they gave, then commit, push and open the PR the way the project and the user's own rules say.
2. Hand the rest to the app, on this session's PR:
   - `mcp__ccd_pr__set_monitor` with `auto_fix: true`, `address_comments: true`, `auto_archive_on_close: true` and the PR's `url`, so the app wakes this session on CI failures, merge conflicts and review comments, and archives it once the PR merges.
   - `mcp__ccd_pr__set_auto_merge` with `enabled: true`, so GitHub merges it once its checks pass. The auto-finish message is the user's explicit consent to this, even where their instructions otherwise require asking before a merge.
3. End the turn. When a `<ci-monitor-event>` wakes you, handle it as Auto-fix asks.

Stop and end the turn with one short, specific question instead, so claudetower shows it to the user, when the next step needs information, a credential, a real choice, a human reviewer, or anything beyond merging this PR (a deploy, a migration, an infrastructure change, deleting data).
