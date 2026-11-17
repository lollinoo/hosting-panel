import { createApprovedServiceSpec } from "@hosting-panel/executor-contracts";
import { describe, expect, it } from "vitest";
import { InMemoryDockerSimulatorAdapter } from "../src/simulator-adapter.js";
import { makeDir } from "../src/simulator-files.js";
import type { SimulatorSiteType } from "../src/simulator-site-types.js";
import { TEST_EXECUTOR_SITE_TYPE } from "./support/test-site-type.js";

/** The executor's test type as the simulator sees it: no database, folder `public`, no extra operations. */
const TEST_SIMULATOR_SITE_TYPE: SimulatorSiteType = {
  def: TEST_EXECUTOR_SITE_TYPE.def,
  protectedPaths: [],
  shellId: "uid=1000 gid=1000 groups=1000",
  seed: () => makeDir(),
  ops: [],
  createOps: null,
};

const SVC = "svc_t1";
const SESSION = `term_${"0".repeat(32)}`;

async function setup(options?: ConstructorParameters<typeof InMemoryDockerSimulatorAdapter>[0]) {
  const sim = new InMemoryDockerSimulatorAdapter(options);
  const own = options?.resolveSiteType !== undefined;
  await sim.deployService(
    createApprovedServiceSpec({
      serviceInstanceId: SVC,
      siteId: "site_t1",
      organizationId: "org_1",
      image: "wordpress:7.1.4-php8.4-apache",
      containerName: "hp_svc_svc_t1",
      volumeMounts: [own ? { volumeSuffix: "public", containerPath: "/srv/public" } : { volumeSuffix: "html", containerPath: "/var/www/html" }],
    }),
  );
  return sim;
}

const testType = () => setup({ resolveSiteType: () => TEST_SIMULATOR_SITE_TYPE });
const code = (p: Promise<unknown>) => p.then(() => "resolved", (e: { code?: string }) => e.code);
const names = async (sim: InMemoryDockerSimulatorAdapter, path = "") =>
  (await sim.siteFiles({ serviceInstanceId: SVC, op: "list", path })).entries.map((e) => e.name);

describe("simulator with a test site type", () => {
  it("starts empty, writes and reads under its own folder", async () => {
    const sim = await testType();
    expect(await names(sim)).toEqual([]);
    await sim.siteFiles({
      serviceInstanceId: SVC,
      op: "write",
      path: "a.txt",
      uploadId: "upload_0123456789ab",
      offset: 0,
      dataBase64: Buffer.from("hello").toString("base64"),
      final: true,
      overwrite: true,
    });
    sim.files.seed(SVC, [
      { path: "in", kind: "link", target: "/srv/public/a.txt" },
      { path: "out", kind: "link", target: "/var/www/html/a.txt" },
    ]);
    expect(await names(sim)).toEqual(["a.txt", "in", "out"]);
    const read = await sim.siteFiles({ serviceInstanceId: SVC, op: "read", path: "in", offset: 0, length: 10 });
    expect(Buffer.from(read.dataBase64, "base64").toString()).toBe("hello");
    expect(await code(sim.siteFiles({ serviceInstanceId: SVC, op: "read", path: "out", offset: 0, length: 10 }))).toBe(
      "PERMISSION_DENIED",
    );
  });

  it("refuses the import operations", async () => {
    const sim = await testType();
    expect(await code(sim.siteFiles({ serviceInstanceId: SVC, op: "import.stat" }))).toBe("VALIDATION_ERROR");
    expect(await code(sim.siteFiles({ serviceInstanceId: SVC, op: "import.discard" }))).toBe("VALIDATION_ERROR");
  });

  it("answers in its own working directory in the terminal", async () => {
    const sim = await testType();
    await sim.openTerminal({ sessionId: SESSION, siteId: "site_t1", serviceInstanceId: SVC });
    const first = await sim.readTerminal({ sessionId: SESSION, cursor: 0 });
    expect(first.output).toBe("/srv/public $ ");
    await sim.writeTerminal({ sessionId: SESSION, input: "id\r" });
    const id = await sim.readTerminal({ sessionId: SESSION, cursor: first.cursor });
    expect(id.output).toBe("id\r\nuid=1000 gid=1000 groups=1000\r\n/srv/public $ ");
  });
});

describe("simulator with the default registry", () => {
  it("treats an absent key and the legacy key alike and refuses an unknown key", async () => {
    const sim = await setup();
    expect(await names(sim)).toContain("wp-config.php");
    expect((await sim.siteFiles({ serviceInstanceId: SVC, siteType: "wordpress", op: "import.stat" })).remains).toBe(false);
    const unknown = { serviceInstanceId: SVC, siteType: "teststatic", op: "list", path: "" } as never;
    expect(await code(sim.siteFiles(unknown))).toBe("VALIDATION_ERROR");
    const term = { sessionId: SESSION, siteId: "site_t1", serviceInstanceId: SVC, siteType: "teststatic" } as never;
    expect(await code(sim.openTerminal(term))).toBe("VALIDATION_ERROR");
  });
});
