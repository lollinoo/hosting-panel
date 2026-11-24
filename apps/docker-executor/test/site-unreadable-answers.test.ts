import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import http from "node:http";
import {
  BACKUPS_RESULT_SCHEMAS,
  SITE_FILES_RESULT_SCHEMAS,
  createErrorEnvelope,
  type BackupsAction,
  type IpcSigningKey,
  type SiteFilesOp,
} from "@hosting-panel/contracts";
import { createApprovedServiceSpec, type BackupsRequest, type SiteFilesRequest } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { ExecutorIpcClientError, SignedDockerExecutorIpcClient } from "../src/index.js";

// Issue #182: an answer the client cannot read after a site's change was sent is a lost answer, as it is for the
// changes of an application (#173). The reads and the changes kept as they are fail as an ordinary error.

const SECRET = "0123456789abcdef0123456789abcdef-site-unreadable";
const SIGNING_KEY: IpcSigningKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: SECRET };
const CANARY = "CANARY-secret-3b90c2";
const SVC = "svc_0123456789abcdef";
const UPLOAD_ID = "upload_0123456789abcdef";
const IMPORT_ID = "0123456789abcdef0123456789abcdef";

type Client = SignedDockerExecutorIpcClient;
type Call = readonly [string, (c: Client) => Promise<unknown>];

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

/** A server that answers every request with the status and body of the moment. */
async function answering() {
  const socketPath = `/tmp/hp-exec-site-${randomBytes(5).toString("hex")}.sock`;
  let answer: readonly [number, string] = [200, "{}"];
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    req.resume();
    req.on("end", () => {
      res.writeHead(answer[0], { "Content-Type": "application/json" });
      res.end(answer[1]);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(socketPath, { force: true });
  });
  const client = new SignedDockerExecutorIpcClient({ signingKey: SIGNING_KEY, socketPath });
  /** How each call ends under each answer, and how many requests reached the server for it. */
  return async (calls: readonly Call[], answers: ReadonlyArray<readonly [number, string]>) => {
    const seen: Array<[string, number, string, number]> = [];
    for (const [name, call] of calls) {
      for (const next of answers) {
        answer = next;
        const before = hits;
        seen.push([name, next[0], verdict(await call(client).then(() => RESOLVED, (err: unknown) => err)), hits - before]);
      }
    }
    return seen;
  };
}

const RESOLVED = Symbol("resolved");
/** Never the message itself: it could quote the body. */
function verdict(err: unknown): string {
  if (err === RESOLVED) return "resolved";
  if (err instanceof ZodError) return "ZodError";
  if (!(err instanceof ExecutorIpcClientError)) return `other: ${(err as Error).name}`;
  if (err.message.includes(CANARY) || JSON.stringify(err.details).includes(CANARY)) return "quotes the body";
  return `${err.code}/${String(err.ambiguousOutcome)}/${String(err.statusCode)}`;
}
const envelope = (code: "DOCKER_ENGINE_UNAVAILABLE" | "RESOURCE_LOCKED") =>
  JSON.stringify(createErrorEnvelope({ code, message: "refused", requestId: "req-1" }));

