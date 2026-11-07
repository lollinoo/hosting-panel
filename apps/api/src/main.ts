import "reflect-metadata";
import { createControlPlaneApp } from "./create-app.js";

async function bootstrap(): Promise<void> {
  const port = process.env["PORT"]
    ? Number.parseInt(process.env["PORT"], 10)
    : process.env["API_PORT"]
      ? Number.parseInt(process.env["API_PORT"], 10)
      : 4000;
  const host = process.env["API_HOST"] ?? "127.0.0.1";
  const fakeCoolifyPort = process.env["FAKE_COOLIFY_PORT"]
    ? Number.parseInt(process.env["FAKE_COOLIFY_PORT"], 10)
    : 4101;

  const handle = await createControlPlaneApp({
    host,
    port,
    listen: true,
    fakeCoolifyPort,
    enableBackgroundWorker: true,
    corsOrigin: process.env["WEB_ORIGIN"] ?? "http://127.0.0.1:3000",
  });

  console.log(
    `[hosting-panel-api] Control Plane API listening on ${handle.baseUrl ?? `${host}:${String(port)}`}`,
  );
  if (handle.fakeCoolify) {
    console.log(
      `[hosting-panel-api] Embedded Fake Coolify v4 Lab listening on ${handle.fakeCoolify.baseUrl}`,
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[hosting-panel-api] Received ${signal}; shutting down cleanly...`);
    try {
      await handle.close();
      process.exit(0);
    } catch (error) {
      console.error("[hosting-panel-api] Error during shutdown:", error);
      process.exit(1);
    }
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

void bootstrap().catch((error: unknown) => {
  console.error("[hosting-panel-api] Fatal startup error:", error);
  process.exit(1);
});
