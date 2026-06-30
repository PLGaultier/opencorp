/**
 * GLM bundle smoke test (OPE-6): verifies the z.ai GLM tiers are reachable
 * through LiteLLM and that JSON-only mode works — the two things the CEO
 * plan/chat paths depend on. Run this once after adding the GLM entries to
 * infra/compose/litellm.config.yaml and ZAI_API_KEY to the LiteLLM env.
 *
 * It does NOT touch the DB or the agent pipeline — it probes the proxy directly,
 * so it's a fast pre-flight before wiring pricing.ts and the plumbing.
 *
 *   LITELLM_URL=http://localhost:4000 bun apps/gateway/scripts/glm-smoke.ts
 *
 * Pass criteria:
 *   - each glm tier returns content + echoes a model id (printed, feeds pricing.ts)
 *   - response_format: json_object yields parseable JSON (else CEO needs a repair path)
 *
 * Tier mapping (infra/compose/litellm.config.yaml): glm-mini -> zai/glm-4.5-air,
 * glm-standard -> zai/glm-4.6, glm-frontier -> zai/glm-4.7.
 */
const LITELLM_URL = process.env.LITELLM_URL ?? "http://localhost:4000";
const API_KEY = process.env.LITELLM_API_KEY;

const TIERS = ["glm-mini", "glm-standard", "glm-frontier"] as const;

function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function complete(model: string, body: Record<string, unknown>) {
  const res = await fetch(`${LITELLM_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}),
    },
    // Headroom matters: glm-4.7 (frontier) is a reasoning model — a tiny budget
    // is spent on reasoning_tokens before any content, yielding empty output.
    // Production CEO calls use 2048; 1024 is plenty for this probe.
    body: JSON.stringify({ model, max_tokens: 1024, ...body }),
  });
  if (!res.ok) throw new Error(`${model} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as {
    choices: { message: { content: string } }[];
    model?: string;
  };
}

async function main() {
  console.log(`LiteLLM at ${LITELLM_URL}\n`);

  // 1. each tier reachable; print the echoed model id (this is what pricing.ts keys on)
  for (const tier of TIERS) {
    const data = await complete(tier, {
      messages: [{ role: "user", content: "Reply with the single word: pong" }],
    });
    const content = data.choices[0]?.message?.content ?? "";
    ok(content.length > 0, `${tier} reachable — echoed model="${data.model ?? "?"}", said "${content.trim().slice(0, 40)}"`);
  }

  // 2. JSON-only mode — the CEO plan/chat schemas require this
  console.log("\nChecking response_format: json_object (CEO plan/chat depend on it):");
  for (const tier of TIERS) {
    const data = await complete(tier, {
      response_format: { type: "json_object" },
      messages: [
        { role: "user", content: 'Return ONLY this JSON object: {"ready": true, "tier": "' + tier + '"}' },
      ],
    });
    const raw = (data.choices[0]?.message?.content ?? "").replace(/^```(?:json)?\n?|```$/g, "").trim();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* leaves parsed null */
    }
    ok(parsed !== null, `${tier} honors json_object (parsed: ${raw.slice(0, 60)})`);
  }

  console.log("\nGLM smoke test PASSED — tiers reachable and JSON mode works.");
}

main().catch((err) => {
  console.error("\n" + err.message);
  console.error("\nIf JSON mode failed, the CEO plan/chat paths need a repair fallback (see OPE-6).");
  process.exitCode = 1;
});
