import { beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { errorMessage } from "@/i18n";

const fetchUpstream = vi.fn();
const getServerSession = vi.fn();
const redirect = vi.fn();

vi.mock("@/lib/upstream", () => ({
  fetchUpstream: (...args: unknown[]) => fetchUpstream(...args),
}));
vi.mock("@/lib/server-session", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));
vi.mock("next/navigation", () => ({
  redirect: (...args: unknown[]) => redirect(...args),
}));

import { serverGet } from "@/lib/server-api";

describe("#8 password change required", () => {
  beforeEach(() => {
    fetchUpstream.mockReset();
    getServerSession.mockReset();
    redirect.mockReset();
    getServerSession.mockResolvedValue({ accessToken: "tok" });
  });

  it("serverGet sends a session that must change its password to the change-password page", async () => {
    fetchUpstream.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: { error: { code: "PASSWORD_CHANGE_REQUIRED", message: "x" } },
    });
    await serverGet("v1/hosts");
    expect(redirect).toHaveBeenCalledWith("/account/change-password");
  });

  it("another 403 does not redirect", async () => {
    fetchUpstream.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: { error: { code: "ORGANIZATION_SUSPENDED", message: "x" } },
    });
    const res = await serverGet("v1/hosts");
    expect(redirect).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false, outcome: "error", status: 403, code: "ORGANIZATION_SUSPENDED" });
  });

  it("the catalogs explain the required password change", () => {
    expect(errorMessage(en, "PASSWORD_CHANGE_REQUIRED")).toBe("Choose a new password to go on: reload the page.");
    expect(errorMessage(itMsgs, "PASSWORD_CHANGE_REQUIRED")).toBe(
      "Per continuare scegli una nuova password: ricarica la pagina.",
    );
  });
});