/** Each op of the files call, with the class it must have: "lost" for a change, "failed" for a read. */
const FILE_OPS: Readonly<Record<SiteFilesOp, readonly ["lost" | "failed", SiteFilesRequest]>> = {
  list: ["failed", { serviceInstanceId: SVC, op: "list", path: "" }],
  stat: ["failed", { serviceInstanceId: SVC, op: "stat", path: "" }],
  read: ["failed", { serviceInstanceId: SVC, op: "read", path: "a.txt", offset: 0, length: 16 }],
  write: [
    "lost",
    { serviceInstanceId: SVC, op: "write", path: "a.txt", uploadId: UPLOAD_ID, offset: 0, dataBase64: "aGk=", final: true, overwrite: false },
  ],
  mkdir: ["lost", { serviceInstanceId: SVC, op: "mkdir", path: "dir" }],
  move: ["lost", { serviceInstanceId: SVC, op: "move", from: "a.txt", to: "b.txt" }],
  delete: ["lost", { serviceInstanceId: SVC, op: "delete", paths: ["a.txt"] }],
  archive: ["lost", { serviceInstanceId: SVC, op: "archive", paths: ["a.txt"], to: "a.zip" }],
  extract: ["lost", { serviceInstanceId: SVC, op: "extract", path: "a.zip", to: "" }],
  "import.put": [
    "lost",
    { serviceInstanceId: SVC, op: "import.put", slot: "archive", uploadId: UPLOAD_ID, offset: 0, dataBase64: "UEsDBA==", final: true },
  ],
  // Not a read: it moves the uploaded file into the import's slot, and a second call does not find it.
  "import.take": ["lost", { serviceInstanceId: SVC, op: "import.take", slot: "dump", path: "old.sql" }],
  "import.stat": ["failed", { serviceInstanceId: SVC, op: "import.stat" }],
  "import.discard": ["lost", { serviceInstanceId: SVC, op: "import.discard" }],
  "import.unpack": ["lost", { serviceInstanceId: SVC, op: "import.unpack", importId: IMPORT_ID }],
  "import.switch": ["lost", { serviceInstanceId: SVC, op: "import.switch", importId: IMPORT_ID }],
  "import.undo": ["lost", { serviceInstanceId: SVC, op: "import.undo", importId: IMPORT_ID }],
  "import.finish": ["lost", { serviceInstanceId: SVC, op: "import.finish", importId: IMPORT_ID }],
};

/** Each backup action: "lost" for a change marked, "failed" for a read or a change kept as it is (reasons in the client). */
const BACKUP_ACTIONS: Readonly<Record<BackupsAction, "lost" | "failed">> = {
  test: "failed",
  localInit: "lost",
  start: "failed",
  status: "failed",
  forget: "failed",
  restore: "failed",
  archive: "failed",
  readArchive: "failed",
  discardArchive: "failed",
  settle: "failed",
  panelStart: "failed",
  siteState: "failed",
  stackStart: "lost",
  stackRestore: "lost",
  stackForget: "lost",
};
const backupCall = (action: BackupsAction): Call => [
  `backups ${action}`,
  (c) =>
    c.backups(
      (action === "localInit"
        ? { action, target: { kind: "local", targetId: "bkt_0123456789abcdef" } }
        : { action, jobId: "op_0123456789abcdef01234567-backup" }) as unknown as BackupsRequest,
    ),
];
const fileCall = (op: SiteFilesOp): Call => [`siteFiles ${op}`, (c) => c.siteFiles(FILE_OPS[op][1])];

const spec = createApprovedServiceSpec({
  serviceInstanceId: SVC,
  siteId: "site_0123456789abcdef",
  organizationId: "org_1",
  image: "nginx:1.27-alpine",
  containerName: "hp-svc-unreadable-1",
  env: {},
  revisionNumber: 1,
  specHash: "sha256_rev1_hash",
  exposeHttp: true,
  internalPort: 80,
});

// The site calls marked in #182: their request, once sent, may have changed the server.
const CHANGES: readonly Call[] = [
  ["sendTestMail", (c) => c.sendTestMail({ to: "a@b.it", from: "c@d.it" })],
  ...(Object.keys(BACKUP_ACTIONS) as BackupsAction[]).filter((a) => BACKUP_ACTIONS[a] === "lost" && !a.startsWith("stack")).map(backupCall),
  ...(Object.keys(FILE_OPS) as SiteFilesOp[]).filter((op) => FILE_OPS[op][0] === "lost").map(fileCall),
  ["deployService", (c) => c.deployService(spec)],
  ["restartService", (c) => c.restartService(SVC)],
  ["restartService with secrets", (c) => c.restartService(SVC, { APP_DB_PASS: "not-a-real-secret" })],
  ["stopService", (c) => c.stopService(SVC)],
  ["deleteService", (c) => c.deleteService(SVC)],
];
// An empty 200, one that fails the schema (its keys must not reach a message), a body that is not JSON, a 5xx
// without the executor's error envelope.
const UNREADABLE: ReadonlyArray<readonly [number, string]> = [
  [200, "{}"],
  [200, ""],
  [200, JSON.stringify({ data: { [CANARY]: CANARY } })],
  [200, `not json ${CANARY}`],
  [500, ""],
  [500, `boom ${CANARY}`],
  [502, JSON.stringify({ message: CANARY })],
];
/** How a read ends under each of UNREADABLE, in order: an ordinary error, never an unknown outcome. */
const FAILED_READ = [
  "200 ZodError x1",
  "200 ZodError x1",
  "200 ZodError x1",
  "200 INTERNAL_ERROR/false/200 x1",
  "500 INTERNAL_ERROR/false/500 x1",
  "500 INTERNAL_ERROR/false/500 x1",
  "502 INTERNAL_ERROR/false/502 x1",
];

