import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from "react";
import {
  isAutomationModel,
  isAutomationReasoningEffort,
  isSupportedModelEffort,
  type AutomationModel,
  type AutomationReasoningEffort,
} from "../../shared/taskboard-automation-options.mjs";
import {
  ApiError,
  addTaskRelation,
  archiveTask as archiveTaskRequest,
  createProject as createProjectRequest,
  createTask as createTaskRequest,
  getProjectAutomation,
  getTaskboardRevision,
  getWorkflowWorkspace,
  getTaskboardMetadata,
  listDevelopmentContexts,
  listDeviceWorkspaces,
  listCodexThreadResources,
  listProjects,
  listTasks,
  moveTask as moveTaskRequest,
  removeTaskRelation,
  restoreTask as restoreTaskRequest,
  setCurrentUserActor,
  uploadAttachment,
  updateProjectAutomation,
  updateTask as updateTaskRequest,
} from "./api";
import {
  actorForAssigneeTarget,
  assigneeTargetForActor,
} from "./actors";
import { BoardColumn, STATUS_DETAILS } from "./components/BoardColumn";
import { AiChat } from "./components/AiChat";
import {
  resolveInlineMediaMarkdown,
  type PendingInlineImage,
} from "./components/InlineMediaComposer";
import { LinearIcon } from "./components/LinearIcon";
import { ProjectAutomationMenu } from "./components/ProjectAutomationMenu";
import { StatusDock } from "./components/StatusDock";
import { TaskContextMenu } from "./components/TaskContextMenu";
import { TaskDetail } from "./components/TaskDetail";
import { TaskEditor } from "./components/TaskEditor";
import { TaskFilterMenu } from "./components/TaskFilterMenu";
import { buildIssueUrl, readIssueIdentifier } from "./issueRoute";
import { DEFAULT_LABELS } from "./labels";
import {
  EMPTY_TASK_FILTERS,
  matchesTaskFilters,
  matchesTaskSearch,
  readTaskFilters,
  taskFilterCount,
  writeTaskFilters,
} from "./taskFilters";
import {
  TASK_STATUSES,
  type ActorIdentity,
  type CodexThreadSummary,
  type DevelopmentScan,
  type HostContext,
  type IssueRelationType,
  type Project,
  type Task,
  type TaskboardMetadata,
  type TaskDraft,
  type TaskStatus,
  type WorkflowOption,
} from "./types";
import {
  DEFAULT_WORKFLOW_OPTIONS,
  readLegacyWorkflowWorkspace,
  workflowOptionsFromWorkspace,
} from "./workflowStore";
// The poller stays in ESM JavaScript so its lifecycle can be tested directly with node:test.
// @ts-expect-error The module's option contract is enforced by its focused node tests.
import { createRevisionPoller, getRevisionPollingInterval } from "./revisionPolling.mjs";

type ConnectionState = "connecting" | "live" | "reconnecting";
type Theme = "light" | "dark";
type BoardView = "issues" | "workflow";
const SHOW_WORKFLOW_BOARD_ENTRY = false;
const NON_PROJECT_RESOURCE_ID = "__non_project_sessions__";
const CODEX_THREAD_RESOURCE_POLL_MS = 5_000;
const WORKBENCH_STATUSES: TaskStatus[] = ["backlog", "todo", "in_progress"];
const STATUS_DOCK_STATUSES: TaskStatus[] = ["in_review", "blocked", "done"];

const WorkflowBoard = lazy(() => import("./components/WorkflowBoard").then((module) => ({
  default: module.WorkflowBoard,
})));

interface EditorState {
  task: Task | null;
  status: TaskStatus;
  projectId: string;
}

interface ContextMenuState {
  taskId: string;
  x: number;
  y: number;
}

interface ProjectChoice {
  id: string;
  name: string;
  issueCount: number;
  inCodex: boolean;
  persisted: boolean;
}

interface ThreadResource {
  projectId: string | null;
  projectName: string;
  threadId: string;
  threadName: string;
}

interface TaskSelectionBox {
  startX: number;
  startY: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface UndoOperation {
  id: number;
  message: string;
  undo: () => Promise<void>;
}

interface UndoNotice {
  id: number;
  message: string;
}

type ProjectAutomationStatus = "ACTIVE" | "PAUSED";
type AutomationQuotaState = "available" | "blocked" | "unknown" | "unavailable";
type AutomationIntervalSeconds = 5 | 10 | 30 | 60 | 300 | 600 | 900 | 1800 | 3600;

interface AutomationQuotaStatus {
  state: AutomationQuotaState;
  checkedAt: number;
  resetsAt?: number;
  reason?: "api-key";
}

interface ProjectAutomationRecord {
  automationId?: string;
  codexProjectId: string;
  status: ProjectAutomationStatus;
  enabledByUser: boolean;
  quotaAware: boolean;
  quota?: AutomationQuotaStatus;
  intervalSeconds: AutomationIntervalSeconds;
  model: AutomationModel;
  reasoningEffort: AutomationReasoningEffort;
}

type ProjectAutomations = Record<string, ProjectAutomationRecord>;

interface AutomationHostItem {
  id: string;
  status: ProjectAutomationStatus;
  model: AutomationModel;
  reasoningEffort: AutomationReasoningEffort;
  rrule: string;
}

interface AutomationHostResponse {
  requestId?: string;
  ok: boolean;
  item?: AutomationHostItem;
  items?: AutomationHostItem[];
  quota?: AutomationQuotaStatus;
  policy?: {
    automationId?: string;
    enabledByUser: boolean;
    quotaAware: boolean;
    intervalSeconds: AutomationIntervalSeconds;
    model: AutomationModel;
    reasoningEffort: AutomationReasoningEffort;
  };
  execution?: {
    activeTaskId?: string | null;
    activeThreadId?: string | null;
    activeRunId?: string | null;
    lastRunAt?: string | null;
    lastError?: string | null;
  };
  error?: string;
}

interface PendingAutomationRequest {
  resolve: (response: AutomationHostResponse) => void;
  reject: (error: Error) => void;
  timeoutId: number;
}

const DEFAULT_USER_ACTOR: ActorIdentity = {
  type: "user",
  id: "local-user",
  name: "本地用户",
  avatarUrl: null,
};

const LAST_PROJECT_KEY = "taskboard.lastProjectId";
const FAVORITE_PROJECTS_KEY = "taskboard.favoriteProjectIds";
const DEVICE_WORKSPACE_PATHS_KEY = "taskboard.deviceWorkspacePaths.v1";
const PROJECT_AUTOMATIONS_KEY = "taskboard.projectAutomations.v1";
const GLOBAL_AUTOMATION_PROJECT_ID = "local";
const DEFAULT_AUTOMATION_OPTIONS = {
  enabledByUser: false,
  quotaAware: false,
  intervalSeconds: 5,
  model: "gpt-5.5",
  reasoningEffort: "high",
} as const;

const EVENT_NAMES = [
  "task.created",
  "task.updated",
  "task.moved",
  "task.archived",
  "task.restored",
  "task.relation.updated",
  "comment.created",
  "comment.updated",
  "comment.deleted",
  "attachment.created",
  "attachment.deleted",
  "project.created",
  "project.updated",
  "workflow.updated",
] as const;

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

function getInitialTheme(): Theme {
  const fromQuery = new URLSearchParams(window.location.search).get("theme");
  if (isTheme(fromQuery)) return fromQuery;
  const stored = window.localStorage.getItem("taskboard.theme");
  if (isTheme(stored)) return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readFavoriteProjectIds(): Set<string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(FAVORITE_PROJECTS_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function readDeviceWorkspacePaths(): Record<string, string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(DEVICE_WORKSPACE_PATHS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => (
      typeof entry[1] === "string" && entry[1].trim().length > 0
    )));
  } catch {
    return {};
  }
}

function readProjectAutomations(): ProjectAutomations {
  try {
    const value = JSON.parse(window.localStorage.getItem(PROJECT_AUTOMATIONS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: ProjectAutomations = {};
    for (const [projectId, record] of Object.entries(value)) {
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      const candidate = record as Partial<ProjectAutomationRecord>;
      const legacyIntervalMinutes = (record as { intervalMinutes?: unknown }).intervalMinutes;
      const intervalSeconds = candidate.intervalSeconds ?? (
        typeof legacyIntervalMinutes === "number" && [5, 10, 15, 30, 60].includes(legacyIntervalMinutes)
          ? legacyIntervalMinutes * 60
          : 5
      );
      const model = candidate.model ?? "gpt-5.5";
      const reasoningEffort = candidate.reasoningEffort ?? "high";
      const enabledByUser = candidate.enabledByUser ?? candidate.status === "ACTIVE";
      const quotaAware = candidate.quotaAware ?? false;
      if (
        (candidate.automationId !== undefined && typeof candidate.automationId !== "string")
        || typeof candidate.codexProjectId !== "string"
        || (candidate.status !== "ACTIVE" && candidate.status !== "PAUSED")
        || !isAutomationIntervalSeconds(intervalSeconds)
        || !isAutomationModel(model)
        || !isAutomationReasoningEffort(reasoningEffort)
        || !isSupportedModelEffort(model, reasoningEffort)
        || (candidate.status === "ACTIVE" && !candidate.automationId)
        || typeof enabledByUser !== "boolean"
        || typeof quotaAware !== "boolean"
      ) continue;
      const quota = isAutomationQuotaStatus(candidate.quota) ? candidate.quota : undefined;
      result[projectId] = {
        automationId: candidate.automationId,
        codexProjectId: candidate.codexProjectId,
        status: candidate.status,
        enabledByUser,
        quotaAware,
        ...(quota ? { quota } : {}),
        intervalSeconds,
        model,
        reasoningEffort,
      };
    }
    return result;
  } catch {
    return {};
  }
}

function isAutomationQuotaStatus(value: unknown): value is AutomationQuotaStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AutomationQuotaStatus>;
  return (
    (candidate.state === "available"
      || candidate.state === "blocked"
      || candidate.state === "unknown"
      || candidate.state === "unavailable")
    && Number.isFinite(candidate.checkedAt)
    && (candidate.resetsAt === undefined || Number.isFinite(candidate.resetsAt))
    && (candidate.reason === undefined || candidate.reason === "api-key")
  );
}

function isAutomationHostPolicy(
  value: AutomationHostResponse["policy"] | undefined,
): value is NonNullable<AutomationHostResponse["policy"]> {
  return Boolean(
    value
    && (value.automationId === undefined || typeof value.automationId === "string")
    && typeof value.enabledByUser === "boolean"
    && typeof value.quotaAware === "boolean"
    && isAutomationIntervalSeconds(value.intervalSeconds)
    && isAutomationModel(value.model)
    && isAutomationReasoningEffort(value.reasoningEffort)
    && isSupportedModelEffort(value.model, value.reasoningEffort),
  );
}

function isAutomationIntervalSeconds(value: unknown): value is AutomationIntervalSeconds {
  return value === 5 || value === 10 || value === 30 || value === 60
    || value === 300 || value === 600 || value === 900 || value === 1800 || value === 3600;
}

function intervalSecondsFromRrule(value: string): AutomationIntervalSeconds | null {
  const seconds = /^RRULE:FREQ=SECONDLY;INTERVAL=(5|10|30|60|300|600|900|1800|3600)$/.exec(value);
  if (seconds) return Number(seconds[1]) as AutomationIntervalSeconds;
  const legacyMinutes = /^RRULE:FREQ=MINUTELY;INTERVAL=(5|10|15|30|60)$/.exec(value);
  return legacyMinutes ? Number(legacyMinutes[1]) * 60 as AutomationIntervalSeconds : null;
}

function workspaceName(path?: string): string | null {
  if (!path) return null;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong while loading your issues.";
}

function isAutomationHostItem(value: unknown): value is AutomationHostItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<AutomationHostItem>;
  return (
    typeof item.id === "string"
    && (item.status === "ACTIVE" || item.status === "PAUSED")
    && isAutomationModel(item.model)
    && isAutomationReasoningEffort(item.reasoningEffort)
    && isSupportedModelEffort(item.model, item.reasoningEffort)
    && typeof item.rrule === "string"
    && intervalSecondsFromRrule(item.rrule) !== null
  );
}

function isLocalTaskboardOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin);
    return (protocol === "http:" || protocol === "https:")
      && (hostname === "127.0.0.1" || hostname === "localhost");
  } catch {
    return false;
  }
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt),
  );
}

function taskToDraft(task: Task): TaskDraft {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    labels: task.labels,
    workflowId: task.workflowId,
    developmentContext: task.developmentContext,
    dueDate: task.dueDate,
    recurrence: task.recurrence,
  };
}

interface LocalRealtimeSyncProps {
  selectedProjectId: string;
  detailTaskId: string | null;
  refreshProjectList: () => Promise<void>;
  refreshTasks: (
    projectId: string,
    options?: { quiet?: boolean; signal?: AbortSignal },
  ) => Promise<void>;
  refreshWorkflowOptions: (projectId: string, signal?: AbortSignal) => Promise<void>;
  setConnection: Dispatch<SetStateAction<ConnectionState>>;
  setCommentsRevision: Dispatch<SetStateAction<number>>;
  setAttachmentsRevision: Dispatch<SetStateAction<number>>;
}

function LocalRealtimeSync({
  selectedProjectId,
  detailTaskId,
  refreshProjectList,
  refreshTasks,
  refreshWorkflowOptions,
  setConnection,
  setCommentsRevision,
  setAttachmentsRevision,
}: LocalRealtimeSyncProps) {
  useEffect(() => {
    const source = new EventSource("/api/events");
    let refreshTimer: number | undefined;
    let refreshProjectsPending = false;
    let refreshTasksPending = false;

    const scheduleRefresh = (options: { projects?: boolean; tasks?: boolean }) => {
      refreshProjectsPending ||= options.projects === true;
      refreshTasksPending ||= options.tasks === true;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        if (refreshProjectsPending) void refreshProjectList();
        if (refreshTasksPending && selectedProjectId) {
          void refreshTasks(selectedProjectId, { quiet: true });
        }
        refreshProjectsPending = false;
        refreshTasksPending = false;
      }, 120);
    };

    const handleEvent = (event: Event) => {
      const message = event as MessageEvent<string>;
      let payload: { projectId?: string; taskId?: string } = {};
      try {
        payload = JSON.parse(message.data) as { projectId?: string; taskId?: string };
      } catch {
        // A malformed event should not interrupt later updates.
      }
      const affectsSelectedProject = Boolean(selectedProjectId)
        && (!payload.projectId || payload.projectId === selectedProjectId);
      if (event.type === "project.created" || event.type === "project.updated") {
        scheduleRefresh({ projects: true });
        return;
      }
      if (event.type.startsWith("task.")) {
        scheduleRefresh({ projects: true, tasks: true });
        return;
      }
      if (event.type === "workflow.updated") {
        if (affectsSelectedProject && selectedProjectId) void refreshWorkflowOptions(selectedProjectId);
        return;
      }
      if (event.type.startsWith("comment.")) {
        if (!detailTaskId || !payload.taskId || payload.taskId === detailTaskId) {
          setCommentsRevision((current) => current + 1);
        }
        scheduleRefresh({ tasks: true });
        return;
      }
      if (event.type.startsWith("attachment.")) {
        if (!detailTaskId || !payload.taskId || payload.taskId === detailTaskId) {
          setAttachmentsRevision((current) => current + 1);
          setCommentsRevision((current) => current + 1);
        }
      }
    };

    EVENT_NAMES.forEach((name) => source.addEventListener(name, handleEvent));
    source.onopen = () => {
      setConnection("live");
      scheduleRefresh({ projects: true, tasks: Boolean(selectedProjectId) });
      if (selectedProjectId) void refreshWorkflowOptions(selectedProjectId);
      if (detailTaskId) {
        setCommentsRevision((current) => current + 1);
        setAttachmentsRevision((current) => current + 1);
      }
    };
    source.onerror = () => setConnection("reconnecting");

    return () => {
      window.clearTimeout(refreshTimer);
      EVENT_NAMES.forEach((name) => source.removeEventListener(name, handleEvent));
      source.close();
    };
  }, [
    detailTaskId,
    refreshProjectList,
    refreshTasks,
    refreshWorkflowOptions,
    selectedProjectId,
    setAttachmentsRevision,
    setCommentsRevision,
    setConnection,
  ]);

  return null;
}

