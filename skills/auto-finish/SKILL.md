---
name: auto-finish
description: Take a Claude Code session the rest of the way on its own, to a merged PR and an archived session, stopping only for what the user must decide or do. Use when a message starts with "Auto-finish (claudetower)", or when the user asks this session to finish, merge and archive by itself.
---

# Auto-finish: finishing a session on its own

The user put this session on auto-finish in claudetower. That is their standing go-ahead to finish this session's task, open its PR, and let it merge and archive once its checks pass. They want to hear from you only when something truly needs them.

Start by saying in one line that auto-finish is on and what is left to reach a merged PR, so the user sees it took effect.

If anything left needs the user (an answer, a choice, a go-ahead beyond merging, something they must do), ask for it with the AskUserQuestion tool, with options to pick from, even if you already asked earlier in the session. Do the parts that do not depend on the answer first, then ask. Once they answer, carry on with the steps below.

Ask only when the answer changes what you do next. Never ask whether to keep waiting, and never offer waiting as an option. When all that is left is something already under way that you cannot speed up (CI, a bot review, a code-owner or teammate review GitHub already requested, a scheduled time), make sure step 2 is done, say in one line what it waits on, and end the turn: auto-merge and the app take it from there. If the user wants to nudge a reviewer or change course, they will tell you.

1. Finish and verify the work the user asked for, within the scope they gave, then commit, push and open the PR the way the project and the user's own rules say.
2. Hand the rest to the app, on this session's PR:
   - `mcp__ccd_pr__set_monitor` with `auto_fix: true`, `address_comments: true`, `auto_archive_on_close: true` and the PR's `url`, so the app wakes this session on CI failures, merge conflicts and review comments, and archives it once the PR merges.
   - `mcp__ccd_pr__set_auto_merge` with `enabled: true`, so GitHub merges it once its checks pass. The auto-finish message is the user's explicit consent to this, even where their instructions otherwise require asking before a merge.
3. If this session started other sessions that are not archived yet (`mcp__ccd_session_mgmt__list_sessions` with `linked: true`), pass `auto_archive_on_close: false` instead. claudetower puts those sessions on auto-finish too and archives this one only after every one of them is archived. Where one of them is blocked on something you can answer from this session's context, send it the answer.
4. End the turn. When a `<ci-monitor-event>` wakes you, handle it as Auto-fix asks.

Stop and ask with the AskUserQuestion tool instead when the next step needs information, a credential, a real choice, or anything beyond merging this PR (a deploy, a migration, an infrastructure change, deleting data). A PR that only waits for a requested human review is not one of these: leave it waiting, as above.
