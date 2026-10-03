import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const PROJECT = "proj_1";
/** Threads whose next archive call fails once. */
const archiveFailures = new Set<string>();

function thread(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectId: PROJECT,
    title: `Thread ${id}`,
    titleFallback: null,
    providerId: "claude-code",
    parentThreadId: null as string | null,
    status: "idle",
    archivedAt: null as number | null,
    lastReadAt: 1,
    latestAttentionAt: 1,
    hasPendingInteraction: false,
    environmentBranchName: null,
    updatedAt: Date.now(),
    createdAt: Date.now(),
    visibility: "visible",
    ...overrides,
  };
}

async function setup(
  threads: ReturnType<typeof thread>[] = [],
  projects: { id: string; name: string }[] = [{ id: PROJECT, name: "Demo" }],
) {
  const host = createFakePluginHost({
    pluginId: "kanban",
    sdk: {
      projects: { list: async () => projects },
      threads: {
        list: async (args?: { archived?: boolean; projectId?: string }) =>
          threads.filter(
            (entry) =>
              (args?.archived
                ? entry.archivedAt !== null
                : entry.archivedAt === null) &&
              (!args?.projectId || entry.projectId === args.projectId),
          ),
        get: async ({ threadId }: { threadId: string }) =>
          threads.find((entry) => entry.id === threadId) ?? thread(threadId),
        spawn: async () => thread("thr_new"),
        output: async ({ threadId }: { threadId: string }) => ({
          output: threadId.startsWith("thr_quiet")
            ? ""
            : `last word from ${threadId}`,
        }),
        archive: async ({ threadId }: { threadId: string }) => {
          if (archiveFailures.delete(threadId)) throw new Error("bb said no");
          const entry = threads.find((row) => row.id === threadId);
          if (entry) entry.archivedAt = Date.now();
          return {};
        },
        unarchive: async ({ threadId }: { threadId: string }) => {
          const entry = threads.find((row) => row.id === threadId);
          if (entry) entry.archivedAt = null;
          return {};
        },
      },
    },
  });
  await plugin(host.bb);
  return host;
}

