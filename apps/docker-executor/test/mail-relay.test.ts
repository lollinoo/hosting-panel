import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAIL_RELAY_CONTAINER_NAME, MAIL_RELAY_IMAGE } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DockerEngineSocketAdapter,
  MAIL_RELAY_NETWORK_NAME,
  MAIL_RELAY_SASL_FILE,
  MAIL_RELAY_SPOOL_VOLUME,
  SHARED_DB_CONFIG_SHA256_LABEL,
  buildMailRelayContainerPayload,
  buildMailRelaySaslLine,
} from "../src/index.js";
import { startMockDockerDaemon } from "./mock-docker-daemon.js";

const cleanupTasks: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const task of cleanupTasks.splice(0).reverse()) {
    await task();
  }
});

const PASSWORD = `Canary:#$"' ü inner ${"x".repeat(8)}`;
const req = {
  host: "smtp.provider.example",
  port: 587 as const,
  username: "user@provider.example",
  password: PASSWORD,
  senderDomain: "mail.hostingco.it",
};
const SECRET_DIR = "/run/hosting-panel/mail-relay";
const build = (over: Partial<typeof req> | { port: 465 } = {}, myHostname = "panel.hostingco.it") =>
  buildMailRelayContainerPayload({ req: { ...req, ...over }, myHostname, secretDirHostPath: SECRET_DIR });

describe("buildMailRelayContainerPayload", () => {
  it("relay env enforces the header rewrite for site clients", () => {
    const env = build().Env;
    expect(env).toContain("POSTFIX_local_header_rewrite_clients=permit_mynetworks");
    expect(env).toContain("POSTFIX_sender_canonical_classes=envelope_sender,header_sender");
    expect(env).toContain("POSTFIX_sender_canonical_maps=static:noreply@mail.hostingco.it");
    expect(env[0]).toBe("RELAYHOST=[smtp.provider.example]:587");
    expect(env).toContain("POSTFIX_myhostname=panel.hostingco.it");
  });

  it("site clients are not exempt from the rate limit", () => {
    const env = build().Env;
    expect(env).toContain("POSTFIX_smtpd_client_event_limit_exceptions=127.0.0.0/8");
    expect(env).toContain("POSTFIX_smtpd_client_message_rate_limit=200");
    expect(env).toContain("POSTFIX_anvil_rate_time_unit=3600s");
    expect(env).toContain("POSTFIX_smtpd_recipient_limit=100");
    expect(env).toContain("POSTFIX_message_size_limit=26214400");
    expect(env.filter((e) => /^POSTFIX_[^=]+=$/.test(e))).toEqual([]);
    // An empty POSTFIX_* value would silently restore the Postfix default.
    expect(() => build({}, "")).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });

  it("relay requires verified TLS", () => {
    expect(build().Env).toContain("POSTFIX_smtp_tls_security_level=secure");
    expect(build().Env).toContain("POSTFIX_smtp_tls_wrappermode=no");
    const tls = build({ port: 465 }).Env;
    expect(tls).toContain("POSTFIX_smtp_tls_wrappermode=yes");
    expect(tls).toContain("RELAYHOST=[smtp.provider.example]:465");
  });

  it("relay binds only a tmpfs directory and a named volume, never a tmpfs file", () => {
    const p = build();
    expect(p.Image).toBe(MAIL_RELAY_IMAGE);
    expect(p.HostConfig.Binds).toEqual([
      `${SECRET_DIR}:/run/secrets/hp-mail:ro`,
      `${MAIL_RELAY_SPOOL_VOLUME}:/var/spool/postfix`,
    ]);
    expect(JSON.stringify(p)).not.toContain(`${SECRET_DIR}/${MAIL_RELAY_SASL_FILE}`);
    expect("PortBindings" in p.HostConfig).toBe(false);
    expect(p.HostConfig).toMatchObject({
      CapDrop: ["ALL"],
      CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "NET_BIND_SERVICE", "SETGID", "SETUID"],
      SecurityOpt: ["no-new-privileges:true"],
      Memory: 134217728,
      MemorySwap: 134217728,
      NanoCpus: 500000000,
      PidsLimit: 128,
      RestartPolicy: { Name: "unless-stopped" },
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
      NetworkMode: MAIL_RELAY_NETWORK_NAME,
    });
    expect(p.Labels).toMatchObject({
      "io.hostingpanel.managed": "true",
      "io.hostingpanel.role": "mail_relay",
    });
    expect(() =>
      buildMailRelayContainerPayload({
        req,
        myHostname: "x.example",
        secretDirHostPath: "/var/run/docker.sock",
      }),
    ).toThrow(expect.objectContaining({ code: "HOST_POLICY_DENIED" }));
  });

  it("sasl line keeps the password verbatim and the payload never contains it", () => {
    expect(buildMailRelaySaslLine(req)).toBe(
      `[smtp.provider.example]:587 user@provider.example:${PASSWORD}\n`,
    );
    expect(JSON.stringify(build())).not.toContain("Canary");
    for (const bad of [
      { password: "a\nb" },
      { password: " lead" },
      { username: "a:b" },
      { host: "10.0.0.1" },
      { host: "SMTP.Provider.example" },
      { port: 26 },
    ]) {
      let thrown: unknown;
      try {
        buildMailRelaySaslLine({ ...req, ...bad } as typeof req);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({ code: "VALIDATION_ERROR" });
      expect(String((thrown as Error).message)).not.toContain("Canary");
    }
  });

  it("the config hash ignores the password", () => {
    const label = (p: ReturnType<typeof build>) => p.Labels[SHARED_DB_CONFIG_SHA256_LABEL];
    expect(label(build())).toMatch(/^[0-9a-f]{64}$/);
    expect(label(build({ password: "another-secret" }))).toBe(label(build()));
    expect(label(build({ host: "smtp.other.example" }))).not.toBe(label(build()));
  });
});

