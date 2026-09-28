import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronRight,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "../icons";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu";
import { ConfirmDialog } from "../ui/dialog";
import { useDialogs } from "../../hooks/useDialogs";
import { useToast } from "../ui/useToast";
import { useNoteDragAndDrop, type NoteMoveTarget } from "../../hooks/useNoteDragAndDrop";
import { localMutationErrorKey } from "../../lib/localMutationError";
import { useSettingsStore } from "../../stores/settingsStore";
import { cn } from "../lib/utils";
import { getCachedPlatform } from "../../utils/platform";
import { treeHorizontalIntent, treeRowActionClearanceStyle } from "./treeDirection";
import { defaultFolderDisplayName } from "./shared";
import type { FolderItem, NoteItem } from "../../types/electron";
import {
  folderContainerKey,
  spaceContainerKey,
  useSpaces,
  useFolders,
  useFolderCounts,
  useNotesByContainer,
  useExpandedContainers,
  useActiveContext,
  useActiveNoteId,
  useIsTreeLoading,
  setActiveContext,
  setActiveNoteId,
  setContainerExpanded,
  toggleContainerExpanded,
  createFolder,
  renameFolder,
  deleteFolder,
  getNoteFromStore,
  getFoldersValue,
} from "../../stores/noteStore";

const FOLDER_INPUT_CLASS =
  "w-full h-6 bg-foreground/5 dark:bg-white/5 rounded px-2 text-xs text-foreground outline-none border border-primary/30 focus:border-primary/50";

const ROW_BASE_CLASS =
  "group relative flex items-center gap-2 rounded-md cursor-pointer select-none " +
  "transition-colors duration-150 outline-none focus-visible:ring-1 focus-visible:ring-ring/30";

// Button forces svg children to 16px; these 20px controls want the 12px icon they pass.
const KEBAB_BUTTON_CLASS =
  "h-5 w-5 rounded-sm [&_svg]:size-3! opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 " +
  "transition-opacity text-muted-foreground/70 dark:text-muted-foreground/70 " +
  "hover:text-foreground/60 hover:bg-foreground/5 active:bg-foreground/8";

const KEBAB_TRIGGER_CLASS = cn(KEBAB_BUTTON_CLASS, "absolute end-1.5");

const HOVER_REVEAL_BUTTON_CLASS =
  "h-5 w-5 rounded-sm [&_svg]:size-3! opacity-0 focus-visible:opacity-100 transition-opacity " +
  "text-muted-foreground/70 dark:text-muted-foreground/70 hover:text-foreground/60 " +
  "hover:bg-foreground/5 active:bg-foreground/8";

const MENU_ITEM_CLASS = "text-xs gap-2 rounded-md px-2 py-1";

const SUB_CONTENT_CLASS = "min-w-36 rounded-xl border border-border p-1";

const DROP_TARGET_CLASS = "bg-primary/12 dark:bg-primary/15 ring-1 ring-primary/25";
const DROP_SUCCESS_CLASS = "bg-emerald-500/10 dark:bg-emerald-400/10 ring-1 ring-emerald-500/20";
const SUB_TRIGGER_CLASS = cn(
  MENU_ITEM_CLASS,
  "cursor-pointer focus:bg-foreground/5 data-[state=open]:bg-foreground/5"
);

type TFn = (key: string, options?: Record<string, unknown>) => string;

type TreeRow =
  | { type: "folder"; key: string; folder: FolderItem; parentKey?: undefined }
  | {
      type: "note";
      key: string;
      note: NoteItem;
      parentKey?: string;
      level: 1 | 2;
    };

interface DropHandlers {
  onDragOver: (e: React.DragEvent) => void;
  onDragEnter: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}

interface RowA11yProps {
  tabIndex: number;
  rowRef: (el: HTMLDivElement | null) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onFocus: () => void;
}

interface SpacesTreeProps {
  onDeleteNote: (id: number) => void;
  onMoveNote: (noteId: number, target: NoteMoveTarget) => Promise<void>;
  onCreateFolderAndMove: (noteId: number, folderName: string) => void;
  onNewNote: (spaceId: number, folderId: number | null) => void;
}

function getFileManagerName(): string {
  const platform = getCachedPlatform();
  return platform === "darwin" ? "Finder" : platform === "win32" ? "Explorer" : "Files";
}