describe("board", () => {
  it("seeds the default columns and adopts recent threads by state", async () => {
    const { harness } = await setup([
      thread("thr_a"),
      thread("thr_b", { status: "active" }),
    ]);

    const board = (await harness.behavior.callRpc("board", {
      projectId: PROJECT,
    })) as { columns: { id: string }[]; cards: { threadId: string; columnId: string }[] };

    expect(board.columns.map((column) => column.id)).toEqual([
      "backlog",
      "in-progress",
      "review",
      "done",
    ]);
    expect(
      Object.fromEntries(
        board.cards.map((card) => [card.threadId, card.columnId]),
      ),
    ).toEqual({ thr_a: "backlog", thr_b: "in-progress" });
  });

  it("merges every project into one board by default", async () => {
    const { harness } = await setup(
      [
        thread("thr_a"),
        thread("thr_b", { projectId: "proj_2", status: "active" }),
      ],
      [
        { id: PROJECT, name: "Demo" },
        { id: "proj_2", name: "Other" },
      ],
    );

    const board = (await harness.behavior.callRpc("board", {
      projectId: null,
    })) as {
      projectId: string | null;
      columns: { id: string }[];
      cards: { threadId: string; columnId: string; projectName: string }[];
    };

    expect(board.projectId).toBeNull();
    // One column per role, not one per project.
    expect(board.columns.map((column) => column.id)).toEqual([
      "todo",
      "doing",
      "review",
      "done",
    ]);
    expect(
      board.cards.map((card) => [card.threadId, card.columnId, card.projectName]),
    ).toEqual([
      ["thr_a", "todo", "Demo"],
      ["thr_b", "doing", "Other"],
    ]);
  });

  it("merges a custom column with the same name across projects", async () => {
    const { harness } = await setup(
      [thread("thr_a"), thread("thr_b", { projectId: "proj_2" })],
      [
        { id: PROJECT, name: "Demo" },
        { id: "proj_2", name: "Other" },
      ],
    );
    await harness.behavior.callRpc("board", { projectId: null });
    for (const project of [PROJECT, "proj_2"]) {
      await harness.behavior.callRpc("addColumn", {
        projectId: project,
        name: "Waiting on CI",
      });
    }
    await harness.behavior.callRpc("moveCard", {
      threadId: "thr_a",
      columnId: "waiting-on-ci",
    });
    await harness.behavior.callRpc("moveCard", {
      threadId: "thr_b",
      columnId: "waiting-on-ci",
    });

    const board = (await harness.behavior.callRpc("board", {
      projectId: null,
    })) as { columns: { id: string }[]; cards: { columnId: string }[] };
    expect(
      board.columns.filter((column) => column.id === "waiting-on-ci"),
    ).toHaveLength(1);
    expect(board.cards.every((card) => card.columnId === "waiting-on-ci")).toBe(
      true,
    );
  });

  it("moves a card dropped in the merged view inside its own project", async () => {
    const { harness } = await setup(
      [thread("thr_b", { projectId: "proj_2" })],
      [
        { id: PROJECT, name: "Demo" },
        { id: "proj_2", name: "Other" },
      ],
    );
    await harness.behavior.callRpc("board", { projectId: null });
    // "review" is the merged column key, resolved per project by role.
    await harness.behavior.callRpc("moveCard", {
      threadId: "thr_b",
      columnId: "review",
    });

    const scoped = (await harness.behavior.callRpc("board", {
      projectId: "proj_2",
    })) as { cards: { threadId: string; columnId: string }[] };
    expect(scoped.cards[0]!.columnId).toBe("review");
  });

  it("does not re-adopt a card the user removed", async () => {
    const { harness } = await setup([thread("thr_a")]);
    await harness.behavior.callRpc("board", { projectId: PROJECT });
    await harness.behavior.callRpc("removeCard", { threadId: "thr_a" });

    const board = (await harness.behavior.callRpc("board", {
      projectId: PROJECT,
    })) as { cards: unknown[] };
    expect(board.cards).toEqual([]);
  });
});

describe("moving cards", () => {
  it("moves by column id, display name or semantic role", async () => {
    const { harness } = await setup([thread("thr_a")]);
    await harness.behavior.callRpc("board", { projectId: PROJECT });

    for (const [ref, expected] of [
      ["done", "done"],
      ["Needs review", "review"],
      ["doing", "in-progress"],
    ] as const) {
      await harness.behavior.callRpc("moveCard", {
        threadId: "thr_a",
        columnId: ref,
      });
      const board = (await harness.behavior.callRpc("board", {
        projectId: PROJECT,
      })) as { cards: { columnId: string }[] };
      expect(board.cards[0]!.columnId).toBe(expected);
    }
  });

  it("orders a card above the one it was dropped on", async () => {
    const { harness } = await setup([
      thread("thr_a"),
      thread("thr_b"),
      thread("thr_c"),
    ]);
    await harness.behavior.callRpc("board", { projectId: PROJECT });
    await harness.behavior.callRpc("moveCard", {
      threadId: "thr_c",
      columnId: "backlog",
      beforeThreadId: "thr_a",
    });

    const board = (await harness.behavior.callRpc("board", {
      projectId: PROJECT,
    })) as { cards: { threadId: string }[] };
    expect(board.cards.map((card) => card.threadId)).toEqual([
      "thr_c",
      "thr_a",
      "thr_b",
    ]);
  });

  it("rejects an unknown column with the available names", async () => {
    const { harness } = await setup([thread("thr_a")]);
    await expect(
      harness.behavior.callRpc("moveCard", {
        threadId: "thr_a",
        columnId: "nope",
      }),
    ).rejects.toThrow(/Backlog, In progress, Needs review, Done/);
  });
});

