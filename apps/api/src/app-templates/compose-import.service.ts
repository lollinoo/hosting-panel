import { Inject, Injectable } from "@nestjs/common";
import { APP_STACK_DIGEST_PATTERN, type ComposeImportDto, type ImportComposeInput } from "@hosting-panel/contracts";
import { isStackExecutor, type DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { importComposeToAppTemplate, listComposeImages } from "@hosting-panel/policy-engine";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { CONTROL_PLANE_CONFIG_TOKEN, DOCKER_EXECUTOR_TOKEN, type ControlPlaneRuntimeConfig } from "../tokens.js";
import { AppTemplatesService } from "./app-templates.service.js";

const UNAVAILABLE = "Applications are not available on this server.";
const LOOKUP_FAILED = "The server could not look up the images of the file right now. Try again in a few minutes.";

/** The registry's own answer about one image: it does not know the reference, or the reference is not one it reads. */
const REGISTRY_REFUSALS: ReadonlySet<unknown> = new Set(["STACK_IMAGE_PULL_FAILED", "STACK_PLAN_INVALID"]);

/** The executor's reason for a failure: `reason` in process, `details[0].reason` over IPC. Its text is never read. */
function reasonOf(err: unknown): unknown {
  const e = err as { reason?: unknown; details?: unknown } | null | undefined;
  if (typeof e?.reason === "string") return e.reason;
  return Array.isArray(e?.details) ? (e.details[0] as { reason?: unknown } | null | undefined)?.reason : undefined;
}

/**
 * Reads a Docker Compose file into a draft HCP-STACK/v2 template (ADR-0036 §2.8). The importer is pure: this service only
 * gives it the digests of the images the file names without one, asked through `hp-docker-executor`, and then asks the
 * template validator for its verdict on the draft. Nothing is stored and nothing is audited: the administrator saves
 * the draft through the template routes, which validate again.
 */
@Injectable()
export class ComposeImportService {
  public constructor(
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly executor: DockerExecutorPort,
    @Inject(AppTemplatesService) private readonly templates: AppTemplatesService,
  ) {}

  public async importCompose(input: ImportComposeInput): Promise<ComposeImportDto> {
    const digests = await this.#resolve(listComposeImages(input.compose));
    const result = importComposeToAppTemplate({
      compose: input.compose,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.category === undefined ? {} : { category: input.category }),
      digests,
    });
    if (!result.ok) return { source: null, report: result.report, validation: null };
    return { source: result.source, report: result.report, validation: this.templates.validate({ source: result.source }) };
  }

  /**
   * One read-only lookup per image, all at once (a file names at most as many images as a stack has services). An
   * image the registry does not know is left out, and the importer refuses it by name in its report; any other
   * failure says nothing about the file, so it is the answer of the whole request. What the executor said never
   * reaches the caller.
   */
  async #resolve(images: readonly string[]): Promise<Map<string, string>> {
    const digests = new Map<string, string>();
    if (images.length === 0) return digests;
    const { executor } = this;
    if (!isStackExecutor(executor) || !executor.isRuntimeAvailable || this.config.runtimeBackend === "disabled") {
      throw new ControlPlaneError("NOT_SUPPORTED", UNAVAILABLE, { details: [{ message: UNAVAILABLE, reason: "STACK_UNSUPPORTED_FEATURE" }] });
    }
    const answers = await Promise.allSettled(images.map((image) => executor.resolveAppStackImage({ image })));
    answers.forEach((answer, index) => {
      const image = images[index];
      if (image === undefined) return;
      if (answer.status === "rejected") {
        if (REGISTRY_REFUSALS.has(reasonOf(answer.reason))) return;
        throw new ControlPlaneError("DOCKER_ENGINE_UNAVAILABLE", LOOKUP_FAILED, { retryable: true });
      }
      const { digest } = answer.value;
      if (answer.value.image === image && APP_STACK_DIGEST_PATTERN.test(digest)) digests.set(image, digest);
    });
    return digests;
  }
}
