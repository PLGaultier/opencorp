/** Thin MCP-over-HTTP client used by agentd inside the sandbox (§8). */

export interface ToolResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  // rate-limit contract fields (§7.2)
  retry_after_s?: number;
  should_wait?: boolean;
  message?: string;
}

export async function callTool(
  gatewayUrl: string,
  token: string,
  server: string,
  tool: string,
  args: unknown,
): Promise<ToolResult> {
  // Retry only transient *transport* failures (connection resets), never HTTP
  // responses — a rate-limited/erroring call reached the gateway and must count
  // (§7.2). A reset never hit the server, so retrying it is safe and idempotent
  // at the transport layer.
  let res: Response | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${gatewayUrl}/tools/${server}/${tool}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(args ?? {}),
      });
      break;
    } catch (err) {
      if (attempt >= 3) return { ok: false, error: "gateway_unreachable", message: String(err) };
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
    }
  }
  const body = (await res.json().catch(() => ({ error: "bad_gateway_response" }))) as Record<
    string,
    unknown
  >;
  if (!res.ok) return { ok: false, ...body } as ToolResult;
  return { ok: true, result: body };
}
