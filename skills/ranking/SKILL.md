---
name: ranking
description: Set up claudetower or change how it ranks Claude Code sessions. Use when the user wants to set up claudetower, or says what should rank higher or lower in claudetower, what counts as urgent, what to hide, how age or the Finish section should work, or asks why a session ranks where it does.
---

# Changing how claudetower ranks sessions

claudetower ranks this Desktop instance's sessions from a ranking file. `docs/ranking.md` in the claudetower repo explains the model; this skill is how the file changes. The user describes what they want in words. You own the numbers: never ask the user to choose a score, a weight or a band edge.

Everything goes through the `mcp__claudetower__ranking` tool:

- `{"action": "show"}`: the file's path and content, the effective ranking, the defaults and the built-in labels.
- `{"action": "preview", "ranking": {...}, "scenarios": [...]}`: reads made-up scenarios under the draft and under the current ranking, with the same reader claudetower uses on real sessions.
- `{"action": "save", "ranking": {...}}`: checks the ranking and writes it. Never write the file any other way.

## Changing the ranking

1. Call `show`. Read the current `rules`, their `said` (the user's words) and `rule` (the precise version).
2. Work out what the user wants. Ask only when their words leave the intent unclear, one question at a time, in plain words.
3. Draft the new file content:
   - **Urgency rules** (`rules`): each holds `said`, the user's words as they gave them, and `rule`, the precise instruction for the reader. Write rules as score ranges tied to the built-in guidance (90-100 live breakage or data or security; 70-89 real impact soon or someone waiting; 40-69 everyday work; 0-39 nice-to-haves): "Score 85-95 when ...". When the user ranks one thing above another, give them ranges that order them. Keep earlier rules unless the user changes them, and fix conflicts between rules rather than stacking them.
   - **No floors by default.** Write "at least N" rules only when the user explicitly asks for one, and tell them the cost: a floor ignores everything that should have lowered the score.
   - **Labels** (`labels`): add one only when the user wants a kind of session recognized or shown; a label alone changes no score unless a rule mentions it. Names are lowercase-with-dashes and must not repeat the built-in ones.
   - **Everything else** (`bands`, `recency`, `lanes`, `finish`, `scheduledTasks`): change only what the user asked about. These never need sessions read again.
   - Something that is really a fixed adjustment for a project or a lane belongs in those numbers, not in a rule, because rules cost re-reads.
4. Call `preview` with 4 to 10 made-up scenarios, not the user's real sessions. Cover each new or changed rule, the places where two rules meet (a session that is both blocking the team and touching CI), and one or two everyday sessions for contrast. Write each `description` as a session's situation would read, with `ageHours` and `lane` when they matter.
5. Show the result as a table: scenario, band, urgency, and its position under the draft next to its position under the current ranking. Point out what moves and why. If a result is not what the user meant, adjust the draft and preview again.
6. Say what saving costs. If the preview says `reReadsSessions`, every session is read again, newest first, over the next minutes, which spends model calls. Otherwise the board re-sorts immediately.
7. Save only after the user accepts. Then say what changed, in one or two sentences.

## Setting up claudetower

When the user asks to set up claudetower, or sends the setup card's message:

1. Explain in two sentences what claudetower ranks by: how urgent each session is, how long it has waited, and what it needs from them; and that sessions in their last mile get their own Finish section so they get closed.
2. Ask whether they want the default ranking or to tell you what matters to them. For the default, save `{}`. Otherwise run "Changing the ranking" above as an interview: what makes a session urgent for them, what they never want to see, whether old sessions should fade or stay.
3. Then offer direct archiving. claudetower's Archive button archives at once when the user's settings allow `mcp__ccd_session_mgmt__archive_session`; without that, it asks the session to archive itself, which is slower and spends one turn. If the user wants it, add that tool name to `permissions.allow` in `~/.claude/settings.json`, keeping everything else in the file as it is.
4. End with where the file lives and that they can change the ranking any time by saying what they want, in any session.