describe("columns", () => {
  it("adds, renames and deletes, relocating the orphaned cards", async () => {
    const { harness } = await setup([thread("thr_a")]);
    await harness.behavior.callRpc("board", { projectId: PROJECT });

    const added = (await harness.behavior.callRpc("addColumn", {
      projectId: PROJECT,
      name: "Waiting on CI",
    })) as { id: string };
    expect(added.id).toBe("waiting-on-ci");

    await harness.behavior.callRpc("moveCard", {
      threadId: "thr_a",
      columnId: added.id,
    });
    await harness.behavior.callRpc("renameColumn", {
      projectId: PROJECT,
      columnId: "backlog",
      name: "Inbox",
    });
    await harness.behavior.callRpc("deleteColumn", {
      projectId: PROJECT,
      columnId: added.id,
    });

    const board = (await harness.behavior.callRpc("board", {
      projectId: PROJECT,
    })) as { columns: { id: string; name: string }[]; cards: { columnId: string }[] };
    expect(board.columns.map((column) => column.id)).not.toContain(added.id);
    expect(board.columns[0]!.name).toBe("Inbox");
    expect(board.cards[0]!.columnId).toBe("backlog");
  });
});

describe("lifecycle automation", () => {
  it("advances a running thread and parks an idle one in review", async () => {
    const rows = [thread("thr_a")];
    const { harness } = await setup(rows);
    await harness.behavior.callRpc("board", { projectId: PROJECT });

    await harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thr_a", projectId: PROJECT }),
    });
    await settle();
    expect(await columnOf(harness, "thr_a")).toBe("in-progress");

    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_a", projectId: PROJECT }),
      lastAssistantText: "done",
    });
    await settle();
    expect(await columnOf(harness, "thr_a")).toBe("review");
  });

  it("leaves a manually placed card alone", async () => {
    const { harness } = await setup([thread("thr_a")]);
    await harness.behavior.callRpc("board", { projectId: PROJECT });
    await harness.behavior.callRpc("moveCard", {
      threadId: "thr_a",
      columnId: "done",
    });

    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_a", projectId: PROJECT }),
      lastAssistantText: "done",
    });
    await settle();
    expect(await columnOf(harness, "thr_a")).toBe("done");
  });
});

