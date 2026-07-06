import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompany, getTask } from "@/lib/data";
import { forwardCookie, isOwner } from "@/lib/server-auth";
import { AgentSprite } from "../../../../sprites";
import { TaskActions } from "./task-actions";

const dt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

export default async function TaskPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  if (!(await isOwner(slug))) notFound(); // task detail is owner-only (§4)
  const [data, task] = await Promise.all([getCompany(slug), getTask(slug, id, await forwardCookie())]);
  if (!data || !task) notFound();

  const failed = task.status === "failed";
  const done = task.status === "done";

  // The task's lifecycle as mission-log lines (same CRT language as the floor).
  const log: { at: string | null; actor: string; cls: string; text: string }[] = [
    { at: task.createdAt, actor: "[SYS ]", cls: "dim", text: "task created" },
    ...(task.startedAt ? [{ at: task.startedAt, actor: "[WRKR]", cls: "", text: "worker picked it up" }] : []),
    ...(task.finishedAt
      ? [{ at: task.finishedAt, actor: "[SYS ]", cls: done ? "ok" : failed ? "fail" : "", text: `task → ${task.status}` }]
      : []),
    ...(task.resultSummary ? [{ at: null, actor: "", cls: "dim", text: task.resultSummary }] : []),
    ...(task.error ? [{ at: null, actor: "", cls: "fail", text: `error: ${task.error}` }] : []),
  ];

  return (
    <main>
      <Link href={`/c/${slug}`} className="backlink">
        ← {data.company.name}
      </Link>

      <div className="mission-head">
        <AgentSprite kind="worker" size={40} />
        <div>
          <h1 style={{ marginBottom: "0.15rem" }}>
            {task.title} <span className={`pill ${task.status}`}>{task.status}</span>
          </h1>
          {task.description && <p className="sub" style={{ margin: 0 }}>{task.description}</p>}
        </div>
      </div>

      <div className="pnl" style={{ margin: "1.25rem 0" }}>
        <div>
          <span>Priority</span>
          <b>{task.priority}</b>
        </div>
        <div>
          <span>Credits est. / charged</span>
          <b>
            {task.creditsEstimated ?? "—"} / {task.creditsCharged ?? "—"}
          </b>
        </div>
      </div>

      {/* Mission log — the task's lifecycle in the house CRT */}
      <div className="terminal mini-crt">
        <div className="term-head">
          <span className={`term-live ${task.status === "running" ? "on" : ""}`} />
          <span className="term-title">Mission log</span>
        </div>
        <div className="term-body">
          {log.map((l, i) => (
            <div className="tl" key={i}>
              <span className="tl-time">{l.at ? dt(l.at) : ""}</span>
              <span className={`tl-actor ${l.actor === "[WRKR]" ? "a-worker" : "a-system"}`}>{l.actor}</span>
              <span className={`tl-body ${l.cls}`}>{l.text}</span>
            </div>
          ))}
          {task.status === "running" && (
            <div className="tl">
              <span className="tl-time" />
              <span className="tl-actor" />
              <span className="tl-body dim">running — live steps stream on the company floor ▮</span>
            </div>
          )}
          {task.traceUrl && (
            <div className="tl">
              <span className="tl-time" />
              <span className="tl-actor a-system">[SYS ]</span>
              <span className="tl-body">
                <a href={task.traceUrl} className="term-link">full LLM trace ↗</a>
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Editing is secondary — folded away to keep the dossier clean */}
      <details className="task-edit">
        <summary>✎ Edit task (title · priority · status · delete)</summary>
        <TaskActions slug={slug} task={task} />
      </details>
    </main>
  );
}
