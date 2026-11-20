import { describe, expect, it } from "vitest";
import { ServiceInstanceActionIpcRequestSchema } from "../src/index.js";

const base = { serviceInstanceId: "svc_1" };

describe("service action IPC", () => {
  it("a restart action carries optional resolved secrets", () => {
    expect(ServiceInstanceActionIpcRequestSchema.safeParse({ ...base, action: "restart" }).success).toBe(true);
    const parsed = ServiceInstanceActionIpcRequestSchema.parse({
      ...base,
      action: "restart",
      resolvedSecrets: { DB_PASSWORD: "x" },
    });
    expect(parsed.resolvedSecrets).toEqual({ DB_PASSWORD: "x" });
  });

  it("refuses resolved secrets on stop and delete", () => {
    for (const action of ["stop", "delete"] as const) {
      const r = ServiceInstanceActionIpcRequestSchema.safeParse({
        ...base,
        action,
        resolvedSecrets: { DB_PASSWORD: "x" },
      });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.path).toEqual(["resolvedSecrets"]);
    }
  });

  it("refuses a bad secret name and a value over 16384 characters", () => {
    const parse = (resolvedSecrets: Record<string, string>) =>
      ServiceInstanceActionIpcRequestSchema.safeParse({ ...base, action: "restart", resolvedSecrets }).success;
    expect(parse({ "1BAD": "x" })).toBe(false);
    expect(parse({ DB_PASSWORD: "a".repeat(16385) })).toBe(false);
    expect(parse({ DB_PASSWORD: "a".repeat(16384) })).toBe(true);
  });
});
