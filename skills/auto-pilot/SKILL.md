---
name: auto-pilot
description: Take a Claude Code session the rest of the way on its own, to a merged PR and an archived session, stopping only for what the user must decide or do. Use when a message starts with "Auto-pilot (claudetower)", or when the user asks this session to finish, merge and archive by itself.
---

# Auto-pilot: finishing a session on its own

The user put this session on auto-pilot in claudetower. That is their standing go-ahead to finish the work this session was asked to do, commit it, push it, open its PR, merge it once its checks pass, and archive the session. They want to hear from you only when something truly needs them.

claudetower sends the auto-pilot message each time this session goes idle with nothing that needs the user. Do as much as you can in one turn, so the session does not stop and wait for the next nudge.

## What the go-ahead covers

The go-ahead is for this session's own task and its own PR, nothing more:

- Finishing the change the user asked for, within the scope they gave. No new features, no unrelated cleanups.
- Running the project's checks (tests, typecheck, lint) and fixing what fails because of this change.
- Committing on a branch, pushing, and opening or updating the PR, following the project's and the user's own rules for branch names, commit messages and PR bodies.
- Waiting for the PR's checks, fixing failures this change caused, and answering automated or bot review.
- Merging the PR when its checks pass and nothing blocks it, with the merge method the repository uses. This message is the user's explicit consent to merge this one PR, even where their instructions otherwise require asking first.
- Whatever the user's own instructions say to do after a merge (for example, refreshing a local checkout).
- Archiving the session with `mcp__ccd_session_mgmt__archive_session`.

It never covers: production deploys, `terraform apply` or other infrastructure changes, data migrations, deleting data, force-pushing a shared branch, merging someone else's PR, sending messages to people, or anything the user's instructions say needs their approval other than merging this PR.

## Steps

1. Read where the session stands: what the user asked for, what is done, the branch, uncommitted files, and any open PR (`gh pr view`, `gh pr checks`).
2. Finish and verify the remaining work. If the user already gave you a choice to make, use their earlier answers; do not invent requirements.
3. Commit, push, and open or update the PR.
4. Wait for the checks in this same turn (`gh pr checks --watch`, run in the background if it may take long, then check again). Do not end the turn just to wait.
5. When a check fails, read its log, fix it if this change caused it, push, and wait again. If it fails for a reason outside this change (a flaky or broken main, an outage), stop and say so.
6. Read new review comments. Address automated ones yourself. If a person asked for changes or must approve, stop: that is theirs.
7. When the checks pass and the PR can merge, merge it. If branch protection requires a review or a check you cannot get, stop and say what is missing.
8. Do any post-merge steps the user's instructions call for.
9. Archive this session with `mcp__ccd_session_mgmt__archive_session`. If that tool is denied, say the work is merged and the session is ready to archive.

## When to stop

Stop, end the turn with one clear question or request, and do not guess, when:

- the next step needs information, a credential, a secret, or a real choice between approaches that only the user can make;
- someone outside the session has to act (a human reviewer, an approval elsewhere, a teammate);
- the next step is outside the go-ahead above;
- the same check has failed three times after your fixes;
- the task turns out larger, riskier or different from what the user asked for.

Put the ask in your last message, short and specific, so claudetower shows it to the user in its Answer or Act lane. claudetower stops nudging this session until the user answers.
