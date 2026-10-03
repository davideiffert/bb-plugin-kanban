// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const board = {
  projectId: "proj_1",
  columns: [
    { id: "backlog", name: "Backlog", role: "todo", position: 0 },
    { id: "done", name: "Done", role: "done", position: 1 },
  ],
  cards: [
    {
      threadId: "thr_a",
      projectId: "proj_1",
      projectName: "Demo",
      columnId: "backlog",
      sortKey: 1000,
      note: "waiting on review",
      title: "Fix the flaky test",
      status: "active",
      providerId: "claude-code",
      branchName: "fix/flake",
      isArchived: false,
      isUnread: true,
      hasPendingInteraction: false,
      childNeedsAttention: false,
      updatedAt: 1,
      movedAt: Date.now() - 3 * 60 * 60 * 1000,
      preview: "Ran the suite twice, both green.",
      children: [
        {
          threadId: "thr_kid",
          title: "grep the logs",
          status: "active",
          providerId: "codex",
          projectName: "Logs",
          hasPendingInteraction: false,
          isArchived: false,
        },
      ],
    },
  ],
};

/**
 * jsdom measures nothing, so stand in a fixed board width and a ResizeObserver
 * that reports it once. Returns the undo.
 */
function withBoardWidth(width: number) {
  const originalObserver = window.ResizeObserver;
  const originalRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    return { ...new DOMRect(0, 0, width, 800), width, height: 800 } as DOMRect;
  };
  window.ResizeObserver = class {
    constructor(private readonly callback: () => void) {}
    observe() {
      this.callback();
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  return () => {
    window.ResizeObserver = originalObserver;
    Element.prototype.getBoundingClientRect = originalRect;
  };
}

/** jsdom reports a desktop width; force the phone breakpoint for one test. */
function withCompactViewport() {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes("max-width"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

describe("kanban panel", () => {
  it("registers one nav panel with a chat side tab", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.navPanels.map((panel) => panel.path)).toEqual(["board"]);
    expect(
      app.navPanels[0]!.fixedTabs?.map((tab) => tab.id),
    ).toEqual(["chat"]);
  });

  it("selects a card into the panel's subPath instead of leaving the board", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          projects: () => ({ projects: [{ id: "proj_1", name: "Demo" }] }),
          board: () => board,
        },
      },
    );

    (await slot.findByText("Fix the flaky test")).click();
    expect(slot.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({ method: "toPluginPanel" }),
    );
    expect(JSON.stringify(slot.inspection.navigateCalls)).toContain("thr_a");
    // A hidden right panel must open, or the click does nothing visible.
    expect(slot.inspection.experimental_fixedTabOpenCalls).toContainEqual(
      expect.objectContaining({ panelId: "board", tabId: "chat" }),
    );
    slot.lifecycle.unmount();
  });

  it("selects from anywhere on the card, not just its title", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          projects: () => ({ projects: [{ id: "proj_1", name: "Demo" }] }),
          board: () => board,
        },
      },
    );

    // The note sits in the card body, outside the title button.
    (await slot.findByText("waiting on review")).click();
    expect(JSON.stringify(slot.inspection.navigateCalls)).toContain("thr_a");
    slot.lifecycle.unmount();
  });

  it("does not select the card when its row actions are used", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          projects: () => ({ projects: [{ id: "proj_1", name: "Demo" }] }),
          board: () => board,
          removeCard: () => ({ ok: true }),
        },
      },
    );

    (await slot.findByLabelText("Remove from board")).click();
    expect(slot.inspection.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("renames a card's thread in place, through bb's own rename", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          projects: () => ({ projects: [{ id: "proj_1", name: "Demo" }] }),
          board: () => board,
        },
      },
    );

    fireEvent.click(await slot.findByLabelText("Rename thread"));
    const input = (await slot.findByLabelText(
      "Thread title",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Fix the flaky test, again" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(slot.inspection.sidebarActionCalls).toContainEqual(
      expect.objectContaining({
        method: "rename",
        threadId: "thr_a",
        title: "Fix the flaky test, again",
      }),
    );
    // Renaming is not a selection.
    expect(slot.inspection.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("keeps a card's title when the rename is cancelled", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          projects: () => ({ projects: [{ id: "proj_1", name: "Demo" }] }),
          board: () => board,
        },
      },
    );

    fireEvent.click(await slot.findByLabelText("Rename thread"));
    const input = (await slot.findByLabelText(
      "Thread title",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "nope" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(slot.inspection.sidebarActionCalls).toEqual([]);
    await slot.findByText("Fix the flaky test");
    slot.lifecycle.unmount();
  });

  /** The fixture card, with its crewmates replaced. */
  function boardWithChildren(children: Record<string, unknown>[]) {
    return {
      ...board,
      cards: [
        {
          ...board.cards[0]!,
          childNeedsAttention: children.some(
            (child) => child.hasPendingInteraction === true,
          ),
          children,
        },
      ],
    };
  }

  const idleCrewmate = {
    threadId: "thr_kid",
    title: "grep the logs",
    status: "idle",
    providerId: "codex",
    projectName: "Logs",
    hasPendingInteraction: false,
    isArchived: false,
  };

  it("shows a running crewmate's row without being asked", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          projects: () => ({ projects: [{ id: "proj_1", name: "Demo" }] }),
          board: () => board,
        },
      },
    );

    // One thin row glued to the parent, not a card of its own.
    await slot.findByText("grep the logs");
    expect(slot.queryByText(/1 child thread, 1 running/)).not.toBeNull();
    // The crewmate lives in another project, so its chip is worth showing.
    expect(slot.queryByText("Logs")).not.toBeNull();
    slot.lifecycle.unmount();
  });

  it("folds the crewmates away once none of them is working", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          projects: () => ({ projects: [{ id: "proj_1", name: "Demo" }] }),
          board: () => boardWithChildren([idleCrewmate]),
        },
      },
    );

    await slot.findByText(/1 child thread/);
    expect(slot.queryByText("grep the logs")).toBeNull();
    (await slot.findByText(/1 child thread/)).click();
    await slot.findByText("grep the logs");
    slot.lifecycle.unmount();
  });

  it("hides the project chip when the crewmate shares the card's project", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          projects: () => ({ projects: [{ id: "proj_1", name: "Demo" }] }),
          board: () =>
            boardWithChildren([
              { ...idleCrewmate, status: "active", projectName: "Demo" },
            ]),
        },
      },
    );

    const row = (await slot.findByText("grep the logs")).closest("button")!;
    // Neither the card's own project nor its own provider is worth repeating.
    expect(row.textContent).not.toContain("Demo");
    expect(row.textContent).not.toContain("claude-code");
    expect(row.textContent).toContain("codex");
    slot.lifecycle.unmount();
  });

  it("opens the crewmate's own thread, not the parent's", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          projects: () => ({ projects: [{ id: "proj_1", name: "Demo" }] }),
          board: () => board,
        },
      },
    );

    fireEvent.click((await slot.findByText("grep the logs")).closest("button")!);
    const calls = JSON.stringify(slot.inspection.navigateCalls);
    expect(calls).toContain("thr_kid");
    expect(calls).not.toContain("thr_a");
    slot.lifecycle.unmount();
  });

  it("says on the parent card when a folded crewmate is waiting on you", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          projects: () => ({ projects: [{ id: "proj_1", name: "Demo" }] }),
          board: () =>
            boardWithChildren([
              { ...idleCrewmate, hasPendingInteraction: true },
            ]),
        },
      },
    );

    await slot.findByText(/child thread needs you/);
    slot.lifecycle.unmount();
  });

  it("rails the drop-only columns when the board itself is narrow", async () => {
    const restore = withBoardWidth(900);
    try {
      const app = await loadPluginApp(() => import("./app"));
      const slot = renderSlot(
        app.navPanels[0]!,
        { subPath: "" },
        {
          rpc: {
            projects: () => ({ projects: [{ id: "proj_1", name: "Demo" }] }),
            board: () => ({
              ...board,
              columns: [
                { id: "backlog", name: "Backlog", role: "todo", position: 0 },
                { id: "doing", name: "In progress", role: "doing", position: 1 },
                { id: "review", name: "Needs review", role: "review", position: 2 },
                { id: "done", name: "Done", role: "done", position: 3 },
              ],
              cards: [{ ...board.cards[0]!, columnId: "doing" }],
            }),
          },
        },
      );

      // Backlog and Done keep their name and count, as a strip you can drop on.
      await slot.findByTitle(/^Backlog \(0\)/);
      await slot.findByTitle(/^Done \(0\)/);
      // The two columns worth reading are still columns, with their cards.
      expect(slot.queryByTitle(/^In progress \(/)).toBeNull();
      expect(slot.queryByTitle(/^Needs review \(/)).toBeNull();
      await slot.findByText("Fix the flaky test");

      // Clicking a rail opens it, and it can be sent back.
      (await slot.findByTitle(/^Done \(0\)/)).click();
      await slot.findByLabelText("Collapse Done");
      (await slot.findByLabelText("Collapse Done")).click();
      await slot.findByTitle(/^Done \(0\)/);
      slot.lifecycle.unmount();
    } finally {
      restore();
    }
  });

  it("leaves a wide board alone", async () => {
    const restore = withBoardWidth(1600);
    try {
      const app = await loadPluginApp(() => import("./app"));
      const slot = renderSlot(
        app.navPanels[0]!,
        { subPath: "" },
        {
          rpc: {
            projects: () => ({ projects: [{ id: "proj_1", name: "Demo" }] }),
            board: () => board,
          },
        },
      );

      await slot.findByText("Fix the flaky test");
      expect(slot.queryByTitle(/^Done \(/)).toBeNull();
      slot.lifecycle.unmount();
    } finally {
      restore();
    }
  });

  it("shows how long a card has sat in its column", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          projects: () => ({ projects: [{ id: "proj_1", name: "Demo" }] }),
          board: () => board,
        },
      },
    );

    await slot.findByText(/3h here/);
    slot.lifecycle.unmount();
  });

  it("shows one column at a time with a move control on a phone", async () => {
    const restore = withCompactViewport();
    try {
      const app = await loadPluginApp(() => import("./app"));
      const slot = renderSlot(
        app.navPanels[0]!,
        { subPath: "" },
        {
          rpc: {
            projects: () => ({ projects: [{ id: "proj_1", name: "Demo" }] }),
            board: () => board,
          },
        },
      );

      // A tab per column, and only the first column's cards on screen.
      const tabs = await slot.findAllByRole("tab");
      expect(tabs.map((tab) => tab.textContent)).toEqual(["Backlog1", "Done0"]);
      await slot.findByText("Fix the flaky test");
      // Dragging is not available on touch, so each card gets a move control.
      await slot.findByText("Move to");
      slot.lifecycle.unmount();
    } finally {
      restore();
    }
  });

  it("keeps a newly created thread on the board, selected beside it", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          projects: () => ({ projects: [{ id: "proj_1", name: "Demo" }] }),
          board: () => board,
          createCardThread: () => ({ threadId: "thr_new" }),
        },
      },
    );

    (await slot.findAllByText("+ New thread"))[0]!.click();
    // The composer is bb's own; drive the submit it would have made.
    const submit = await slot.findByTestId("bb-new-thread-composer-submit");
    fireEvent.click(submit);

    await waitFor(() => {
      expect(slot.inspection.navigateCalls).toContainEqual(
        expect.objectContaining({ method: "toPluginPanel" }),
      );
    });
    expect(JSON.stringify(slot.inspection.navigateCalls)).toContain("thr_new");
    // Never the full-page thread route — that is what took us off the board.
    expect(
      slot.inspection.navigateCalls.some((call) => call.method === "toThread"),
    ).toBe(false);
    slot.lifecycle.unmount();
  });

  it("prompts for a card when the chat tab has no selection", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const tab = app.navPanels[0]!.fixedTabs![0]!;
    const slot = renderSlot(tab, { subPath: "" }, {});
    await slot.findByText(/Pick a card/);
    slot.lifecycle.unmount();
  });

  it("renders each column with its cards", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          projects: () => ({ projects: [{ id: "proj_1", name: "Demo" }] }),
          board: () => board,
        },
        context: { projectId: "proj_1", threadId: null },
      },
    );

    await slot.findByText("Fix the flaky test");
    await slot.findByText("waiting on review");
    await slot.findByText("Done");
    // All projects is the default view, so each card carries a project chip
    // (as well as the entry in the project picker).
    const labels = await slot.findAllByText("Demo");
    expect(labels.some((node) => node.tagName === "SPAN")).toBe(true);
    slot.lifecycle.unmount();
  });
});
