"use client";

import Link from "next/link";
import { useState } from "react";

export interface TaskRow {
  key: string;
  href?: string;
  status: string;
  title: string;
}

const TASK_LABEL: Record<string, string> = {
  running: "Running",
  queued: "Queued",
  pending: "Pending",
  failed: "Failed",
  done: "Done",
};

function Row({ t }: { t: TaskRow }) {
  const inner = (
    <>
      <span className={`task-dot ${t.status}`} />
      <span className="task-title">{t.title}</span>
      <span className={`task-state ${t.status}`}>{TASK_LABEL[t.status]}</span>
    </>
  );
  return t.href ? (
    <Link className="task-row" href={t.href}>
      {inner}
    </Link>
  ) : (
    <div className="task-row">{inner}</div>
  );
}

/**
 * Task list with finished (done) tasks collapsed behind a "＋" toggle at the
 * end, so the active work is what the user sees first. Tasks arrive pre-sorted
 * active-first from the page.
 */
export function TaskList({ tasks }: { tasks: TaskRow[] }) {
  const [showDone, setShowDone] = useState(false);

  if (tasks.length === 0) return <p className="sub">No tasks yet.</p>;

  const active = tasks.filter((t) => t.status !== "done");
  const done = tasks.filter((t) => t.status === "done");

  return (
    <div className="task-list">
      {active.map((t) => (
        <Row key={t.key} t={t} />
      ))}
      {showDone && done.map((t) => <Row key={t.key} t={t} />)}
      {done.length > 0 && (
        <button className="task-toggle" type="button" onClick={() => setShowDone((v) => !v)}>
          {showDone ? "−" : "＋"} {done.length} finished {done.length === 1 ? "task" : "tasks"}
        </button>
      )}
    </div>
  );
}
