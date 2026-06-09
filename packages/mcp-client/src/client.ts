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
  const res = await fetch(`${gatewayUrl}/tools/${server}/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(args ?? {}),
  });
  const body = (await res.json().catch(() => ({ error: "bad_gateway_response" }))) as Record<
    string,
    unknown
  >;
  if (!res.ok) return { ok: false, ...body } as ToolResult;
  return { ok: true, result: body };
}
