import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import { deferMalformedBody, peekBody, raiseDeferredBodyError } from "../src/common/deferred-body-error.js";

const request = (): FastifyRequest => ({ raw: {} }) as unknown as FastifyRequest;

const malformed = (fn: () => unknown): void => {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(ControlPlaneError);
  expect((thrown as ControlPlaneError).code).toBe("VALIDATION_ERROR");
  expect((thrown as ControlPlaneError).message).toBe("Malformed JSON request body.");
};

describe("a malformed JSON body waits for the route's authorisation (#17)", () => {
  it("is not a thenable, so Nest can await it as a handler argument", async () => {
    const body = deferMalformedBody(request());
    expect(await Promise.resolve(body)).toBe(body);
  });

  it("raises the 400 on any read, including a schema parse and JSON.stringify", () => {
    const body = deferMalformedBody(request()) as Record<string, unknown>;
    malformed(() => body["action"]);
    malformed(() => "siteId" in body);
    malformed(() => Object.keys(body));
    malformed(() => JSON.stringify(body));
    malformed(() => z.object({ action: z.string() }).parse(body));
    malformed(() => z.object({ action: z.string().optional() }).passthrough().safeParse(body));
  });

  it("raises the 400 when the route's check allows the caller, and only on that request", () => {
    const req = request();
    deferMalformedBody(req);
    malformed(() => raiseDeferredBodyError(req));
    expect(() => raiseDeferredBodyError(request())).not.toThrow();
  });

  it("reads as absent to a route that peeks to choose its permission check", () => {
    const body = deferMalformedBody(request());
    expect(peekBody(body)).toBeUndefined();
    const wellFormed = { action: "stop" };
    expect(peekBody(wellFormed)).toBe(wellFormed);
    expect(peekBody(null)).toBeNull();
    expect(peekBody(undefined)).toBeUndefined();
  });
});
