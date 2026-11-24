import { ImportComposeInputSchema } from "@hosting-panel/contracts";
import { forwardToUpstream } from "@/lib/bff-proxy";

// Reads a Compose file into a draft and writes nothing: no Idempotency-Key. The API looks every image of the file up
// in its registry (up to 40 s for one lookup), so the answer may take longer than any other route here.
export const POST = (req: Request) =>
  forwardToUpstream(req, "v1/admin/app-templates/import-compose", "POST", undefined, {
    timeoutMs: 60_000,
    body: (b) => ImportComposeInputSchema.safeParse(b).success,
  });
