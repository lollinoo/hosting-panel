import { describe, expect, it } from "vitest";
import { APP_BUILT_IN_TEMPLATES } from "../src/app-templates/built-in.js";
import { APP_IMAGE_ALLOWLIST, appStackImageLookupProblem, appStackImageRegistryProblem } from "../src/app-templates/images.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

/** Names whose registry part is a public DNS name, or that name no registry (Docker Hub). */
const PUBLIC = ["nginx", "library/nginx:1.27", "bitnami/redis", "ghcr.io/owner/app", "registry.example.com:5000/team/app:1.0", "quay.io/x/y"];

/** Names whose registry part is this server, a private address or a name of a private network. */
const PRIVATE = [
  "127.0.0.1:5000/x",
  "127.1/x",
  "10.0.0.5/x",
  "192.168.1.10:443/x",
  "localhost/x",
  "localhost:5000/x",
  "registry:5000/x",
  "a.localhost/x",
  "registry.local/x",
  "registry.internal:5000/x",
  "[::1]:5000/x",
  "0x7f.0.0.1/x",
];

const builtInImages = APP_BUILT_IN_TEMPLATES.flatMap((t) => [...t.source.matchAll(/^\s+image:\s*(\S+)\s*$/gm)].map((m) => m[1]!));

describe("the registry part of an image name", () => {
  it("finds the images of the built-in templates", () => {
    expect(builtInImages.length).toBeGreaterThanOrEqual(APP_BUILT_IN_TEMPLATES.length);
  });

  it.each([...PUBLIC, ...PUBLIC.map((name) => `${name.replace(/:[^/:]+$/, "")}@${DIGEST}`), ...APP_IMAGE_ALLOWLIST.map((e) => e.repository), ...builtInImages])(
    "accepts %s",
    (image) => {
      expect(appStackImageRegistryProblem(image)).toBeNull();
    },
  );

  it.each([...PRIVATE, ...PRIVATE.map((name) => `${name}@${DIGEST}`), ...PRIVATE.map((name) => `${name}:1.0@${DIGEST}`)])("refuses %s", (image) => {
    expect(appStackImageRegistryProblem(image)).toBe("registry_not_public");
  });

  it.each([
    ["a domain in capitals, which Docker reads as a registry", "Registry.Example.com/x"],
    ["a single label in capitals", "Registry/x"],
    ["a trailing dot", "registry.example.com./x"],
    ["a label over 63 characters", `${"a".repeat(64)}.example.com/x`],
    ["a label that starts with '-'", "-registry.example.com/x"],
    ["a label that ends with '-'", "registry-.example.com/x"],
    ["an empty label", "registry..example.com/x"],
    ["a port that is not a number", "registry.example.com:http/x"],
    ["a port of six digits", "registry.example.com:123456/x"],
    ["a name under .home.arpa", "nas.home.arpa/x"],
    ["the metadata name of a cloud", "metadata.google.internal/x"],
    ["the Docker name of the host", "host.docker.internal/x"],
    ["an IPv4 address in hex", "0x7f000001.example.0x1/x"],
    ["an IPv4 address with a decimal last part", "example.com.1/x"],
  ])("refuses %s", (_, image) => {
    expect(appStackImageRegistryProblem(image)).toBe("registry_not_public");
  });

  it.each([
    ["localdomain", "registry.localdomain"],
    ["lan", "nas.lan"],
    ["home", "registry.home"],
    ["corp", "hub.acme.corp"],
    ["intranet", "registry.intranet"],
    ["private", "registry.private"],
  ])("refuses a name under .%s, in any case, with or without a port", (_, host) => {
    for (const registry of [host, `${host}:5000`, host.toUpperCase(), `${host.toUpperCase()}:5000`]) {
      expect(appStackImageRegistryProblem(`${registry}/x`)).toBe("registry_not_public");
      expect(appStackImageRegistryProblem(`${registry}/x@${DIGEST}`)).toBe("registry_not_public");
    }
    expect(appStackImageLookupProblem(`${host}:5000/x:1.0`)).toBe("registry_not_public");
  });

  it.each([
    "registry.home.example.org/x",
    "lan.example.com/x",
    "corp.example.net:5000/x",
    "private-registry.example.com/x",
    "intranet.example.io/x",
    `localdomain.example.com/x@${DIGEST}`,
  ])("accepts %s, a public name that only contains one of those words", (image) => {
    expect(appStackImageRegistryProblem(image)).toBeNull();
  });

  it.each(["localhost", "localhost:5000", "registry.local", `localhost@${DIGEST}`, "nginx:1.27"])(
    "reads %s, which has no '/', as a name of Docker Hub",
    (image) => {
      expect(appStackImageRegistryProblem(image)).toBeNull();
    },
  );

  it("is part of the lookup rule, after the form", () => {
    for (const image of PUBLIC) expect(appStackImageLookupProblem(image)).toBeNull();
    for (const image of PRIVATE.filter((name) => !name.startsWith("["))) expect(appStackImageLookupProblem(image)).toBe("registry_not_public");
    expect(appStackImageLookupProblem("[::1]:5000/x")).toBe("invalid");
    expect(appStackImageLookupProblem("Registry.Local/x")).toBe("invalid");
  });
});
