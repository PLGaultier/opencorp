import { describe, expect, test } from "bun:test";
import { Tracer, publicTraceUrl, type TraceConfig } from "../src/trace";

const cfg: TraceConfig = {
  host: "https://langfuse.example.com/",
  publicKey: "pk",
  secretKey: "sk",
  projectId: "proj1",
};

function fakeFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response("{}", { status: 207 });
  }) as typeof fetch;
  return { calls, fn };
}

describe("Langfuse tracer (§9.2)", () => {
  test("public trace URL needs a project id", () => {
    expect(publicTraceUrl(cfg, "t1")).toBe("https://langfuse.example.com/project/proj1/traces/t1");
    expect(publicTraceUrl({ host: cfg.host }, "t1")).toBeNull();
  });

  test("batches a public trace-create plus generations, with basic auth", async () => {
    const { calls, fn } = fakeFetch();
    const tracer = new Tracer(cfg, fn);
    const times = { startTime: new Date("2026-06-10T10:00:00Z"), endTime: new Date("2026-06-10T10:00:02Z") };
    tracer.generation({ traceId: "task-1", name: "step-1", model: "standard", input: "i", output: "o", usage: { input: 100, output: 20 }, ...times });
    tracer.generation({ traceId: "task-1", name: "step-2", model: "standard", input: "i2", output: "o2", ...times });
    expect(calls).toHaveLength(0); // nothing sent before flush

    await tracer.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://langfuse.example.com/api/public/ingestion");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from("pk:sk").toString("base64")}`);

    const { batch } = JSON.parse(String(calls[0]!.init.body)) as { batch: { type: string; body: Record<string, unknown> }[] };
    expect(batch.map((e) => e.type)).toEqual(["trace-create", "generation-create", "generation-create"]);
    expect(batch[0]!.body).toMatchObject({ id: "task-1", public: true });
    expect(batch[1]!.body).toMatchObject({ traceId: "task-1", name: "step-1", usage: { input: 100, output: 20 } });

    // queue drained; flush with nothing queued sends nothing
    await tracer.flush();
    expect(calls).toHaveLength(1);
  });

  test("flush never throws on network failure", async () => {
    const tracer = new Tracer(cfg, (() => Promise.reject(new Error("down"))) as typeof fetch);
    tracer.generation({ traceId: "t", name: "s", model: "m", input: "i", output: "o", startTime: new Date(), endTime: new Date() });
    await tracer.flush(); // must not reject
  });
});
