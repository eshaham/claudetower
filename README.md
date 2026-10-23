# claudetower

A panel for Claude Code Desktop that shows every Claude Code session on your machine, ranked by what it needs from you.

It sits beside the chat in each session. It reads the desktop app's own session records and transcripts, so it covers all of your local sessions, not only the one you're in.

## What it shows

The panel lists the sessions of the Desktop instance it runs in. If you run more than one instance, each with its own data folder, each panel shows only its own sessions.

Each stopped session gets one card with:

- The project, the ticket and its tracker priority (when the session names one), uncommitted files, and how long ago it last spoke.
- Its pull requests: an icon and diff size for each open PR, with failing or running checks, and a count of merged ones.
- What it's waiting for, labeled **Answer**, **Act**, **Review**, **Follow up**, **In flight** or **Wrap up**, with a **Critical** or **High** label when the task is serious.
- The options the session offered you at the end (its question and buttons), so you can see the choice without opening it.
- An **Archive** button once the session is finished: no open PR, no uncommitted files, and nothing left for you.
- A chevron that expands your last message and Claude's reply.

The session you're in sits in a **This session** section at the top. Widen the panel past 100 columns and it switches to a board with one lane per label.

Clicking a card opens that session.

## How it decides

When a session finishes a turn, Sonnet reads it once on your Claude subscription. It sees a digest of the whole conversation, the last exchange, the session's open PRs, and any sessions started from it. It answers what the session waits for, what you should do next, how urgent it is, and whether the session is finished. A session is read again only when it has a new message, a PR changes state, or a session is started from it.

Ranking combines recency (halving every 48 hours), the ticket's priority, the task's priority, and whether the session waits on you. A **critical** task is a P0 happening now: a production service down for users, data loss, a security incident, or the team blocked, such as the main branch's CI broken.

## How it learns each project

claudetower doesn't assume any tool. Once per project, and again every 7 days while the project has active sessions, Sonnet profiles it from the repo: its git remote, recent branches, session titles, CI workflows, README and CLAUDE.md, plus the MCP tools your Claude Code can call. The profile names the project's ticket prefixes, the tool that looks up one of its tickets, the services it depends on, and what a P0 looks like there. Session reads use it to judge priority.

## Requirements

- Claude Code Desktop on macOS.
- `gh`, signed in, for PR details. Without it the PR rows are skipped.
- For ticket priority, an MCP connector to the project's issue tracker. Without one, tickets show without priority.

claudetower reads Claude Code Desktop's own session records and transcripts, opens sessions through its `claude://` links, and archives through its session tools. None of these are a public API, so a Desktop update can change them and break parts of the panel until claudetower catches up.

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
