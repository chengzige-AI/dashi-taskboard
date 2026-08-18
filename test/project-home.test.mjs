import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
const editorSource = await readFile(new URL("../web/src/components/TaskEditor.tsx", import.meta.url), "utf8");
const detailSource = await readFile(new URL("../web/src/components/TaskDetail.tsx", import.meta.url), "utf8");
const statusDockSource = await readFile(new URL("../web/src/components/StatusDock.tsx", import.meta.url), "utf8");

test("the resource library shows only native Codex projects and thread resources", () => {
  assert.match(appSource, /hostContext\?\.projects \?\? \[\]/);
  assert.match(appSource, /resourceProjectChoices/);
  assert.match(appSource, /codexThreadResourcesLoaded/);
  assert.match(appSource, /persistedById/);
  assert.match(appSource, /className="project-nav resource-library"/);
  assert.match(appSource, /application\/x-taskboard-project/);
  assert.match(appSource, /application\/x-taskboard-codex-thread/);
  assert.match(appSource, /listCodexThreadResources/);
  assert.match(appSource, /NON_PROJECT_RESOURCE_ID/);
  assert.match(appSource, />非项目会话</);
  assert.match(appSource, /codexThreadResourcesLoaded\s*\? codexResourceProjects\.map/);
  assert.match(appSource, /CODEX_THREAD_RESOURCE_POLL_MS = 10_000/);
  assert.match(appSource, /addEventListener\("visibilitychange", refreshWhenVisible\)/);
  assert.match(appSource, /validThreadKeys/);
  assert.match(appSource, /setPublisherThreads\(\(current\) =>/);
  assert.match(appSource, /createProjectRequest/);
  assert.match(apiSource, /export async function listCodexThreadResources/);
  assert.match(apiSource, /export async function createProject/);
});

test("all issues load into one unified workbench", () => {
  assert.match(apiSource, /export async function listTasks\(projectId\?: string \| null/);
  assert.match(apiSource, /if \(projectId\) params\.set\("projectId", projectId\)/);
  assert.match(appSource, /listTasks\(null, options\.signal\)/);
  assert.match(appSource, /TASK_STATUSES\.map\(\(status\) => \[status, filteredTasks\.filter/);
  assert.doesNotMatch(appSource, /changeProject\(saved\.projectId\)/);
});

test("the persistent publisher creates backlog tasks and can bind selected threads", () => {
  assert.match(appSource, /className="task-publisher"/);
  assert.match(appSource, /handlePublisherDrop/);
  assert.match(appSource, /selectedThreadResources/);
  assert.match(appSource, /status: "backlog"/);
  assert.match(appSource, /codexThreadId: target\.threadId/);
  assert.match(styles, /\.task-publisher \{/);
});

test("box selection and batch task dragging are wired through the board", () => {
  assert.match(appSource, /taskSelectionBox/);
  assert.match(appSource, /updateTaskSelectionFromBox/);
  assert.match(appSource, /selectedTaskIds/);
  assert.match(appSource, /finishTaskDrop\(destination: TaskStatus, taskIds: string\[\] \| string/);
  assert.match(styles, /\.task-selection-marquee/);
  assert.match(styles, /\.task-card\.is-selected/);
});

test("new issues can target any synced project while existing issue details stay fixed", () => {
  assert.match(editorSource, /className="property-control property-project"/);
  assert.match(editorSource, /projects\.map\(\(project\) =>/);
  assert.match(editorSource, /onProjectChange\(event\.target\.value\)/);
  assert.doesNotMatch(detailSource, /project-property-icon|project\.name/);
  assert.match(appSource, /createTaskRequest\(targetProjectId, draft\)/);
  assert.match(appSource, /setTasks\(\(current\) => sortTasks\(\[/);
});

test("the unified workbench keeps three primary columns and opens review states from a compact dock", () => {
  assert.match(appSource, /const WORKBENCH_STATUSES: TaskStatus\[\] = \["backlog", "todo", "in_progress"\]/);
  assert.match(appSource, /const STATUS_DOCK_STATUSES: TaskStatus\[\] = \["in_review", "blocked", "done"\]/);
  assert.match(appSource, /<StatusDock[\s\S]*?activeStatus=\{activeStatusDrawer\}/);
  assert.match(appSource, /className="status-drawer"/);
  assert.match(statusDockSource, /onDrop: \(status: TaskStatus, taskId: string\) => void/);
  assert.match(styles, /\.workbench-board \.board-column \{[\s\S]*?flex: 1 1 0/);
  assert.match(styles, /\.status-dock \{[\s\S]*?grid-template-rows: repeat\(3/);
});

test("realtime task updates refresh the unified task list", () => {
  assert.match(appSource, /useEffect\(\(\) => \{\s*const source = new EventSource\("\/api\/events"\)/);
  assert.match(appSource, /event\.type\.startsWith\("task\."\)[\s\S]*?scheduleRefresh\(\{ projects: true, tasks: true \}\)/);
});

test("narrow screens keep the resource library, board, and publisher usable", () => {
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*?\.project-nav\.resource-library \{/);
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*?\.task-publisher \{/);
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*?\.board-column \{/);
});

test("user-facing Chinese copy is stored as UTF-8 instead of mojibake", () => {
  assert.match(appSource, />任务面板<\/span>/);
  assert.match(appSource, />\s*议题看板/);
  assert.match(appSource, />项目<\/span>/);
  assert.doesNotMatch(appSource, /浠诲姟|璁|椤圭洰|妯″紡|鎼滅储|鎷栧埌|鈱榋|娓呴櫎/);
});