describe("cli", () => {
  it("prints the board and moves the calling thread", async () => {
    const { harness } = await setup([thread("thr_a")]);
    await harness.behavior.callRpc("board", { projectId: PROJECT });

    const moved = await harness.behavior.runCli(
      ["move", "review", "--note", "waiting on you"],
      { threadId: "thr_a" },
    );
    expect(moved.exitCode).toBe(0);

    const printed = await harness.behavior.runCli(["board"], {
      threadId: "thr_a",
    });
    expect(printed.stdout).toContain("Needs review (1)");
    expect(printed.stdout).toContain("waiting on you");
  });

  it("prints every project with --all", async () => {
    const { harness } = await setup(
      [thread("thr_a"), thread("thr_b", { projectId: "proj_2" })],
      [
        { id: PROJECT, name: "Demo" },
        { id: "proj_2", name: "Other" },
      ],
    );
    const printed = await harness.behavior.runCli(["board", "--all"], {});
    expect(printed.stdout).toContain("[Demo]");
    expect(printed.stdout).toContain("[Other]");
  });

  it("reports an unusable column on stderr", async () => {
    const { harness } = await setup([thread("thr_a")]);
    const result = await harness.behavior.runCli(["move", "nope"], {
      threadId: "thr_a",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No column");
  });

  it("prints every project when run outside a thread", async () => {
    const { harness } = await setup(
      [thread("thr_a"), thread("thr_b", { projectId: "proj_2" })],
      [
        { id: PROJECT, name: "Demo" },
        { id: "proj_2", name: "Other" },
      ],
    );
    const printed = await harness.behavior.runCli(["board"], {});
    expect(printed.stdout).toContain("[Demo]");
    expect(printed.stdout).toContain("[Other]");
  });

  it("names an unknown project instead of printing an empty board", async () => {
    const { harness } = await setup([thread("thr_a")]);
    const result = await harness.behavior.runCli(
      ["board", "--project", "proj_missing"],
      {},
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No project proj_missing");
  });

  it("says how to pick a thread when none is in scope", async () => {
    const { harness } = await setup([thread("thr_a")]);
    const result = await harness.behavior.runCli(["move", "review"], {});
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--thread <thr_id>");
  });

  it("prints every project with --all without looking up the calling thread", async () => {
    // A deleted calling thread must not block the all-projects board.
    const { harness } = await setup([thread("thr_a")]);
    const printed = await harness.behavior.runCli(["board", "--all"], {
      threadId: "thr_gone",
    });
    expect(printed.exitCode).toBe(0);
    expect(printed.stdout).toContain("[Demo]");
    expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(0);
  });

  it("asks for a value when --project has none", async () => {
    const { harness } = await setup([thread("thr_a")]);
    const result = await harness.behavior.runCli(["board", "--project"], {});
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--project needs a value");
  });

  it("does not tell a child thread to place a card it cannot have", async () => {
    const { harness } = await setup([
      thread("thr_parent"),
      thread("thr_kid", { parentThreadId: "thr_parent" }),
    ]);
    const result = await harness.behavior.runCli(
      ["note", "hello", "--thread", "thr_kid"],
      {},
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("child thread");
    expect(result.stderr).not.toContain("kanban move");
  });

  it("fails a move for a child thread and points at the parent", async () => {
    const { harness } = await setup([
      thread("thr_parent"),
      thread("thr_kid", { parentThreadId: "thr_parent" }),
    ]);
    const result = await harness.behavior.runCli(
      ["move", "doing", "--thread", "thr_kid"],
      {},
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Move the parent's card instead");
  });
});

describe("agent tool", () => {
  it("moves the calling thread's card and echoes the column", async () => {
    const { harness } = await setup([thread("thr_a")]);
    await harness.behavior.callRpc("board", { projectId: PROJECT });

    const result = await harness.behavior.callAgentTool(
      "kanban_move_card",
      { column: "doing", note: "shipped" },
      { threadId: "thr_a", projectId: PROJECT },
    );
    expect(JSON.stringify(result)).toContain("In progress");
    expect(await columnOf(harness, "thr_a")).toBe("in-progress");
  });

  it("sends an agent reporting itself done to review, and archives nothing", async () => {
    // Done archives the thread, and archiving the last thread of a managed
    // worktree deletes that worktree. An agent does not get to trigger it.
    const { harness } = await setup([thread("thr_a")]);
    await harness.behavior.callRpc("board", { projectId: PROJECT });

    const result = await harness.behavior.callAgentTool(
      "kanban_move_card",
      { column: "done", note: "shipped" },
      { threadId: "thr_a", projectId: PROJECT },
    );

    expect(await columnOf(harness, "thr_a")).toBe("review");
    expect(JSON.stringify(result)).toContain("Needs review");
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
  });

  it("tells a crewmate it has no card of its own", async () => {
    const { harness } = await setup([
      thread("thr_parent"),
      thread("thr_kid", { parentThreadId: "thr_parent" }),
    ]);
    await harness.behavior.callRpc("board", { projectId: PROJECT });

    const result = await harness.behavior.callAgentTool(
      "kanban_move_card",
      { column: "doing" },
      { threadId: "thr_kid", projectId: PROJECT },
    );

    expect(JSON.stringify(result)).toContain("Thread thr_parent");
    const board = (await harness.behavior.callRpc("board", {
      projectId: PROJECT,
    })) as { cards: { threadId: string }[] };
    expect(board.cards.map((card) => card.threadId)).toEqual(["thr_parent"]);
  });

  it("refuses the same move from the CLI", async () => {
    const { harness } = await setup([thread("thr_a")]);
    await harness.behavior.callRpc("board", { projectId: PROJECT });

    const result = await harness.behavior.runCli([
      "move",
      "done",
      "--thread",
      "thr_a",
    ]);

    expect(result.stdout).toContain("Only the user marks work done");
    expect(await columnOf(harness, "thr_a")).toBe("review");
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
  });
});

async function columnOf(
  harness: Awaited<ReturnType<typeof setup>>["harness"],
  threadId: string,
): Promise<string | undefined> {
  const board = (await harness.behavior.callRpc("board", {
    projectId: PROJECT,
  })) as { cards: { threadId: string; columnId: string }[] };
  return board.cards.find((card) => card.threadId === threadId)?.columnId;
}

/** Lifecycle handlers are fire-and-forget; let their promises drain. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}


describe("new thread from a column", () => {
  it("lands in the first column when the project lacks the chosen one", async () => {
    // A merged column can belong to another project. The thread already
    // exists by then, so failing would only invite a duplicate on retry.
    // Running, so a backfill on the board load would say In progress instead.
    const { harness } = await setup([thread("thr_new", { status: "active" })]);
    const result = (await harness.behavior.callRpc("createCardThread", {
      columnId: "only-in-another-project",
      request: { prompt: "hi" },
    })) as { threadId: string };

    expect(result.threadId).toBe("thr_new");
    expect(await columnOf(harness, "thr_new")).toBe("backlog");
  });
});

describe("done means done", () => {
  it("archives the thread when its card reaches Done", async () => {
    const { harness } = await setup([thread("thr_a")]);
    await harness.behavior.callRpc("board", { projectId: PROJECT });

    await harness.behavior.callRpc("moveCard", {
      threadId: "thr_a",
      columnId: "done",
    });

    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(1);
  });

  it("leaves the card in place when archiving fails, and retries on the next drop", async () => {
    const { harness } = await setup([thread("thr_a")]);
    await harness.behavior.callRpc("board", { projectId: PROJECT });
    archiveFailures.add("thr_a");

    await expect(
      harness.behavior.callRpc("moveCard", { threadId: "thr_a", columnId: "done" }),
    ).rejects.toThrow();
    expect(await columnOf(harness, "thr_a")).toBe("backlog");

    await harness.behavior.callRpc("moveCard", { threadId: "thr_a", columnId: "done" });
    expect(await columnOf(harness, "thr_a")).toBe("done");
    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(2);
  });

  it("unarchives the thread when the card is dragged back out", async () => {
    const { harness } = await setup([thread("thr_a")]);
    await harness.behavior.callRpc("board", { projectId: PROJECT });
    await harness.behavior.callRpc("moveCard", {
      threadId: "thr_a",
      columnId: "done",
    });
    await harness.behavior.callRpc("moveCard", {
      threadId: "thr_a",
      columnId: "doing",
    });

    expect(harness.inspection.sdk.callsTo("threads.unarchive")).toHaveLength(1);
  });

  it("does not re-archive a thread that arrived in Done by being archived", async () => {
    const { harness } = await setup([
      thread("thr_a", { archivedAt: Date.now() }),
    ]);
    await harness.behavior.callRpc("board", { projectId: PROJECT });
    await harness.behavior.callRpc("moveCard", {
      threadId: "thr_a",
      columnId: "done",
    });

    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
  });

  it("leaves the thread alone when archiveOnDone is off", async () => {
    const { harness } = await setup([thread("thr_a")]);
    await harness.behavior.setSettings({ archiveOnDone: false });
    await harness.behavior.callRpc("board", { projectId: PROJECT });
    await harness.behavior.callRpc("moveCard", {
      threadId: "thr_a",
      columnId: "done",
    });

    expect(harness.inspection.sdk.callsTo("threads.archive")).toHaveLength(0);
  });

  it("hides finished cards past the visible window but keeps recent ones", async () => {
    const days = (count: number) => Date.now() - count * 24 * 60 * 60 * 1000;
    const { harness } = await setup([
      // Adopted within the 14-day backfill window, finished beyond the 7-day
      // Done window.
      thread("thr_old", { archivedAt: days(10), updatedAt: days(10) }),
      thread("thr_recent", { archivedAt: days(1), updatedAt: days(1) }),
    ]);

    const board = (await harness.behavior.callRpc("board", {
      projectId: PROJECT,
    })) as { cards: { threadId: string }[] };
    expect(board.cards.map((card) => card.threadId)).toEqual(["thr_recent"]);
  });

  it("keeps every finished card when the window is disabled", async () => {
    const days = (count: number) => Date.now() - count * 24 * 60 * 60 * 1000;
    const { harness } = await setup([
      thread("thr_old", { archivedAt: days(10), updatedAt: days(10) }),
    ]);
    await harness.behavior.setSettings({ doneVisibleDays: "0" });

    const board = (await harness.behavior.callRpc("board", {
      projectId: PROJECT,
    })) as { cards: { threadId: string }[] };
    expect(board.cards.map((card) => card.threadId)).toEqual(["thr_old"]);
  });
});


describe("subagents", () => {
  it("rolls child threads onto the parent card instead of listing them", async () => {
    const { harness } = await setup([
      thread("thr_parent"),
      thread("thr_kid", { parentThreadId: "thr_parent", status: "active" }),
      // Background workers are hidden but still belong to the parent.
      thread("thr_worker", {
        parentThreadId: "thr_parent",
        visibility: "hidden",
      }),
      // A grandchild rolls up to the same top-most card.
      thread("thr_grandkid", { parentThreadId: "thr_kid" }),
    ]);

    const board = (await harness.behavior.callRpc("board", {
      projectId: PROJECT,
    })) as { cards: { threadId: string; children: { threadId: string }[] }[] };

    expect(board.cards.map((card) => card.threadId)).toEqual(["thr_parent"]);
    expect(board.cards[0]!.children.map((child) => child.threadId).sort()).toEqual(
      ["thr_grandkid", "thr_kid", "thr_worker"],
    );
  });

  it("keeps a crewmate spawned into another project off its own board", async () => {
    // How bb actually spawns them: the crewmate gets its own project, so an
    // ancestry walk scoped to one project loses the parent and hands out a card.
    const { harness } = await setup(
      [
        thread("thr_parent"),
        thread("thr_kid", {
          projectId: "proj_2",
          parentThreadId: "thr_parent",
          status: "active",
          providerId: "codex",
        }),
        thread("thr_grandkid", {
          projectId: "proj_3",
          parentThreadId: "thr_kid",
          hasPendingInteraction: true,
        }),
      ],
      [
        { id: PROJECT, name: "Demo" },
        { id: "proj_2", name: "Second" },
        { id: "proj_3", name: "Third" },
      ],
    );

    const board = (await harness.behavior.callRpc("board", {
      projectId: null,
    })) as {
      cards: {
        threadId: string;
        childNeedsAttention: boolean;
        children: { threadId: string; providerId: string; projectName: string }[];
      }[];
    };

    expect(board.cards.map((card) => card.threadId)).toEqual(["thr_parent"]);
    const children = board.cards[0]!.children;
    expect(children.map((child) => child.threadId).sort()).toEqual([
      "thr_grandkid",
      "thr_kid",
    ]);
    // Each row can say where its crewmate actually lives, and on what.
    expect(
      children.find((child) => child.threadId === "thr_kid"),
    ).toMatchObject({ providerId: "codex", projectName: "Second" });
    expect(
      children.find((child) => child.threadId === "thr_grandkid")?.projectName,
    ).toBe("Third");
    // A crewmate waiting on the user is not allowed to hide inside the card.
    expect(board.cards[0]!.childNeedsAttention).toBe(true);
  });

  it("clears the card of a crewmate that turned out to live elsewhere", async () => {
    const kid = thread("thr_kid", { projectId: "proj_2" });
    const projects = [
      { id: PROJECT, name: "Demo" },
      { id: "proj_2", name: "Second" },
    ];
    const { harness } = await setup([thread("thr_parent"), kid], projects);

    const before = (await harness.behavior.callRpc("board", {
      projectId: null,
    })) as { cards: { threadId: string }[] };
    expect(before.cards).toHaveLength(2);

    kid.parentThreadId = "thr_parent";
    const after = (await harness.behavior.callRpc("board", {
      projectId: null,
    })) as { cards: { threadId: string; children: unknown[] }[] };
    expect(after.cards.map((card) => card.threadId)).toEqual(["thr_parent"]);
    expect(after.cards[0]!.children).toHaveLength(1);
  });

  it("still gives a card to a thread whose parent is gone", async () => {
    const { harness } = await setup([
      thread("thr_orphan", { parentThreadId: "thr_deleted" }),
    ]);

    const board = (await harness.behavior.callRpc("board", {
      projectId: PROJECT,
    })) as { cards: { threadId: string }[] };
    expect(board.cards.map((card) => card.threadId)).toEqual(["thr_orphan"]);
  });

  it("clears a card a child was given before the rollup existed", async () => {
    const kid = thread("thr_kid");
    const { harness } = await setup([thread("thr_parent"), kid]);

    const before = (await harness.behavior.callRpc("board", {
      projectId: PROJECT,
    })) as { cards: { threadId: string }[] };
    expect(before.cards).toHaveLength(2);

    kid.parentThreadId = "thr_parent";
    const after = (await harness.behavior.callRpc("board", {
      projectId: PROJECT,
    })) as { cards: { threadId: string; children: unknown[] }[] };
    expect(after.cards.map((card) => card.threadId)).toEqual(["thr_parent"]);
    expect(after.cards[0]!.children).toHaveLength(1);
  });
});

describe("activity line", () => {
  it("takes the last assistant message straight from the idle event", async () => {
    const { harness } = await setup([thread("thr_a")]);
    await harness.behavior.callRpc("board", { projectId: PROJECT });

    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thr_a",
        projectId: PROJECT,
        updatedAt: Date.now(),
      }),
      lastAssistantText: "```ts\ncode\n```\n\nTests are green, ready for you.",
    });
    await settle();

    const board = (await harness.behavior.callRpc("board", {
      projectId: PROJECT,
    })) as { cards: { preview: string | null }[] };
    // Code fences and newlines are stripped down to one readable line.
    expect(board.cards[0]!.preview).toBe("Tests are green, ready for you.");
  });

  it("backfills a missing line after the board has been served", async () => {
    const { harness } = await setup([thread("thr_a")]);

    const first = (await harness.behavior.callRpc("board", {
      projectId: PROJECT,
    })) as { cards: { preview: string | null }[] };
    expect(first.cards[0]!.preview).toBeNull(); // never blocks the first load
    await settle();

    const second = (await harness.behavior.callRpc("board", {
      projectId: PROJECT,
    })) as { cards: { preview: string | null }[] };
    expect(second.cards[0]!.preview).toBe("last word from thr_a");
    expect(harness.inspection.sdk.callsTo("threads.output")).toHaveLength(1);
  });

  it("reads a thread with nothing to show once, not on every load", async () => {
    // An empty line used to look unfetched, so each load fetched it again and
    // republished, and the open board refreshed itself in a loop.
    const { harness } = await setup([thread("thr_quiet")]);
    for (let load = 0; load < 3; load++) {
      await harness.behavior.callRpc("board", { projectId: PROJECT });
      await settle();
    }
    expect(harness.inspection.sdk.callsTo("threads.output")).toHaveLength(1);
  });
});
