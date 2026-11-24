import { createHash } from "node:crypto";
import type { AppTemplateValidationDto, ComposeImportDto, RuntimeBackend } from "@hosting-panel/contracts";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppTemplatesService } from "../src/app-templates/app-templates.service.js";
import { ComposeImportService } from "../src/app-templates/compose-import.service.js";
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import type { ControlPlaneRuntimeConfig } from "../src/tokens.js";
import { PINNED_COMPOSE, WORDPRESS_COMPOSE, WORDPRESS_COMPOSE_IMAGES } from "./fixtures/compose-files.js";
import { FakeStackExecutor } from "./support/fake-stack-executor.js";

const VERDICT: AppTemplateValidationDto = { valid: true, issues: [], parameters: [], preview: null };
const LOOKUP_FAILED = "The server could not look up the images of the file right now. Try again in a few minutes.";
const UNAVAILABLE = "Applications are not available on this server.";
const digestOf = (image: string): string => `sha256:${createHash("sha256").update(image).digest("hex")}`;
const [WORDPRESS_IMAGE, MARIADB_IMAGE] = WORDPRESS_COMPOSE_IMAGES as [string, string];

describe("ComposeImportService: the digests the importer needs, asked through the executor", () => {
  let fake: FakeStackExecutor & DockerExecutorPort;
  let validated: string[];

  function service(executor: DockerExecutorPort = fake, runtimeBackend: RuntimeBackend = "local-simulator"): ComposeImportService {
    const templates = {
      validate: (input: { source: string }) => {
        validated.push(input.source);
        return VERDICT;
      },
    } as unknown as AppTemplatesService;
    return new ComposeImportService({ runtimeBackend } as ControlPlaneRuntimeConfig, executor, templates);
  }
  const lookups = (): unknown[] => fake.calls.filter((call) => call.method === "resolveAppStackImage").map((call) => call.request);
  const codes = (dto: ComposeImportDto, level: string): string[] => dto.report.filter((note) => note.level === level).map((note) => note.code);

  async function refusal(promise: Promise<unknown>): Promise<ControlPlaneError> {
    const err = await promise.then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(err).toBeInstanceOf(ControlPlaneError);
    return err as ControlPlaneError;
  }

  beforeEach(() => {
    fake = FakeStackExecutor.create();
    validated = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks one digest per image of the file, in file order, and gives the validator the draft that pins them", async () => {
    const dto = await service().importCompose({ compose: WORDPRESS_COMPOSE });
    expect(lookups()).toEqual(WORDPRESS_COMPOSE_IMAGES.map((image) => ({ image })));
    expect(dto.source).toContain(`image: "${WORDPRESS_IMAGE}@${digestOf(WORDPRESS_IMAGE)}"`);
    expect(dto.source).toContain(`image: "${MARIADB_IMAGE}@${digestOf(MARIADB_IMAGE)}"`);
    expect(codes(dto, "refused")).toEqual([]);
    expect(codes(dto, "changed").filter((code) => code === "IMAGE_PINNED")).toHaveLength(2);
    expect(validated).toEqual([dto.source]);
    expect(dto.validation).toBe(VERDICT);
  });

  it("passes the name and the category of the request to the importer, over the file's header", async () => {
    const dto = await service().importCompose({ compose: WORDPRESS_COMPOSE, name: "Il sito", category: "content" });
    expect(dto.source).toContain('name: "Il sito"');
    expect(dto.source).toContain('category: "content"');
    expect(dto.source).not.toContain('category: "cms"');
  });

  it("asks nothing for a file whose images carry their digest, even where applications cannot run", async () => {
    for (const backend of ["local-simulator", "disabled"] as const) {
      const dto = await service(fake, backend).importCompose({ compose: PINNED_COMPOSE });
      expect(dto.source, backend).toContain(`@sha256:${"ab".repeat(32)}`);
      expect(codes(dto, "info")).toContain("IMAGE_DIGEST_KEPT");
    }
    const bare = { isRuntimeAvailable: true } as unknown as DockerExecutorPort;
    expect((await service(bare).importCompose({ compose: PINNED_COMPOSE })).source).not.toBeNull();
    expect(lookups()).toEqual([]);
  });

  it("asks nothing for a file the importer cannot read, and returns its refusal without a draft or a verdict", async () => {
    const dto = await service().importCompose({ compose: "services: [not, a, mapping]\n" });
    expect(lookups()).toEqual([]);
    expect(dto.source).toBeNull();
    expect(dto.validation).toBeNull();
    expect(codes(dto, "refused").length).toBeGreaterThan(0);
    expect(validated).toEqual([]);
  });

  it("answers NOT_SUPPORTED where no executor can look an image up, before any lookup", async () => {
    const unavailable = FakeStackExecutor.create();
    Object.assign(unavailable, { isRuntimeAvailable: false });
    const cases: [string, ComposeImportService][] = [
      ["runtime disabled", service(fake, "disabled")],
      ["executor without the application port", service({ isRuntimeAvailable: true } as unknown as DockerExecutorPort)],
      ["runtime not available", service(unavailable)],
    ];
    for (const [name, subject] of cases) {
      const err = await refusal(subject.importCompose({ compose: WORDPRESS_COMPOSE }));
      expect([err.code, err.message], name).toEqual(["NOT_SUPPORTED", UNAVAILABLE]);
      expect(err.details, name).toEqual([{ message: UNAVAILABLE, reason: "STACK_UNSUPPORTED_FEATURE" }]);
    }
    expect(lookups()).toEqual([]);
    expect(unavailable.calls).toEqual([]);
    expect(validated).toEqual([]);
  });

  it("leaves out an image its registry refuses, in either shape of the executor's failure: the importer names it", async () => {
    const shapes: [string, () => void][] = [
      ["over IPC (details[0].reason)", () => fake.failNext("resolveAppStackImage", "definite", "STACK_IMAGE_PULL_FAILED")],
      ["over IPC, a reference the executor does not read", () => fake.failNext("resolveAppStackImage", "definite", "STACK_PLAN_INVALID")],
      [
        "in process (reason)",
        () =>
          vi
            .spyOn(fake, "resolveAppStackImage")
            .mockRejectedValueOnce(Object.assign(new Error("registry text"), { code: "DOCKER_ENGINE_UNAVAILABLE", reason: "STACK_IMAGE_PULL_FAILED" })),
      ],
    ];
    for (const [name, arrange] of shapes) {
      arrange();
      const dto = await service().importCompose({ compose: WORDPRESS_COMPOSE });
      expect(dto.source, name).toBeNull();
      expect(dto.validation, name).toBeNull();
      expect(dto.report.filter((note) => note.level === "refused"), name).toEqual([
        expect.objectContaining({ code: "IMAGE_UNRESOLVED", path: "services.wordpress.image" }),
      ]);
      // The other image was still looked up and pinned: one refusal, not two.
      expect(codes(dto, "changed"), name).toContain("IMAGE_PINNED");
      expect(JSON.stringify(dto), name).not.toContain("registry text");
      vi.restoreAllMocks();
    }
    expect(validated).toEqual([]);
  });

  it("treats an answer for another image, or one that is no digest, as no answer", async () => {
    vi.spyOn(fake, "resolveAppStackImage").mockResolvedValueOnce({ image: "other:1", digest: digestOf("other:1") });
    fake.imageDigests.set(MARIADB_IMAGE, "sha256:short");
    const dto = await service().importCompose({ compose: WORDPRESS_COMPOSE });
    expect(dto.source).toBeNull();
    expect(dto.report.filter((note) => note.level === "refused").map((note) => [note.code, note.path])).toEqual([
      ["IMAGE_UNRESOLVED", "services.wordpress.image"],
      ["IMAGE_UNRESOLVED", "services.mariadb.image"],
    ]);
  });

  it("fails the whole request, retryable and with a fixed text, when a lookup fails for any other reason", async () => {
    const faults: [string, () => void][] = [
      ["Engine unreachable", () => fake.failNext("resolveAppStackImage", "definite")],
      ["outcome unknown", () => fake.failNext("resolveAppStackImage", "ambiguous")],
      ["a reason that is not the registry's", () => fake.failNext("resolveAppStackImage", "definite", "STACK_IMAGE_NOT_ALLOWED")],
      ["a thrown value that is no error", () => vi.spyOn(fake, "resolveAppStackImage").mockRejectedValueOnce(null)],
      [
        "a timeout with the executor's own text",
        () => vi.spyOn(fake, "resolveAppStackImage").mockRejectedValueOnce(new Error("connect ECONNREFUSED /run/hp/executor.sock")),
      ],
    ];
    for (const [name, arrange] of faults) {
      arrange();
      const err = await refusal(service().importCompose({ compose: WORDPRESS_COMPOSE }));
      expect([err.code, err.message, err.retryable], name).toEqual(["DOCKER_ENGINE_UNAVAILABLE", LOOKUP_FAILED, true]);
      expect(err.details, name).toEqual([]);
      vi.restoreAllMocks();
    }
    expect(validated).toEqual([]);
  });
});