describe("DockerEngineSocketAdapter.applyMailRelay", () => {
  async function setup(options?: {
    readonly execExitCode?: number;
    readonly executorUid?: number;
    readonly createDir?: boolean;
  }) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-mail-relay-"));
    cleanupTasks.push(() => rm(tmp, { recursive: true, force: true }));
    const mockDaemon = await startMockDockerDaemon(
      options?.execExitCode !== undefined ? { execExitCode: options.execExitCode } : undefined,
    );
    cleanupTasks.push(() => mockDaemon.close());
    const secretDir = path.join(tmp, "mail-relay");
    if (options?.createDir !== false) {
      await mkdir(secretDir);
    }
    mockDaemon.createdNetworks.push({
      Name: "hp_site_internal_s1",
      Labels: { "io.hostingpanel.network_role": "site_internal" },
    });
    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: mockDaemon.socketPath,
      secretsRootDir: path.join(tmp, "secrets"),
      ingressRootDir: path.join(tmp, "ingress"),
      pullMissingImages: false,
      mailRelaySecretDir: secretDir,
      mailRelayFlushWaitMs: 50,
      ...(options?.executorUid !== undefined ? { executorUid: options.executorUid } : {}),
    });
    const relay = () =>
      [...mockDaemon.containers.values()].find((c) => c.name === MAIL_RELAY_CONTAINER_NAME);
    const count = (from: number, re: RegExp) =>
      mockDaemon.requestedPaths.slice(from).filter((p) => re.test(p)).length;
    const calls = (from: number) => ({
      create: count(from, /\/containers\/create/),
      restart: count(from, /\/containers\/hp_mail_relay\/restart\?t=10$/),
      exec: count(from, /\/containers\/hp_mail_relay\/exec$/),
    });
    return { adapter, mockDaemon, secretDir, relay, calls };
  }

  it("apply creates the relay, writes the secret 0444, attaches site networks and flushes", async () => {
    const { adapter, mockDaemon, secretDir, relay, calls } = await setup();
    await adapter.applyMailRelay(req);

    const file = path.join(secretDir, MAIL_RELAY_SASL_FILE);
    expect(await readFile(file, "utf8")).toBe(buildMailRelaySaslLine(req));
    expect((await stat(file)).mode & 0o777).toBe(0o444);
    expect(relay()?.running).toBe(true);
    expect(relay()?.hostConfig.Binds).toEqual([
      `${secretDir}:/run/secrets/hp-mail:ro`,
      `${MAIL_RELAY_SPOOL_VOLUME}:/var/spool/postfix`,
    ]);
    expect(mockDaemon.createdVolumes).toContain(MAIL_RELAY_SPOOL_VOLUME);
    expect(mockDaemon.volumeLabels.get(MAIL_RELAY_SPOOL_VOLUME)).toEqual({
      "io.hostingpanel.managed": "true",
    });
    expect(mockDaemon.createdNetworks).toContainEqual(
      expect.objectContaining({ Name: MAIL_RELAY_NETWORK_NAME, Internal: false }),
    );
    expect(mockDaemon.networkConnectCalls).toContainEqual({
      network: "hp_site_internal_s1",
      container: MAIL_RELAY_CONTAINER_NAME,
      aliases: ["hp-mail"],
    });
    expect(mockDaemon.execCalls).toEqual([
      { container: MAIL_RELAY_CONTAINER_NAME, Cmd: ["postqueue", "-f"] },
    ]);
    expect(calls(0)).toEqual({ create: 1, restart: 0, exec: 1 });
    expect(JSON.stringify([...mockDaemon.containers.values()])).not.toContain("Canary");
    expect(mockDaemon.requestedPaths.join("\n")).not.toContain("Canary");
  });

  it("apply restarts and flushes the relay only when the password file changes", async () => {
    const { adapter, mockDaemon, relay, calls } = await setup();
    await adapter.applyMailRelay(req);
    const firstId = relay()?.id;

    let from = mockDaemon.requestedPaths.length;
    await adapter.applyMailRelay(req);
    expect(calls(from)).toEqual({ create: 0, restart: 0, exec: 0 });

    from = mockDaemon.requestedPaths.length;
    await adapter.applyMailRelay({ ...req, password: "new-secret" });
    expect(calls(from)).toEqual({ create: 0, restart: 1, exec: 1 });
    expect(relay()?.id).toBe(firstId);

    from = mockDaemon.requestedPaths.length;
    await adapter.applyMailRelay({ ...req, password: "new-secret", host: "smtp.other.example" });
    expect(calls(from)).toEqual({ create: 1, restart: 0, exec: 1 });
    expect(relay()?.id).not.toBe(firstId);
    expect(mockDaemon.deletedVolumes).toEqual([]);
  });

  it("apply after the secret file vanished (reboot) restarts and flushes once", async () => {
    const { adapter, mockDaemon, secretDir, calls } = await setup();
    await adapter.applyMailRelay(req);
    await rm(path.join(secretDir, MAIL_RELAY_SASL_FILE));

    const from = mockDaemon.requestedPaths.length;
    await adapter.applyMailRelay(req);
    expect(calls(from)).toEqual({ create: 0, restart: 1, exec: 1 });
    expect(await readFile(path.join(secretDir, MAIL_RELAY_SASL_FILE), "utf8")).toBe(
      buildMailRelaySaslLine(req),
    );
  });

  it("a failed restart is retried by the next identical apply", async () => {
    const { adapter, mockDaemon, calls } = await setup();
    await adapter.applyMailRelay(req);
    const changed = { ...req, password: "new-secret" };

    mockDaemon.failRestarts.remaining = 1;
    await expect(adapter.applyMailRelay(changed)).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
    });

    const from = mockDaemon.requestedPaths.length;
    await adapter.applyMailRelay(changed);
    expect(calls(from)).toEqual({ create: 0, restart: 1, exec: 1 });
  });

  it("a flush that keeps failing does not fail the apply", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { adapter, mockDaemon, relay } = await setup({ execExitCode: 1 });
    await expect(adapter.applyMailRelay(req)).resolves.toBeUndefined();
    expect(relay()?.running).toBe(true);
    expect(mockDaemon.execCalls.length).toBeGreaterThanOrEqual(1);
    const logged = warn.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('"event":"mail_relay_flush_failed"'))).toBe(true);
    expect(logged.join("\n")).not.toContain("Canary");
  });

  it("concurrent applies run one after the other and the last one wins", async () => {
    const { adapter, secretDir } = await setup();
    const second = { ...req, password: "second-secret" };
    await Promise.all([adapter.applyMailRelay(req), adapter.applyMailRelay(second)]);
    expect(await readFile(path.join(secretDir, MAIL_RELAY_SASL_FILE), "utf8")).toBe(
      buildMailRelaySaslLine(second),
    );
  });

  it("apply null removes the container and wipes the secret but keeps the volume", async () => {
    const { adapter, mockDaemon, secretDir, relay } = await setup();
    await adapter.applyMailRelay(null); // nothing to remove yet
    await adapter.applyMailRelay(req);
    await adapter.applyMailRelay(null);
    expect(relay()).toBeUndefined();
    await expect(stat(path.join(secretDir, MAIL_RELAY_SASL_FILE))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(mockDaemon.deletedVolumes).toEqual([]);
    expect(mockDaemon.volumeLabels.has(MAIL_RELAY_SPOOL_VOLUME)).toBe(true);
  });

  it("apply refuses when the secret directory is missing or not the executor's", async () => {
    const missing = await setup({ createDir: false });
    await expect(missing.adapter.applyMailRelay(req)).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
      message: expect.stringContaining("Run bootstrap first"),
    });
    expect(missing.relay()).toBeUndefined();

    const foreign = await setup({ executorUid: (process.getuid?.() ?? 1000) + 1 });
    await expect(foreign.adapter.applyMailRelay(req)).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
    });
    await expect(
      stat(path.join(foreign.secretDir, MAIL_RELAY_SASL_FILE)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(foreign.relay()).toBeUndefined();
  });
});
