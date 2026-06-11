import type { Agent, DepartmentPlan } from "@/lib/data";

/**
 * The org chart (M5): CEO + department heads (CMO/CTO/CFO) + workers, with
 * each agent's role prompt inline (transparency includes the prompts) and the
 * departments' most recent heartbeat advice from the ledger.
 */
export function OrgChart({
  agents,
  departmentPlans,
}: {
  agents: Agent[];
  departmentPlans: DepartmentPlan[];
}) {
  if (agents.length === 0) return null;

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <h2 style={{ fontSize: "1.05rem" }}>Org chart</h2>
      {agents.map((a) => (
        <div className="agent" key={a.id}>
          <span className={`pill ${a.kind}`}>{a.kind}</span>
          <span>{a.name}</span>
          <span className="sub" style={{ marginLeft: "auto" }}>
            {a.modelTier}
          </span>
          <details>
            <summary className="sub">role prompt</summary>
            <p className="sub" style={{ whiteSpace: "pre-wrap" }}>
              {a.rolePrompt}
            </p>
          </details>
        </div>
      ))}

      {departmentPlans.length > 0 && (
        <>
          <h3 style={{ fontSize: "0.95rem", marginTop: "1rem" }}>Recent department plans</h3>
          {departmentPlans.slice(0, 6).map((p) => (
            <div className="agent plan" key={p.seq}>
              <span className="pill department">{p.actor}</span>
              <span>
                {p.payload.headline ?? "—"}
                {p.payload.proposedTasks && p.payload.proposedTasks.length > 0 && (
                  <span className="sub"> · proposed: {p.payload.proposedTasks.join(" · ")}</span>
                )}
              </span>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
