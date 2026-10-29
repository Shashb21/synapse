/** Dedicated test server: ordinary provider transport, isolated build output, no LLM stub. */
import { createServer } from "node:http";
import { once } from "node:events";
import next from "next";

const endpoint = new URL(process.env.XAI_BASE_URL);
if (endpoint.hostname !== "127.0.0.1" || process.env.XAI_API_KEY !== "kan80-local-fixture") {
  throw new Error("Learning browser server requires the loopback fixture provider.");
}
// Bind first: port zero lets the OS reserve a free port without a check/use race.
const server = createServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("Learning browser server has no TCP address.");
const app = next({ dev: true, dir: process.env.KAN80_PROJECT_DIR, hostname: "127.0.0.1", port: address.port });
await app.prepare();
const handle = app.getRequestHandler();
server.on("request", (request, response) => {
  handle(request, response).catch(error => {
    console.error(error);
    if (!response.headersSent) response.writeHead(500);
    response.end("Learning fixture server failed.");
  });
});
process.send?.({ ready: true, port: address.port });
process.on("SIGTERM", async () => {
  server.closeAllConnections();
  server.close();
  await app.close();
  process.exit(0);
});