function SectionHeader({
  label,
  icon,
  action,
  className,
  expanded,
  onToggle,
  toggleRef,
  dropHandlers,
  isDragOver,
  isDropSuccess,
}: {
  label: string;
  /** Resting icon shown in the chevron slot; the chevron appears on hover. */
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  expanded?: boolean;
  onToggle?: () => void;
  toggleRef?: React.Ref<HTMLButtonElement>;
  dropHandlers?: DropHandlers;
  isDragOver?: boolean;
  isDropSuccess?: boolean;
}) {
  // All-caps has no descenders, so its optical centre sits ~1px above the line box.
  const labelClassName =
    "translate-y-px text-[11px] font-medium uppercase tracking-[0.08em] text-foreground/55 select-none";

  return (
    <div
      role="none"
      {...dropHandlers}
      className={cn(
        "group flex items-center justify-between h-7 px-2 rounded-md",
        isDragOver && DROP_TARGET_CLASS,
        isDropSuccess && DROP_SUCCESS_CLASS,
        className
      )}
    >
      {onToggle ? (
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex h-full min-w-0 items-center gap-2 rounded-sm outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/30"
        >
          <span
            aria-hidden="true"
            className="relative h-4 w-4 flex items-center justify-center shrink-0"
          >
            {icon && (
              <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover:opacity-0">
                {icon}
              </span>
            )}
            <ChevronRight
              size={12}
              className={cn(
                "text-foreground/60 transition-all duration-150",
                expanded ? "rotate-90" : "rtl:rotate-180",
                icon && "opacity-0 group-hover:opacity-100"
              )}
            />
          </span>
          <span className={labelClassName}>{label}</span>
        </button>
      ) : (
        <span className={labelClassName}>{label}</span>
      )}
      {action}
    </div>
  );
}

