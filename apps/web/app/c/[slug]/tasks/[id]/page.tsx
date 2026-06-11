import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompany, getTask } from "@/lib/data";
import { TaskActions } from "./task-actions";

const dt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

export default async function TaskPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const [data, task] = await Promise.all([getCompany(slug), getTask(slug, id)]);
  if (!data || !task) notFound();

  return (
    <main>
      <Link href={`/c/${slug}`} className="backlink">
        ← {data.company.name}
      </Link>
      <h1>
        {task.title} <span className={`pill ${task.status}`}>{task.status}</span>
      </h1>
      {task.description && <p className="sub">{task.description}</p>}

      <div className="pnl">
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
        <div>
          <span>Created</span>
          <b>{dt(task.createdAt)}</b>
        </div>
        <div>
          <span>Started</span>
          <b>{dt(task.startedAt)}</b>
        </div>
        <div>
          <span>Finished</span>
          <b>{dt(task.finishedAt)}</b>
        </div>
      </div>

      {task.resultSummary && (
        <div className="detail-block">
          <span className="sub">Result</span>
          <p>{task.resultSummary}</p>
        </div>
      )}
      {task.error && (
        <div className="detail-block error">
          <span className="sub">Error</span>
          <p>{task.error}</p>
        </div>
      )}
      {task.traceUrl && (
        <p className="sub" style={{ marginTop: "0.75rem" }}>
          <a href={task.traceUrl} style={{ textDecoration: "underline" }}>
            full LLM trace ↗
          </a>
        </p>
      )}

      <section style={{ marginTop: "2rem" }}>
        <TaskActions slug={slug} task={task} />
      </section>
    </main>
  );
}
