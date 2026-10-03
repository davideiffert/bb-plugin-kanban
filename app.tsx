// bb-plugin-kanban — frontend entry.
//
// The board is a thin projection: cards are threads, the plugin backend owns
// only their placement. Dragging a card and an agent calling `bb kanban move`
// go through the same backend move, and both refresh every open board through
// the realtime channel.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ThreadChat,
  definePluginApp,
  experimental_NewThreadComposer as NewThreadComposer,
  experimental_useAppPanel,
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { NewThreadRequest } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useBoardWidth } from "./hooks/useBoardWidth.js";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { cn } from "@/lib/utils";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Board = Awaited<ReturnType<Rpc["call"]>> extends never ? never : never;

interface Column {
  id: string;
  name: string;
  role: "todo" | "doing" | "review" | "done" | null;
  position: number;
}

interface Child {
  threadId: string;
  title: string;
  status: string;
  providerId: string;
  projectName: string;
  hasPendingInteraction: boolean;
  isArchived: boolean;
}

interface Card {
  threadId: string;
  projectId: string;
  projectName: string;
  columnId: string;
  sortKey: number;
  note: string | null;
  title: string;
  status: string;
  providerId: string;
  branchName: string | null;
  isArchived: boolean;
  isUnread: boolean;
  hasPendingInteraction: boolean;
  childNeedsAttention: boolean;
  updatedAt: number;
  movedAt: number;
  preview: string | null;
  children: Child[];
}

interface BoardData {
  projectId: string | null;
  columns: Column[];
  cards: Card[];
}

/**
 * The board page. The selected card lives in the panel's own `subPath`, which
 * BB also hands to the Chat tab beside it — that is how a card click reaches
 * the conversation without either surface owning the other's state, and it
 * makes a board link point at a specific thread.
 */