describe("an answer the client cannot read after a site's change was sent", () => {
  it("classifies every op of the files call and every action of the backups call", () => {
    expect(Object.keys(FILE_OPS).sort()).toEqual(Object.keys(SITE_FILES_RESULT_SCHEMAS).sort());
    expect(Object.keys(BACKUP_ACTIONS).sort()).toEqual(Object.keys(BACKUPS_RESULT_SCHEMAS).sort());
  });

  it("is a lost answer for every site call marked: sent once, never quoted", async () => {
    expect(CHANGES.map(([name]) => name)).toEqual([
      "sendTestMail",
      "backups localInit",
      "siteFiles write",
      "siteFiles mkdir",
      "siteFiles move",
      "siteFiles delete",
      "siteFiles archive",
      "siteFiles extract",
      "siteFiles import.put",
      "siteFiles import.take",
      "siteFiles import.discard",
      "siteFiles import.unpack",
      "siteFiles import.switch",
      "siteFiles import.undo",
      "siteFiles import.finish",
      "deployService",
      "restartService",
      "restartService with secrets",
      "stopService",
      "deleteService",
    ]);
    const seen = await (await answering())(CHANGES, UNREADABLE);
    expect(seen.filter(([, , v, n]) => v !== "OPERATION_AMBIGUOUS/true/502" || n !== 1)).toEqual([]);
  });

  it("keeps a refusal the executor stated, and a 4xx, a sure refusal for the same calls", async () => {
    const answers = [
      [500, envelope("DOCKER_ENGINE_UNAVAILABLE")],
      [409, envelope("RESOURCE_LOCKED")],
      [400, ""],
      [404, ""],
      [400, `bad ${CANARY}`],
    ] as const;
    const seen = await (await answering())(CHANGES, answers);
    // One list per answer, in the order above: every call ends the same way under it.
    const outcomes = (k: number) => [...new Set(seen.filter((_row, i) => i % answers.length === k).map(([, , v, n]) => `${v} x${String(n)}`))];
    expect(answers.map((_, k) => outcomes(k))).toEqual([
      ["DOCKER_ENGINE_UNAVAILABLE/false/500 x1"],
      ["RESOURCE_LOCKED/false/409 x1"],
      ["INTERNAL_ERROR/false/400 x1"],
      ["NOT_FOUND/false/404 x1"],
      ["INTERNAL_ERROR/false/400 x1"],
    ]);
  });

  it("leaves a read of each mixed call a failed read", async () => {
    const reads: readonly Call[] = [fileCall("list"), backupCall("status")];
    const seen = await (await answering())(reads, UNREADABLE);
    for (const [name] of reads) {
      expect(seen.filter(([n]) => n === name).map(([, s, v, n]) => `${String(s)} ${v} x${String(n)}`), name).toEqual(FAILED_READ);
    }
  });

  it("never makes an unknown outcome of the other ops and actions", async () => {
    const others: readonly Call[] = [
      ...(Object.keys(FILE_OPS) as SiteFilesOp[]).filter((op) => FILE_OPS[op][0] === "failed").map(fileCall),
      ...(Object.keys(BACKUP_ACTIONS) as BackupsAction[]).filter((a) => BACKUP_ACTIONS[a] === "failed").map(backupCall),
    ];
    expect(others).toHaveLength(4 + 11);
    const seen = await (await answering())(others, UNREADABLE);
    expect(seen.filter(([, , v, n]) => v.startsWith("OPERATION_AMBIGUOUS") || v === "quotes the body" || n !== 1)).toEqual([]);
  });
});
