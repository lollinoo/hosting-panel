import type { IpcSigningKey, IpcVerificationKey } from "@hosting-panel/contracts";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  DockerExecutorIpcServer,
  InMemoryDockerSimulatorAdapter,
  SignedDockerExecutorIpcClient,
} from "../src/index.js";
import { ExecutorCodedError } from "../src/traefik-config.js";

const HMAC_KEY = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: "0123456789abcdef0123456789abcdef-term-ipc-key" } as const;
const SESSION_ID = `term_${"c0ffee00".repeat(4)}`;
const AT = "2026-11-17T10:00:00.000Z";
const ENDED = { reason: "closed", at: AT } as const;
const RECORD = { sessionId: SESSION_ID, siteId: "site_1", serviceInstanceId: "svc_1", containerName: "hp_svc_svc_1", openedAt: AT, ended: null };

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});

/** A port double that records each terminal call and answers fixed values, or throws a set error. */
function recordingPort() {
  const calls: Array<[string, unknown]> = [];
  let failure: ExecutorCodedError | null = null;
  const answer = <T>(name: string, req: unknown, value: T): Promise<T> => {
    calls.push([name, req]);
    return failure ? Promise.reject(failure) : Promise.resolve(value);
  };
  const port = {
    isRuntimeAvailable: true,
    openTerminal: (req) => answer("openTerminal", req, { containerName: "hp_svc_svc_1", openedAt: AT }),
    writeTerminal: (req) => answer("writeTerminal", req, undefined),
    readTerminal: (req) => answer("readTerminal", req, { output: "/var/www/html $ ", cursor: 16, dropped: false, ended: ENDED }),
    closeTerminal: (req) => answer("closeTerminal", req, ENDED),
    listTerminals: () => answer("listTerminals", undefined, [RECORD]),
    restartPanelContainer: (req) => answer("restartPanelContainer", req, { startedAt: AT }),
  } as Partial<DockerExecutorPort> as DockerExecutorPort;
  return { port, calls, fail: (code: string) => { failure = new ExecutorCodedError("refused", code as never); } };
}

async function ipc(executor: DockerExecutorPort) {
  const server = new DockerExecutorIpcServer({
    executor,
    keyring: { "hmac-v1": HMAC_KEY as IpcVerificationKey },
    transport: "loopback-test",
  });
  cleanup.push(() => server.stop());
  const bound = await server.start();
  return new SignedDockerExecutorIpcClient({ signingKey: HMAC_KEY as IpcSigningKey, transport: "loopback-test", port: bound.port });
}

describe("terminal IPC routes", () => {
  it("each of the six calls reaches its route and returns the parsed answer", async () => {
    const { port, calls } = recordingPort();
    const client = await ipc(port);
    expect(await client.openTerminal({ sessionId: SESSION_ID, siteId: "site_1", serviceInstanceId: "svc_1" }))
      .toEqual({ containerName: "hp_svc_svc_1", openedAt: AT });
    expect(await client.writeTerminal({ sessionId: SESSION_ID, input: "id\n" })).toBeUndefined();
    expect(await client.readTerminal({ sessionId: SESSION_ID, cursor: 0 }))
      .toEqual({ output: "/var/www/html $ ", cursor: 16, dropped: false, ended: ENDED });
    expect(await client.closeTerminal({ sessionId: SESSION_ID })).toEqual(ENDED);
    expect(await client.listTerminals()).toEqual([RECORD]);
    expect(await client.restartPanelContainer({ component: "mail_relay" })).toEqual({ startedAt: AT });
    expect(calls).toEqual([
      ["openTerminal", { sessionId: SESSION_ID, siteId: "site_1", serviceInstanceId: "svc_1" }],
      ["writeTerminal", { sessionId: SESSION_ID, input: "id\n" }],
      ["readTerminal", { sessionId: SESSION_ID, cursor: 0 }],
      ["closeTerminal", { sessionId: SESSION_ID }],
      ["listTerminals", undefined],
      ["restartPanelContainer", { component: "mail_relay" }],
    ]);
  });

  it("refuses bad requests with VALIDATION_ERROR before the port is called", async () => {
    const { port, calls } = recordingPort();
    const client = await ipc(port);
    const canary = `HPCANARY_${"x".repeat(4097)}`;
    const long = await client.writeTerminal({ sessionId: SESSION_ID, input: canary }).catch((e: unknown) => e);
    expect(long).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(JSON.stringify(long)).not.toContain("HPCANARY");
    expect(String((long as Error).message)).not.toContain("HPCANARY");
    await expect(client.readTerminal({ sessionId: "term_NOT_A_SESSION", cursor: 0 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(client.closeTerminal({ sessionId: `${SESSION_ID}0` })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(client.readTerminal({ sessionId: SESSION_ID, cursor: -1 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(client.restartPanelContainer({ component: "hp_api" as never })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(calls).toEqual([]);
  });

  it("passes NOT_FOUND and RESOURCE_LOCKED from the port to the client", async () => {
    const { port, fail } = recordingPort();
    const client = await ipc(port);
    fail("NOT_FOUND");
    await expect(client.openTerminal({ sessionId: SESSION_ID, siteId: "site_1", serviceInstanceId: "svc_1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(client.readTerminal({ sessionId: SESSION_ID, cursor: 0 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    fail("RESOURCE_LOCKED");
    await expect(client.restartPanelContainer({ component: "sftp" })).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
    await expect(client.openTerminal({ sessionId: SESSION_ID, siteId: "site_1", serviceInstanceId: "svc_1" })).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
  });
});

describe("restartPanelContainer on the simulator", () => {
  it("changes the start time of that one component and answers NOT_FOUND for a missing one", async () => {
    const sim = new InMemoryDockerSimulatorAdapter();
    const client = await ipc(sim);
    const before = await client.getPanelContainers();
    sim.setPanelContainer("shared_database", { restartCount: 3 });
    const { startedAt } = await client.restartPanelContainer({ component: "shared_database" });
    expect(startedAt).not.toBeNull();
    const after = await client.getPanelContainers();
    for (const row of after) {
      const old = before.find((r) => r.component === row.component)!;
      if (row.component === "shared_database") {
        expect(row).toMatchObject({ state: "running", startedAt, restartCount: 0 });
        expect(row.startedAt).not.toBe(old.startedAt);
      } else {
        expect(row).toEqual(old);
      }
    }
    expect(after.find((r) => r.component === "phpmyadmin")?.state).toBe("missing");
    await expect(client.restartPanelContainer({ component: "phpmyadmin" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
