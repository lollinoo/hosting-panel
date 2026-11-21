import type { FastifyRequest } from "fastify";
import { ControlPlaneError } from "./control-plane.error.js";

/**
 * A malformed JSON body must not be answered before the route has authorised the caller (#17). Fastify parses the
 * body before the controller runs, so the parser does not fail the request: it keeps the error here and hands the
 * route a body that raises it on first use. The authorisation checks raise it too, as soon as they allow the
 * caller. So the caller first gets the route's own 401, 403 or 404, and the 400 only once it is authorised.
 */
const pending = new WeakMap<object, ControlPlaneError>();
const malformedBodies = new WeakSet<object>();

export function deferMalformedBody(req: FastifyRequest): object {
  const error = new ControlPlaneError("VALIDATION_ERROR", "Malformed JSON request body.");
  pending.set(req.raw, error);
  const raise = (): never => {
    throw error;
  };
  const body = new Proxy(Object.create(null) as object, {
    // Not a thenable: Nest awaits every handler argument, and that reads `then` before the route runs.
    get: (_target, key) => (key === "then" ? undefined : raise()),
    has: raise,
    ownKeys: raise,
    getOwnPropertyDescriptor: raise,
    getPrototypeOf: raise,
    set: raise,
    defineProperty: raise,
    deleteProperty: raise,
  });
  malformedBodies.add(body);
  return body;
}

/**
 * For a route that looks at its body to choose its permission check: a malformed body reads as absent, so the
 * route falls back to the check it makes without one, and the 400 comes once that check allows the caller.
 */
export function peekBody(body: unknown): unknown {
  return typeof body === "object" && body !== null && malformedBodies.has(body) ? undefined : body;
}

/** Called when a check has allowed the caller: a malformed body is refused now, before the route acts. */
export function raiseDeferredBodyError(req: FastifyRequest): void {
  const error = pending.get(req.raw);
  if (error !== undefined) throw error;
}
