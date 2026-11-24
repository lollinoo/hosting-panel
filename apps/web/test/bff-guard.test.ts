import { describe, expect, it } from "vitest";
import { validateCsrfAndOrigin, validateOrigin } from "@/lib/bff-guard";
import type { SessionData } from "@/lib/session";

const session = { accessToken: "tok", csrfToken: "SENTINEL-csrf" } as SessionData;
const req = (headers: Record<string, string>) =>
  new Request("http://localhost:3000/api/x", { method: "POST", headers: { "X-CSRF-Token": "SENTINEL-csrf", ...headers } });
const body = async (res: Response | null) => {
  expect(res).not.toBeNull();
  const json = await res!.json();
  return { status: res!.status, code: json.error.code as string, message: json.error.message as string };
};
const FOREIGN = { status: 403, code: "PERMISSION_DENIED", message: "Origine della richiesta non consentita" };

describe("validateCsrfAndOrigin", () => {
  it("lets through the same origin (any case), no Origin, a matching Host or forwarded host", () => {
    for (const headers of <Record<string, string>[]>[
      { Origin: "http://localhost:3000" },
      { Origin: "HTTP://LOCALHOST:3000" },
      {},
      { Origin: "https://panel.example.test", Host: "panel.example.test" },
      { Origin: "https://panel.example.test", "X-Forwarded-Host": "panel.example.test" },
    ]) {
      expect(validateCsrfAndOrigin(req(headers), session)).toBeNull();
    }
  });

  it("refuses no session with 401", async () => {
    expect((await body(validateCsrfAndOrigin(req({}), null))).status).toBe(401);
  });

  it("refuses a foreign origin with 403", async () => {
    expect(await body(validateCsrfAndOrigin(req({ Origin: "http://evil.example.test" }), session))).toEqual(FOREIGN);
  });

  it("refuses an Origin that is no URL (null from a sandboxed frame, or rubbish) like a foreign one, without throwing", async () => {
    for (const origin of ["null", "::not a url::"]) {
      expect(await body(validateCsrfAndOrigin(req({ Origin: origin }), session))).toEqual(FOREIGN);
    }
  });

  it("checks the origin before the CSRF token", async () => {
    expect(await body(validateCsrfAndOrigin(req({ Origin: "null", "X-CSRF-Token": "bad" }), session))).toEqual(FOREIGN);
  });

  it("refuses a missing or wrong CSRF token with 403", async () => {
    const missing = new Request("http://localhost:3000/api/x", { method: "POST", headers: { Origin: "http://localhost:3000" } });
    expect(await body(validateCsrfAndOrigin(missing, session))).toEqual({
      status: 403,
      code: "PERMISSION_DENIED",
      message: "Intestazione X-CSRF-Token mancante",
    });
    expect(await body(validateCsrfAndOrigin(req({ "X-CSRF-Token": "bad" }), session))).toEqual({
      status: 403,
      code: "PERMISSION_DENIED",
      message: "Token CSRF non valido o non corrispondente",
    });
  });
});

// The routes that work without a session (sign-in, sign-out, password reset) have no CSRF token to rely on.
describe("validateOrigin", () => {
  const post = (headers: Record<string, string>) =>
    new Request("http://localhost:3000/api/session/login", { method: "POST", headers });

  it("lets through the same origin, a matching Host or forwarded host, also when the Origin is required", () => {
    for (const headers of <Record<string, string>[]>[
      { Origin: "http://localhost:3000" },
      { Origin: "https://panel.example.test", Host: "panel.example.test" },
      { Origin: "https://panel.example.test", "X-Forwarded-Host": "panel.example.test" },
    ]) {
      expect(validateOrigin(post(headers), { required: true })).toBeNull();
    }
  });

  it("refuses a foreign Origin and an Origin that is no URL with 403", async () => {
    for (const origin of ["http://evil.example.test", "null", "::not a url::"]) {
      expect(await body(validateOrigin(post({ Origin: origin }), { required: true }))).toEqual(FOREIGN);
    }
  });

  it("refuses a missing Origin when it is required; otherwise lets it through as the CSRF guard does", async () => {
    expect(await body(validateOrigin(post({}), { required: true }))).toEqual({
      status: 403,
      code: "PERMISSION_DENIED",
      message: "Intestazione Origin mancante",
    });
    expect(validateOrigin(post({}))).toBeNull();
  });
});
