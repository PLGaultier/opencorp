import { createGateway } from "./app";

const { app } = createGateway();
const port = Number(process.env.PORT ?? 3004);
console.log(`mcp-gateway listening on :${port}`);
export default { port, fetch: app.fetch };
