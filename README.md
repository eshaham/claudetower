# claudtower

A panel for Claude Code Desktop that shows every Claude Code session on your machine, ranked by what it needs from you.

It sits beside the chat in each session. It reads the desktop app's own session records and transcripts, so it covers all of your local sessions, not only the one you're in.

## What it shows

Each stopped session gets one card with:

- The project, the ticket and its Linear priority (when the session names one), uncommitted files, and how long ago it last spoke.
- Its pull requests: an icon and diff size for each open PR, with failing or running checks, and a count of merged ones.
- What it's waiting for, labeled **Answer**, **Act**, **Review**, **Follow up**, **In flight** or **Wrap up**.
- An **Archive** button once the session is finished: no open PR, no uncommitted files, and nothing left for you.
- A chevron that expands your last message and Claude's reply.

The session you're in sits in a **This session** section at the top. Widen the panel past 100 columns and it switches to a board with one lane per label.

Clicking a card opens that session.

## How it decides

When a session finishes a turn, Sonnet reads it once on your Claude subscription. It sees a digest of the whole conversation, the last exchange, the session's open PRs, and any sessions started from it. It answers what the session waits for, what you should do next, how urgent it is, and whether the session is finished. A session is read again only when it has a new message, a PR changes state, or a session is started from it.

Ranking combines recency (halving every 48 hours), the ticket's Linear priority, the urgency Sonnet reads, and whether the session waits on you.

## Requirements

- Claude Code Desktop on macOS.
- `gh`, signed in, for PR details. Without it the PR rows are skipped.
- A Linear MCP connector, for ticket priority. Without it tickets show without priority.

## Install

Clone the repo, then load it from its folder in every session by adding this to `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/absolute/path/to/claudtower",
    "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"
  },
  "pluginConfigs": {
    "claudtower": { "options": { "ticketPrefixes": "ENG,OPS" } }
  }
}
```

`CLAUDE_CODE_PLUGIN_DIR_WATCH` makes running sessions reload the panel when its files change, so edits to the repo apply without restarting. New sessions pick it up when they start.

`ticketPrefixes` lists the issue-key prefixes to look for in session titles and branches. Leave it empty to skip tickets.

The repo also carries a marketplace file, so `claude plugin marketplace add <path or owner/repo>` and `claude plugin install claudtower@claudtower` work too. That route doesn't reload on edits.

The panel is titled **claudtower**. Type `/tower` in any session to reopen it after closing it.
