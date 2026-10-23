# claudetower

A panel for Claude Code Desktop that shows every Claude Code session on your machine, ranked by what it needs from you.

It sits beside the chat in each session. It reads the desktop app's own session records and transcripts, so it covers all of your local sessions, not only the one you're in.

## What it shows

The panel lists the sessions of the Desktop instance it runs in. If you run more than one instance, each with its own data folder, each panel shows only its own sessions.

Each stopped session gets one card with:

- The project, the ticket and its tracker priority (when the session names one), uncommitted files, and how long ago it last spoke.
- Its pull requests: an icon and diff size for each open PR, with failing or running checks, and a count of merged ones.
- What it's waiting for, labeled **Answer**, **Act**, **Review**, **Follow up**, **In flight** or **Wrap up**, with an **Urgent** or **High** label when the task is serious, and labels such as `production` or `ci` when they apply.
- The options the session offered you at the end (its question and buttons), so you can see the choice without opening it.
- An **Archive** button once the session is finished: no open PR, no uncommitted files, and nothing left for you. When your settings allow `mcp__ccd_session_mgmt__archive_session`, it archives the session at once; otherwise it asks that session to archive itself, so the request goes through the session's own permission checks.
- A chevron that expands your last message and Claude's reply.

The session you're in sits in a **This session** section at the top. Sessions in their last mile (ready to archive, a PR ready to merge, a last yes/no) gather in a **Finish** section, oldest first, so nearly-done work gets closed. Widen the panel past 100 columns and it switches to a board with one lane per label.

Clicking a card opens that session.

## How it decides

When a session finishes a turn, Sonnet reads it once on your Claude subscription. It sees a digest of the whole conversation, the last exchange, the session's open PRs, its ticket, and any sessions started from it. It answers what the session waits for, what you should do next, an urgency score from 0 to 100, which labels apply, and whether the session is in its last mile or finished. A session is read again only when something it was read with changes: a new message, a PR's state, its ticket's priority, or your ranking rules.

The order is plain arithmetic on that reading, recalculated on every refresh with no model call: urgency, lowered gently by age, times a small factor for what the session waits for. Age only orders sessions of similar urgency, so urgent work stays on top however old it is.

What counts as urgent is yours to set, in your own words. The first time the panel opens, a card offers a short setup in a new session; after that, tell any session what should rank higher or lower and the `claudetower:ranking` skill updates your ranking file, previewing the change on made-up examples before saving. [docs/ranking.md](docs/ranking.md) explains the whole model.

## How it learns each project

claudetower doesn't assume any tool. Once per project, and again every 7 days while the project has active sessions, Sonnet profiles it from the repo: its git remote, recent branches, session titles, CI workflows, README and CLAUDE.md, plus the MCP tools your Claude Code can call. The profile names the project's ticket prefixes, the tool that looks up one of its tickets, the services it depends on, and what a P0 looks like there. Session reads use it to judge priority.

## Requirements

- Claude Code Desktop on macOS.
- `gh`, signed in, for PR details. Without it the PR rows are skipped.
- For ticket priority, an MCP connector to the project's issue tracker. Without one, tickets show without priority.

claudetower reads Claude Code Desktop's own session records and transcripts and opens sessions through its `claude://` links. None of these are a public API, so a Desktop update can change them and break parts of the panel until claudetower catches up.

## Install

In a terminal:

```bash
claude plugin marketplace add eshaham/claudetower
```

```bash
claude plugin install claudetower@claudetower
```

In Claude Code Desktop, the same is under **+** → **Plugins** → **Add marketplace**, then add the claudetower plugin. New sessions show the panel when they start.

The panel is titled **claudetower**. Type `/tower` in any session to reopen it after closing it.

### Settings

`ticketPrefixes` is optional. Leave it empty to use the prefixes claudetower learns for each project, or list prefixes to use everywhere instead, in `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "claudetower": { "options": { "ticketPrefixes": "ENG,OPS" } }
  }
}
```

## Developing

Clone the repo and load it from your clone in every session, so your edits apply without reinstalling. Uninstall the marketplace copy first, then add to `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/absolute/path/to/claudetower",
    "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"
  }
}
```

`CLAUDE_CODE_PLUGIN_DIR_WATCH` makes running sessions reload the panel when its files change. Sessions read these settings when they start, so restart the Desktop app once after adding them.

Check a change with `claude plugin validate .`.

## License

MIT