export function App() {
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const embedded = query.get("host") === "codex";
  const undoShortcut = navigator.userAgent.includes("Macintosh") ? "⌘Z" : "Ctrl+Z";
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [hostContext, setHostContext] = useState<HostContext | null>(null);
  const [developmentScan, setDevelopmentScan] = useState<DevelopmentScan>({ workspacePath: null, contexts: [] });
  const [developmentScanLoading, setDevelopmentScanLoading] = useState(false);
  const [manageTaskboardSkillPath, setManageTaskboardSkillPath] = useState("");
  const [taskboardMetadata, setTaskboardMetadata] = useState<TaskboardMetadata | null>(null);
  const [localAiChatAvailable, setLocalAiChatAvailable] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [codexResourceProjects, setCodexResourceProjects] = useState<Array<{ id: string; workspacePath: string }>>([]);
  const [codexThreadResourcesLoaded, setCodexThreadResourcesLoaded] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [codexThreadsByProject, setCodexThreadsByProject] = useState<Record<string, CodexThreadSummary[]>>({});
  const [unassignedCodexThreads, setUnassignedCodexThreads] = useState<CodexThreadSummary[]>([]);
  const [publisherText, setPublisherText] = useState("");
  const [publisherProjectId, setPublisherProjectId] = useState("");
  const [publisherThreads, setPublisherThreads] = useState<ThreadResource[]>([]);
  const [selectedThreadKeys, setSelectedThreadKeys] = useState<Set<string>>(() => new Set());
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [hasLoadedTasks, setHasLoadedTasks] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState(readTaskFilters);
  const [boardView, setBoardView] = useState<BoardView>("issues");
  const [activeStatusDrawer, setActiveStatusDrawer] = useState<TaskStatus | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [detailTaskIdentifier, setDetailTaskIdentifier] = useState<string | null>(
    () => readIssueIdentifier(window.location.search),
  );
  const [commentsRevision, setCommentsRevision] = useState(0);
  const [attachmentsRevision, setAttachmentsRevision] = useState(0);
  const [workflowRevision, setWorkflowRevision] = useState(0);
  const [workflowOptions, setWorkflowOptions] = useState<WorkflowOption[]>(DEFAULT_WORKFLOW_OPTIONS);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [draggedTaskHeight, setDraggedTaskHeight] = useState(0);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(() => new Set());
  const [taskSelectionBox, setTaskSelectionBox] = useState<TaskSelectionBox | null>(null);
  const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);
  const [movingTaskId, setMovingTaskId] = useState<string | null>(null);
  const [settlingTaskId, setSettlingTaskId] = useState<string | null>(null);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [openingThreadTaskId, setOpeningThreadTaskId] = useState<string | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [favoriteProjectIds, setFavoriteProjectIds] = useState(readFavoriteProjectIds);
  const [deviceWorkspacePaths, setDeviceWorkspacePaths] = useState(readDeviceWorkspacePaths);
  const [projectAutomations, setProjectAutomations] = useState(readProjectAutomations);
  const [automationPending, setAutomationPending] = useState(false);
  const [automationError, setAutomationError] = useState<string | null>(null);
  const [announcement, setAnnouncementValue] = useState("");
  const [undoNotice, setUndoNotice] = useState<UndoNotice | null>(null);
  const tasksRequestRef = useRef(0);
  const tasksRef = useRef<Task[]>([]);
  const undoSequenceRef = useRef(0);
  const undoStackRef = useRef<UndoOperation[]>([]);
  const undoInFlightRef = useRef(false);
  const dragRegionRef = useRef<HTMLDivElement>(null);
  const boardScrollRef = useRef<HTMLDivElement>(null);
  const taskSelectionPointerRef = useRef<number | null>(null);
  const selectedProjectIdRef = useRef(selectedProjectId);
  selectedProjectIdRef.current = selectedProjectId;

  const revisionPollingInterval = getRevisionPollingInterval(taskboardMetadata);
  const pendingAutomationRequestsRef = useRef(new Map<string, PendingAutomationRequest>());
  const automationRequestInFlightRef = useRef(false);
  const projectAutomationsRef = useRef(projectAutomations);

  const setAnnouncement = useCallback((message: string) => {
    setUndoNotice(null);
    setAnnouncementValue(message);
  }, []);

  const rememberDeviceWorkspacePath = useCallback((projectId: string, workspacePath: string) => {
    const normalizedPath = workspacePath.trim();
    setDeviceWorkspacePaths((current) => {
      if (current[projectId] === normalizedPath || (!normalizedPath && !(projectId in current))) {
        return current;
      }
      const next = { ...current };
      if (normalizedPath) next[projectId] = normalizedPath;
      else delete next[projectId];
      window.localStorage.setItem(DEVICE_WORKSPACE_PATHS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const currentUser = hostContext?.user ?? DEFAULT_USER_ACTOR;
  const publisherProject = projects.find((project) => project.id === publisherProjectId)
    ?? projects.find((project) => project.id === selectedProjectId)
    ?? projects[0]
    ?? null;
  const selectedDeviceWorkspacePath = deviceWorkspacePaths[selectedProjectId];
  const editorContextProjectId = editor?.projectId ?? selectedProjectId;
  const editorContextProject = projects.find((project) => project.id === editorContextProjectId) ?? null;
  const editorDeviceWorkspacePath = deviceWorkspacePaths[editorContextProjectId]
    ?? editorContextProject?.workspacePath
    ?? undefined;
  const selectedProjectAutomation = projectAutomations[GLOBAL_AUTOMATION_PROJECT_ID];
  const automationProjectContext = useMemo(() => {
    if (!isLocalTaskboardOrigin(window.location.origin)) {
      return { unavailableReason: "仅本地任务面板可用" };
    }
    if (!manageTaskboardSkillPath) {
      return { unavailableReason: "任务面板还没有读取到 Skill 路径" };
    }
    if (!localAiChatAvailable) {
      return { unavailableReason: "Windows 本机未检测到可用的 AI 命令行" };
    }
    return {
      codexProjectId: GLOBAL_AUTOMATION_PROJECT_ID,
      unavailableReason: null,
    };
  }, [
    localAiChatAvailable,
    manageTaskboardSkillPath,
  ]);
  const detailTask = detailTaskIdentifier
    ? tasks.find((task) => task.identifier === detailTaskIdentifier) ?? null
    : null;
  const detailProject = detailTask
    ? projects.find((project) => project.id === detailTask.projectId) ?? null
    : null;
  const detailTaskId = detailTask?.id ?? null;
  const contextMenuTask = contextMenu
    ? tasks.find((task) => task.id === contextMenu.taskId) ?? null
    : null;
  const availableLabels = useMemo(
    () => [...new Set([
      ...DEFAULT_LABELS.map((label) => label.name),
      ...tasks.flatMap((task) => task.labels),
    ])],
    [tasks],
  );
  const projectChoices = useMemo<ProjectChoice[]>(() => {
    const persistedById = new Map(projects.map((project) => [project.id, project]));
    const seen = new Set<string>();
    const choices: ProjectChoice[] = [];
    for (const project of hostContext?.projects ?? []) {
      if (!project.id || !project.name || seen.has(project.id)) continue;
      seen.add(project.id);
      choices.push({
        id: project.id,
        name: persistedById.get(project.id)?.name ?? project.name,
        issueCount: persistedById.get(project.id)?.issueCount ?? 0,
        inCodex: true,
        persisted: persistedById.has(project.id),
      });
    }
    for (const project of projects) {
      if (seen.has(project.id)) continue;
      choices.push({
        id: project.id,
        name: project.name,
        issueCount: project.issueCount,
        inCodex: false,
        persisted: true,
      });
    }
    return choices.sort((left, right) => (
      Number(favoriteProjectIds.has(right.id)) - Number(favoriteProjectIds.has(left.id))
    ));
  }, [favoriteProjectIds, hostContext?.projects, projects]);
  const resourceProjectChoices = useMemo<ProjectChoice[]>(() => {
    const persistedById = new Map(projects.map((project) => [project.id, project]));
    const hostProjectsById = new Map((hostContext?.projects ?? []).map((project) => [project.id, project]));
    const sourceProjects = codexThreadResourcesLoaded
      ? codexResourceProjects.map((project) => ({
          id: project.id,
          name: hostProjectsById.get(project.id)?.name
            ?? persistedById.get(project.id)?.name
            ?? workspaceName(project.workspacePath)
            ?? project.id,
        }))
      : (hostContext?.projects ?? []);
    const seen = new Set<string>();
    return sourceProjects.flatMap((project) => {
      if (!project.id || !project.name || seen.has(project.id)) return [];
      seen.add(project.id);
      const persisted = persistedById.get(project.id);
      return [{
        id: project.id,
        name: persisted?.name ?? project.name,
        issueCount: persisted?.issueCount ?? 0,
        inCodex: true,
        persisted: Boolean(persisted),
      }];
    }).sort((left, right) => (
      Number(favoriteProjectIds.has(right.id)) - Number(favoriteProjectIds.has(left.id))
    ));
  }, [codexResourceProjects, codexThreadResourcesLoaded, favoriteProjectIds, hostContext?.projects, projects]);
  const projectsWithIssues = useMemo(
    () => projectChoices.filter((project) => project.issueCount > 0),
    [projectChoices],
  );
  const projectsWithoutIssues = useMemo(
    () => projectChoices.filter((project) => project.issueCount === 0),
    [projectChoices],
  );
  const selectedThreadResources = useMemo(() => {
    const resources: ThreadResource[] = [];
    for (const project of resourceProjectChoices) {
      for (const thread of codexThreadsByProject[project.id] ?? []) {
        if (!selectedThreadKeys.has(`${project.id}:${thread.id}`)) continue;
        resources.push({
          projectId: project.id,
          projectName: project.name,
          threadId: thread.id,
          threadName: thread.name,
        });
      }
    }
    for (const thread of unassignedCodexThreads) {
      if (!selectedThreadKeys.has(`${NON_PROJECT_RESOURCE_ID}:${thread.id}`)) continue;
      resources.push({
        projectId: null,
        projectName: "非项目会话",
        threadId: thread.id,
        threadName: thread.name,
      });
    }
    return resources;
  }, [codexThreadsByProject, resourceProjectChoices, selectedThreadKeys, unassignedCodexThreads]);
  const validThreadKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const project of resourceProjectChoices) {
      for (const thread of codexThreadsByProject[project.id] ?? []) {
        keys.add(`${project.id}:${thread.id}`);
      }
    }
    for (const thread of unassignedCodexThreads) {
      keys.add(`${NON_PROJECT_RESOURCE_ID}:${thread.id}`);
    }
    return keys;
  }, [codexThreadsByProject, resourceProjectChoices, unassignedCodexThreads]);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    setSelectedThreadKeys((current) => {
      const next = new Set([...current].filter((key) => validThreadKeys.has(key)));
      return next.size === current.size ? current : next;
    });
    setPublisherThreads((current) => {
      const next = current.filter((thread) => validThreadKeys.has(threadKey(thread.projectId, thread.threadId)));
      return next.length === current.length ? current : next;
    });
  }, [validThreadKeys]);

  const writeProjectAutomation = useCallback((
    projectId: string,
    record: ProjectAutomationRecord | null | undefined,
  ) => {
    setProjectAutomations((current) => {
      if (
        record
        && current[projectId]?.automationId === record.automationId
        && current[projectId]?.codexProjectId === record.codexProjectId
        && current[projectId]?.status === record.status
        && current[projectId]?.enabledByUser === record.enabledByUser
        && current[projectId]?.quotaAware === record.quotaAware
        && JSON.stringify(current[projectId]?.quota) === JSON.stringify(record.quota)
        && current[projectId]?.intervalSeconds === record.intervalSeconds
        && current[projectId]?.model === record.model
        && current[projectId]?.reasoningEffort === record.reasoningEffort
      ) {
        return current;
      }
      const next = { ...current };
      if (record) next[projectId] = record;
      else delete next[projectId];
      projectAutomationsRef.current = next;
      window.localStorage.setItem(PROJECT_AUTOMATIONS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const sendAutomationRequest = useCallback((
    operation: "ensure-active" | "pause" | "list" | "apply-policy",
    options: Pick<
      ProjectAutomationRecord,
      "enabledByUser" | "quotaAware" | "intervalSeconds" | "model" | "reasoningEffort"
    >,
    _automationId?: string,
  ) => {
    if (
      !automationProjectContext.codexProjectId
    ) {
      return Promise.reject(new Error(
        automationProjectContext.unavailableReason ?? "Cannot read project automation settings",
      ));
    }
    if (operation === "list") {
      return getProjectAutomation<AutomationHostResponse>(GLOBAL_AUTOMATION_PROJECT_ID);
    }
    return updateProjectAutomation<AutomationHostResponse>(GLOBAL_AUTOMATION_PROJECT_ID, {
      enabledByUser: options.enabledByUser,
      quotaAware: false,
      intervalSeconds: options.intervalSeconds,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
    });
  }, [
    automationProjectContext,
  ]);

  const reconcileProjectAutomation = useCallback(async () => {
    if (automationProjectContext.unavailableReason) {
      setAutomationError(null);
      return;
    }
    if (!automationProjectContext.codexProjectId || automationRequestInFlightRef.current) return;
    const stored = projectAutomationsRef.current[GLOBAL_AUTOMATION_PROJECT_ID];
    automationRequestInFlightRef.current = true;
    setAutomationPending(true);
    setAutomationError(null);
    try {
      const options = stored ?? {
        status: "PAUSED" as const,
        ...DEFAULT_AUTOMATION_OPTIONS,
      };
      let response = await sendAutomationRequest("list", options, stored?.automationId);
      if (!isAutomationHostPolicy(response.policy) && stored) {
        response = await sendAutomationRequest("apply-policy", options, stored.automationId);
      }
      if (response.execution?.lastError) {
        setAutomationError(`最近一次自动执行失败：${response.execution.lastError}`);
      }
      const items = Array.isArray(response.items)
        ? response.items.filter(isAutomationHostItem)
        : [];
      const policy = isAutomationHostPolicy(response.policy) ? response.policy : null;
      if (!policy) return;
      const item = (isAutomationHostItem(response.item) ? response.item : undefined)
        ?? items.find((candidate) => candidate.id === policy.automationId)
        ?? (items.length === 1 ? items[0] : undefined);
      writeProjectAutomation(GLOBAL_AUTOMATION_PROJECT_ID, {
        automationId: item?.id ?? policy.automationId,
        codexProjectId: automationProjectContext.codexProjectId,
        status: item?.status ?? "PAUSED",
        enabledByUser: policy.enabledByUser,
        quotaAware: policy.quotaAware,
        ...(response.quota ? { quota: response.quota } : {}),
        intervalSeconds: policy.intervalSeconds,
        model: policy.model,
        reasoningEffort: policy.reasoningEffort,
      });
    } catch (error) {
      setAutomationError(error instanceof Error ? error.message : "Cannot read automation status");
    } finally {
      automationRequestInFlightRef.current = false;
      setAutomationPending(false);
    }
  }, [
    automationProjectContext,
    sendAutomationRequest,
    writeProjectAutomation,
  ]);

  const saveProjectAutomation = useCallback(async (options: {
    enabledByUser: boolean;
    quotaAware: boolean;
    intervalSeconds: AutomationIntervalSeconds;
    model: AutomationModel;
    reasoningEffort: AutomationReasoningEffort;
  }) => {
    const stored = projectAutomations[GLOBAL_AUTOMATION_PROJECT_ID];
    if (
      automationProjectContext.unavailableReason
      || !automationProjectContext.codexProjectId
      || automationRequestInFlightRef.current
    ) return;
    const previousRecord = stored;
    automationRequestInFlightRef.current = true;
    setAutomationPending(true);
    setAutomationError(null);
    try {
      const response = await sendAutomationRequest("apply-policy", options, stored?.automationId);
      if (response.execution?.lastError) {
        setAutomationError(`最近一次自动执行失败：${response.execution.lastError}`);
      }
      const item = isAutomationHostItem(response.item) ? response.item : undefined;
      writeProjectAutomation(GLOBAL_AUTOMATION_PROJECT_ID, {
        automationId: item?.id,
        codexProjectId: automationProjectContext.codexProjectId,
        status: item?.status ?? "PAUSED",
        enabledByUser: options.enabledByUser,
        quotaAware: options.quotaAware,
        ...(response.quota ? { quota: response.quota } : {}),
        intervalSeconds: options.intervalSeconds,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      });
    } catch (error) {
      writeProjectAutomation(GLOBAL_AUTOMATION_PROJECT_ID, previousRecord);
      setAutomationError(error instanceof Error ? error.message : "Cannot update automation");
    } finally {
      automationRequestInFlightRef.current = false;
      setAutomationPending(false);
    }
  }, [
    automationProjectContext,
    projectAutomations,
    sendAutomationRequest,
    writeProjectAutomation,
  ]);

  function openTaskDetail(task: Pick<Task, "identifier" | "projectId">) {
    closeContextMenu();
    setProjectMenuOpen(false);
    setDetailTaskIdentifier(task.identifier);
    const currentIssue = readIssueIdentifier(window.location.search);
    const boardUrl = buildIssueUrl(window.location.href, task.projectId, null);
    if (!currentIssue) {
      window.history.replaceState(window.history.state, "", boardUrl);
    }
    const detailUrl = buildIssueUrl(
      currentIssue ? window.location.href : boardUrl.href,
      task.projectId,
      task.identifier,
    );
    window.history.pushState(window.history.state, "", detailUrl);
  }

  function closeTaskDetail() {
    setDetailTaskIdentifier(null);
    const url = buildIssueUrl(window.location.href, selectedProjectId || null, null);
    window.history.replaceState(window.history.state, "", url);
  }

  useEffect(() => {
    function syncRouteFromLocation() {
      const url = new URL(window.location.href);
      const routeProjectId = url.searchParams.get("project") ?? "";
      setDetailTaskIdentifier(readIssueIdentifier(url.search));
      if (routeProjectId === selectedProjectId) return;
      setBoardView("issues");
      setSelectedProjectId(routeProjectId);
      if (routeProjectId) window.localStorage.setItem(LAST_PROJECT_KEY, routeProjectId);
      else window.localStorage.removeItem(LAST_PROJECT_KEY);
    }

    window.addEventListener("popstate", syncRouteFromLocation);
    return () => window.removeEventListener("popstate", syncRouteFromLocation);
  }, [selectedProjectId]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.embedded = String(embedded);
    document.documentElement.style.colorScheme = theme;
    if (!embedded) window.localStorage.setItem("taskboard.theme", theme);
  }, [embedded, theme]);

  useEffect(() => {
    writeTaskFilters(filters);
  }, [filters]);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    if (!projectMenuOpen) return;
    function closeProjectMenu(event: PointerEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-project-switcher]")) setProjectMenuOpen(false);
    }
    function closeProjectMenuWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setProjectMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeProjectMenu);
    window.addEventListener("keydown", closeProjectMenuWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeProjectMenu);
      window.removeEventListener("keydown", closeProjectMenuWithEscape);
    };
  }, [projectMenuOpen]);

  useEffect(() => {
    setAutomationError(null);
    void reconcileProjectAutomation();
  }, [selectedProjectId, reconcileProjectAutomation]);

  useEffect(() => {
    if (!embedded || window.parent === window) return;

    function receiveHostMessage(event: MessageEvent) {
      if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
      const message = event.data as { type?: string; payload?: unknown; theme?: unknown };

      if (message.type === "taskboard:automation-response" && message.payload) {
        const payload = message.payload as Partial<AutomationHostResponse>;
        if (typeof payload.requestId !== "string") return;
        const pending = pendingAutomationRequestsRef.current.get(payload.requestId);
        if (!pending) return;
        window.clearTimeout(pending.timeoutId);
        pendingAutomationRequestsRef.current.delete(payload.requestId);
        if (payload.ok) pending.resolve(payload as AutomationHostResponse);
        else pending.reject(new Error(typeof payload.error === "string" ? payload.error : "Codex cannot update automation"));


        return;
      }

      if (message.type === "taskboard:theme" && isTheme(message.theme)) {
        setTheme(message.theme);
        return;
      }

      if (message.type === "taskboard:thread-prepared") {
        setOpeningThreadTaskId(null);
        return;
      }

      if (message.type === "taskboard:thread-create-error" && message.payload) {
        const payload = message.payload as { taskId?: unknown; error?: unknown };
        setOpeningThreadTaskId(null);
        setActionError(typeof payload.error === "string" ? payload.error : "Cannot create Codex thread.");
        return;
      }

      if (message.type !== "taskboard:host-context" || !message.payload) return;
      const payload = message.payload as HostContext;
      setHostContext(payload);
      setCurrentUserActor(payload.user);
      if (isTheme(payload.theme)) setTheme(payload.theme);
    }

    window.addEventListener("message", receiveHostMessage);
    window.parent.postMessage({ type: "taskboard:ready" }, "*");
    return () => {
      window.removeEventListener("message", receiveHostMessage);
      for (const pending of pendingAutomationRequestsRef.current.values()) {
        window.clearTimeout(pending.timeoutId);
      }
      pendingAutomationRequestsRef.current.clear();
    };
  }, [embedded]);

  useLayoutEffect(() => {
    if (!embedded || window.parent === window || !dragRegionRef.current) return;
    const region = dragRegionRef.current;
    const publish = () => {
      const rect = region.getBoundingClientRect();
      window.parent.postMessage({
        type: "taskboard:drag-region",
        payload: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      }, "*");
    };
    const observer = new ResizeObserver(publish);
    observer.observe(region);
    window.addEventListener("resize", publish);
    publish();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publish);
      window.parent.postMessage({ type: "taskboard:drag-region", payload: null }, "*");
    };
  }, [detailTaskId, embedded, selectedProjectId]);

  const loadProjectList = useCallback(async (signal?: AbortSignal) => {
    setProjectsLoading(true);
    setLoadError(null);
    try {
      const [nextProjects, metadata, workspaces] = await Promise.all([
        listProjects(signal),
        getTaskboardMetadata(signal),
        listDeviceWorkspaces(signal),
      ]);
      setTaskboardMetadata((current) => (
        current
        && current.mode === metadata.mode
        && current.realtime?.transport === metadata.realtime?.transport
        && current.realtime?.intervalMs === metadata.realtime?.intervalMs
        && current.manageTaskboardSkillPath === metadata.manageTaskboardSkillPath
        && current.localCapabilities?.available === metadata.localCapabilities?.available
          ? current
          : metadata
      ));
      setManageTaskboardSkillPath(metadata.manageTaskboardSkillPath ?? "");
      setLocalAiChatAvailable(metadata.capabilities?.localAiChat === true);
      setDeviceWorkspacePaths((current) => {
        const next = { ...current, ...workspaces };
        if (JSON.stringify(next) === JSON.stringify(current)) return current;
        window.localStorage.setItem(DEVICE_WORKSPACE_PATHS_KEY, JSON.stringify(next));
        return next;
      });
      setProjects(nextProjects);
      const fromQuery = new URLSearchParams(window.location.search).get("project");
      const remembered = window.localStorage.getItem(LAST_PROJECT_KEY);
      const current = selectedProjectIdRef.current;
      const nextProjectId = (
        (fromQuery && nextProjects.some((project) => project.id === fromQuery) ? fromQuery : null)
        ?? (current && nextProjects.some((project) => project.id === current) ? current : null)
        ?? (remembered && nextProjects.some((project) => project.id === remembered) ? remembered : null)
        ?? nextProjects[0]?.id
        ?? ""
      );
      setSelectedProjectId(nextProjectId);
      setPublisherProjectId((currentPublisherProjectId) => (
        currentPublisherProjectId && nextProjects.some((project) => project.id === currentPublisherProjectId)
          ? currentPublisherProjectId
          : nextProjectId
      ));
      if (nextProjectId) {
        window.localStorage.setItem(LAST_PROJECT_KEY, nextProjectId);
        const issueIdentifier = readIssueIdentifier(window.location.search);
        window.history.replaceState(null, "", buildIssueUrl(window.location.href, nextProjectId, issueIdentifier));
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") setLoadError(errorMessage(error));
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadProjectList(controller.signal);
    return () => controller.abort();
  }, [loadProjectList]);

  useEffect(() => {
    if (!localAiChatAvailable) {
      setCodexResourceProjects([]);
      setCodexThreadResourcesLoaded(false);
      setCodexThreadsByProject({});
      setUnassignedCodexThreads([]);
      return;
    }
    const controller = new AbortController();
    let loading = false;
    const refresh = async () => {
      if (loading || controller.signal.aborted) return;
      loading = true;
      try {
        const snapshot = await listCodexThreadResources(controller.signal);
        if (controller.signal.aborted) return;
        setCodexResourceProjects(snapshot.projects);
        setCodexThreadResourcesLoaded(true);
        setCodexThreadsByProject(snapshot.projectThreads);
        setUnassignedCodexThreads(snapshot.unassignedThreads);
        setDeviceWorkspacePaths((current) => {
          const next = { ...current };
          for (const project of snapshot.projects) next[project.id] = project.workspacePath;
          if (JSON.stringify(next) === JSON.stringify(current)) return current;
          window.localStorage.setItem(DEVICE_WORKSPACE_PATHS_KEY, JSON.stringify(next));
          return next;
        });
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          setCodexResourceProjects([]);
          setCodexThreadResourcesLoaded(false);
          setCodexThreadsByProject({});
          setUnassignedCodexThreads([]);
        }
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), CODEX_THREAD_RESOURCE_POLL_MS);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [localAiChatAvailable]);

  const refreshProjectList = useCallback(async () => {
    try {
      setProjects(await listProjects());
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, []);

  const refreshTasks = useCallback(async (
    _projectId?: string,
    options: { quiet?: boolean; signal?: AbortSignal } = {},
  ) => {
    const requestId = ++tasksRequestRef.current;
    if (!options.quiet) setTasksLoading(true);
    setLoadError(null);
    try {
      const nextTasks = await listTasks(null, options.signal);
      if (requestId !== tasksRequestRef.current) return;
      setTasks(sortTasks(nextTasks));
      setHasLoadedTasks(true);
    } catch (error) {
      if ((error as Error).name !== "AbortError" && requestId === tasksRequestRef.current) {
        setLoadError(errorMessage(error));
      }
    } finally {
      if (!options.quiet && requestId === tasksRequestRef.current) setTasksLoading(false);
    }
  }, []);

  useEffect(() => {
    if (projects.length === 0) {
      setTasks([]);
      setHasLoadedTasks(false);
      return;
    }
    setHasLoadedTasks(false);
    const controller = new AbortController();
    void refreshTasks(selectedProjectId, { signal: controller.signal });
    return () => controller.abort();
  }, [projects.length, refreshTasks, selectedProjectId]);

  const refreshWorkflowOptions = useCallback(async (projectId: string, signal?: AbortSignal) => {
    const record = await getWorkflowWorkspace<unknown>(projectId, signal);
    if (!signal?.aborted) setWorkflowOptions(workflowOptionsFromWorkspace(record.workspace));
  }, []);

  useEffect(() => {
    if (!editorContextProjectId) {
      setWorkflowOptions(DEFAULT_WORKFLOW_OPTIONS);
      return;
    }
    setWorkflowOptions(workflowOptionsFromWorkspace(readLegacyWorkflowWorkspace(editorContextProjectId)));
    const controller = new AbortController();
    void refreshWorkflowOptions(editorContextProjectId, controller.signal).catch((error) => {
      if ((error as Error).name !== "AbortError") {
        setWorkflowOptions(workflowOptionsFromWorkspace(readLegacyWorkflowWorkspace(editorContextProjectId)));
      }
    });
    return () => controller.abort();
  }, [editorContextProjectId, refreshWorkflowOptions]);

  useEffect(() => {
    if (!editorContextProjectId) {
      setDevelopmentScan({ workspacePath: null, contexts: [] });
      return;
    }
    const controller = new AbortController();
    const codexProjectId = editorContextProjectId === "local" ? hostContext?.projectId : editorContextProjectId;
    const codexThreadId = hostContext?.threadId ?? detailTask?.threadId ?? undefined;
    setDevelopmentScan({ workspacePath: editorDeviceWorkspacePath ?? null, contexts: [] });
    setDevelopmentScanLoading(true);
    void listDevelopmentContexts(
      editorContextProjectId,
      codexProjectId,
      codexThreadId,
      controller.signal,
      editorDeviceWorkspacePath,
    )
      .then((scan) => {
        setDevelopmentScan(scan);
        if (scan.workspacePath) rememberDeviceWorkspacePath(editorContextProjectId, scan.workspacePath);
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") {
          setDevelopmentScan({ workspacePath: editorDeviceWorkspacePath ?? null, contexts: [] });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setDevelopmentScanLoading(false);
      });
    return () => controller.abort();
  }, [
    detailTask?.threadId,
    hostContext?.projectId,
    hostContext?.threadId,
    rememberDeviceWorkspacePath,
    editorContextProjectId,
    editorDeviceWorkspacePath,
  ]);

  useEffect(() => {
    if (revisionPollingInterval === null) return;
    const controller = new AbortController();
    setConnection("connecting");
    const poller = createRevisionPoller({
      intervalMs: revisionPollingInterval,
      fetchRevision: async (since: number) => {
        try {
          const result = await getTaskboardRevision(since, controller.signal);
          setConnection("live");
          return result;
        } catch (error) {
          if (!controller.signal.aborted) setConnection("reconnecting");
          throw error;
        }
      },
      onInvalidate: () => {
        void refreshProjectList();
        const projectId = selectedProjectIdRef.current;
        if (projectId) {
          void refreshTasks(projectId, { quiet: true });
          void refreshWorkflowOptions(projectId).catch(() => {});
        }
        setWorkflowRevision((current) => current + 1);
        setCommentsRevision((current) => current + 1);
        setAttachmentsRevision((current) => current + 1);
      },
    });
    poller.start();
    return () => {
      controller.abort();
      poller.stop();
    };
  }, [
    revisionPollingInterval,
    refreshProjectList,
    refreshTasks,
    refreshWorkflowOptions,
  ]);

  function pushUndo(message: string, undo: () => Promise<void>, showNotice = true) {
    const operation = { id: ++undoSequenceRef.current, message, undo };
    undoStackRef.current = [...undoStackRef.current.slice(-19), operation];
    setAnnouncementValue("");
    setUndoNotice(showNotice ? { id: operation.id, message } : null);
  }

  async function performUndo() {
    if (undoInFlightRef.current) return;
    const operation = undoStackRef.current.at(-1);
    if (!operation) return;
    undoStackRef.current = undoStackRef.current.slice(0, -1);
    undoInFlightRef.current = true;
    setUndoNotice(null);
    setProjectMenuOpen(false);
    closeContextMenu();
    setActionError(null);
    try {
      await operation.undo();
    } catch (error) {
      setActionError(`无法撤回这次操作：${errorMessage(error)}`);
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
    } finally {
      undoInFlightRef.current = false;
    }
  }

  async function restoreTaskDetails(
    snapshot: Task,
    changed: Task,
    assigneeTarget = assigneeTargetForActor(snapshot.assignee, currentUser),
  ) {
    const candidate = tasksRef.current.find((task) => task.id === changed.id);
    const current = candidate && candidate.version >= changed.version ? candidate : changed;
    const restored = await updateTaskRequest(current, {
      ...taskToDraft(snapshot),
      ...(assigneeTarget ? { assigneeTarget } : {}),
    });
    setTasks((tasks) => sortTasks(tasks.map((task) => task.id === restored.id ? restored : task)));
  }

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.matches("input, textarea, select, [contenteditable='true']");
      if (
        event.key.toLowerCase() === "z"
        && (event.metaKey || event.ctrlKey)
        && !event.shiftKey
        && !isTyping
        && !editor
      ) {
        event.preventDefault();
        void performUndo();
        return;
      }
      if (isTyping || contextMenu || projectMenuOpen) return;
      if (
        event.key.toLowerCase() === "c"
        && !event.metaKey
        && !event.ctrlKey
        && selectedProjectId
        && boardView === "issues"
      ) {
        event.preventDefault();
        setEditor({ task: null, status: "backlog", projectId: publisherProject?.id ?? selectedProjectId });
      }
      if (event.key === "/" && !detailTaskId && selectedProjectId && boardView === "issues") {
        event.preventDefault();
        document.getElementById("task-search")?.focus();
      }
      if (event.key === "Escape") {
        if (detailTaskId) closeTaskDetail();
        else if (activeStatusDrawer) setActiveStatusDrawer(null);
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [activeStatusDrawer, boardView, contextMenu, detailTaskId, editor, projectMenuOpen, publisherProject?.id, selectedProjectId]);

  const filteredTasks = useMemo(() => {
    return tasks.filter(
      (task) => matchesTaskSearch(task, search) && matchesTaskFilters(task, filters),
    );
  }, [filters, search, tasks]);

  const activeFilterCount = taskFilterCount(filters);

  const tasksByStatus = useMemo(() => {
    return Object.fromEntries(
      TASK_STATUSES.map((status) => [status, filteredTasks.filter((task) => task.status === status)]),
    ) as Record<TaskStatus, Task[]>;
  }, [filteredTasks]);

  function selectBoardView(view: BoardView) {
    closeContextMenu();
    setBoardView(view);
  }

  async function saveEditor(
    draft: TaskDraft,
    attachments: File[],
    inlineImages: PendingInlineImage[],
    batchTitles?: string[],
  ) {
    if (!editor) return;
    const targetProjectId = editor.task?.projectId ?? editor.projectId;
    if (!targetProjectId) return;
    setActionError(null);
    try {
      const creating = editor.task === null;
      if (creating && batchTitles && batchTitles.length > 1) {
        const savedTasks: Task[] = [];
        for (const title of batchTitles) {
          savedTasks.push(await createTaskRequest(targetProjectId, { ...draft, title }));
        }
        setProjects((current) => current.map((project) => (
          project.id === targetProjectId
            ? { ...project, issueCount: project.issueCount + savedTasks.length }
            : project
        )));
        setTasks((current) => sortTasks([
          ...current.filter((task) => !savedTasks.some((saved) => saved.id === task.id)),
          ...savedTasks,
        ]));
        setEditor(null);
        pushUndo(`Created ${savedTasks.length} tasks.`, async () => {
          await Promise.all(savedTasks.map((task) => archiveTaskRequest(task)));
          setTasks((current) => current.filter((task) => !savedTasks.some((saved) => saved.id === task.id)));
        });
        return;
      }
      let saved = editor.task
        ? await updateTaskRequest(editor.task, draft)
        : await createTaskRequest(targetProjectId, draft);
      if (creating) {
        setProjects((current) => current.map((project) => (
          project.id === targetProjectId
            ? { ...project, issueCount: project.issueCount + 1 }
            : project
        )));
      }
      let uploadedAttachments = 0;
      let failedAttachments = 0;
      if (creating && (attachments.length > 0 || inlineImages.length > 0)) {
        const [results, inlineAttachments] = await Promise.all([
          Promise.allSettled(
            attachments.map((file) => uploadAttachment(saved.id, file)),
          ),
          Promise.all(
            inlineImages.map((image) => uploadAttachment(saved.id, image.file)),
          ),
        ]);
        uploadedAttachments = results.filter((result) => result.status === "fulfilled").length;
        failedAttachments = results.length - uploadedAttachments;
        if (inlineImages.length > 0) {
          const description = resolveInlineMediaMarkdown(
            draft.description,
            inlineImages,
            inlineAttachments,
          );
          saved = await updateTaskRequest(saved, { ...draft, description });
        }
      }
      setTasks((current) => sortTasks([
        ...current.filter((task) => task.id !== saved.id),
        saved,
      ]));
      setEditor(null);
      if (failedAttachments > 0) {
        setActionError(`${saved.identifier} created, but ${failedAttachments} attachments failed to upload.`);
      }
      if (creating) {
        const totalUploaded = uploadedAttachments + inlineImages.length;
        const message = `${saved.identifier} created${totalUploaded > 0 ? ` with ${totalUploaded} attachment(s)` : ""}.`;
        pushUndo(message, async () => {
          const candidate = tasksRef.current.find((task) => task.id === saved.id);
          const current = candidate && candidate.version >= saved.version ? candidate : saved;
          await archiveTaskRequest(current);
          setTasks((tasks) => tasks.filter((task) => task.id !== saved.id));
        });
      } else if (editor.task) {
        const previous = editor.task;
        const previousAssigneeTarget = assigneeTargetForActor(previous.assignee, currentUser);
        if (!draft.assigneeTarget || previousAssigneeTarget) {
          pushUndo(
            `${saved.identifier} updated.`,
            () => restoreTaskDetails(previous, saved, previousAssigneeTarget),
          );
        }
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        void refreshTasks(selectedProjectId, { quiet: true });
      }
      throw error;
    }
  }

  async function moveTask(
    task: Task,
    status: TaskStatus,
    beforeTaskId: string | null = null,
    silent = false,
  ) {
    if (movingTaskId) {
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
      return;
    }

    const destination = tasks.filter((candidate) => (
      candidate.projectId === task.projectId && candidate.status === status && candidate.id !== task.id
    ));
    const insertionIndex = beforeTaskId
      ? destination.findIndex((candidate) => candidate.id === beforeTaskId)
      : destination.length;
    const targetIndex = insertionIndex < 0 ? destination.length : insertionIndex;
    const desiredOrder = [...destination];
    desiredOrder.splice(targetIndex, 0, task);
    const currentOrder = tasks.filter((candidate) => (
      candidate.projectId === task.projectId && candidate.status === status
    ));
    if (
      task.status === status
      && currentOrder.length === desiredOrder.length
      && currentOrder.every((candidate, index) => candidate.id === desiredOrder[index].id)
    ) {
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
      return;
    }
    const previousTask = destination[targetIndex - 1] ?? null;
    const nextTask = destination[targetIndex] ?? null;
    const sortOrder = previousTask && nextTask
      ? (previousTask.sortOrder + nextTask.sortOrder) / 2
      : previousTask
        ? previousTask.sortOrder + 1024
        : nextTask
          ? nextTask.sortOrder - 1024
          : 1024;
    const previous = task;
    setActionError(null);
    setMovingTaskId(task.id);
    setTasks((current) => sortTasks(current.map((candidate) =>
      candidate.id === task.id ? { ...candidate, status, sortOrder } : candidate,
    )));

    try {
      const moved = await moveTaskRequest(task, status, sortOrder);
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === moved.id ? moved : candidate,
      )));
      const message = task.status === status
        ? `${task.identifier} order updated.`
        : `${task.identifier} moved to ${STATUS_DETAILS[status].label}.`;
      pushUndo(message, async () => {
        const candidate = tasksRef.current.find((current) => current.id === moved.id);
        const current = candidate && candidate.version >= moved.version ? candidate : moved;
        const restored = await moveTaskRequest(current, previous.status, previous.sortOrder);
        setTasks((tasks) => sortTasks(tasks.map((item) => item.id === restored.id ? restored : item)));
      }, !silent);
    } catch (error) {
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === previous.id ? previous : candidate,
      )));
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "That issue changed elsewhere. The board has been refreshed."
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
    } finally {
      setMovingTaskId(null);
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
    }
  }

  function finishTaskDrop(destination: TaskStatus, taskIds: string[] | string, beforeTaskId: string | null = null) {
    const ids = Array.isArray(taskIds) ? taskIds : [taskIds];
    const draggedTasks = ids
      .map((id) => tasks.find((candidate) => candidate.id === id))
      .filter((task): task is Task => Boolean(task));
    setDraggedTaskId(null);
    setDraggedTaskHeight(0);
    setDropTarget(null);
    if (draggedTasks.length === 0) return;
    const [firstTask] = draggedTasks;
    setSettlingTaskId(firstTask.id);
    window.setTimeout(() => {
      setSettlingTaskId((current) => current === firstTask.id ? null : current);
    }, 220);
    void (async () => {
      for (const task of draggedTasks) {
        await moveTask(task, destination, beforeTaskId, true);
      }
      setSelectedTaskIds(new Set());
    })();
  }

  async function updateTaskProperties(task: Task, changes: Partial<TaskDraft>, message?: string): Promise<Task> {
    const previous = task;
    const { assigneeTarget, ...taskChanges } = changes;
    const optimisticAssignee = assigneeTarget
      ? actorForAssigneeTarget(assigneeTarget, currentUser)
      : task.assignee;
    setActionError(null);
    setTasks((current) => current.map((candidate) =>
      candidate.id === task.id
        ? { ...candidate, ...taskChanges, assignee: optimisticAssignee }
        : candidate,
    ));

    try {
      const updated = await updateTaskRequest(task, { ...taskToDraft(task), ...changes });
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      )));
      const previousAssigneeTarget = assigneeTargetForActor(previous.assignee, currentUser);
      if (!assigneeTarget || previousAssigneeTarget) {
        pushUndo(
          message ?? `${task.identifier} updated.`,
          () => restoreTaskDetails(previous, updated, previousAssigneeTarget),
        );
      }
      return updated;
    } catch (error) {
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === previous.id ? previous : candidate,
      )));
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "That issue changed elsewhere. The board has been refreshed."
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
      throw error;
    }
  }

  async function mutateTaskRelation(
    action: "add" | "remove",
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
  ) {
    setActionError(null);
    try {
      const result = action === "add"
        ? await addTaskRelation(task, type, relatedTaskId)
        : await removeTaskRelation(task, type, relatedTaskId);
      setTasks((current) => sortTasks(current.map((candidate) => {
        if (candidate.id === result.task.id) return result.task;
        if (candidate.id === result.relatedTask.id) return result.relatedTask;
        return candidate;
      })));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
      return result;
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "That issue changed elsewhere. The board has been refreshed."
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
      throw error;
    }
  }

  async function duplicateTask(task: Task) {
    setActionError(null);
    try {
      const duplicated = await createTaskRequest(task.projectId, {
        ...taskToDraft(task),
        assigneeTarget: assigneeTargetForActor(task.assignee, currentUser),
        developmentContext: null,
      });
      setTasks((current) => sortTasks([...current, duplicated]));
      pushUndo(`${duplicated.identifier} duplicate created.`, async () => {
        const candidate = tasksRef.current.find((current) => current.id === duplicated.id);
        const current = candidate && candidate.version >= duplicated.version ? candidate : duplicated;
        await archiveTaskRequest(current);
        setTasks((tasks) => tasks.filter((item) => item.id !== duplicated.id));
      });
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function archiveTask(task: Task) {
    setActionError(null);
    try {
      const archived = await archiveTaskRequest(task);
      setTasks((current) => current.filter((candidate) => candidate.id !== task.id));
      pushUndo(`${task.identifier} archived.`, async () => {
        const restored = await restoreTaskRequest(archived);
        setTasks((current) => sortTasks([
          ...current.filter((candidate) => candidate.id !== restored.id),
          restored,
        ]));
      });
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "That issue changed elsewhere. The board has been refreshed."
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
    }
  }

  async function copyText(text: string, message: string) {
    try {
      await navigator.clipboard.writeText(text);
      setAnnouncement(message);
    } catch {
      setActionError("Cannot write to clipboard.");
    }
  }

  function openThread(threadId: string) {
    if (embedded && window.parent !== window) {
      window.parent.postMessage({ type: "taskboard:open-thread", payload: { threadId } }, "*");
      return;
    }

    window.location.assign(`codex://threads/${encodeURIComponent(threadId.trim())}`);
  }

  function expandCodexSidebar() {
    if (!embedded || window.parent === window) return;
    window.parent.postMessage({ type: "taskboard:expand-sidebar" }, "*");
  }

  function openTaskInThread(task: Task) {
    const resultThreadId = task.codexThreadId?.trim();
    if (resultThreadId) {
      openThread(resultThreadId);
      return;
    }
    if (!manageTaskboardSkillPath) {
      setActionError("Manage Taskboard skill path is not available. Refresh and try again.");
      return;
    }
    const worktreePath = task.developmentContext?.type === "worktree"
      ? task.developmentContext.path
      : null;
    const taskProject = projects.find((project) => project.id === task.projectId) ?? null;
    const workspacePath = worktreePath
      ?? deviceWorkspacePaths[task.projectId]
      ?? taskProject?.workspacePath
      ?? developmentScan.workspacePath
      ?? hostContext?.workspacePath;
    const instruction = `e-taskboard Addressing the issues mentioned in ${task.identifier}`;
    const prompt = `[$manage-taskboard](${manageTaskboardSkillPath}) ${instruction}`;

    if (!embedded || window.parent === window) {
      const query = new URLSearchParams();
      if (workspacePath) query.set("path", workspacePath);
      query.set("prompt", prompt);
      window.location.assign(`codex://new?${query.toString().replace(/\+/g, "%20")}`);
      return;
    }
    if (openingThreadTaskId) return;
    const codexProject = hostContext?.projects?.find((project) => project.id === task.projectId);
    setOpeningThreadTaskId(task.id);
    setActionError(null);
    window.parent.postMessage({
      type: "taskboard:create-thread",
      payload: {
        taskId: task.id,
        identifier: task.identifier,
        instruction,
        skillName: "manage-taskboard",
        skillDisplayName: "Manage Taskboard",
        skillPath: manageTaskboardSkillPath,
        codexProjectId: codexProject?.id ?? (task.projectId === "local" ? hostContext?.projectId : task.projectId),
        projectName: taskProject?.name,
        workspacePath,
        workspaceLabel: worktreePath ? workspaceName(worktreePath) : undefined,
      },
    }, "*");
  }

  function changeProject(projectId: string) {
    closeContextMenu();
    setProjectMenuOpen(false);
    setDetailTaskIdentifier(null);
    setBoardView("issues");
    setActiveStatusDrawer(null);
    setSelectedProjectId(projectId);
    window.localStorage.setItem(LAST_PROJECT_KEY, projectId);
    setSearch("");
    setFilters(EMPTY_TASK_FILTERS);
    setActionError(null);
    undoStackRef.current = [];
    setUndoNotice(null);
    const url = buildIssueUrl(window.location.href, projectId, null);
    window.history.replaceState(null, "", url);
  }

  function toggleFavoriteProject() {
    if (!selectedProjectId) return;
    const shouldFavorite = !favoriteProjectIds.has(selectedProjectId);
    setFavoriteProjectIds((current) => {
      const next = new Set(current);
      if (shouldFavorite) next.add(selectedProjectId);
      else next.delete(selectedProjectId);
      window.localStorage.setItem(FAVORITE_PROJECTS_KEY, JSON.stringify([...next]));
      return next;
    });
    setAnnouncement(`${selectedProject?.name ?? "Project"} ${shouldFavorite ? "favorited" : "unfavorited"}.`);
  }

  async function selectProject(choice: ProjectChoice) {
    if (openingProjectId) return;
    setOpeningProjectId(choice.id);
    setActionError(null);
    try {
      let project = projects.find((candidate) => candidate.id === choice.id) ?? null;
      if (!project) {
        try {
          project = await createProjectRequest({
            id: choice.id,
            name: choice.name,
            workspacePath: null,
          });
          setProjects((current) => [...current, project!]);
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== "PROJECT_EXISTS") throw error;
          const nextProjects = await listProjects();
          setProjects(nextProjects);
          project = nextProjects.find((candidate) => candidate.id === choice.id) ?? null;
          if (!project) throw error;
        }
      }
      changeProject(project.id);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setOpeningProjectId(null);
    }
  }

  async function ensureProject(projectId: string): Promise<Project> {
    const existing = projects.find((project) => project.id === projectId);
    if (existing) return existing;
    const choice = projectChoices.find((project) => project.id === projectId);
    if (!choice) throw new Error("Unknown project");
    try {
      const created = await createProjectRequest({
        id: choice.id,
        name: choice.name,
        workspacePath: null,
      });
      setProjects((current) => [...current, created]);
      return created;
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "PROJECT_EXISTS") throw error;
      const nextProjects = await listProjects();
      setProjects(nextProjects);
      const project = nextProjects.find((candidate) => candidate.id === projectId);
      if (!project) throw error;
      return project;
    }
  }

  function threadKey(projectId: string | null, threadId: string) {
    return `${projectId ?? NON_PROJECT_RESOURCE_ID}:${threadId}`;
  }

  function toggleThreadSelection(resource: ThreadResource) {
    setSelectedThreadKeys((current) => {
      const next = new Set(current);
      const key = threadKey(resource.projectId, resource.threadId);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function readThreadResource(dataTransfer: DataTransfer): ThreadResource | null {
    try {
      const parsed = JSON.parse(dataTransfer.getData("application/x-taskboard-codex-thread"));
      if (
        parsed
        && (typeof parsed.projectId === "string" || parsed.projectId === null)
        && typeof parsed.projectName === "string"
        && typeof parsed.threadId === "string"
        && typeof parsed.threadName === "string"
      ) {
        return parsed;
      }
    } catch {
      // Non-thread drags are handled separately.
    }
    return null;
  }

  function readThreadResources(dataTransfer: DataTransfer): ThreadResource[] {
    try {
      const parsed = JSON.parse(dataTransfer.getData("application/x-taskboard-codex-threads"));
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is ThreadResource => (
          item
          && (typeof item.projectId === "string" || item.projectId === null)
          && typeof item.projectName === "string"
          && typeof item.threadId === "string"
          && typeof item.threadName === "string"
        ));
      }
    } catch {
      // Single-thread drags are read below.
    }
    const single = readThreadResource(dataTransfer);
    return single ? [single] : [];
  }

  function handlePublisherDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    const threads = readThreadResources(event.dataTransfer);
    if (threads.length > 0) {
      if (threads[0].projectId) setPublisherProjectId(threads[0].projectId);
      setPublisherThreads(threads);
      return;
    }
    const projectId = event.dataTransfer.getData("application/x-taskboard-project");
    const project = projectChoices.find((choice) => choice.id === projectId);
    if (project) {
      setPublisherProjectId(project.id);
      setPublisherThreads([]);
    }
  }

  async function submitPublisher() {
    const title = publisherText.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
    if (!title) return;
    const targets = publisherThreads.length > 0
      ? publisherThreads
      : selectedThreadResources.length > 0
        ? selectedThreadResources
        : [];
    setActionError(null);
    try {
      const savedTasks: Task[] = [];
      if (targets.length > 0) {
        for (const target of targets) {
          const targetProjectId = target.projectId ?? publisherProject?.id ?? selectedProjectId;
          if (!targetProjectId) throw new Error("请选择一个项目作为派单目标");
          await ensureProject(targetProjectId);
          savedTasks.push(await createTaskRequest(targetProjectId, {
            title,
            description: publisherText.trim(),
            status: "backlog",
            priority: "none",
            labels: [],
            workflowId: null,
            developmentContext: null,
            dueDate: null,
            recurrence: null,
            codexThreadId: target.threadId,
            codexThreadName: target.threadName,
          }));
        }
      } else {
        const targetProjectId = publisherProject?.id ?? selectedProjectId;
        if (!targetProjectId) return;
        await ensureProject(targetProjectId);
        savedTasks.push(await createTaskRequest(targetProjectId, {
          title,
          description: publisherText.trim(),
          status: "backlog",
          priority: "none",
          labels: [],
          workflowId: null,
          developmentContext: null,
          dueDate: null,
          recurrence: null,
        }));
      }
      setTasks((current) => sortTasks([
        ...current.filter((task) => !savedTasks.some((saved) => saved.id === task.id)),
        ...savedTasks,
      ]));
      setProjects((current) => current.map((project) => {
        const createdCount = savedTasks.filter((task) => task.projectId === project.id).length;
        return createdCount > 0 ? { ...project, issueCount: project.issueCount + createdCount } : project;
      }));
      setPublisherText("");
      setPublisherThreads([]);
      setSelectedThreadKeys(new Set());
      pushUndo(`Created ${savedTasks.length} backlog task${savedTasks.length === 1 ? "" : "s"}.`, async () => {
        await Promise.all(savedTasks.map((task) => archiveTaskRequest(task)));
        setTasks((current) => current.filter((task) => !savedTasks.some((saved) => saved.id === task.id)));
      });
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  const contextName = workspaceName(hostContext?.workspacePath);
  const headerProjectName = selectedProject?.name ?? "codex-kanban";
  const appShellStyle = embedded
    ? { "--codex-titlebar-left-inset": `${hostContext?.titlebarLeftInset ?? 0}px` } as CSSProperties
    : undefined;

  function updateTaskSelectionFromBox(box: TaskSelectionBox) {
    const selected = new Set<string>();
    const selectionRect = {
      left: box.x,
      top: box.y,
      right: box.x + box.width,
      bottom: box.y + box.height,
    };
    for (const card of boardScrollRef.current?.querySelectorAll<HTMLElement>("[data-task-id]") ?? []) {
      const rect = card.getBoundingClientRect();
      const intersects = rect.left < selectionRect.right
        && rect.right > selectionRect.left
        && rect.top < selectionRect.bottom
        && rect.bottom > selectionRect.top;
      if (intersects && card.dataset.taskId) selected.add(card.dataset.taskId);
    }
    setSelectedTaskIds(selected);
  }

  function startTaskSelection(event: ReactPointerEvent<HTMLElement>) {
    if (
      event.button !== 0
      || !(event.target instanceof HTMLElement)
      || event.target.closest(".task-card, button, input, textarea, select, a, .status-dock, .status-drawer")
    ) {
      return;
    }
    const box = {
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      width: 0,
      height: 0,
    };
    taskSelectionPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setTaskSelectionBox(box);
    setSelectedTaskIds(new Set());
  }

  function moveTaskSelection(event: ReactPointerEvent<HTMLElement>) {
    if (taskSelectionPointerRef.current !== event.pointerId || !taskSelectionBox) return;
    const nextBox = {
      ...taskSelectionBox,
      x: Math.min(taskSelectionBox.startX, event.clientX),
      y: Math.min(taskSelectionBox.startY, event.clientY),
      width: Math.abs(event.clientX - taskSelectionBox.startX),
      height: Math.abs(event.clientY - taskSelectionBox.startY),
    };
    setTaskSelectionBox(nextBox);
    updateTaskSelectionFromBox(nextBox);
  }

  function endTaskSelection(event: ReactPointerEvent<HTMLElement>) {
    if (taskSelectionPointerRef.current !== event.pointerId) return;
    taskSelectionPointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setTaskSelectionBox(null);
  }

  function renderBoardColumn(status: TaskStatus, options: { drawer?: boolean } = {}) {
    return (
      <BoardColumn
        key={status}
        status={status}
        statusIndex={TASK_STATUSES.indexOf(status)}
        tasks={tasksByStatus[status]}
        isDropTarget={dropTarget === status}
        draggedTaskId={draggedTaskId}
        draggedTaskHeight={draggedTaskHeight}
        movingTaskId={movingTaskId}
        settlingTaskId={settlingTaskId}
        contextMenuTaskId={contextMenu?.taskId ?? null}
        selectedTaskIds={selectedTaskIds}
        onCreate={(initialStatus) => setEditor({
          task: null,
          status: initialStatus,
          projectId: publisherProject?.id ?? selectedProjectId,
        })}
        onEdit={openTaskDetail}
        onContextMenu={(task, position) => setContextMenu({ taskId: task.id, ...position })}
        onMove={(task, destination) => void moveTask(task, destination)}
        onDragStart={(task, height) => {
          if (!selectedTaskIds.has(task.id)) setSelectedTaskIds(new Set([task.id]));
          setDraggedTaskId(task.id);
          setDraggedTaskHeight(height);
          setDropTarget(task.status);
        }}
        onDragEnd={() => {
          setDraggedTaskId(null);
          setDraggedTaskHeight(0);
          setDropTarget(null);
        }}
        onDragEnter={setDropTarget}
        onDrop={finishTaskDrop}
        onOpenThread={openThread}
        onHide={() => options.drawer && setActiveStatusDrawer(null)}
        hideable={false}
        creatable={!options.drawer}
      />
    );
  }

  return (
    <div className={`app-shell${embedded ? " embedded" : ""}`} style={appShellStyle}>
      {taskboardMetadata && taskboardMetadata.mode !== "cloud" && (
        <LocalRealtimeSync
          selectedProjectId={selectedProjectId}
          detailTaskId={detailTaskId}
          refreshProjectList={refreshProjectList}
          refreshTasks={refreshTasks}
          refreshWorkflowOptions={refreshWorkflowOptions}
          setConnection={setConnection}
          setCommentsRevision={setCommentsRevision}
          setAttachmentsRevision={setAttachmentsRevision}
        />
      )}
      {!embedded && (
        <aside className="app-nav" aria-label="Taskboard navigation">
          <div className="brand-row">
            <span className="brand-mark" aria-hidden="true"><LinearIcon name="project" /></span>
            <span>codex-kanban</span>
          </div>

          <nav className="primary-nav" aria-label="Views">
            <span className="nav-label">Workspace</span>
            <button className="nav-item active" type="button" aria-current="page">
              <span className="nav-glyph" aria-hidden="true">
                <LinearIcon name="myIssues" />
              </span>
              议题
              <span className="nav-count">{tasks.length}</span>
            </button>
          </nav>

          <div className="project-nav resource-library">
            <span className="nav-label">项目</span>
            {resourceProjectChoices.map((project) => (
              <div className="resource-project" key={project.id}>
              <button
                type="button"
                className="project-nav-item resource-project-item"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "copy";
                  event.dataTransfer.setData("application/x-taskboard-project", project.id);
                  event.dataTransfer.setData("text/plain", project.id);
                }}
                onClick={() => {
                  setPublisherProjectId(project.id);
                  setPublisherThreads([]);
                }}
                title={`切换到 ${project.name}`}
              >
                <span className="project-dot" aria-hidden="true" />
                <span className="project-nav-name">{project.name}</span>
                <span className="project-nav-count">{project.issueCount}</span>
              </button>
                      <div className="thread-resource-list" aria-label={`${project.name} 会话`}>
                {(codexThreadsByProject[project.id] ?? []).map((thread) => {
                  const resource = {
                    projectId: project.id,
                    projectName: project.name,
                    threadId: thread.id,
                    threadName: thread.name,
                  };
                  const selected = selectedThreadKeys.has(threadKey(project.id, thread.id));
                  return (
                    <button
                      type="button"
                      className={`thread-resource-item${selected ? " selected" : ""}`}
                      key={thread.id}
                      draggable
                      aria-pressed={selected}
                      onClick={() => toggleThreadSelection(resource)}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "copy";
                        const selectedResources = selectedThreadResources.length > 0 && selected
                          ? selectedThreadResources
                          : [resource];
                        event.dataTransfer.setData("application/x-taskboard-codex-thread", JSON.stringify(resource));
                        event.dataTransfer.setData("application/x-taskboard-codex-threads", JSON.stringify(selectedResources));
                        event.dataTransfer.setData("text/plain", thread.id);
                      }}
                      title={thread.preview || thread.name}
                    >
                      <LinearIcon name="conversation" />
                      <span>{thread.name}</span>
                    </button>
                  );
                })}
              </div>
              </div>
            ))}
            {unassignedCodexThreads.length > 0 && (
              <div className="resource-project" key={NON_PROJECT_RESOURCE_ID}>
                <div className="project-nav-item resource-project-item resource-project-static">
                  <span className="project-dot" aria-hidden="true" />
                  <span className="project-nav-name">非项目会话</span>
                  <span className="project-nav-count">{unassignedCodexThreads.length}</span>
                </div>
                <div className="thread-resource-list" aria-label="非项目会话">
                  {unassignedCodexThreads.map((thread) => {
                    const resource = {
                      projectId: null,
                      projectName: "非项目会话",
                      threadId: thread.id,
                      threadName: thread.name,
                    };
                    const selected = selectedThreadKeys.has(threadKey(null, thread.id));
                    return (
                      <button
                        type="button"
                        className={`thread-resource-item${selected ? " selected" : ""}`}
                        key={thread.id}
                        draggable
                        aria-pressed={selected}
                        onClick={() => toggleThreadSelection(resource)}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "copy";
                          const selectedResources = selectedThreadResources.length > 0 && selected
                            ? selectedThreadResources
                            : [resource];
                          event.dataTransfer.setData("application/x-taskboard-codex-thread", JSON.stringify(resource));
                          event.dataTransfer.setData("application/x-taskboard-codex-threads", JSON.stringify(selectedResources));
                          event.dataTransfer.setData("text/plain", thread.id);
                        }}
                        title={thread.preview || thread.name}
                      >
                        <LinearIcon name="conversation" />
                        <span>{thread.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="nav-spacer" />
          <div className="nav-footer">
            <div className={`connection connection-${connection}`}>
              <span aria-hidden="true" />
              {connection === "live" ? "Live sync" : "Reconnecting..."}
            </div>
            <button
              type="button"
              className="theme-toggle"
              onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            >
              <span aria-hidden="true"><LinearIcon name={theme === "dark" ? "sun" : "moon"} /></span>
              {theme === "dark" ? "浅色模式" : "深色模式"}
            </button>
          </div>
        </aside>
      )}

      <main className="workspace">
        {selectedProjectId ? (
          <header className="workspace-header">
          <div className="workspace-title">
            <div className="workspace-kicker">
              {detailTask && (
                <button
                  className="detail-back-button"
                  type="button"
                  aria-label="返回议题看板"
                  title="返回议题看板 (Esc)"
                  onClick={closeTaskDetail}
                >
                  <LinearIcon name="chevronLeft" />
                </button>
              )}
              {embedded && hostContext?.sidebarCollapsed && (
                <button
                  className="detail-back-button codex-sidebar-expand-button"
                  type="button"
                  aria-label="Expand Codex sidebar"
                  title="Expand sidebar"
                  onClick={expandCodexSidebar}
                >
                  <LinearIcon name="codexSidebarExpand" />
                </button>
              )}
              {selectedProjectId ? (
                <div className="header-project-switcher" data-project-switcher>
                  <button
                    className="header-project-button"
                    type="button"
                    aria-label="切换项目"
                    aria-haspopup="menu"
                    aria-expanded={projectMenuOpen}
                    onClick={() => setProjectMenuOpen((current) => !current)}
                  >
                    <span className="project-avatar" aria-hidden="true">
                      {headerProjectName.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="project-name">{headerProjectName}</span>
                    <LinearIcon className="project-switcher-chevron" name="chevronDown" />
                  </button>
                  {projectMenuOpen && (
                    <div className="header-project-menu" role="menu" aria-label="项目">
                      <span>切换项目</span>
                      {projectChoices.map((project) => (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={project.id === selectedProjectId}
                          disabled={openingProjectId !== null}
                          key={project.id}
                          onClick={() => {
                            if (project.id === selectedProjectId) setProjectMenuOpen(false);
                            else void selectProject(project);
                          }}
                        >
                          <span className="project-avatar" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span>
                          <span>{project.name}</span>
                          {favoriteProjectIds.has(project.id) && <span className="project-menu-favorite" aria-label="Favorite"><LinearIcon name="favorite" /></span>}
                          {project.id === selectedProjectId && <span className="project-menu-check" aria-hidden="true"><LinearIcon name="check" /></span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <span className="project-avatar" aria-hidden="true">
                    {headerProjectName.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="project-name">{headerProjectName}</span>
                </>
              )}
              {!selectedProjectId && (
                <>
                  <span className="breadcrumb-chevron" aria-hidden="true"><LinearIcon name="chevronRight" /></span>
                  <strong>项目</strong>
                </>
              )}
              {!detailTask && selectedProjectId && (
                <button
                  className={`favorite-button${favoriteProjectIds.has(selectedProjectId) ? " active" : ""}`}
                  type="button"
                  aria-label={favoriteProjectIds.has(selectedProjectId) ? "取消收藏项目" : "收藏项目"}
                  aria-pressed={favoriteProjectIds.has(selectedProjectId)}
                  title={favoriteProjectIds.has(selectedProjectId) ? "取消收藏" : "收藏项目"}
                  onClick={toggleFavoriteProject}
                >
                  <LinearIcon className="favorite-icon" name="favorite" />
                </button>
              )}
              {!detailTask && selectedProjectId && embedded && contextName && <span className="codex-context">{contextName}</span>}
            </div>
          </div>

          <div ref={dragRegionRef} className="workspace-drag-region" aria-hidden="true" />

          <div className="header-actions">
            {selectedProjectId && (
              <ProjectAutomationMenu
                automation={selectedProjectAutomation}
                pending={automationPending}
                error={automationError}
                unavailableReason={automationProjectContext.unavailableReason}
                onOpen={() => void reconcileProjectAutomation()}
                onChange={(options) => void saveProjectAutomation(options)}
              />
            )}
            {selectedProjectId && boardView === "issues" && (
              <button
                className="icon-button header-create-button"
                type="button"
                onClick={() => setEditor({
                  task: null,
                  status: "backlog",
                  projectId: publisherProject?.id ?? selectedProjectId,
                })}
                aria-label="新建议题"
                title="新建议题 (C)"
              >
                <LinearIcon name="plus" />
              </button>
            )}
          </div>
          </header>
        ) : (
          <div ref={dragRegionRef} className="home-window-drag-region" aria-hidden="true" />
        )}

        {selectedProjectId && !detailTask && <div className="board-toolbar">
          <div className="view-tabs" aria-label="看板视图">
            <button
              className={`view-tab${boardView === "issues" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "issues"}
              onClick={() => selectBoardView("issues")}
            >
              议题看板
            </button>
            {SHOW_WORKFLOW_BOARD_ENTRY && (
              <button
                className={`view-tab${boardView === "workflow" ? " active" : ""}`}
                type="button"
                aria-pressed={boardView === "workflow"}
                onClick={() => selectBoardView("workflow")}
              >
                节点模式
              </button>
            )}
          </div>
          {boardView === "issues" && <div className="toolbar-tools">
            <label className={`search-field${search ? " has-value" : ""}`} title="搜索议题 (/)" >
              <LinearIcon className="search-icon" name="search" />
              <span className="sr-only">搜索议题</span>
              <input
                id="task-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search issues..."
              />
              {!search && <kbd>/</kbd>}
            </label>
            <TaskFilterMenu
              tasks={tasks}
              search={search}
              labels={availableLabels}
              filters={filters}
              onChange={setFilters}
            />
            {(search || activeFilterCount > 0) && (
              <button
                className="clear-filter"
                type="button"
                aria-label="Clear filters"
                title="Clear filters"
                onClick={() => { setSearch(""); setFilters(EMPTY_TASK_FILTERS); }}
              >
                <LinearIcon name="close" />
              </button>
            )}
          </div>}
        </div>}

        {(loadError || actionError) && (
          <div className="error-banner" role="alert">
            <span className="error-mark" aria-hidden="true"><LinearIcon name="alert" /></span>
            <div><strong>codex-kanban needs attention</strong><p>{actionError ?? loadError}</p></div>
            <button
              type="button"
              onClick={() => {
                setActionError(null);
                if (selectedProjectId) void refreshTasks(selectedProjectId);
                else void loadProjectList();
              }}
            >
              Try again
            </button>
          </div>
        )}

        {!selectedProjectId ? (
          <section className="project-home">
            <div className="project-home-heading">
              <span>codex-kanban</span>
              <h1>选择项目</h1>
              <p>Start from a Codex project or a saved Taskboard project.</p>
            </div>
            {projectsLoading ? (
              <div className="project-grid project-grid-loading" aria-label="正在加载项目" aria-busy="true">
                <span /><span /><span />
              </div>
            ) : projectChoices.length > 0 ? (
              <div className="project-home-groups">
                {[
                  { id: "with-issues", title: "已有议题", projects: projectsWithIssues },
                  { id: "without-issues", title: "尚未添加议题", projects: projectsWithoutIssues },
                ].map((group) => (
                  <section className="project-home-group" key={group.id} aria-labelledby={`project-group-${group.id}`}>
                    <div className="project-group-heading">
                      <h2 id={`project-group-${group.id}`}>{group.title}</h2>
                      <span>{group.projects.length}</span>
                    </div>
                    {group.projects.length > 0 ? (
                      <div className="project-grid">
                        {group.projects.map((project) => (
                          <div className="project-card" key={project.id}>
                            <button
                              className="project-card-open"
                              type="button"
                              disabled={openingProjectId !== null}
                              onClick={() => void selectProject(project)}
                            >
                              <span className="project-card-avatar" aria-hidden="true">
                                {project.name.slice(0, 1).toUpperCase()}
                              </span>
                              <span className="project-card-copy">
                                <strong>{project.name}</strong>
                                <span>
                          {project.inCodex ? "本机项目" : "已保存的项目"}
                                  {project.issueCount > 0 ? ` - ${project.issueCount} issues` : ""}
                                </span>
                              </span>
                              {favoriteProjectIds.has(project.id) && <span className="project-card-favorite" aria-label="Favorite"><LinearIcon name="favorite" /></span>}
                              <span className="project-card-action" aria-hidden="true">
                                {openingProjectId === project.id ? "Opening..." : <LinearIcon name="chevronRight" />}
                              </span>
                            </button>
                            <label className="project-card-directory">
                              <LinearIcon name="folder" />
                              <input
                                key={deviceWorkspacePaths[project.id] ?? ""}
                                type="text"
                                defaultValue={deviceWorkspacePaths[project.id] ?? ""}
                                placeholder="设置此设备的项目目录"
                                aria-label={`${project.name} 在此设备上的项目目录`}
                                onBlur={(event) => rememberDeviceWorkspacePath(project.id, event.currentTarget.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") event.currentTarget.blur();
                                }}
                              />
                            </label>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="project-group-empty">暂无项目</p>
                    )}
                  </section>
                ))}
              </div>
            ) : (
              <div className="project-home-empty">
                <span className="empty-orbit" aria-hidden="true"><i /><i /></span>
                <h2>No projects yet</h2>
                <p>Create a project in Codex, then open Taskboard again.</p>
              </div>
            )}
          </section>
        ) : detailTask && detailProject ? (
          <TaskDetail
            key={detailTask.id}
            task={detailTask}
            tasks={tasks}
            currentUser={currentUser}
            availableLabels={availableLabels}
            workflows={workflowOptions}
            developmentScan={developmentScan}
            developmentScanLoading={developmentScanLoading}
            commentsRevision={commentsRevision}
            attachmentsRevision={attachmentsRevision}
            onUpdate={(current, changes) => updateTaskProperties(current, changes)}
            onOpenTask={openTaskDetail}
            onAddRelation={(current, type, relatedTaskId) => (
              mutateTaskRelation("add", current, type, relatedTaskId)
            )}
            onRemoveRelation={(current, type, relatedTaskId) => (
              mutateTaskRelation("remove", current, type, relatedTaskId)
            )}
            onOpenThread={openThread}
            onOpenInThread={openTaskInThread}
            openingThread={openingThreadTaskId === detailTask.id}
            onError={setActionError}
            onAnnounce={setAnnouncement}
          />
        ) : boardView === "workflow" ? (
          <Suspense fallback={<div className="workflow-board-loading">Opening workflow...</div>}>
            <WorkflowBoard
              key={selectedProject?.id ?? "local"}
              projectId={selectedProject?.id ?? "local"}
              projectName={selectedProject?.name ?? "当前项目"}
              workspacePath={
                selectedDeviceWorkspacePath
                ?? developmentScan.workspacePath
                ?? hostContext?.workspacePath
              }
              revision={workflowRevision}
              onWorkflowsChange={setWorkflowOptions}
            />
          </Suspense>
        ) : tasksLoading && !hasLoadedTasks ? (
          <div className="loading-board" aria-label="Loading issues" aria-busy="true">
            {WORKBENCH_STATUSES.map((status) => (
              <div className="loading-column" key={status}>
                <span /><div /><div />
              </div>
            ))}
          </div>
        ) : (
          <div className="board-stage">
            <div
              ref={boardScrollRef}
              className="board-scroll"
              aria-label="Issue board"
              onPointerDown={startTaskSelection}
              onPointerMove={moveTaskSelection}
              onPointerUp={endTaskSelection}
              onPointerCancel={endTaskSelection}
            >
              <div className="board workbench-board">
              {filteredTasks.length === 0 && tasks.length > 0 && (search || activeFilterCount > 0) && (
                <section className="page-empty filter-empty board-filter-empty">
                  <span className="empty-search" aria-hidden="true"><LinearIcon name="search" /></span>
                  <h2>No matching issues</h2>
                  <p>Change the search or clear filters.</p>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => { setSearch(""); setFilters(EMPTY_TASK_FILTERS); }}
                  >
                    清除筛选
                  </button>
                </section>
              )}
              {WORKBENCH_STATUSES.map((status) => renderBoardColumn(status))}
              </div>
              {taskSelectionBox && (
                <div
                  className="task-selection-marquee"
                  style={{
                    left: taskSelectionBox.x,
                    top: taskSelectionBox.y,
                    width: taskSelectionBox.width,
                    height: taskSelectionBox.height,
                  }}
                />
              )}
            </div>
            <StatusDock
              statuses={STATUS_DOCK_STATUSES}
              counts={Object.fromEntries(
                TASK_STATUSES.map((status) => [status, tasksByStatus[status].length]),
              ) as Record<TaskStatus, number>}
              activeStatus={activeStatusDrawer}
              dropTarget={dropTarget}
              onSelect={(status) => setActiveStatusDrawer((current) => current === status ? null : status)}
              onDragTargetChange={setDropTarget}
              onDrop={(destination, taskId) => finishTaskDrop(destination, taskId)}
            />
            {activeStatusDrawer && (
              <aside className="status-drawer" aria-label={`${STATUS_DETAILS[activeStatusDrawer].label}任务`}>
                <button
                  type="button"
                  className="icon-button status-drawer-close"
                  aria-label={`关闭${STATUS_DETAILS[activeStatusDrawer].label}`}
                  title="关闭 (Esc)"
                  onClick={() => setActiveStatusDrawer(null)}
                >
                  <LinearIcon name="close" />
                </button>
                {renderBoardColumn(activeStatusDrawer, { drawer: true })}
              </aside>
            )}
          </div>
        )}
        {!detailTask && (
          <section
            className="task-publisher"
            aria-label="Task publisher"
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }}
            onDrop={handlePublisherDrop}
          >
            <div className="publisher-target">
              <LinearIcon name={publisherThreads.length > 0 || selectedThreadResources.length > 0 ? "conversation" : "project"} />
              <span>
                {publisherThreads.length > 0
                  ? `${publisherThreads.length} threads`
                  : selectedThreadResources.length > 0
                    ? `${selectedThreadResources.length} selected threads`
                    : publisherProject?.name ?? "Drop a project or thread"}
              </span>
            </div>
            <textarea
              value={publisherText}
              rows={2}
              placeholder="Send a task to backlog"
              onChange={(event) => setPublisherText(event.target.value)}
            />
            <button
              className="button primary publisher-submit"
              type="button"
              disabled={!publisherText.trim() || (!publisherProject && publisherThreads.length === 0 && selectedThreadResources.length === 0)}
              onClick={() => void submitPublisher()}
            >
              <LinearIcon name="send" />
              Backlog
            </button>
          </section>
        )}
      </main>

      {editor && (
        <TaskEditor
          key={editor.task?.id ?? `new-${editor.status}`}
          task={editor.task}
          initialStatus={editor.status}
          projectId={editor.projectId}
          projects={projects}
          labels={availableLabels}
          workflows={workflowOptions}
          currentUser={currentUser}
          developmentScan={developmentScan}
          developmentScanLoading={developmentScanLoading}
          onProjectChange={(projectId) => setEditor((current) => (
            current ? { ...current, projectId } : current
          ))}
          onCancel={() => setEditor(null)}
          onSave={saveEditor}
        />
      )}

      {contextMenu && contextMenuTask && (
        <TaskContextMenu
          task={contextMenuTask}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          labels={availableLabels}
          onClose={closeContextMenu}
          onEdit={openTaskDetail}
          onStatusChange={(task, status) => void moveTask(task, status)}
          onPriorityChange={(task, nextPriority) => void updateTaskProperties(
            task,
            { priority: nextPriority },
            `${task.identifier} priority updated.`,
          ).catch(() => {})}
          onLabelsChange={(task, labels) => void updateTaskProperties(
            task,
            { labels },
            `${task.identifier} labels updated.`,
          ).catch(() => {})}
          onDuplicate={(task) => void duplicateTask(task)}
          onCopy={(text, message) => void copyText(text, message)}
          onOpenInThread={openTaskInThread}
          onArchive={(task) => void archiveTask(task)}
        />
      )}

      <AiChat
        available={localAiChatAvailable}
        projectId={selectedProjectId || null}
        issueId={detailTaskId}
      />

      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      {undoNotice && (
        <div
          className="toast undo-toast"
          role="status"
          onAnimationEnd={() => setUndoNotice((current) => current?.id === undoNotice.id ? null : current)}
        >
          <span className="toast-check" aria-hidden="true"><LinearIcon name="check" /></span>
          <span className="undo-toast-message">{undoNotice.message}</span>
          <button type="button" onClick={() => void performUndo()}>
            撤回 <kbd>{undoShortcut}</kbd>
          </button>
        </div>
      )}
      {announcement && (
        <div className="toast" role="status" onAnimationEnd={() => setAnnouncementValue("")}>
          <span aria-hidden="true"><LinearIcon name="check" /></span>{announcement}
        </div>
      )}
      {draggedTaskId && <div className="drag-hint" aria-hidden="true">拖到目标位置后松开</div>}
    </div>
  );
}
