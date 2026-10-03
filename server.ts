// bb-plugin-kanban — backend entry.
//
// Every card on the board IS a bb thread. The plugin owns only the placement
// (which column, what order, an optional note); titles, status and activity are
// always read live from bb so a card can never drift from its thread.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

/** Semantic roles let the lifecycle automation survive column renames. */
const COLUMN_ROLES = ["todo", "doing", "review", "done"] as const;
type ColumnRole = (typeof COLUMN_ROLES)[number];

const DEFAULT_COLUMNS: { id: string; name: string; role: ColumnRole }[] = [
  { id: "backlog", name: "Backlog", role: "todo" },
  { id: "in-progress", name: "In progress", role: "doing" },
  { id: "review", name: "Needs review", role: "review" },
  { id: "done", name: "Done", role: "done" },
];

const SORT_STEP = 1000;

const columnSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(COLUMN_ROLES).nullable(),
  position: z.number(),
});

const cardSchema = z.object({
  threadId: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  columnId: z.string(),
  sortKey: z.number(),
  note: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  providerId: z.string(),
  branchName: z.string().nullable(),
  isArchived: z.boolean(),
  isUnread: z.boolean(),
  hasPendingInteraction: z.boolean(),
  /** A rolled-up crewmate is waiting on the user; the parent has to say so. */
  childNeedsAttention: z.boolean(),
  updatedAt: z.number(),
  movedAt: z.number(),
  /** Last thing the agent said, cached; null until it has been fetched. */
  preview: z.string().nullable(),
  /** Crewmate threads, rolled up onto their top-most parent's card. */
  children: z.array(
    z.object({
      threadId: z.string(),
      title: z.string(),
      status: z.string(),
      providerId: z.string(),
      /** The crewmate's own project, which is often not the parent's. */
      projectName: z.string(),
      hasPendingInteraction: z.boolean(),
      isArchived: z.boolean(),
    }),
  ),
});

const boardSchema = z.object({
  /** `null` is the all-projects view: columns merged across every board. */
  projectId: z.string().nullable(),
  columns: z.array(columnSchema),
  cards: z.array(cardSchema),
});

