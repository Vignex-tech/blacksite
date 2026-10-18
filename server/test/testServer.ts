// One Colyseus test server shared by every test file. Booting a second server
// in the same process after shutting one down fails to match-make, so each
// file calls testServer() (booted once, on first use) and the root `after`
// hook below shuts it down when the whole run ends.
import { ColyseusTestServer, boot } from "@colyseus/testing";
import appConfig from "../src/app.config.js";

let server: Promise<ColyseusTestServer<typeof appConfig>> | undefined;

export function testServer(): Promise<ColyseusTestServer<typeof appConfig>> {
  server ??= boot(appConfig);
  return server;
}

// Root-level hook: runs once, after every test in every file.
after(async () => {
  if (server) await (await server).shutdown();
});
