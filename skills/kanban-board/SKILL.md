---
name: kanban-board
description: Keep this thread's kanban card in the right column. Use whenever you start working, finish a chunk of work, hand something back to the user, or get blocked. The board is how the user sees what every thread is doing.
---

# Keeping the kanban board honest

Your thread most likely has a card on the Kanban panel. A thread spawned by
another thread has no card of its own; it shows as a row on its parent's card,
so report to the thread that spawned you instead. The card is only useful if it
says what is actually happening, so move your own card as the work
changes state. bb also moves cards automatically when a thread starts and stops
running; your job is the part bb cannot infer: blocked, waiting on review, or
finished.

## Moving your card

Preferred (native tool, no shell):

```
kanban_move_card { "column": "doing", "note": "wiring the importer" }
```

Equivalent from the shell:

```
bb kanban move doing --note "wiring the importer"
```

`column` accepts a column id, its display name, or one of the semantic roles
`todo`, `doing`, `review`. Use a role when you do not know the board's column
names, since users rename and add columns.

## When to move

| Moment | Column | Note to leave |
| --- | --- | --- |
| You start real work on the task | `doing` | what you are building |
| You need the user to decide, review, or approve | `review` | the exact question or what to check |
| You are blocked on something outside the thread | `review` | what you are blocked on |
| The work is finished and verified | `review` | what landed, and how it was verified |
| The task turned out to be someone else's / not now | `todo` | why it is parked |

Keep the note under one line. It is the only thing the user reads on the card.

## Reading the board

Use `kanban_move_card` for your own card. To see the board:

```
bb kanban board          # this thread's project
bb kanban board --all    # every project, merged by column
bb kanban columns        # this thread's project
```

Read the board before claiming work that another thread already has in `doing`.

## Rules

- Move your own card. Do not move another thread's card unless the user asks.
- **You cannot move a card to `done`.** Done archives the thread, and archiving
  the last thread of a managed worktree makes bb delete that worktree and its
  branch, so it is the user's call alone. Asking for `done` puts the card in
  review instead. Finish by moving to `review` with a note saying what landed
  and how you verified it; the user closes it out.
- One note per move; replace the old note rather than appending history.
