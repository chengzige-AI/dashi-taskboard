import type { DragEvent } from "react";
import type { TaskStatus } from "../types";
import { STATUS_DETAILS, StatusIcon } from "./BoardColumn";

interface StatusDockProps {
  statuses: TaskStatus[];
  counts: Record<TaskStatus, number>;
  activeStatus: TaskStatus | null;
  dropTarget: TaskStatus | null;
  onSelect: (status: TaskStatus) => void;
  onDragTargetChange: (status: TaskStatus | null) => void;
  onDrop: (status: TaskStatus, taskId: string) => void;
}

export function StatusDock({
  statuses,
  counts,
  activeStatus,
  dropTarget,
  onSelect,
  onDragTargetChange,
  onDrop,
}: StatusDockProps) {
  function dropTask(event: DragEvent<HTMLButtonElement>, status: TaskStatus) {
    event.preventDefault();
    const taskId = event.dataTransfer.getData("application/x-taskboard-task")
      || event.dataTransfer.getData("text/plain");
    onDragTargetChange(null);
    if (taskId) onDrop(status, taskId);
  }

  return (
    <aside className="status-dock" aria-label="其他任务状态">
      {statuses.map((status) => {
        const details = STATUS_DETAILS[status];
        const active = activeStatus === status;
        return (
          <button
            key={status}
            type="button"
            className={`status-dock-button status-${status}${active ? " active" : ""}${dropTarget === status ? " is-drop-target" : ""}`}
            aria-pressed={active}
            aria-label={`显示${details.label}，${counts[status]}个议题`}
            title={`显示${details.label}`}
            onClick={() => onSelect(status)}
            onDragEnter={(event) => {
              event.preventDefault();
              onDragTargetChange(status);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              onDragTargetChange(status);
            }}
            onDragLeave={(event) => {
              if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                onDragTargetChange(null);
              }
            }}
            onDrop={(event) => dropTask(event, status)}
          >
            <span className={`status-icon status-icon-${details.tone}`}><StatusIcon status={status} /></span>
            <span className="status-dock-label">{details.label}</span>
            <span className="status-dock-count">{counts[status]}</span>
          </button>
        );
      })}
    </aside>
  );
}
