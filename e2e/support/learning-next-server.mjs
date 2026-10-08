/** Dedicated test server: ordinary provider transport, isolated build output, no LLM stub. */
import { createServer } from "node:http";
import next from "next";

const port = Number(process.env.KAN80_BROWSER_PORT);
const endpoint = new URL(process.env.XAI_BASE_URL);
if (endpoint.hostname !== "127.0.0.1" || process.env.XAI_API_KEY !== "kan80-local-fixture") {
  throw new Error("Learning browser server requires the loopback fixture provider.");
}
const app = next({ dev: true, dir: process.env.KAN80_PROJECT_DIR, hostname: "127.0.0.1", port });
await app.prepare();
const handle = app.getRequestHandler();
const server = createServer((request, response) => {
  handle(request, response).catch(error => {
    console.error(error);
    if (!response.headersSent) response.writeHead(500);
    response.end("Learning fixture server failed.");
  });
});
server.listen(port, "127.0.0.1", () => process.send?.({ ready: true }));
process.on("SIGTERM", async () => {
  server.closeAllConnections();
  server.close();
  await app.close();
  process.exit(0);
});