export const rpcContract = defineRpcContract({
  projects: {
    input: z.null(),
    output: z.object({
      projects: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  },
  board: {
    input: z.object({ projectId: z.string().nullable() }).strict(),
    output: boardSchema,
  },
  moveCard: {
    input: z
      .object({
        threadId: z.string().min(1),
        columnId: z.string().min(1),
        beforeThreadId: z.string().min(1).nullable().optional(),
      })
      .strict(),
    output: z.object({ ok: z.boolean() }),
  },
  removeCard: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  setNote: {
    input: z
      .object({ threadId: z.string().min(1), note: z.string().max(280) })
      .strict(),
    output: z.object({ ok: z.boolean() }),
  },
  addColumn: {
    input: z
      .object({ projectId: z.string().min(1), name: z.string().min(1).max(40) })
      .strict(),
    output: columnSchema,
  },
  renameColumn: {
    input: z
      .object({
        projectId: z.string().min(1),
        columnId: z.string().min(1),
        name: z.string().min(1).max(40),
      })
      .strict(),
    output: z.object({ ok: z.boolean() }),
  },
  deleteColumn: {
    input: z
      .object({ projectId: z.string().min(1), columnId: z.string().min(1) })
      .strict(),
    output: z.object({ ok: z.boolean() }),
  },
  createCardThread: {
    input: z
      .object({
        columnId: z.string().min(1),
        request: z.record(z.string(), z.unknown()),
      })
      .strict(),
    output: z.object({ threadId: z.string() }),
  },
});

type Board = z.infer<typeof boardSchema>;
type ColumnRow = {
  project_id: string;
  id: string;
  name: string;
  role: ColumnRole | null;
  position: number;
};
type CardRow = {
  thread_id: string;
  project_id: string;
  column_id: string | null;
  sort_key: number;
  note: string | null;
  moved_at: number;
};

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    autoAdvance: {
      type: "boolean",
      label: "Move cards automatically as threads run",
      default: true,
    },
    backfillDays: {
      type: "string",
      label: "Adopt existing threads newer than N days (0 disables)",
      default: "14",
    },
    doneVisibleDays: {
      type: "string",
      label: "Hide finished cards after N days (0 keeps them forever)",
      default: "7",
    },
    archiveOnDone: {
      type: "boolean",
      label:
        "Archive the thread when you drag its card to Done (in a managed " +
        "worktree, bb then deletes that worktree and its branch)",
      default: true,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS columns (
       project_id TEXT NOT NULL,
       id TEXT NOT NULL,
       name TEXT NOT NULL,
       role TEXT,
       position INTEGER NOT NULL,
       PRIMARY KEY (project_id, id)
     )`,
    `CREATE TABLE IF NOT EXISTS cards (
       thread_id TEXT PRIMARY KEY,
       project_id TEXT NOT NULL,
       column_id TEXT,
       sort_key REAL NOT NULL DEFAULT 0,
       note TEXT,
       moved_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS cards_by_project ON cards (project_id, column_id)`,
    `CREATE TABLE IF NOT EXISTS previews (
       thread_id TEXT PRIMARY KEY,
       thread_updated_at INTEGER NOT NULL,
       text TEXT
     )`,
  ]);

  // ---------------------------------------------------------------- columns

  function listColumns(projectId: string): ColumnRow[] {
    const rows = db
      .prepare(
        `SELECT project_id, id, name, role, position FROM columns
         WHERE project_id = ? ORDER BY position ASC`,
      )
      .all(projectId) as ColumnRow[];
    if (rows.length > 0) return rows;

    const insert = db.prepare(
      `INSERT OR IGNORE INTO columns (project_id, id, name, role, position)
       VALUES (?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      DEFAULT_COLUMNS.forEach((column, index) => {
        insert.run(projectId, column.id, column.name, column.role, index);
      });
    })();
    return listColumns(projectId);
  }

  /** Accepts a column id, its display name, or a semantic role. */
  function resolveColumn(projectId: string, ref: string): ColumnRow | null {
    const columns = listColumns(projectId);
    const needle = ref.trim().toLowerCase();
    return (
      columns.find((column) => column.id.toLowerCase() === needle) ??
      columns.find((column) => column.name.toLowerCase() === needle) ??
      columns.find((column) => column.role === needle) ??
      columns.find((column) => slug(column.name) === slug(needle)) ??
      null
    );
  }

  function columnByRole(projectId: string, role: ColumnRole): ColumnRow | null {
    return listColumns(projectId).find((column) => column.role === role) ?? null;
  }

  // ------------------------------------------------------------------ cards

  function getCard(threadId: string): CardRow | undefined {
    return db
      .prepare(`SELECT * FROM cards WHERE thread_id = ?`)
      .get(threadId) as CardRow | undefined;
  }

  function endSortKey(projectId: string, columnId: string): number {
    const row = db
      .prepare(
        `SELECT MAX(sort_key) AS max FROM cards
         WHERE project_id = ? AND column_id = ?`,
      )
      .get(projectId, columnId) as { max: number | null };
    return (row.max ?? 0) + SORT_STEP;
  }

  /** Sort key that lands the card directly above `beforeThreadId`. */
  function sortKeyBefore(
    projectId: string,
    columnId: string,
    beforeThreadId: string | null | undefined,
  ): number {
    if (!beforeThreadId) return endSortKey(projectId, columnId);
    const target = getCard(beforeThreadId);
    if (!target || target.column_id !== columnId) {
      return endSortKey(projectId, columnId);
    }
    const previous = db
      .prepare(
        `SELECT MAX(sort_key) AS max FROM cards
         WHERE project_id = ? AND column_id = ? AND sort_key < ?
           AND thread_id != ?`,
      )
      .get(projectId, columnId, target.sort_key, beforeThreadId) as {
      max: number | null;
    };
    const lower = previous.max ?? target.sort_key - 2 * SORT_STEP;
    return (lower + target.sort_key) / 2;
  }

  function writeCard(
    threadId: string,
    projectId: string,
    columnId: string | null,
    sortKey: number,
    movedAt: number = Date.now(),
  ) {
    db.prepare(
      `INSERT INTO cards (thread_id, project_id, column_id, sort_key, moved_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         project_id = excluded.project_id,
         column_id = excluded.column_id,
         sort_key = excluded.sort_key,
         moved_at = excluded.moved_at`,
    ).run(threadId, projectId, columnId, sortKey, movedAt);
  }

  /**
   * A crewmate has no card of its own; it is a row on its parent's. Moving one
   * would write a card row that the next board load deletes, so the tool says
   * so instead of pretending. Returns the owning card's title, or null.
   */
  async function rollsUpToParent(threadId: string): Promise<string | null> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.parentThreadId === null) return null;
    try {
      const parent = await bb.sdk.threads.get({
        threadId: thread.parentThreadId,
      });
      return parent.title ?? parent.titleFallback ?? "its parent thread";
    } catch {
      return "its parent thread";
    }
  }

  async function threadProjectId(threadId: string): Promise<string> {
    const thread = await bb.sdk.threads.get({ threadId });
    return thread.projectId;
  }

  /**
   * Done on the board means done in bb: the user dropping a card in a `done`
   * column archives the thread, and dragging it back out unarchives it. Both
   * directions are no-ops when the thread is already in the right state, which
   * is what keeps this from ping-ponging with the `thread.archived` handler.
   */
  async function syncArchiveState(
    threadId: string,
    previous: CardRow | undefined,
    column: ColumnRow,
  ) {
    const { archiveOnDone } = await settings.get();
    if (!archiveOnDone) return;

    const wasDone =
      previous?.column_id != null &&
      listColumns(previous.project_id).find(
        (entry) => entry.id === previous.column_id,
      )?.role === "done";
    const isDone = column.role === "done";
    // Done to Done still checks the thread: if an earlier archive failed,
    // dropping the card again is how the user retries it.
    if (!isDone && !wasDone) return;

    const thread = await bb.sdk.threads.get({ threadId });
    const isArchived = thread.archivedAt !== null;
    if (isDone && !isArchived) {
      await bb.sdk.threads.archive({ threadId });
    } else if (!isDone && isArchived) {
      await bb.sdk.threads.unarchive({ threadId });
    }
  }

  /**
   * The single move primitive behind the UI, the CLI, the agent tool and the
   * lifecycle automation.
   *
   * `actor` is the whole safety story. Done archives the thread, and archiving
   * the last thread of a managed worktree destroys that worktree and its
   * branch — so only the user's own gesture is allowed to put a card there.
   * An agent reporting its work finished lands in review, where the user can
   * see it and decide. `lifecycle` is bb telling us a thread was already
   * archived elsewhere; the card follows, and nothing is archived twice.
   */
  async function moveCard(args: {
    threadId: string;
    column: string;
    beforeThreadId?: string | null;
    note?: string;
    projectId?: string;
    actor: "user" | "agent" | "lifecycle";
  }): Promise<{ column: ColumnRow; projectId: string; redirected: boolean }> {
    const projectId = args.projectId ?? (await threadProjectId(args.threadId));
    const previous = getCard(args.threadId);
    const requested = resolveColumn(projectId, args.column);
    if (!requested) {
      const names = listColumns(projectId)
        .map((entry) => entry.name)
        .join(", ");
      throw new Error(
        `No column "${args.column}". Columns: ${names}. ` +
          `A role works too: todo, doing, review.`,
      );
    }
    const refused = args.actor === "agent" && requested.role === "done";
    const column = refused
      ? (columnByRole(projectId, "review") ?? requested)
      : requested;
    if (refused && column.id === requested.id) {
      throw new Error(
        `Only the user moves a card to "${requested.name}", because that ` +
          `archives the thread. This board has no review column to use ` +
          `instead. Leave the card where it is and say the work is done.`,
      );
    }
    // Archive first: if bb refuses, the card stays where it was instead of
    // sitting in Done beside a thread that is still open.
    if (args.actor === "user") {
      await syncArchiveState(args.threadId, previous, column);
    }
    writeCard(
      args.threadId,
      projectId,
      column.id,
      sortKeyBefore(projectId, column.id, args.beforeThreadId),
    );
    if (args.note !== undefined) {
      db.prepare(`UPDATE cards SET note = ? WHERE thread_id = ?`).run(
        args.note.trim() === "" ? null : args.note.trim(),
        args.threadId,
      );
    }
    publish(projectId);
    return { column, projectId, redirected: refused };
  }

  function publish(projectId: string) {
    bb.realtime.publish("board", { projectId });
  }

  // ------------------------------------------------------------ board query

  type LiveThread = {
    id: string;
    projectId: string;
    parentThreadId: string | null;
    title: string | null;
    titleFallback: string | null;
    providerId: string;
    status: string;
    archivedAt: number | null;
    lastReadAt: number | null;
    hasPendingInteraction?: boolean;
    environmentBranchName?: string | null;
    updatedAt: number;
    latestAttentionAt: number;
    createdAt: number;
    visibility: string;
  };

  async function listThreads(args: {
    projectId?: string;
    archived: boolean;
    limit: number;
  }): Promise<LiveThread[]> {
    const result = (await bb.sdk.threads.list({
      ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
      archived: args.archived,
      limit: args.limit,
      // Background workers are usually hidden; they are still crewmates of a
      // card, so they count toward its rollup even though they never get one.
      includeHidden: true,
    })) as unknown;
    const rows = Array.isArray(result)
      ? result
      : ((result as { threads?: unknown[] }).threads ?? []);
    return rows as LiveThread[];
  }

  /**
   * The line captured at the thread's current revision. `fresh` is separate
   * from the text because a thread with nothing to show stores null, and that
   * must not look unfetched, or every board load would fetch and republish it
   * again in a loop.
   */
  function cachedPreview(
    threadId: string,
    updatedAt: number,
  ): { fresh: boolean; text: string | null } {
    const row = db
      .prepare(`SELECT text, thread_updated_at FROM previews WHERE thread_id = ?`)
      .get(threadId) as
      | { text: string | null; thread_updated_at: number }
      | undefined;
    const fresh = row !== undefined && row.thread_updated_at >= updatedAt;
    return { fresh, text: fresh ? row.text : null };
  }

  function storePreview(threadId: string, updatedAt: number, text: string | null) {
    db.prepare(
      `INSERT INTO previews (thread_id, thread_updated_at, text)
       VALUES (?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         thread_updated_at = excluded.thread_updated_at,
         text = excluded.text`,
    ).run(threadId, updatedAt, condense(text));
  }

  /**
   * Fetched after the board has already been served, then republished, so a
   * first load is never blocked on N transcript reads. Cached per thread
   * revision, so a board that has not changed costs nothing.
   */
  let previewsInFlight = false;
  async function refreshPreviews(
    projectId: string,
    stale: { threadId: string; updatedAt: number }[],
  ) {
    if (previewsInFlight || stale.length === 0) return;
    previewsInFlight = true;
    try {
      for (const entry of stale.slice(0, 25)) {
        try {
          const { output } = await bb.sdk.threads.output({
            threadId: entry.threadId,
          });
          storePreview(entry.threadId, entry.updatedAt, output);
        } catch {
          // A thread that cannot be read simply has no preview line.
          storePreview(entry.threadId, entry.updatedAt, null);
        }
      }
      publish(projectId);
    } finally {
      previewsInFlight = false;
    }
  }

  /**
   * Every project's threads at once. A crewmate is usually spawned into its
   * own project, so an ancestry walk that only sees one project's threads
   * loses the parent link and hands the crewmate a card of its own. Fetched
   * once per board request and passed down, so the all-projects view does not
   * refetch it per board.
   */
  async function threadUniverse(): Promise<Map<string, LiveThread>> {
    const [live, archived] = await Promise.all([
      listThreads({ archived: false, limit: 500 }),
      listThreads({ archived: true, limit: 300 }),
    ]);
    const all = new Map<string, LiveThread>();
    for (const thread of [...live, ...archived]) all.set(thread.id, thread);
    return all;
  }

  async function loadBoard(
    projectId: string,
    projectName: string,
    projectNames: Map<string, string>,
    all: Map<string, LiveThread>,
  ): Promise<Board> {
    const columns = listColumns(projectId);

    // A crewmate is not its own piece of work: roll every descendant up onto
    // the top-most ancestor that owns a card, so the board shows the task and
    // not the machinery under it. The ancestor owns the card even when the
    // crewmate lives in another project.
    const childrenOf = new Map<string, LiveThread[]>();
    const threads = new Map<string, LiveThread>();
    for (const thread of all.values()) {
      const root = rootThreadId(thread, all);
      if (root !== thread.id) {
        const siblings = childrenOf.get(root) ?? [];
        siblings.push(thread);
        childrenOf.set(root, siblings);
        continue;
      }
      if (thread.projectId !== projectId) continue;
      if (thread.visibility === "hidden") continue;
      threads.set(thread.id, thread);
    }

    // Children adopted before the rollup existed still have their own row.
    const orphans = [...childrenOf.values()]
      .flat()
      .map((child) => child.id)
      .filter((id) => getCard(id));
    if (orphans.length > 0) {
      db.prepare(
        `DELETE FROM cards WHERE thread_id IN (${orphans.map(() => "?").join(",")})`,
      ).run(...orphans);
    }

    await adoptExistingThreads(projectId, columns, threads);

    const rows = db
      .prepare(
        `SELECT * FROM cards WHERE project_id = ? AND column_id IS NOT NULL`,
      )
      .all(projectId) as CardRow[];

    const knownColumns = new Set(columns.map((column) => column.id));
    // Finished work stays visible for a while, then drops off the board. The
    // row survives, so an aged-off card is never re-adopted, and the thread
    // itself is untouched.
    const doneColumns = new Set(
      columns.filter((column) => column.role === "done").map((c) => c.id),
    );
    const doneCutoff = await doneCutoffMs();
    const cards: Board["cards"] = [];
    for (const row of rows) {
      const thread = threads.get(row.thread_id);
      if (!thread) continue; // deleted or out of range; leave the row alone
      if (
        doneCutoff !== null &&
        row.column_id !== null &&
        doneColumns.has(row.column_id) &&
        row.moved_at < doneCutoff
      ) {
        continue;
      }
      cards.push({
        threadId: row.thread_id,
        projectId,
        projectName,
        columnId: knownColumns.has(row.column_id!)
          ? row.column_id!
          : columns[0]!.id,
        sortKey: row.sort_key,
        note: row.note,
        title: thread.title ?? thread.titleFallback ?? "Untitled thread",
        status: thread.status,
        providerId: thread.providerId,
        branchName: thread.environmentBranchName ?? null,
        isArchived: thread.archivedAt !== null,
        isUnread:
          thread.lastReadAt === null ||
          thread.latestAttentionAt > thread.lastReadAt,
        hasPendingInteraction: thread.hasPendingInteraction === true,
        preview: cachedPreview(row.thread_id, thread.updatedAt).text,
        childNeedsAttention: (childrenOf.get(row.thread_id) ?? []).some(
          (child) => child.hasPendingInteraction === true,
        ),
        children: (childrenOf.get(row.thread_id) ?? [])
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 20)
          .map((child) => ({
            threadId: child.id,
            title: child.title ?? child.titleFallback ?? "Child thread",
            status: child.status,
            providerId: child.providerId,
            projectName: projectNames.get(child.projectId) ?? projectName,
            hasPendingInteraction: child.hasPendingInteraction === true,
            isArchived: child.archivedAt !== null,
          })),
        updatedAt: thread.updatedAt,
        movedAt: row.moved_at,
      });
    }
    cards.sort((a, b) => a.sortKey - b.sortKey);

    void refreshPreviews(
      projectId,
      cards
        .filter(
          (card) =>
            !card.isArchived &&
            !cachedPreview(card.threadId, card.updatedAt).fresh,
        )
        .map((card) => ({
          threadId: card.threadId,
          updatedAt: card.updatedAt,
        })),
    );

    return {
      projectId,
      columns: columns.map((column) => ({
        id: column.id,
        name: column.name,
        role: column.role,
        position: column.position,
      })),
      cards,
    };
  }

  /**
   * A brand-new board should not be empty: adopt recent threads once, placing
   * them by their current state. Cards the user removed stay removed because
   * their row survives with a NULL column.
   */
  async function adoptExistingThreads(
    projectId: string,
    columns: ColumnRow[],
    threads: Map<string, LiveThread>,
  ) {
    const { backfillDays } = await settings.get();
    const days = Number.parseInt(backfillDays, 10);
    if (!Number.isFinite(days) || days <= 0) return;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const known = new Set(
      (
        db
          .prepare(`SELECT thread_id FROM cards WHERE project_id = ?`)
          .all(projectId) as { thread_id: string }[]
      ).map((row) => row.thread_id),
    );

    const todo = columnByRole(projectId, "todo") ?? columns[0]!;
    const doing = columnByRole(projectId, "doing") ?? todo;
    const done = columnByRole(projectId, "done") ?? columns[columns.length - 1]!;

    for (const thread of threads.values()) {
      if (known.has(thread.id)) continue;
      if (thread.updatedAt < cutoff) continue;
      const column =
        thread.archivedAt !== null
          ? done
          : thread.status === "active"
            ? doing
            : todo;
      writeCard(
        thread.id,
        projectId,
        column.id,
        endSortKey(projectId, column.id),
        // Age an adopted card from when its thread last moved, not from now,
        // so a fresh install does not resurrect a month of finished work.
        thread.updatedAt,
      );
    }
  }

  async function listProjects(): Promise<{ id: string; name: string }[]> {
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    return projects.map((project) => ({ id: project.id, name: project.name }));
  }

  /**
   * The default view. Every project's board is loaded and their columns are
   * merged by key — semantic role first, slugged name for custom columns — so
   * one "Needs review" column holds cards from every project. The merged id
   * round-trips through `resolveColumn`, which matches a role or a name inside
   * whichever project the dragged card actually belongs to.
   */
  async function loadAllProjects(): Promise<Board> {
    const [projects, all] = await Promise.all([
      listProjects(),
      threadUniverse(),
    ]);
    const names = projectNameMap(projects);
    const boards = await Promise.all(
      projects.map((project) =>
        loadBoard(project.id, project.name, names, all),
      ),
    );
    return mergeBoards(boards);
  }

  async function loadProjectBoard(projectId: string): Promise<Board> {
    const [projects, all] = await Promise.all([
      listProjects(),
      threadUniverse(),
    ]);
    const project = projects.find((entry) => entry.id === projectId);
    return loadBoard(
      projectId,
      project?.name ?? "Project",
      projectNameMap(projects),
      all,
    );
  }

  /** Cards finished before this instant are hidden; null keeps them forever. */
  async function doneCutoffMs(): Promise<number | null> {
    const { doneVisibleDays } = await settings.get();
    const days = Number.parseInt(doneVisibleDays, 10);
    if (!Number.isFinite(days) || days <= 0) return null;
    return Date.now() - days * 24 * 60 * 60 * 1000;
  }

  /** A CLI failure as one line that says what to try next. */
  function cliError(error: unknown, threadId: string | undefined): string {
    const message = error instanceof Error ? error.message : String(error);
    if (/thread not found/i.test(message)) {
      return `No thread ${threadId}. bb thread list shows ids.`;
    }
    return message;
  }

  // -------------------------------------------------------------------- rpc

  bb.rpc.register(rpcContract, {
    async projects() {
      return { projects: await listProjects() };
    },
    async board({ projectId }) {
      return projectId === null
        ? loadAllProjects()
        : loadProjectBoard(projectId);
    },
    async moveCard({ threadId, columnId, beforeThreadId }) {
      // The board panel is the user's own hand.
      await moveCard({
        threadId,
        column: columnId,
        beforeThreadId,
        actor: "user",
      });
      return { ok: true };
    },
    async removeCard({ threadId }) {
      const card = getCard(threadId);
      if (!card) return { ok: false };
      db.prepare(`UPDATE cards SET column_id = NULL WHERE thread_id = ?`).run(
        threadId,
      );
      publish(card.project_id);
      return { ok: true };
    },
    async setNote({ threadId, note }) {
      const card = getCard(threadId);
      if (!card) return { ok: false };
      db.prepare(`UPDATE cards SET note = ? WHERE thread_id = ?`).run(
        note.trim() === "" ? null : note.trim(),
        threadId,
      );
      publish(card.project_id);
      return { ok: true };
    },
    async addColumn({ projectId, name }) {
      const columns = listColumns(projectId);
      const id = uniqueColumnId(columns, name);
      const position = columns.length;
      db.prepare(
        `INSERT INTO columns (project_id, id, name, role, position)
         VALUES (?, ?, ?, NULL, ?)`,
      ).run(projectId, id, name.trim(), position);
      publish(projectId);
      return { id, name: name.trim(), role: null, position };
    },
    async renameColumn({ projectId, columnId, name }) {
      db.prepare(
        `UPDATE columns SET name = ? WHERE project_id = ? AND id = ?`,
      ).run(name.trim(), projectId, columnId);
      publish(projectId);
      return { ok: true };
    },
    async deleteColumn({ projectId, columnId }) {
      const columns = listColumns(projectId);
      if (columns.length <= 1) throw new Error("Keep at least one column.");
      const fallback = columns.find((column) => column.id !== columnId)!;
      db.transaction(() => {
        db.prepare(
          `UPDATE cards SET column_id = ? WHERE project_id = ? AND column_id = ?`,
        ).run(fallback.id, projectId, columnId);
        db.prepare(`DELETE FROM columns WHERE project_id = ? AND id = ?`).run(
          projectId,
          columnId,
        );
      })();
      publish(projectId);
      return { ok: true };
    },
    async createCardThread({ columnId, request }) {
      const thread = await bb.sdk.threads.spawn(
        request as unknown as Parameters<typeof bb.sdk.threads.spawn>[0],
      );
      // The thread exists now, so never fail from here: a merged column the
      // chosen project lacks puts the card in that project's first column.
      const column =
        resolveColumn(thread.projectId, columnId) ??
        listColumns(thread.projectId)[0]!;
      await moveCard({
        threadId: thread.id,
        column: column.id,
        projectId: thread.projectId,
        actor: "user",
      });
      return { threadId: thread.id };
    },
  });

  // ------------------------------------------------------- lifecycle events

  /** Only ever advances a card forward, and never overrides a manual move. */
  async function autoMove(
    threadId: string,
    projectId: string,
    from: ColumnRole[],
    to: ColumnRole,
    actor: "agent" | "lifecycle" = "agent",
  ) {
    const { autoAdvance } = await settings.get();
    if (!autoAdvance) return;
    const card = getCard(threadId);
    const columns = listColumns(projectId);
    const current = columns.find((column) => column.id === card?.column_id);
    if (card && card.column_id === null) return; // removed from the board
    if (card && current && !from.includes(current.role as ColumnRole)) return;
    const target = columnByRole(projectId, to);
    if (!target || (current && current.id === target.id)) return;
    await moveCard({ threadId, column: target.id, projectId, actor });
  }

  bb.events.on("thread.created", ({ thread }) => {
    if (thread.visibility === "hidden") return;
    // Crewmates roll up onto their parent's card instead of getting one.
    if (thread.parentThreadId !== null) return;
    const columns = listColumns(thread.projectId);
    const target = columnByRole(thread.projectId, "todo") ?? columns[0]!;
    if (getCard(thread.id)) return;
    writeCard(
      thread.id,
      thread.projectId,
      target.id,
      endSortKey(thread.projectId, target.id),
    );
    publish(thread.projectId);
  });

  bb.events.on("thread.active", ({ thread }) => {
    void autoMove(thread.id, thread.projectId, ["todo", "review"], "doing").catch(
      (error) => bb.log.warn(`auto-move failed: ${String(error)}`),
    );
  });

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    if (lastAssistantText !== null) {
      // Free: no transcript read needed for the line the board wants.
      storePreview(thread.id, thread.updatedAt, lastAssistantText);
    }
    void autoMove(thread.id, thread.projectId, ["doing"], "review").catch(
      (error) => bb.log.warn(`auto-move failed: ${String(error)}`),
    );
  });

  bb.events.on("thread.failed", ({ thread }) => {
    void autoMove(thread.id, thread.projectId, ["doing"], "review").catch(
      (error) => bb.log.warn(`auto-move failed: ${String(error)}`),
    );
  });

  // The thread was archived somewhere else in bb; the card is only catching up.
  bb.events.on("thread.archived", ({ thread }) => {
    void autoMove(
      thread.id,
      thread.projectId,
      ["todo", "doing", "review"],
      "done",
      "lifecycle",
    ).catch((error) => bb.log.warn(`auto-move failed: ${String(error)}`));
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    db.prepare(`DELETE FROM cards WHERE thread_id = ?`).run(thread.id);
    publish(thread.projectId);
  });

  // ------------------------------------------------------------ agent tools

  bb.agents.registerTool({
    name: "kanban_move_card",
    description:
      "Move this thread's card to a kanban column and optionally set the " +
      "one-line note shown on the card. Call it when the work changes state. " +
      "Only the user marks a card done, so asking for a done column lands the " +
      "card in review instead.",
    instructions:
      "Keep the kanban board honest: move your card with kanban_move_card " +
      "when you start work, when you need review, and when you finish. " +
      "Finishing means review, not done. Done is the user's call, and it " +
      "archives the thread.",
    presentation: {
      label: {
        pending: "Updating the kanban board",
        completed: "Updated the kanban board",
      },
    },
    parameters: z.object({
      column: z
        .string()
        .describe("Column id, name or role (todo, doing, review, done)"),
      note: z
        .string()
        .max(280)
        .optional()
        .describe("Short status line shown on the card"),
      threadId: z
        .string()
        .optional()
        .describe("Defaults to the calling thread"),
    }),
    async execute({ column, note, threadId }, context) {
      const target = threadId ?? context.threadId;
      if (!target) return { content: [{ type: "text", text: "No thread to move. Pass threadId, the thr_ id of the card's thread." }], isError: true };
      const rolledUp = await rollsUpToParent(target);
      if (rolledUp !== null) {
        return (
          `No card to move: you are a child thread, and your thread shows as a ` +
          `row on ${rolledUp}'s card. Report to whoever spawned you instead.`
        );
      }
      const moved = await moveCard({
        threadId: target,
        column,
        note,
        actor: "agent",
      });
      return moved.redirected
        ? `Moved to "${moved.column.name}". Only the user marks a card done, ` +
            `because that archives the thread. Say the work is finished and ` +
            `let them close it.`
        : `Moved to "${moved.column.name}".`;
    },
  });

  bb.agents.registerTool({
    name: "kanban_board",
    description:
      "Read the kanban board: columns and their cards. Defaults to this " +
      "thread's project; pass allProjects to see every project at once.",
    parameters: z.object({
      projectId: z
        .string()
        .optional()
        .describe("Defaults to this thread's project"),
      allProjects: z
        .boolean()
        .optional()
        .describe("Merge every project's board into one view"),
    }),
    async execute({ projectId, allProjects }, context) {
      if (allProjects) return renderBoard(await loadAllProjects());
      const target =
        projectId ??
        context.projectId ??
        (context.threadId ? await threadProjectId(context.threadId) : null);
      if (!target) return renderBoard(await loadAllProjects());
      return renderBoard(await loadProjectBoard(target));
    },
  });

  // -------------------------------------------------------------------- cli

  bb.cli.register({
    name: "kanban",
    summary: "Kanban board where every card is a thread",
    commands: [
      {
        name: "board",
        summary: "Print the board",
        usage: "bb kanban board [--project <proj_id>] [--all]",
      },
      {
        name: "move",
        summary: "Move a card to a column",
        usage: "bb kanban move <column> [--thread <thr_id>] [--note <text>]",
      },
      {
        name: "note",
        summary: "Set the note shown on a card",
        usage: "bb kanban note <text> [--thread <thr_id>]",
      },
      {
        name: "columns",
        summary: "List the columns of a project",
        usage: "bb kanban columns [--project <proj_id>]",
      },
    ],
    async run(argv, ctx) {
      const flags = parseFlags(argv);
      const command = flags.positional[0] ?? "board";
      const threadId = flags.options.thread ?? ctx.threadId;
      const noThread = {
        exitCode: 1,
        stderr:
          "No thread in scope. Run this inside a bb thread, or pass " +
          "--thread <thr_id> (bb thread list shows ids).\n",
      };

      for (const [name, example] of [
        ["project", "proj_id"],
        ["thread", "thr_id"],
      ]) {
        if (flags.options[name!] === "") {
          return {
            exitCode: 1,
            stderr: `--${name} needs a value, like --${name} <${example}>.\n`,
          };
        }
      }

      try {
        if (command === "board" && "all" in flags.options) {
          return {
            exitCode: 0,
            stdout: `${renderBoard(await loadAllProjects())}\n`,
          };
        }
        if (command === "board" || command === "columns") {
          const projectId =
            flags.options.project ??
            (threadId ? await threadProjectId(threadId) : null);
          // Outside a thread, the board means what the panel shows first:
          // every project at once.
          if (command === "board" && !projectId) {
            return {
              exitCode: 0,
              stdout: `${renderBoard(await loadAllProjects())}\n`,
            };
          }
          if (!projectId) {
            return {
              exitCode: 1,
              stderr:
                "No project in scope. Pass --project <proj_id> " +
                "(bb project list shows ids).\n",
            };
          }
          if (!(await listProjects()).some((entry) => entry.id === projectId)) {
            return {
              exitCode: 1,
              stderr: `No project ${projectId}. bb project list shows ids.\n`,
            };
          }
          if (command === "columns") {
            const text = listColumns(projectId)
              .map(
                (column) =>
                  `${column.id}\t${column.name}${column.role ? `\t(${column.role})` : ""}`,
              )
              .join("\n");
            return { exitCode: 0, stdout: `${text}\n` };
          }
          return {
            exitCode: 0,
            stdout: `${renderBoard(await loadProjectBoard(projectId))}\n`,
          };
        }

        if (command === "move") {
          const column = flags.positional[1];
          if (!column) {
            return {
              exitCode: 1,
              stderr:
                "Usage: bb kanban move <column> [--thread <thr_id>] [--note <text>]\n" +
                "<column> is a column name, id, or role: todo, doing, review.\n",
            };
          }
          if (!threadId) return noThread;
          const rolledUp = await rollsUpToParent(threadId);
          if (rolledUp !== null) {
            return {
              exitCode: 1,
              stderr:
                `No card to move: ${threadId} is a child thread, shown as a row ` +
                `on ${rolledUp}'s card. Move the parent's card instead.\n`,
            };
          }
          const moved = await moveCard({
            threadId,
            column,
            note: flags.options.note,
            actor: "agent",
          });
          return {
            exitCode: 0,
            stdout: moved.redirected
              ? `Only the user marks work done. Moved ${threadId} to ` +
                `"${moved.column.name}" instead.\n`
              : `Moved ${threadId} to "${moved.column.name}".\n`,
          };
        }

        if (command === "note") {
          const note = flags.positional.slice(1).join(" ");
          if (!threadId) return noThread;
          const rolledUp = await rollsUpToParent(threadId);
          if (rolledUp !== null) {
            return {
              exitCode: 1,
              stderr:
                `${threadId} is a child thread, shown as a row on ` +
                `${rolledUp}'s card, so it has no note of its own.\n`,
            };
          }
          const card = getCard(threadId);
          if (!card || card.column_id === null) {
            return {
              exitCode: 1,
              stderr:
                `${threadId} is not on the board. Put it there first: ` +
                `bb kanban move <column> --thread ${threadId}\n`,
            };
          }
          db.prepare(`UPDATE cards SET note = ? WHERE thread_id = ?`).run(
            note.trim() === "" ? null : note.trim(),
            threadId,
          );
          publish(card.project_id);
          return { exitCode: 0, stdout: "Note updated.\n" };
        }

        return {
          exitCode: 1,
          stderr: `Unknown command "${command}". Try: board, move, note, columns.\n`,
        };
      } catch (error) {
        return { exitCode: 1, stderr: `${cliError(error, threadId)}\n` };
      }
    },
  });

  bb.onDispose(() => bb.log.info("kanban unloaded"));
}