function TreeChildren({
  open,
  children,
  grouped = true,
}: {
  open: boolean;
  children: React.ReactNode;
  grouped?: boolean;
}) {
  return (
    <div
      role="none"
      className={cn(
        "grid transition-[grid-template-rows] duration-[160ms] ease-out",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
      )}
    >
      <div
        role={grouped ? "group" : "none"}
        className={cn(
          "min-h-0 overflow-hidden transition-opacity duration-[80ms]",
          open ? "opacity-100" : "opacity-0"
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Expand/collapse toggle. With `icon`, the icon is the resting state and the
 * chevron fades in when the row (a `group`) is hovered.
 */
function RowToggle({
  isExpanded,
  onToggle,
  icon,
}: {
  isExpanded: boolean;
  onToggle: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <span
      aria-hidden="true"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="relative h-4 w-4 flex items-center justify-center shrink-0 rounded-sm text-foreground/50 hover:text-foreground/80 transition-colors duration-150"
    >
      {icon && (
        <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover:opacity-0">
          {icon}
        </span>
      )}
      <ChevronRight
        size={12}
        className={cn(
          "transition-all duration-150",
          isExpanded ? "rotate-90" : "rtl:rotate-180",
          icon && "opacity-0 group-hover:opacity-100"
        )}
      />
    </span>
  );
}

function DropSuccessCheck({ isDropSuccess }: { isDropSuccess: boolean }) {
  if (!isDropSuccess) return null;
  return (
    <Check
      size={10}
      className="text-emerald-500 dark:text-emerald-400 shrink-0 animate-[scale-in_200ms_ease-out]"
    />
  );
}

function SearchableMoveSubmenu({
  icon,
  label,
  itemCount,
  search,
  onSearchChange,
  searchPlaceholder,
  children,
  footer,
}: {
  icon: React.ReactNode;
  label: string;
  itemCount: number;
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={SUB_TRIGGER_CLASS}>
        {icon}
        {label}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent sideOffset={4} className={SUB_CONTENT_CLASS}>
        {itemCount > 5 && (
          <>
            <div className="relative px-1.5 py-0.5">
              <Search
                size={12}
                className="absolute start-3 top-1/2 -translate-y-1/2 text-foreground/45 pointer-events-none"
              />
              <input
                dir="auto"
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
                placeholder={searchPlaceholder}
                className="input-inline w-full ps-8 pe-1 py-1 text-xs text-foreground placeholder:text-foreground/45 outline-none border-none appearance-none"
              />
            </div>
            <DropdownMenuSeparator />
          </>
        )}
        <div className="overflow-y-auto max-h-40">{children}</div>
        {footer && (
          <>
            <DropdownMenuSeparator />
            {footer}
          </>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function FolderRow({
  folder,
  isExpanded,
  isActive,
  count,
  isDragOver,
  isDropSuccess,
  dropHandlers,
  noteFilesEnabled,
  fileManagerName,
  onActivate,
  onToggle,
  onNewNote,
  onRename,
  onDelete,
  a11y,
  t,
}: {
  folder: FolderItem;
  isExpanded: boolean;
  isActive: boolean;
  count: number;
  isDragOver: boolean;
  isDropSuccess: boolean;
  dropHandlers: DropHandlers;
  noteFilesEnabled: boolean;
  fileManagerName: string;
  onActivate: () => void;
  onToggle: () => void;
  onNewNote: () => void;
  onRename: () => void;
  onDelete: () => void;
  a11y: RowA11yProps;
  t: TFn;
}) {
  const displayName = defaultFolderDisplayName(folder, t);

  return (
    <div
      role="treeitem"
      aria-level={1}
      aria-expanded={isExpanded}
      aria-selected={isActive}
      aria-label={
        count > 0 ? `${displayName}, ${t("notes.spaces.noteCount", { count })}` : displayName
      }
      tabIndex={a11y.tabIndex}
      ref={a11y.rowRef}
      onKeyDown={a11y.onKeyDown}
      onFocus={a11y.onFocus}
      onClick={onActivate}
      title={displayName}
      {...dropHandlers}
      style={treeRowActionClearanceStyle()}
      className={cn(
        ROW_BASE_CLASS,
        "h-7 pe-2 ps-2",
        isActive
          ? "bg-primary/8 dark:bg-primary/10"
          : "hover:bg-foreground/4 dark:hover:bg-white/4",
        isDragOver && DROP_TARGET_CLASS,
        isDropSuccess && DROP_SUCCESS_CLASS
      )}
    >
      <RowToggle
        isExpanded={isExpanded}
        onToggle={onToggle}
        icon={
          <Folder
            size={14}
            className={cn(
              "transition-colors duration-150",
              isDragOver || isActive ? "text-primary" : "text-foreground/55 dark:text-foreground/45"
            )}
          />
        }
      />
      <span
        dir="auto"
        className={cn(
          "text-[13px] truncate flex-1 transition-colors duration-150",
          isDragOver || isActive
            ? "text-foreground font-medium"
            : "text-foreground/85 group-hover:text-foreground"
        )}
      >
        {displayName}
      </span>
      <DropSuccessCheck isDropSuccess={isDropSuccess} />
      <span className="absolute end-1.5 flex items-center gap-px">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("notes.list.newNote")}
          onClick={(e) => {
            e.stopPropagation();
            onNewNote();
          }}
          className={KEBAB_BUTTON_CLASS}
        >
          <Plus size={12} />
        </Button>
        {(!folder.is_default || noteFilesEnabled) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("common.actions")}
                onClick={(e) => e.stopPropagation()}
                className={KEBAB_BUTTON_CLASS}
              >
                <MoreHorizontal size={12} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={4} className="min-w-32">
              {noteFilesEnabled && (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    window.electronAPI?.showFolderInExplorer?.(folder.name);
                  }}
                  className={MENU_ITEM_CLASS}
                >
                  <ExternalLink size={11} className="text-muted-foreground/70" />
                  {t("notes.context.showInFileManager", { manager: fileManagerName })}
                </DropdownMenuItem>
              )}
              {!folder.is_default && (
                <>
                  {noteFilesEnabled && <DropdownMenuSeparator />}
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      onRename();
                    }}
                    className={MENU_ITEM_CLASS}
                  >
                    <Pencil size={11} className="text-muted-foreground/70" />
                    {t("notes.context.rename")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete();
                    }}
                    className={cn(
                      MENU_ITEM_CLASS,
                      "text-destructive focus:text-destructive focus:bg-destructive/10"
                    )}
                  >
                    <Trash2 size={11} />
                    {t("notes.context.delete")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </span>
    </div>
  );
}

interface MoveOption {
  key: string;
  label: string;
  target: NoteMoveTarget;
  isCurrent: boolean;
}

function NoteLeaf({
  note,
  level,
  indentClassName,
  isActive,
  isDragging,
  dragHandlers,
  folders,
  noteFilesEnabled,
  fileManagerName,
  onOpen,
  onMove,
  onCreateFolderAndMove,
  onDelete,
  a11y,
  t,
}: {
  note: NoteItem;
  level: 1 | 2;
  indentClassName: string;
  isActive: boolean;
  isDragging: boolean;
  dragHandlers: {
    draggable: true;
    onDragStart: (e: React.DragEvent) => void;
    onDragEnd: () => void;
  };
  folders: FolderItem[];
  noteFilesEnabled: boolean;
  fileManagerName: string;
  onOpen: () => void;
  onMove: (target: NoteMoveTarget) => void;
  onCreateFolderAndMove: (noteId: number, folderName: string) => void;
  onDelete: (id: number) => void;
  a11y: RowA11yProps;
  t: TFn;
}) {
  const [moveSearch, setMoveSearch] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [hasMirroredFile, setHasMirroredFile] = useState(false);

  const moveOptions = useMemo<MoveOption[]>(
    () =>
      folders
        .filter((f) => f.space_id === note.space_id)
        .map((folder) => ({
          key: folderContainerKey(folder.id),
          label: defaultFolderDisplayName(folder, t),
          target: { spaceId: note.space_id, folderId: folder.id },
          isCurrent: note.folder_id === folder.id,
        })),
    [folders, note.folder_id, note.space_id, t]
  );

  const filteredOptions = useMemo(() => {
    if (!moveSearch) return moveOptions;
    const query = moveSearch.toLowerCase();
    return moveOptions.filter((option) => option.label.toLowerCase().includes(query));
  }, [moveOptions, moveSearch]);

  const renderOption = (option: MoveOption) => (
    <DropdownMenuItem
      key={option.key}
      disabled={option.isCurrent}
      onClick={(e) => {
        e.stopPropagation();
        onMove(option.target);
      }}
      className={MENU_ITEM_CLASS}
    >
      <span dir="auto" className="truncate flex-1">
        {option.label}
      </span>
      {option.isCurrent && <Check size={9} className="text-primary shrink-0" />}
    </DropdownMenuItem>
  );

  const title = note.title || t("notes.list.untitled");

  return (
    <div
      role="treeitem"
      aria-level={level}
      aria-selected={isActive}
      tabIndex={a11y.tabIndex}
      ref={a11y.rowRef}
      onKeyDown={a11y.onKeyDown}
      onFocus={a11y.onFocus}
      onClick={onOpen}
      title={title}
      {...dragHandlers}
      style={treeRowActionClearanceStyle(1)}
      className={cn(
        ROW_BASE_CLASS,
        "h-7 pe-2",
        indentClassName,
        isActive
          ? "bg-primary/8 dark:bg-primary/10"
          : "hover:bg-foreground/4 dark:hover:bg-white/4",
        isDragging && "opacity-40"
      )}
    >
      <FileText
        size={14}
        className={cn(
          "shrink-0 transition-colors duration-150",
          isActive
            ? "text-primary"
            : "text-foreground/50 dark:text-foreground/45 group-hover:text-foreground/70 dark:group-hover:text-foreground/55"
        )}
      />
      <span
        dir="auto"
        className={cn(
          "text-[13px] truncate flex-1 transition-colors duration-150",
          isActive
            ? "text-foreground font-medium"
            : "text-foreground/85 group-hover:text-foreground"
        )}
      >
        {title}
      </span>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open && noteFilesEnabled) {
            window.electronAPI
              ?.noteFilesHasNoteFile?.(note.id)
              .then((exists) => setHasMirroredFile(!!exists))
              .catch(() => setHasMirroredFile(false));
          }
          if (!open) {
            setMoveSearch("");
            setIsCreating(false);
            setNewFolderName("");
          }
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("common.actions")}
            onClick={(e) => e.stopPropagation()}
            className={KEBAB_TRIGGER_CLASS}
          >
            <MoreHorizontal size={12} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4} className="min-w-40">
          {noteFilesEnabled && (
            <>
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  window.electronAPI?.showNoteFile?.(note.id);
                }}
                className={MENU_ITEM_CLASS}
              >
                <ExternalLink size={11} className="text-muted-foreground/70" />
                {t("notes.context.showInFileManager", { manager: fileManagerName })}
              </DropdownMenuItem>
              {hasMirroredFile && (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    window.electronAPI?.noteFilesOpenInObsidian?.(note.id);
                  }}
                  className={MENU_ITEM_CLASS}
                >
                  <ExternalLink size={11} className="text-muted-foreground/70" />
                  {t("notes.context.openInObsidian")}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
            </>
          )}
          <SearchableMoveSubmenu
            icon={<FolderOpen size={11} className="text-muted-foreground/70" />}
            label={t("notes.context.moveToFolder")}
            itemCount={moveOptions.length}
            search={moveSearch}
            onSearchChange={setMoveSearch}
            searchPlaceholder={t("notes.context.searchFolders")}
            footer={
              isCreating ? (
                <div className="px-1">
                  <input
                    dir="auto"
                    autoFocus
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter" && newFolderName.trim()) {
                        onCreateFolderAndMove(note.id, newFolderName.trim());
                        setNewFolderName("");
                        setIsCreating(false);
                      }
                      if (e.key === "Escape") {
                        setIsCreating(false);
                        setNewFolderName("");
                      }
                    }}
                    placeholder={t("notes.folders.folderName")}
                    className="input-inline w-full px-2 py-1.5 rounded-md bg-transparent text-xs text-foreground placeholder:text-foreground/45 outline-none border-none appearance-none"
                  />
                </div>
              ) : (
                <DropdownMenuItem
                  onSelect={(e) => {
                    e.preventDefault();
                    setIsCreating(true);
                  }}
                  className={cn(MENU_ITEM_CLASS, "text-foreground/70")}
                >
                  <Plus size={10} />
                  {t("notes.context.newFolder")}
                </DropdownMenuItem>
              )
            }
          >
            {filteredOptions.map(renderOption)}
            {moveSearch && filteredOptions.length === 0 && (
              <p className="text-xs text-foreground/50 text-center py-1.5">
                {t("notes.context.noResults")}
              </p>
            )}
          </SearchableMoveSubmenu>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              onDelete(note.id);
            }}
            className={cn(
              MENU_ITEM_CLASS,
              "text-destructive focus:text-destructive focus:bg-destructive/10"
            )}
          >
            <Trash2 size={11} />
            {t("notes.context.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export default function SpacesTree({
  onDeleteNote,
  onMoveNote,
  onCreateFolderAndMove,
  onNewNote,
}: SpacesTreeProps) {
  const { t, i18n } = useTranslation();
  const { toast, dismiss } = useToast();
  const fileManagerName = getFileManagerName();

  const spaces = useSpaces();
  const folders = useFolders();
  const folderCounts = useFolderCounts();
  const notesByContainer = useNotesByContainer();
  const expanded = useExpandedContainers();
  const activeContext = useActiveContext();
  const activeNoteId = useActiveNoteId();
  const isTreeLoading = useIsTreeLoading();
  const noteFilesEnabled = useSettingsStore((s) => s.noteFilesEnabled);

  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renamingFolderId, setRenamingFolderId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const sectionToggleRef = useRef<HTMLButtonElement>(null);
  const undoToastIdRef = useRef<string | null>(null);

  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();

  const personalSpace = spaces[0];
  const spaceKey = personalSpace ? spaceContainerKey(personalSpace.id) : null;
  const sectionExpanded = spaceKey ? expanded.has(spaceKey) : false;
  const spaceFolders = useMemo(
    () => (personalSpace ? folders.filter((f) => f.space_id === personalSpace.id) : []),
    [folders, personalSpace]
  );
  const rootNotes = spaceKey ? (notesByContainer[spaceKey] ?? []) : [];

  const targetLabel = (target: NoteMoveTarget): string => {
    if (target.folderId != null) {
      const folder = folders.find((f) => f.id === target.folderId);
      return folder ? defaultFolderDisplayName(folder, t) : "";
    }
    return t("notes.spaces.personal");
  };

  const showUndoToast = (title: string, target: string, onUndo: () => void): void => {
    if (undoToastIdRef.current) dismiss(undoToastIdRef.current);
    undoToastIdRef.current = toast({
      title: t("notes.spaces.moved", { title, target }),
      duration: 8000,
      action: (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (undoToastIdRef.current) dismiss(undoToastIdRef.current);
            undoToastIdRef.current = null;
            onUndo();
          }}
          className="h-6 px-2 text-xs text-white/70 hover:text-white hover:bg-white/10"
        >
          {t("notes.spaces.undo")}
        </Button>
      ),
    });
  };

  const moveNoteSafely = async (noteId: number, target: NoteMoveTarget): Promise<boolean> => {
    try {
      await onMoveNote(noteId, target);
      return true;
    } catch (err: unknown) {
      toast({
        title: t("notes.spaces.couldNotMoveNote"),
        description: t(localMutationErrorKey(err instanceof Error ? err.message : undefined)),
        variant: "destructive",
      });
      return false;
    }
  };

  // The 8s undo window outlives the tree snapshot: the previous folder may
  // have been deleted meanwhile. Never restore a note into a folder nothing
  // renders — degrade to the space root.
  const undoMoveNote = async (
    noteId: number,
    title: string,
    prev: NoteMoveTarget
  ): Promise<void> => {
    const folderGone =
      prev.folderId != null && !getFoldersValue().some((f) => f.id === prev.folderId);
    const restore = folderGone ? { spaceId: prev.spaceId, folderId: null } : prev;
    const moved = await moveNoteSafely(noteId, restore);
    if (moved && folderGone) {
      toast({ title: t("notes.spaces.moved", { title, target: t("notes.spaces.personal") }) });
    }
  };

  const commitMoveNote = async (noteId: number, target: NoteMoveTarget): Promise<void> => {
    const note = getNoteFromStore(noteId);
    const prev: NoteMoveTarget | null = note
      ? { spaceId: note.space_id, folderId: note.folder_id }
      : null;
    const moved = await moveNoteSafely(noteId, target);
    if (moved && prev) {
      const title = note?.title || t("notes.list.untitled");
      // Undo silently restores the previous folder — no confirm, no new toast.
      showUndoToast(title, targetLabel(target), () => void undoMoveNote(noteId, title, prev));
    }
  };

  const { dragState, noteDragHandlers, dropTargetHandlers } = useNoteDragAndDrop({
    untitledLabel: t("notes.list.untitled"),
    onMoveToTarget: commitMoveNote,
    onHoverTarget: (key) => setContainerExpanded(key, true),
  });

  const visibleRows = useMemo<TreeRow[]>(() => {
    const rows: TreeRow[] = [];
    if (!spaceKey || !expanded.has(spaceKey)) return rows;
    spaceFolders.forEach((folder) => {
      const folderKey = folderContainerKey(folder.id);
      rows.push({ type: "folder", key: folderKey, folder });
      if (expanded.has(folderKey)) {
        (notesByContainer[folderKey] ?? []).forEach((note) => {
          rows.push({ type: "note", key: `n:${note.id}`, note, parentKey: folderKey, level: 2 });
        });
      }
    });
    (notesByContainer[spaceKey] ?? []).forEach((note) => {
      rows.push({ type: "note", key: `n:${note.id}`, note, level: 1 });
    });
    return rows;
  }, [spaceKey, spaceFolders, notesByContainer, expanded]);

  const effectiveFocusKey =
    focusedKey && visibleRows.some((r) => r.key === focusedKey)
      ? focusedKey
      : (visibleRows[0]?.key ?? null);

  const focusRow = (key: string | undefined) => {
    if (!key) return;
    setFocusedKey(key);
    rowRefs.current.get(key)?.focus();
  };

  /** Restore focus to a row after an inline input closes (keyboard paths only). */
  const focusRowSoon = (key: string) => {
    setFocusedKey(key);
    requestAnimationFrame(() => rowRefs.current.get(key)?.focus());
  };

  const activateRow = (row: TreeRow) => {
    if (row.type === "folder") {
      // Deselect the note so the main pane shows the folder overview.
      setActiveNoteId(null);
      setActiveContext(row.folder.space_id, row.folder.id);
      toggleContainerExpanded(row.key);
    } else {
      setActiveNoteId(row.note.id);
    }
  };

  const startRenameFolder = (folder: FolderItem) => {
    setRenamingFolderId(folder.id);
    setRenameValue(folder.name);
  };

  const requestDeleteFolder = (folder: FolderItem) => {
    const count = folderCounts[folder.id] ?? 0;
    showConfirmDialog({
      title: t("notes.folders.deleteTitle"),
      description:
        count > 0
          ? t("notes.folders.deleteDescription", { name: folder.name, count })
          : t("notes.folders.deleteDescriptionEmpty", { name: folder.name }),
      confirmText: t("notes.folders.deleteConfirm"),
      variant: "destructive",
      onConfirm: async () => {
        const result = await deleteFolder(folder.id);
        if (!result.success && result.error) {
          toast({
            title: t("notes.folders.couldNotDelete"),
            description: t(localMutationErrorKey(result.error)),
            variant: "destructive",
          });
        }
      },
    });
  };

  const handleRowKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, row: TreeRow) => {
    if (e.target !== e.currentTarget) return;
    const idx = visibleRows.findIndex((r) => r.key === row.key);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
      e.preventDefault();
      if (activeContext) onNewNote(activeContext.spaceId, activeContext.folderId);
      return;
    }
    const horizontalIntent = treeHorizontalIntent(e.key, i18n.dir());
    if (horizontalIntent === "inward") {
      e.preventDefault();
      if (row.type === "note") return;
      if (!expanded.has(row.key)) {
        setContainerExpanded(row.key, true);
      } else if (visibleRows[idx + 1]?.parentKey === row.key) {
        focusRow(visibleRows[idx + 1]?.key);
      }
      return;
    }
    if (horizontalIntent === "outward") {
      e.preventDefault();
      if (row.type !== "note" && expanded.has(row.key)) {
        setContainerExpanded(row.key, false);
      } else if (row.parentKey) {
        focusRow(row.parentKey);
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusRow(visibleRows[idx + 1]?.key);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusRow(visibleRows[idx - 1]?.key);
        break;
      case "F2":
        e.preventDefault();
        if (row.type === "folder" && !row.folder.is_default) startRenameFolder(row.folder);
        break;
      case "Delete":
      case "Backspace":
        // Bare Backspace stays inert; Cmd/Ctrl+Backspace matches the native delete gesture.
        if (e.key === "Backspace" && !(e.metaKey || e.ctrlKey)) break;
        e.preventDefault();
        if (row.type === "note") {
          focusRow(visibleRows[idx + 1]?.key ?? visibleRows[idx - 1]?.key);
          onDeleteNote(row.note.id);
        } else if (!row.folder.is_default) {
          requestDeleteFolder(row.folder);
        }
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        activateRow(row);
        break;
    }
  };

  const a11yFor = (key: string): RowA11yProps => ({
    tabIndex: key === effectiveFocusKey ? 0 : -1,
    rowRef: (el) => {
      if (el) rowRefs.current.set(key, el);
      else rowRefs.current.delete(key);
    },
    onKeyDown: (e) => {
      const row = visibleRows.find((r) => r.key === key);
      if (row) handleRowKeyDown(e, row);
    },
    onFocus: () => setFocusedKey(key),
  });

  const startCreateFolder = () => {
    if (spaceKey) setContainerExpanded(spaceKey, true);
    setCreatingFolder(true);
    setNewFolderName("");
  };

  const confirmCreateFolder = async (): Promise<string | null> => {
    const trimmed = newFolderName.trim();
    const wasCreating = creatingFolder;
    setCreatingFolder(false);
    setNewFolderName("");
    if (!wasCreating || !personalSpace || !trimmed) return null;
    const result = await createFolder(trimmed, personalSpace.id);
    if (result.success && result.folder) {
      setActiveContext(personalSpace.id, result.folder.id);
      return folderContainerKey(result.folder.id);
    }
    if (result.error) {
      toast({
        title: t("notes.folders.couldNotCreate"),
        description: t(localMutationErrorKey(result.error)),
        variant: "destructive",
      });
    }
    return null;
  };

  const confirmRename = async () => {
    const folderId = renamingFolderId;
    const trimmed = renameValue.trim();
    setRenamingFolderId(null);
    setRenameValue("");
    if (folderId == null || !trimmed) return;
    const result = await renameFolder(folderId, trimmed);
    if (!result.success && result.error) {
      toast({
        title: t("notes.folders.couldNotRename"),
        description: t(localMutationErrorKey(result.error)),
        variant: "destructive",
      });
    }
  };

  const renderNote = (
    note: NoteItem,
    level: 1 | 2,
    indentClassName: string,
    parentKey?: string
  ) => (
    <NoteLeaf
      key={note.id}
      note={note}
      level={level}
      indentClassName={indentClassName}
      isActive={note.id === activeNoteId}
      isDragging={dragState.draggingNoteId === note.id}
      dragHandlers={noteDragHandlers({
        id: note.id,
        title: note.title,
        folderId: note.folder_id,
        spaceId: note.space_id,
      })}
      folders={folders}
      noteFilesEnabled={noteFilesEnabled}
      fileManagerName={fileManagerName}
      onOpen={() => activateRow({ type: "note", key: `n:${note.id}`, note, parentKey, level })}
      onMove={(target) => void commitMoveNote(note.id, target)}
      onCreateFolderAndMove={onCreateFolderAndMove}
      onDelete={() => onDeleteNote(note.id)}
      a11y={a11yFor(`n:${note.id}`)}
      t={t}
    />
  );

  const renderFolder = (folder: FolderItem) => {
    const folderKey = folderContainerKey(folder.id);
    const isExpanded = expanded.has(folderKey);

    if (renamingFolderId === folder.id) {
      return (
        <div key={folder.id} role="none" className="ps-2 pe-2">
          <input
            dir="auto"
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                confirmRename();
                focusRowSoon(folderKey);
              }
              if (e.key === "Escape") {
                setRenamingFolderId(null);
                setRenameValue("");
                focusRowSoon(folderKey);
              }
            }}
            onBlur={confirmRename}
            className={FOLDER_INPUT_CLASS}
          />
        </div>
      );
    }

    return (
      <div key={folder.id} role="none">
        <FolderRow
          folder={folder}
          isExpanded={isExpanded}
          isActive={activeNoteId == null && activeContext?.folderId === folder.id}
          count={folderCounts[folder.id] ?? 0}
          isDragOver={dragState.dragOverKey === folderKey}
          isDropSuccess={dragState.dropSuccessKey === folderKey}
          dropHandlers={dropTargetHandlers({
            spaceId: folder.space_id,
            folderId: folder.id,
            folderName: folder.name,
            isDefaultFolder: Boolean(folder.is_default),
          })}
          noteFilesEnabled={noteFilesEnabled}
          fileManagerName={fileManagerName}
          onActivate={() => activateRow({ type: "folder", key: folderKey, folder })}
          onToggle={() => toggleContainerExpanded(folderKey)}
          onNewNote={() => onNewNote(folder.space_id, folder.id)}
          onRename={() => startRenameFolder(folder)}
          onDelete={() => requestDeleteFolder(folder)}
          a11y={a11yFor(folderKey)}
          t={t}
        />
        <TreeChildren open={isExpanded}>
          <div className="space-y-px">
            {(notesByContainer[folderKey] ?? []).map((note) =>
              renderNote(note, 2, "ps-8", folderKey)
            )}
          </div>
        </TreeChildren>
      </div>
    );
  };

  if (isTreeLoading && spaces.length === 0) {
    return (
      <div className="flex-1 flex items-start justify-center py-8">
        <Loader2 size={12} className="animate-spin text-foreground/45" />
      </div>
    );
  }

  return (
    <>
      <div
        role="tree"
        aria-label={t("notes.list.title")}
        className="scrollbar-hidden flex-1 overflow-y-auto px-1.5 pb-2 space-y-px"
      >
        <div role="none" className="group/section">
          <SectionHeader
            label={t("notes.spaces.privateSpaces")}
            icon={<Lock size={12} className="text-foreground/55" />}
            expanded={sectionExpanded}
            onToggle={() => {
              if (spaceKey) toggleContainerExpanded(spaceKey);
            }}
            toggleRef={sectionToggleRef}
            dropHandlers={
              personalSpace
                ? dropTargetHandlers({ spaceId: personalSpace.id, folderId: null })
                : undefined
            }
            isDragOver={!!spaceKey && dragState.dragOverKey === spaceKey}
            isDropSuccess={!!spaceKey && dragState.dropSuccessKey === spaceKey}
            action={
              personalSpace ? (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("notes.context.newFolder")}
                  onClick={startCreateFolder}
                  className={cn(HOVER_REVEAL_BUTTON_CLASS, "group-hover/section:opacity-100")}
                >
                  <Plus size={12} />
                </Button>
              ) : undefined
            }
          />
          {personalSpace && (
            <TreeChildren open={sectionExpanded} grouped={false}>
              {/* The personal space remains the storage boundary but is flattened in the UI. */}
              <div className="space-y-px">
                {spaceFolders.map(renderFolder)}
                {creatingFolder && (
                  <div className="ps-2 pe-2">
                    <input
                      dir="auto"
                      autoFocus
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          void confirmCreateFolder().then((key) => key && focusRowSoon(key));
                        }
                        if (e.key === "Escape") {
                          setCreatingFolder(false);
                          setNewFolderName("");
                          sectionToggleRef.current?.focus();
                        }
                      }}
                      onBlur={confirmCreateFolder}
                      placeholder={t("notes.folders.folderName")}
                      className={cn(FOLDER_INPUT_CLASS, "placeholder:text-foreground/45")}
                    />
                  </div>
                )}
                {rootNotes.map((note) => renderNote(note, 1, "ps-[30px]"))}
              </div>
            </TreeChildren>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />
    </>
  );
}
