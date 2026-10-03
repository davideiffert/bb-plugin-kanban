# Changelog

## 0.2.0

First public release.

- Works with bb 0.44 and 0.45, built against plugin SDK 0.6.15.
- Clicking a card opens its chat even when bb's right panel is hidden.
- `bb kanban` outside a thread prints every project instead of only the
  first one.
- CLI errors exit with a failure code and name the next command to try.
  An unknown project or thread is reported instead of showing an empty board.
- Cards and messages say "child thread" instead of "crewmate."
- Fixed: a thread with no reply text made an open board refresh itself in a
  loop.
- Fixed: when archiving failed, the card still moved to Done, and dropping it
  there again did not retry. The card now stays put until the archive works.
- Fixed: "+ New thread" in a merged column could create the thread and then
  report a failure. The card now goes in the project's first column.
- Fixed: `--all` no longer needs the calling thread to exist, `--project` with
  no value is an error, and `note` gives correct advice for child threads and
  removed cards.

## 0.1.0

The version used privately before release.

- A board where every card is a bb thread, merged across projects by column
  role.
- Automatic moves from thread events, plus an agent tool, a CLI, and a bundled
  skill so agents move their own cards.
- Only the user can move a card to Done, because Done archives the thread.
- Child threads roll up onto their parent's card.
- Rename, remove, and new-thread actions on the board, a chat panel beside it,
  a narrow layout, and a phone layout.