function KanbanPanel({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const appPanel = experimental_useAppPanel();
  // Renames go through bb's own thread mutation, so a card title and the
  // sidebar row for the same thread can never disagree.
  const threadActions = useSidebarThreadActions();

  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  // null is the default: every project merged into one board.
  const [projectId, setProjectId] = useState<string | null>(null);
  const [board, setBoard] = useState<BoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [composeColumn, setComposeColumn] = useState<Column | null>(null);
  const [newColumnName, setNewColumnName] = useState("");
  const [addingColumn, setAddingColumn] = useState(false);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const isAllProjects = projectId === null;
  const selectedThreadId = subPath.split("/")[0] || null;
  const isCompact = useIsCompactViewport();
  const [visibleColumnId, setVisibleColumnId] = useState<string | null>(null);
  const shownColumnId =
    visibleColumnId ?? board?.columns[0]?.id ?? null;
  const laneRef = useRef<HTMLDivElement | null>(null);
  const boardWidth = useBoardWidth(laneRef);
  // Four 288px columns and their gaps need this much before the board starts
  // scrolling sideways. Under it, the columns that are only drop targets get
  // out of the way of the two you actually read.
  const isNarrow =
    !isCompact && boardWidth !== null && boardWidth < FULL_BOARD_WIDTH;
  const [openedRail, setOpenedRail] = useState<string | null>(null);
  const railColumnIds = useMemo(() => {
    const rails = new Set<string>();
    if (!isNarrow) return rails;
    const columns = board?.columns ?? [];
    const reading = columns.filter(
      (column) => column.role === "doing" || column.role === "review",
    );
    // A board with no doing/review roles is somebody's custom one: keep its
    // first two columns and rail the rest, rather than guessing at meaning.
    const keep = new Set(
      (reading.length > 0 ? reading : columns.slice(0, 2)).map(
        (column) => column.id,
      ),
    );
    for (const column of columns) {
      if (!keep.has(column.id) && column.id !== openedRail) rails.add(column.id);
    }
    return rails;
  }, [board?.columns, isNarrow, openedRail]);

  const refresh = useCallback(async () => {
    try {
      const next = (await rpc.call("board", {
        projectId: projectIdRef.current,
      })) as BoardData;
      setBoard(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [rpc]);

  useEffect(() => {
    void rpc
      .call("projects", null)
      .then((result) => setProjects(result.projects))
      .catch(() => undefined);
  }, [rpc]);

  useEffect(() => {
    void refresh();
  }, [refresh, projectId]);

  // Any move — from this board, another window, the CLI or an agent tool —
  // republishes on this channel.
  useRealtime("board", () => {
    void refresh();
  });

  const cardsByColumn = useMemo(() => {
    const grouped = new Map<string, Card[]>();
    for (const column of board?.columns ?? []) grouped.set(column.id, []);
    for (const card of board?.cards ?? []) {
      grouped.get(card.columnId)?.push(card);
    }
    return grouped;
  }, [board]);

  async function move(
    threadId: string,
    columnId: string,
    beforeThreadId: string | null,
  ) {
    // Optimistic: the realtime refresh lands a moment later.
    setBoard((current) =>
      current
        ? {
            ...current,
            cards: current.cards.map((card) =>
              card.threadId === threadId ? { ...card, columnId } : card,
            ),
          }
        : current,
    );
    try {
      await rpc.call("moveCard", { threadId, columnId, beforeThreadId });
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      void refresh();
    }
  }

  function onDrop(columnId: string, beforeThreadId: string | null) {
    const threadId = dragging;
    setDragging(null);
    setDropTarget(null);
    if (!threadId) return;
    void move(threadId, columnId, beforeThreadId);
  }

  async function addColumn() {
    const name = newColumnName.trim();
    if (!name || !projectId) return;
    setNewColumnName("");
    setAddingColumn(false);
    try {
      await rpc.call("addColumn", { projectId, name });
      await refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function rename(threadId: string, title: string) {
    // Optimistic, same as a move: the realtime refresh lands a moment later.
    setBoard((current) =>
      current
        ? {
            ...current,
            cards: current.cards.map((card) =>
              card.threadId === threadId ? { ...card, title } : card,
            ),
          }
        : current,
    );
    try {
      await threadActions.rename(threadId, title);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      void refresh();
    }
  }

  /**
   * Select a thread on the board and bring its Chat tab forward. Navigation
   * alone only changes the selection, so with the right panel hidden a click
   * would otherwise do nothing visible.
   */
  function openCard(threadId: string) {
    // Clicking through cards should not fill up history.
    navigate.toPluginPanel("board", { subPath: threadId, replace: true });
    appPanel.openFixedTab({ surface: { kind: "current" }, tab: CHAT_TAB });
  }

  async function createThread(request: NewThreadRequest, column: Column) {
    const { threadId } = await rpc.call("createCardThread", {
      columnId: column.id,
      request: request as unknown as Record<string, unknown>,
    });
    setComposeColumn(null);
    await refresh();
    // Stay on the board: the new thread opens in the Chat tab beside it, the
    // same way clicking any other card does.
    openCard(threadId);
  }

  if (error) {
    return (
      <div className="p-6 text-sm text-destructive">
        <p>Could not load the board: {error}</p>
        <p className="mt-2 text-muted-foreground">
          Reopen Kanban to try again. If it keeps failing, run{" "}
          <code>bb plugin list</code> to check that the plugin is running.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <label className="text-xs text-muted-foreground" htmlFor="kanban-project">
          Project
        </label>
        <select
          id="kanban-project"
          className="h-8 rounded-md border border-border bg-background px-2 text-sm"
          value={projectId ?? ""}
          onChange={(event) => setProjectId(event.target.value || null)}
        >
          <option value="">All projects</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-2">
          {isAllProjects ? (
            <span className="text-xs text-muted-foreground">
              Columns merged across every project. Pick one to edit its columns
            </span>
          ) : addingColumn ? (
            <>
              <Input
                autoFocus
                className="h-8 w-40"
                placeholder="Column name"
                value={newColumnName}
                onChange={(event) => setNewColumnName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void addColumn();
                  if (event.key === "Escape") setAddingColumn(false);
                }}
              />
              <Button size="sm" onClick={() => void addColumn()}>
                Add
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAddingColumn(true)}
            >
              New column
            </Button>
          )}
        </div>
      </div>

      {isCompact && (board?.columns.length ?? 0) > 0 ? (
        <div
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1.5"
          role="tablist"
          aria-label="Columns"
        >
          {board!.columns.map((column) => {
            const isVisible = column.id === shownColumnId;
            return (
              <button
                key={column.id}
                type="button"
                role="tab"
                aria-selected={isVisible}
                onClick={() => setVisibleColumnId(column.id)}
                className={cn(
                  "shrink-0 rounded-full px-3 py-1 text-xs",
                  isVisible
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {column.name}
                <span className="ml-1 opacity-70">
                  {(cardsByColumn.get(column.id) ?? []).length}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div
        ref={laneRef}
        className={cn(
          "flex min-h-0 flex-1 gap-3 p-3",
          isCompact ? "flex-col overflow-y-auto" : "overflow-x-auto",
        )}
      >
        {(board?.columns ?? [])
          .filter((column) => !isCompact || column.id === shownColumnId)
          .map((column) => {
          const cards = cardsByColumn.get(column.id) ?? [];
          if (railColumnIds.has(column.id)) {
            return (
              <ColumnRail
                key={column.id}
                name={column.name}
                count={cards.length}
                isDropTarget={dropTarget === column.id}
                onOpen={() => setOpenedRail(column.id)}
                onDragOver={() => setDropTarget(column.id)}
                onDragLeave={() =>
                  setDropTarget((current) =>
                    current === column.id ? null : current,
                  )
                }
                onDrop={() => onDrop(column.id, null)}
              />
            );
          }
          return (
            <div
              key={column.id}
              className={cn(
                "flex flex-col rounded-lg border border-border bg-card/40",
                isCompact
                  ? "w-full flex-1"
                  : isNarrow
                    ? "min-w-0 flex-1"
                    : "w-72 shrink-0",
                dropTarget === column.id && "border-primary bg-card",
              )}
              onDragOver={(event) => {
                event.preventDefault();
                setDropTarget(column.id);
              }}
              onDragLeave={() =>
                setDropTarget((current) =>
                  current === column.id ? null : current,
                )
              }
              onDrop={(event) => {
                event.preventDefault();
                onDrop(column.id, null);
              }}
            >
              <div
                className={cn(
                  "flex items-center gap-2 px-3 py-2",
                  isCompact && "hidden",
                )}
              >
                {isAllProjects ? (
                  <span className="text-sm font-medium">{column.name}</span>
                ) : (
                  <ColumnTitle
                    column={column}
                    projectId={projectId}
                    rpc={rpc}
                    onDone={refresh}
                  />
                )}
                <span className="text-xs text-muted-foreground">
                  {cards.length}
                </span>
                {openedRail === column.id ? (
                  <button
                    type="button"
                    aria-label={`Collapse ${column.name}`}
                    title="Back to a drop target"
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setOpenedRail(null)}
                  >
                    «
                  </button>
                ) : null}
                {isAllProjects ? null : (
                <button
                  type="button"
                  aria-label={`Delete ${column.name}`}
                  className="ml-auto text-xs text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    if (!projectId) return;
                    void rpc
                      .call("deleteColumn", { projectId, columnId: column.id })
                      .then(refresh)
                      .catch((cause) => toast.error(String(cause)));
                  }}
                >
                  ✕
                </button>
                )}
              </div>

              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                {cards.map((card) => (
                  <CardTile
                    key={card.threadId}
                    card={card}
                    showProject={isAllProjects}
                    isDragging={dragging === card.threadId}
                    onDragStart={() => setDragging(card.threadId)}
                    onDragEnd={() => setDragging(null)}
                    onDropBefore={() => onDrop(column.id, card.threadId)}
                    isSelected={selectedThreadId === card.threadId}
                    isCompact={isCompact}
                    columns={board?.columns ?? []}
                    onMoveTo={(columnId) => void move(card.threadId, columnId, null)}
                    onSelectChild={openCard}
                    onSelect={() => openCard(card.threadId)}
                    onOpenFull={() => navigate.toThread(card.threadId)}
                    onRename={(title) => void rename(card.threadId, title)}
                    onRemove={() => {
                      void rpc
                        .call("removeCard", { threadId: card.threadId })
                        .then(refresh)
                        .catch((cause) => toast.error(String(cause)));
                    }}
                  />
                ))}
                {cards.length === 0 ? (
                  <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                    Drop a card here
                  </p>
                ) : null}
                <button
                  type="button"
                  className="rounded-md border border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setComposeColumn(column)}
                >
                  + New thread
                </button>
              </div>
            </div>
          );
        })}
        {board && board.columns.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            No projects yet. Create one to start a board.
          </p>
        ) : null}
      </div>

      <Dialog
        open={composeColumn !== null}
        onOpenChange={(open) => {
          if (!open) setComposeColumn(null);
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>New card in {composeColumn?.name}</DialogTitle>
          </DialogHeader>
          {composeColumn ? (
            <NewThreadComposer
              defaultProjectId={projectId ?? undefined}
              onSubmit={(request) => createThread(request, composeColumn)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ColumnTitle({
  column,
  projectId,
  rpc,
  onDone,
}: {
  column: Column;
  projectId: string | null;
  rpc: Rpc;
  onDone: () => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(column.name);

  useEffect(() => setName(column.name), [column.name]);

  if (!editing) {
    return (
      <button
        type="button"
        className="text-sm font-medium"
        title="Rename column"
        onClick={() => setEditing(true)}
      >
        {column.name}
      </button>
    );
  }

  const commit = () => {
    setEditing(false);
    if (!projectId || name.trim() === "" || name === column.name) return;
    void rpc
      .call("renameColumn", { projectId, columnId: column.id, name })
      .then(onDone)
      .catch((cause) => toast.error(String(cause)));
  };

  return (
    <Input
      autoFocus
      className="h-7 w-36"
      value={name}
      onChange={(event) => setName(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") setEditing(false);
      }}
    />
  );
}

/** How long a card has sat where it is — the stalled-work signal. */
function formatAge(since: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - since) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * A column with nothing to read, kept as a place to drop things. Backlog and
 * Done are drop targets far more often than they are lists, so on a narrow
 * board they become a labelled strip and hand their width to In progress and
 * Needs review. Clicking one opens it; it still takes a dropped card while
 * collapsed, so archiving stays a single drag.
 */
function ColumnRail({
  name,
  count,
  isDropTarget,
  onOpen,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  name: string;
  count: number;
  isDropTarget: boolean;
  onOpen: () => void;
  onDragOver: () => void;
  onDragLeave: () => void;
  onDrop: () => void;
}) {
  return (
    <button
      type="button"
      title={`${name} (${count}). Click to open, or drop a card here.`}
      className={cn(
        "flex w-9 shrink-0 flex-col items-center gap-2 rounded-lg border border-border bg-card/40 py-3",
        "text-xs text-muted-foreground hover:text-foreground",
        isDropTarget && "border-primary bg-card text-foreground",
      )}
      onClick={onOpen}
      onDragOver={(event) => {
        event.preventDefault();
        onDragOver();
      }}
      onDragLeave={onDragLeave}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
    >
      <span className="tabular-nums">{count}</span>
      <span className="[writing-mode:vertical-rl] whitespace-nowrap">
        {name}
      </span>
    </button>
  );
}

/** Four 288px columns plus their gaps and the board's padding. */
const FULL_BOARD_WIDTH = 1212;

const STATUS_TONE: Record<string, string> = {
  active: "bg-primary",
  error: "bg-destructive",
  starting: "bg-primary/60",
  stopping: "bg-muted-foreground",
  idle: "bg-muted-foreground/50",
};

function CardTile({
  card,
  showProject,
  isDragging,
  isSelected,
  isCompact,
  columns,
  onDragStart,
  onDragEnd,
  onDropBefore,
  onSelect,
  onOpenFull,
  onRemove,
  onRename,
  onMoveTo,
  onSelectChild,
}: {
  card: Card;
  showProject: boolean;
  isDragging: boolean;
  isSelected: boolean;
  isCompact: boolean;
  columns: Column[];
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropBefore: () => void;
  onSelect: () => void;
  onOpenFull: () => void;
  onRemove: () => void;
  onRename: (title: string) => void;
  onMoveTo: (columnId: string) => void;
  onSelectChild: (threadId: string) => void;
}) {
  const didDrag = useRef(false);
  // Null until the user says otherwise: a card opens itself while its crewmates
  // are working and folds up once they are all done, but a click always wins.
  const [showChildren, setShowChildren] = useState<boolean | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(card.title);
  const running = card.children.filter(
    (child) => child.status === "active",
  ).length;
  const childrenOpen =
    showChildren ??
    (running > 0 || card.children.some((child) => child.hasPendingInteraction));

  // A rename from anywhere else (sidebar, agent, another window) wins while
  // this card is not being edited.
  useEffect(() => {
    if (!editingTitle) setDraftTitle(card.title);
  }, [card.title, editingTitle]);

  function commitTitle() {
    setEditingTitle(false);
    const title = draftTitle.trim();
    if (!title || title === card.title) {
      setDraftTitle(card.title);
      return;
    }
    onRename(title);
  }

  return (
    <div
      draggable={!editingTitle}
      title="Open the conversation in the side panel"
      onClick={() => {
        // A drag ends with a click on some platforms; swallow that one.
        if (didDrag.current) {
          didDrag.current = false;
          return;
        }
        onSelect();
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", card.threadId);
        didDrag.current = true;
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onDropBefore();
      }}
      className={cn(
        "group @container cursor-pointer rounded-md border border-border bg-card p-2 shadow-sm",
        isDragging && "opacity-50",
        isSelected && "border-primary ring-1 ring-primary",
      )}
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className={cn(
            "mt-1.5 size-1.5 shrink-0 rounded-full",
            STATUS_TONE[card.status] ?? "bg-muted-foreground/50",
            card.status === "active" && "animate-pulse",
          )}
        />
        {editingTitle ? (
          <Input
            autoFocus
            aria-label="Thread title"
            className="h-7 flex-1 text-sm"
            value={draftTitle}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") commitTitle();
              if (event.key === "Escape") {
                setDraftTitle(card.title);
                setEditingTitle(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onSelect();
            }}
            // Double-click renames in place, the same gesture as the sidebar.
            onDoubleClick={(event) => {
              event.stopPropagation();
              setEditingTitle(true);
            }}
            className="flex-1 cursor-pointer text-left text-sm leading-snug"
          >
            <span className={cn(card.isUnread && "font-medium")}>
              {card.title}
            </span>
          </button>
        )}
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {editingTitle ? null : (
            <button
              type="button"
              aria-label="Rename thread"
              title="Rename thread"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                setDraftTitle(card.title);
                setEditingTitle(true);
              }}
            >
              ✎
            </button>
          )}
          <button
            type="button"
            aria-label="Open the full thread"
            title="Open the full thread"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onOpenFull();
            }}
          >
            ↗
          </button>
          <button
            type="button"
            aria-label="Remove from board"
            title="Remove from board"
            className="text-xs text-muted-foreground hover:text-destructive"
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
          >
            ✕
          </button>
        </div>
      </div>
      {card.note ? (
        <p className="mt-1 pl-3.5 text-xs text-muted-foreground">{card.note}</p>
      ) : card.preview ? (
        <p className="mt-1 line-clamp-2 pl-3.5 text-xs text-muted-foreground">
          {card.preview}
        </p>
      ) : null}

      {card.children.length > 0 ? (
        <div className="mt-1.5 pl-3.5">
          <button
            type="button"
            aria-expanded={childrenOpen}
            className="text-[11px] text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              setShowChildren(!childrenOpen);
            }}
          >
            {childrenOpen ? "\u25be" : "\u25b8"} {card.children.length} child thread
            {card.children.length === 1 ? "" : "s"}
            {running > 0 ? `, ${running} running` : ""}
          </button>
          {childrenOpen ? (
            <ul className="mt-1 space-y-px border-l border-border pl-2">
              {card.children.map((child) => (
                <li key={child.threadId}>
                  <button
                    type="button"
                    className="flex w-full min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-left text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelectChild(child.threadId);
                    }}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "size-1 shrink-0 rounded-full",
                        STATUS_TONE[child.status] ?? "bg-muted-foreground/50",
                        child.status === "active" && "animate-pulse",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{child.title}</span>
                    {/* The name is the point, so the trailing meta gives up its
                        width first and disappears entirely on a narrow card.
                        Only what differs from the parent is worth the room. */}
                    <span className="ml-auto hidden min-w-0 max-w-[50%] shrink items-center gap-1.5 overflow-hidden text-muted-foreground/70 @[17rem]:flex">
                      {child.hasPendingInteraction ? (
                        <span className="shrink-0 text-primary">needs you</span>
                      ) : null}
                      {child.projectName !== card.projectName ? (
                        <span className="truncate rounded bg-muted px-1 text-foreground/70">
                          {child.projectName}
                        </span>
                      ) : null}
                      {child.providerId !== card.providerId ? (
                        <span className="truncate">{child.providerId}</span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-3.5 text-[11px] text-muted-foreground">
        {showProject ? (
          <span className="rounded bg-muted px-1 py-0.5 text-foreground/70">
            {card.projectName}
          </span>
        ) : null}
        <span>{card.providerId}</span>
        {card.branchName ? <span>· {card.branchName}</span> : null}
        {card.hasPendingInteraction ? (
          <span className="text-primary">· needs you</span>
        ) : null}
        {!card.hasPendingInteraction && card.childNeedsAttention ? (
          <span className="text-primary">· child thread needs you</span>
        ) : null}
        {card.isArchived ? <span>· archived</span> : null}
        <span title={`Moved ${new Date(card.movedAt).toLocaleString()}`}>
          · {formatAge(card.movedAt)} here
        </span>
      </div>

      {isCompact ? (
        <label className="mt-2 flex items-center gap-1.5 pl-3.5 text-[11px] text-muted-foreground">
          Move to
          <select
            className="h-7 flex-1 rounded-md border border-border bg-background px-1 text-xs text-foreground"
            value={card.columnId}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => {
              event.stopPropagation();
              onMoveTo(event.target.value);
            }}
          >
            {columns.map((column) => (
              <option key={column.id} value={column.id}>
                {column.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

/**
 * BB's own chat surface for whichever card is selected — the full thing:
 * transcript, composer, attachments, send/queue/stop. It reads the same
 * `subPath` the board writes, so no state crosses between the two surfaces.
 */
function ChatTab({ subPath }: { subPath: string }) {
  const threadId = subPath.split("/")[0] || null;

  if (!threadId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Pick a card to read and reply to its thread here.
      </div>
    );
  }

  return (
    <ThreadChat
      threadId={threadId}
      variant="compact"
      layout="contained"
      className="h-full"
    />
  );
}

const CHAT_TAB = { panelId: "board", id: "chat" } as const;

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "Kanban",
    icon: "Columns",
    path: "board",
    component: KanbanPanel,
    fixedTabs: [
      {
        ...CHAT_TAB,
        title: "Chat",
        icon: "MessageSquare",
        component: ChatTab,
        // The chat owns its own scrolling and composer docking.
        layout: "flush",
      },
    ],
  });
});