// ------------------------------------------------------------------ helpers

/** Card children carry their own project's name, which is rarely the parent's. */
function projectNameMap(
  projects: { id: string; name: string }[],
): Map<string, string> {
  return new Map(projects.map((project) => [project.id, project.name]));
}

/** Walks up to the ancestor that owns the card; tolerates a broken chain. */
function rootThreadId(
  thread: { id: string; parentThreadId: string | null },
  all: Map<string, { id: string; parentThreadId: string | null }>,
): string {
  const seen = new Set<string>([thread.id]);
  let current = thread;
  while (current.parentThreadId !== null) {
    const parent = all.get(current.parentThreadId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    current = parent;
  }
  return current.id;
}

/** One readable line: no newlines, no markdown fences, bounded length. */
function condense(text: string | null): string | null {
  if (text === null) return null;
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (flat === "") return null;
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueColumnId(
  columns: { id: string }[],
  name: string,
): string {
  const base = slug(name) || "column";
  const taken = new Set(columns.map((column) => column.id));
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

/** Role first so equivalent columns merge even when projects renamed them. */
function columnKey(column: Board["columns"][number]): string {
  return column.role ?? slug(column.name);
}

function mergeBoards(boards: Board[]): Board {
  const columns = new Map<
    string,
    { column: Board["columns"][number]; rank: number; seen: number }
  >();
  for (const board of boards) {
    for (const column of board.columns) {
      const key = columnKey(column);
      const existing = columns.get(key);
      if (existing) {
        existing.rank = Math.min(existing.rank, column.position);
        continue;
      }
      columns.set(key, {
        column: { ...column, id: key },
        rank: column.position,
        seen: columns.size,
      });
    }
  }

  const merged = [...columns.values()]
    .sort((a, b) => a.rank - b.rank || a.seen - b.seen)
    .map((entry, index) => ({ ...entry.column, position: index }));

  const cards = boards.flatMap((board) => {
    const keys = new Map(
      board.columns.map((column) => [column.id, columnKey(column)]),
    );
    return board.cards.map((card) => ({
      ...card,
      columnId: keys.get(card.columnId) ?? merged[0]?.id ?? card.columnId,
    }));
  });
  cards.sort((a, b) => a.sortKey - b.sortKey || a.movedAt - b.movedAt);

  return { projectId: null, columns: merged, cards };
}

function renderBoard(board: Board): string {
  if (board.columns.length === 0) return "No board yet.";
  return board.columns
    .map((column) => {
      const cards = board.cards.filter((card) => card.columnId === column.id);
      const lines = cards.map(
        (card) =>
          `  - ${card.threadId}  ${card.title}` +
          `${board.projectId === null ? ` [${card.projectName}]` : ""}` +
          `${card.note ? `: ${card.note}` : ""}` +
          `${
            card.children.length > 0
              ? ` (${card.children.length} child thread${card.children.length === 1 ? "" : "s"})`
              : ""
          }` +
          `${card.isArchived ? " [archived]" : ""}` +
          `${card.status === "active" ? " [running]" : ""}`,
      );
      return [
        `${column.name} (${cards.length})`,
        ...(lines.length > 0 ? lines : ["  (empty)"]),
      ].join("\n");
    })
    .join("\n\n");
}

const BOOLEAN_FLAGS = new Set(["all"]);

function parseFlags(argv: string[]): {
  positional: string[];
  options: Record<string, string>;
} {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token.startsWith("--")) {
      const [name, inline] = token.slice(2).split(/=(.*)/s);
      const next = argv[index + 1];
      if (inline !== undefined) {
        options[name!] = inline;
      } else if (
        BOOLEAN_FLAGS.has(name!) ||
        next === undefined ||
        next.startsWith("--")
      ) {
        options[name!] = "";
      } else {
        options[name!] = next;
        index += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, options };
}
