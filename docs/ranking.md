# How claudetower ranks sessions

claudetower orders your sessions in two steps that never mix:

1. **Reading**, by a model, once per change in a session. Sonnet reads where the session stands and gives it an urgency score, labels, and whether it is in its last mile.
2. **Scoring**, plain arithmetic, on every refresh. It combines what the reading stored with facts claudetower already has (age, lane). It never calls a model, so any change to the weights re-sorts the board at once.

What matters to you is written in your own words in a ranking file. A skill turns your words into precise rules, so you never pick numbers yourself.

## The ranking file

Each Desktop instance has its own file, `~/.claude/claudetower/rankings/<instance>.json` (the instance is the name of its data folder, `Claude` for the default one). Without a file, claudetower uses the built-in default, which works for anyone. A file only needs the parts it changes; the rest comes from the default.

```json
{
  "rules": [
    {
      "said": "Anything blocking the rest of the team is urgent",
      "rule": "Score 85-95 when other engineers are blocked by this work: main CI broken, deploys blocked, a PR others wait on."
    }
  ],
  "labels": [
    { "name": "billing", "means": "Touches billing, invoices or payment flows" }
  ],
  "bands": [
    { "name": "Urgent", "from": 80, "color": "error" },
    { "name": "High", "from": 60, "color": "warning" },
    { "name": "Normal", "from": 30 },
    { "name": "Low", "from": 0 }
  ],
  "recency": { "halfLifeHours": 48, "floor": 0.8 },
  "lanes": {
    "answer": 1,
    "act": 1,
    "review": 1,
    "follow-up": 0.95,
    "in-flight": 0.85,
    "wrap-up": 0.8
  },
  "finish": { "show": 3 },
  "scheduledTasks": "problems-only"
}
```

| Part             | What it does                                                                               | Changing it re-reads sessions? |
| ---------------- | ------------------------------------------------------------------------------------------ | ------------------------------ |
| `rules`          | Your urgency rules: `said` is your words, `rule` is the precise version the reader follows | Yes                            |
| `labels`         | Labels of your own, added to the built-in ones                                             | Yes                            |
| `bands`          | Names for urgency ranges, shown on cards; display only                                     | No                             |
| `recency`        | How age lowers the score                                                                   | No                             |
| `lanes`          | A small factor per lane                                                                    | No                             |
| `finish`         | How many last-mile sessions the Finish section shows                                       | No                             |
| `scheduledTasks` | `problems-only` hides scheduled-task runs unless a run has a problem; `all` shows them     | No                             |

## Reading

When a session changes, Sonnet reads it and stores, per session:

- `urgency`: 0 to 100. How much the task matters now, from the built-in guidance plus your rules. The ticket linked to the session, when open, is one piece of evidence; a closed ticket says nothing.
- `labels`: built-in labels (`production`, `security`, `ci`, `deploy`, `blocks-others`) and yours, when they apply.
- `isLastMile`: the session needs only a small final step from you: merge a ready PR, answer a last yes/no, glance at a finished change.
- `isFinished`: nothing is left; it can be archived.
- Where it stands: needs you (do, decide, review), waiting on others, or done; what it waits for; follow-ups.

Readings are stored per instance in claudetower's plugin data, keyed by session. Each reading remembers a fingerprint of what it was read with: the transcript's last message, PR states, the linked ticket's priority and status, and the rules and labels. When any of those change, the session is read again. Re-reads go newest first, a few per refresh.

The built-in guidance for urgency:

- 90-100: something live is broken for users, data is at risk, or there is a security incident.
- 70-89: real impact soon or for some users, a deadline today, or someone else is waiting on you.
- 40-69: everyday work.
- 0-39: exploration, cleanup, nice-to-haves.

Rules that force a minimum ("always at least 80") are allowed but never in the default: a floor ignores everything that should lower a score.

## Scoring

```
score = urgency × recency × lane
recency = floor + (1 − floor) × 0.5 ^ (age in hours ÷ halfLifeHours)
```

Recency is continuous, recalculated from the exact age on every refresh. Its floor keeps age from moving a session across bands: with the default 0.8, an urgency-85 session from last week (68) still ranks above a fresh urgency-50 one (50). Recency orders sessions within a band.

A session that is running keeps its last reading and score, and comes back to its place when it stops.

## Sections

- **This session**: the session the panel is in.
- **Finish**: sessions in their last mile and sessions ready to archive. Oldest first, so nothing nearly done rots. Only the first few show (`finish.show`), with a count of the rest. Each archives on its own button; there is no bulk archive.
- **The list**: everything else that needs you, highest score first.
- **Running**: sessions working right now.

## Changing the ranking

The `claudetower:ranking` skill is how anyone changes the file, any time: say what matters, in words ("CI failures matter more than review requests", "stop showing scheduled tasks"). The skill:

1. Reads the current file and the default through claudetower's `ranking` tool.
2. Turns your words into precise rules, keeping your words in `said`.
3. Previews the change on made-up scenarios, not your real sessions, covering each rule and where rules meet. The preview runs the real reader on those scenarios and shows each one's score, band and order.
4. Says whether the change re-reads sessions, and saves only once you accept.

## First run

When an instance has no ranking file, the panel shows a setup card:

- **Set up** asks, in the session you are in, to start a new session that runs the setup. The setup goes through the ranking skill as an interview, then offers to allow archiving directly (see the README).
- **Use defaults** writes the default file and hides the card.
