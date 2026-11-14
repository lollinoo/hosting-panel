import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SFTP_PORT, SFTP_IMAGE, type SftpAccessUser } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SFTP_STATE_DIR,
  DockerEngineSocketAdapter,
  SFTP_CONTAINER_NAME,
  SFTP_NETWORK_NAME,
  SFTP_VOLUME_PREFIX,
  SHARED_DB_CONFIG_SHA256_LABEL,
  buildSftpContainerPayload,
  ensureSftpStateFiles,
  generateEd25519HostKey,
  readSftpState,
  renderSftpSshdConfig,
  renderSftpUserFiles,
  sshFingerprint,
} from "../src/index.js";
import {
  commitSftpStatePlan,
  hashSftpContainerConfig,
  prepareSftpStatePlan,
  publicKeyLineFromOpenSshPrivateKey,
} from "../src/sftp-platform.js";
import { startMockDockerDaemon } from "./mock-docker-daemon.js";

const cleanupTasks: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const task of cleanupTasks.splice(0).reverse()) {
    await task();
  }
});

const HASH_1 =
  "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1";
const HASH_2 =
  "$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v.";

const hasSshKeygen = spawnSync("ssh-keygen", ["-?"]).error === undefined;

// Test-only keypair generated with `ssh-keygen -t ed25519 -N "" -C "test-only@example"`.
const PINNED_SSH_KEYGEN_BODY_B64 =
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW" +
  "QyNTUxOQAAACAn/JcbL+zZM2uF44BSwr1FsFYbjDgP9EQA+YqPJy7WkAAAAJgO9bONDvWz" +
  "jQAAAAtzc2gtZWQyNTUxOQAAACAn/JcbL+zZM2uF44BSwr1FsFYbjDgP9EQA+YqPJy7WkA" +
  "AAAEDKfxRyY1cpFYPXmGXCpgV2uP0IuVcFFvzZC17gq9ragyf8lxsv7Nkza4XjgFLCvUWw" +
  "VhuMOA/0RAD5io8nLtaQAAAAEXRlc3Qtb25seUBleGFtcGxlAQIDBA==";
const PINNED_SSH_KEYGEN_EXPECTED_PUB_LINE =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICf8lxsv7Nkza4XjgFLCvUWwVhuMOA/0RAD5io8nLtaQ hp_sftp\n";

function wrapOpenSshPem(body: Buffer): string {
  const b64 = body.toString("base64").replace(/.{1,70}/g, "$&\n");
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}-----END OPENSSH PRIVATE KEY-----\n`;
}

function wireStr(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

function readWireStr(buf: Buffer, offset: number): { value: Buffer; next: number } {
  const len = buf.readUInt32BE(offset);
  return { value: buf.subarray(offset + 4, offset + 4 + len), next: offset + 4 + len };
}

interface ParsedOpenSshEd25519 {
  cipher: Buffer;
  kdf: Buffer;
  kdfOptions: Buffer;
  keyCount: number;
  pubBlob: Buffer;
  check: Buffer;
  privType: Buffer;
  privPub: Buffer;
  privSecret: Buffer;
  privComment: Buffer;
  padding: Buffer;
}

function parseOpenSshPemForMutation(pem: string): ParsedOpenSshEd25519 {
  const m =
    /^-----BEGIN OPENSSH PRIVATE KEY-----\r?\n([\s\S]+?)\r?\n-----END OPENSSH PRIVATE KEY-----$/.exec(
      pem.trim(),
    );
  if (!m?.[1]) {
    throw new Error("Invalid test fixture PEM");
  }
  const body = Buffer.from(m[1].replace(/\s+/g, ""), "base64");
  let o = "openssh-key-v1\0".length;
  const cipher = readWireStr(body, o);
  o = cipher.next;
  const kdf = readWireStr(body, o);
  o = kdf.next;
  const kdfOptions = readWireStr(body, o);
  o = kdfOptions.next;
  const keyCount = body.readUInt32BE(o);
  o += 4;
  const pubEntry = readWireStr(body, o);
  const privEntry = readWireStr(body, pubEntry.next);
  const priv = privEntry.value;
  const check = Buffer.from(priv.subarray(0, 8));
  const privType = readWireStr(priv, 8);
  const privPub = readWireStr(priv, privType.next);
  const privSecret = readWireStr(priv, privPub.next);
  const privComment = readWireStr(priv, privSecret.next);
  const padding = Buffer.from(priv.subarray(privComment.next));
  return {
    cipher: Buffer.from(cipher.value),
    kdf: Buffer.from(kdf.value),
    kdfOptions: Buffer.from(kdfOptions.value),
    keyCount,
    pubBlob: Buffer.from(pubEntry.value),
    check,
    privType: Buffer.from(privType.value),
    privPub: Buffer.from(privPub.value),
    privSecret: Buffer.from(privSecret.value),
    privComment: Buffer.from(privComment.value),
    padding,
  };
}

function buildOpenSshBodyFromParts(
  parts: ParsedOpenSshEd25519,
  options?: { readonly omitComment?: boolean; readonly trailingBody?: Buffer },
): Buffer {
  const privChunks = [
    parts.check,
    wireStr(parts.privType),
    wireStr(parts.privPub),
    wireStr(parts.privSecret),
  ];
  if (!options?.omitComment) {
    privChunks.push(wireStr(parts.privComment));
  }
  privChunks.push(parts.padding);
  const priv = Buffer.concat(privChunks);
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32BE(parts.keyCount, 0);
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "ascii"),
    wireStr(parts.cipher),
    wireStr(parts.kdf),
    wireStr(parts.kdfOptions),
    countBuf,
    wireStr(parts.pubBlob),
    wireStr(priv),
  ]);
  return options?.trailingBody ? Buffer.concat([body, options.trailingBody]) : body;
}

function buildDamagedHostKeys(validPem: string): ReadonlyArray<{ readonly label: string; readonly pem: string }> {
  const baseParts = parseOpenSshPemForMutation(validPem);
  const body = buildOpenSshBodyFromParts(baseParts);

  const flipSeed = parseOpenSshPemForMutation(validPem);
  flipSeed.privSecret[0]! ^= 0x01;

  const flipSecretPubCopy = parseOpenSshPemForMutation(validPem);
  flipSecretPubCopy.privSecret[32]! ^= 0x01;

  const flipInnerPub = parseOpenSshPemForMutation(validPem);
  flipInnerPub.privPub[0]! ^= 0x01;

  const wrongInnerType = parseOpenSshPemForMutation(validPem);
  wrongInnerType.privType = Buffer.from("ssh-rsa", "ascii");
  // Re-pad so only the inner key type differs while block alignment remains valid.
  const rawLenNoPad =
    8 +
    wireStr(wrongInnerType.privType).length +
    wireStr(wrongInnerType.privPub).length +
    wireStr(wrongInnerType.privSecret).length +
    wireStr(wrongInnerType.privComment).length;
  const padBytes: number[] = [];
  for (let i = 1; (rawLenNoPad + padBytes.length) % 8 !== 0; i += 1) {
    padBytes.push(i);
  }
  wrongInnerType.padding = Buffer.from(padBytes);

  const badPadding = parseOpenSshPemForMutation(validPem);
  expect(badPadding.padding.length).toBeGreaterThan(0);
  badPadding.padding[0] = 0x7f;

  const missingComment = parseOpenSshPemForMutation(validPem);
  missingComment.padding = Buffer.from([1, 2, 3]);

  const trailingInsidePriv = parseOpenSshPemForMutation(validPem);
  trailingInsidePriv.padding = Buffer.concat([
    trailingInsidePriv.padding,
    Buffer.from([trailingInsidePriv.padding.length + 1]),
  ]);

  const trailingEightBytesInPriv = parseOpenSshPemForMutation(validPem);
  const basePadLen = trailingEightBytesInPriv.padding.length;
  trailingEightBytesInPriv.padding = Buffer.concat([
    trailingEightBytesInPriv.padding,
    Buffer.from(Array.from({ length: 8 }, (_, idx) => basePadLen + idx + 1)),
  ]);

  const trailingInPubBlob = parseOpenSshPemForMutation(validPem);
  trailingInPubBlob.pubBlob = Buffer.concat([trailingInPubBlob.pubBlob, Buffer.from([0x00])]);

  return [
    { label: "one byte flipped in the seed", pem: wrapOpenSshPem(buildOpenSshBodyFromParts(flipSeed)) },
    {
      label: "one byte flipped in the private copy of the public key",
      pem: wrapOpenSshPem(buildOpenSshBodyFromParts(flipSecretPubCopy)),
    },
    {
      label: "one byte flipped in the inner public key",
      pem: wrapOpenSshPem(buildOpenSshBodyFromParts(flipInnerPub)),
    },
    {
      label: "wrong inner key type",
      pem: wrapOpenSshPem(buildOpenSshBodyFromParts(wrongInnerType)),
    },
    {
      label: "wrong padding byte",
      pem: wrapOpenSshPem(buildOpenSshBodyFromParts(badPadding)),
    },
    {
      label: "missing comment",
      pem: wrapOpenSshPem(buildOpenSshBodyFromParts(missingComment, { omitComment: true })),
    },
    {
      label: "truncated file (PEM footer removed)",
      pem: validPem.slice(0, validPem.indexOf("-----END OPENSSH PRIVATE KEY-----") - 10),
    },
    {
      label: "truncated file (body shortened by 3 bytes)",
      pem: wrapOpenSshPem(body.subarray(0, body.length - 3)),
    },
    {
      label: "trailing bytes in key body",
      pem: wrapOpenSshPem(buildOpenSshBodyFromParts(baseParts, { trailingBody: Buffer.from([1, 2, 3]) })),
    },
    {
      label: "trailing bytes in private section",
      pem: wrapOpenSshPem(buildOpenSshBodyFromParts(trailingInsidePriv)),
    },
    {
      label: "trailing 8-byte block in private section",
      pem: wrapOpenSshPem(buildOpenSshBodyFromParts(trailingEightBytesInPriv)),
    },
    {
      label: "trailing bytes in outer public key blob",
      pem: wrapOpenSshPem(buildOpenSshBodyFromParts(trailingInPubBlob)),
    },
    {
      label: "trailing bytes after PEM footer",
      pem: `${validPem.trimEnd()}\nextra-trailing-line\n`,
    },
  ];
}

function makeUser(over: Partial<SftpAccessUser> = {}): SftpAccessUser {
  return {
    username: "s1a2b3c4d_web",
    passwordHash: HASH_1,
    siteId: "site_a",
    serviceInstanceId: "svc_a",
    ...over,
  };
}

describe("renderSftpSshdConfig", () => {
  it("renders the exact hardened internal-sftp sshd_config on port 2222", () => {
    const config = renderSftpSshdConfig();
    expect(config).toBe(
      [
        "Port 2222",
        "ListenAddress 0.0.0.0",
        "HostKey /etc/hp-sftp/ssh_host_ed25519_key",
        "PidFile none",
        "UsePAM no",
        "AuthenticationMethods password",
        "PasswordAuthentication yes",
        "PermitEmptyPasswords no",
        "PubkeyAuthentication no",
        "KbdInteractiveAuthentication no",
        "HostbasedAuthentication no",
        "AuthorizedKeysFile none",
        "PermitRootLogin no",
        "AllowGroups hpsftp",
        "ChrootDirectory %h",
        "ForceCommand internal-sftp -d /files -u 0022",
        "Subsystem sftp internal-sftp",
        "DisableForwarding yes",
        "AllowTcpForwarding no",
        "AllowStreamLocalForwarding no",
        "AllowAgentForwarding no",
        "X11Forwarding no",
        "PermitTunnel no",
        "PermitTTY no",
        "GatewayPorts no",
        "PermitUserRC no",
        "PermitUserEnvironment no",
        "UseDNS no",
        "PrintMotd no",
        "MaxAuthTries 3",
        "LoginGraceTime 20",
        "MaxStartups 10:30:60",
        "PerSourceMaxStartups 10",
        "MaxSessions 4",
        "ClientAliveInterval 60",
        "ClientAliveCountMax 3",
        "ChannelTimeout session=30m",
        "UnusedConnectionTimeout 10m",
        "PerSourcePenalties authfail:10s crash:90s noauth:1s grace-exceeded:20s max:600s min:15s",
        "LogLevel INFO",
        "",
      ].join("\n"),
    );
    expect(config).not.toContain("PrintLastLog");
  });
});

describe("renderSftpUserFiles", () => {
  it("renders exact passwd, group and shadow lines with shared uid/gid 33 and /bin/false", () => {
    const users: SftpAccessUser[] = [
      makeUser({ username: "s1a2b3c4d_web", passwordHash: HASH_1, siteId: "site_a", serviceInstanceId: "svc_a" }),
      makeUser({ username: "s1a2b3c4d_ci", passwordHash: HASH_2, siteId: "site_a", serviceInstanceId: "svc_a" }),
      makeUser({ username: "s9f8e7d6c_admin", passwordHash: HASH_1, siteId: "site_b", serviceInstanceId: "svc_b" }),
    ];

    const files = renderSftpUserFiles(users);

    expect(files.passwd).toBe(
      [
        "root:x:0:0:root:/root:/bin/false",
        "sshd:x:22:22:sshd:/var/empty:/bin/false",
        "s1a2b3c4d_web:x:33:33::/srv/sftp/site_a:/bin/false",
        "s1a2b3c4d_ci:x:33:33::/srv/sftp/site_a:/bin/false",
        "s9f8e7d6c_admin:x:33:33::/srv/sftp/site_b:/bin/false",
        "",
      ].join("\n"),
    );

    expect(files.group).toBe(
      ["root:x:0:", "sshd:x:22:", "hpsftp:x:33:", ""].join("\n"),
    );

    expect(files.shadow).toBe(
      [
        "root:*:::::::",
        "sshd:*:::::::",
        `s1a2b3c4d_web:${HASH_1}:::::::`,
        `s1a2b3c4d_ci:${HASH_2}:::::::`,
        `s9f8e7d6c_admin:${HASH_1}:::::::`,
        "",
      ].join("\n"),
    );
  });

  it("renders only system entries when user list is empty", () => {
    const files = renderSftpUserFiles([]);
    expect(files.passwd).toBe(
      "root:x:0:0:root:/root:/bin/false\nsshd:x:22:22:sshd:/var/empty:/bin/false\n",
    );
    expect(files.group).toBe("root:x:0:\nsshd:x:22:\nhpsftp:x:33:\n");
    expect(files.shadow).toBe("root:*:::::::\nsshd:*:::::::\n");
  });

  it("rejects malformed user fields with VALIDATION_ERROR without echoing passwordHash", () => {
    const canary = "$6$canarysalt123456$" + "a".repeat(86);
    expect(() =>
      renderSftpUserFiles([makeUser({ username: "root", passwordHash: canary })]),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));

    let caught: unknown;
    try {
      renderSftpUserFiles([makeUser({ passwordHash: `${canary}:extra` })]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(String((caught as Error).message)).not.toContain(canary);
  });

  it("keeps staying users byte-for-byte in disk order with new users last, and append-only renders old text plus tail", () => {
    const uA = makeUser({ username: "s1a2b3c4d_a", passwordHash: HASH_1, siteId: "site_a", serviceInstanceId: "svc_a" });
    const uB = makeUser({ username: "s1a2b3c4d_b", passwordHash: HASH_2, siteId: "site_b", serviceInstanceId: "svc_b" });
    const uC = makeUser({ username: "s1a2b3c4d_c", passwordHash: HASH_1, siteId: "site_c", serviceInstanceId: "svc_c" });
    const uD = makeUser({ username: "s1a2b3c4d_d", passwordHash: HASH_2, siteId: "site_d", serviceInstanceId: "svc_d" });

    // [A, B, C] then [A, C, D] keeps A and C lines byte-for-byte and in order with D last
    const initialABC = renderSftpUserFiles([uA, uB, uC]);
    const replacedACD = renderSftpUserFiles([uA, uC, uD], initialABC);
    const freshACD = renderSftpUserFiles([uA, uC, uD]);

    expect(replacedACD).toEqual(freshACD);
    expect(replacedACD.passwd).toBe(
      [
        "root:x:0:0:root:/root:/bin/false",
        "sshd:x:22:22:sshd:/var/empty:/bin/false",
        "s1a2b3c4d_a:x:33:33::/srv/sftp/site_a:/bin/false",
        "s1a2b3c4d_c:x:33:33::/srv/sftp/site_c:/bin/false",
        "s1a2b3c4d_d:x:33:33::/srv/sftp/site_d:/bin/false",
        "",
      ].join("\n"),
    );
    expect(replacedACD.shadow).toBe(
      [
        "root:*:::::::",
        "sshd:*:::::::",
        `s1a2b3c4d_a:${HASH_1}:::::::`,
        `s1a2b3c4d_c:${HASH_1}:::::::`,
        `s1a2b3c4d_d:${HASH_2}:::::::`,
        "",
      ].join("\n"),
    );

    // Also when input order reverses [C, A, D] relative to disk [A, B, C], A and C keep disk order [A, C] with D last
    const reorderedACD = renderSftpUserFiles([uC, uA, uD], initialABC);
    expect(reorderedACD).toEqual(replacedACD);

    // [A, B] then [A, B, C] is the old text plus a tail
    const initialAB = renderSftpUserFiles([uA, uB]);
    const appendedABC = renderSftpUserFiles([uA, uB, uC], initialAB);
    expect(appendedABC.passwd.startsWith(initialAB.passwd)).toBe(true);
    expect(appendedABC.passwd.slice(initialAB.passwd.length)).toBe(
      "s1a2b3c4d_c:x:33:33::/srv/sftp/site_c:/bin/false\n",
    );
    expect(appendedABC.group).toBe(initialAB.group);
    expect(appendedABC.shadow.startsWith(initialAB.shadow)).toBe(true);
    expect(appendedABC.shadow.slice(initialAB.shadow.length)).toBe(`s1a2b3c4d_c:${HASH_1}:::::::\n`);
  });
});

describe("buildSftpContainerPayload", () => {
  const baseInput = {
    image: SFTP_IMAGE,
    stateDir: DEFAULT_SFTP_STATE_DIR,
    hostIp: "0.0.0.0",
    port: DEFAULT_SFTP_PORT,
    network: SFTP_NETWORK_NAME,
    sites: [
      { siteId: "site_b", volume: `${SFTP_VOLUME_PREFIX}svc_b_html` },
      { siteId: "site_a", volume: `${SFTP_VOLUME_PREFIX}svc_a_html` },
    ],
  };

  it("builds hardened container payload with exact caps, limits, labels, sorted binds and port binding", () => {
    const { payload, configSha256 } = buildSftpContainerPayload(baseInput);

    expect(SFTP_CONTAINER_NAME).toBe("hp_sftp");
    expect(configSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.Image).toBe(SFTP_IMAGE);
    expect(payload.Entrypoint).toEqual(["/usr/sbin/sshd.pam"]);
    expect(payload.Cmd).toEqual(["-D", "-e", "-f", "/etc/hp-sftp/sshd_config"]);
    expect(payload.ExposedPorts).toEqual({ "2222/tcp": {} });
    expect(payload.Labels).toEqual({
      "io.hostingpanel.managed": "true",
      "io.hostingpanel.role": "sftp",
      [SHARED_DB_CONFIG_SHA256_LABEL]: configSha256,
    });
    expect(payload.HostConfig).toEqual({
      Privileged: false,
      CapDrop: ["ALL"],
      CapAdd: ["SETGID", "SETUID", "SYS_CHROOT"],
      SecurityOpt: ["no-new-privileges:true"],
      ReadonlyRootfs: true,
      PidsLimit: 512,
      NanoCpus: 500_000_000,
      Memory: 268_435_456,
      MemorySwap: 268_435_456,
      RestartPolicy: { Name: "unless-stopped" },
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
      NetworkMode: SFTP_NETWORK_NAME,
      PortBindings: {
        "2222/tcp": [{ HostIp: "0.0.0.0", HostPort: "2222" }],
      },
      Binds: [
        "/var/lib/hosting-panel/sftp/etc:/etc/hp-sftp:ro",
        "/var/lib/hosting-panel/sftp/users/group:/etc/group:ro",
        "/var/lib/hosting-panel/sftp/users/passwd:/etc/passwd:ro",
        "/var/lib/hosting-panel/sftp/users/shadow:/etc/shadow:ro",
        "hp_vol_svc_a_html:/srv/sftp/site_a/files:rw",
        "hp_vol_svc_b_html:/srv/sftp/site_b/files:rw",
      ],
    });
  });

  it("configSha256 ignores site order/users and changes with volume set, port, image and config", () => {
    const a = buildSftpContainerPayload(baseInput);
    const reordered = buildSftpContainerPayload({
      ...baseInput,
      sites: [...baseInput.sites].reverse(),
    });
    expect(reordered.configSha256).toBe(a.configSha256);

    const addedSite = buildSftpContainerPayload({
      ...baseInput,
      sites: [...baseInput.sites, { siteId: "site_c", volume: `${SFTP_VOLUME_PREFIX}svc_c_html` }],
    });
    expect(addedSite.configSha256).not.toBe(a.configSha256);

    const changedPort = buildSftpContainerPayload({ ...baseInput, port: 2223 });
    expect(changedPort.configSha256).not.toBe(a.configSha256);
    expect(changedPort.payload.HostConfig.PortBindings).toEqual({
      "2222/tcp": [{ HostIp: "0.0.0.0", HostPort: "2223" }],
    });

    const changedImage = buildSftpContainerPayload({
      ...baseInput,
      image: "linuxserver/openssh-server@sha256:" + "0".repeat(64),
    });
    expect(changedImage.configSha256).not.toBe(a.configSha256);

    const changedConfig = buildSftpContainerPayload({
      ...baseInput,
      sshdConfig: `${renderSftpSshdConfig()}# changed\n`,
    });
    expect(changedConfig.configSha256).not.toBe(a.configSha256);

    // Whole create payload (minus hash label) + sshdConfig is hashed: changing only PidsLimit changes the hash.
    const cfg = renderSftpSshdConfig();
    expect(hashSftpContainerConfig(a.payload, cfg)).toBe(a.configSha256);
    const diffPids = {
      ...a.payload,
      HostConfig: { ...a.payload.HostConfig, PidsLimit: a.payload.HostConfig.PidsLimit + 1 },
    };
    expect(hashSftpContainerConfig(diffPids, cfg)).not.toBe(a.configSha256);
  });

  it("refuses docker.sock paths with HOST_POLICY_DENIED", () => {
    expect(() =>
      buildSftpContainerPayload({ ...baseInput, stateDir: "/var/run/docker.sock" }),
    ).toThrow(expect.objectContaining({ code: "HOST_POLICY_DENIED" }));
    expect(() =>
      buildSftpContainerPayload({
        ...baseInput,
        sites: [{ siteId: "site_a", volume: "/var/run/docker.sock" }],
      }),
    ).toThrow(expect.objectContaining({ code: "HOST_POLICY_DENIED" }));
  });
});

describe("Ed25519 host key and sshFingerprint", () => {
  it("matches the pinned ssh-keygen SHA256 vector", () => {
    const pinnedPub =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEAOq1485YhrhTY9F4SNxMV7v84GQLyfqg3CdCUCL6cf hp_sftp";
    expect(sshFingerprint(pinnedPub)).toBe(
      "SHA256:DpQ/0ofF8CkAqPsHW7jwFQRyQl9a/6hX0T+BCi463zM",
    );
  });

  it("generates an OpenSSH Ed25519 keypair whose public line round-trips sshFingerprint", async () => {
    const keypair = generateEd25519HostKey();
    expect(keypair.privateKeyFile).toMatch(
      /^-----BEGIN OPENSSH PRIVATE KEY-----\n[\s\S]+\n-----END OPENSSH PRIVATE KEY-----\n$/,
    );
    expect(keypair.publicKeyLine).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ hp_sftp\n$/);
    const fp = sshFingerprint(keypair.publicKeyLine);
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);

    if (hasSshKeygen) {
      const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-sftp-key-"));
      cleanupTasks.push(() => rm(tmp, { recursive: true, force: true }));
      const keyPath = path.join(tmp, "id_ed25519");
      const pubPath = `${keyPath}.pub`;
      await writeFile(keyPath, keypair.privateKeyFile, { mode: 0o600 });
      await writeFile(pubPath, keypair.publicKeyLine, { mode: 0o644 });

      const pubOut = spawnSync("ssh-keygen", ["-y", "-f", keyPath], { encoding: "utf8" });
      expect(pubOut.status).toBe(0);
      expect(pubOut.stdout.trim()).toBe(keypair.publicKeyLine.trim());

      const fpOut = spawnSync("ssh-keygen", ["-lf", pubPath], { encoding: "utf8" });
      expect(fpOut.status).toBe(0);
      expect(fpOut.stdout).toContain(fp);
    }
  });

  it("accepts a pinned ssh-keygen -t ed25519 key and a freshly generated ssh-keygen key with the exact same public line", async () => {
    const pinnedPem = wrapOpenSshPem(Buffer.from(PINNED_SSH_KEYGEN_BODY_B64, "base64"));
    expect(publicKeyLineFromOpenSshPrivateKey(pinnedPem)).toBe(
      PINNED_SSH_KEYGEN_EXPECTED_PUB_LINE,
    );

    if (hasSshKeygen) {
      const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-sftp-keygen-"));
      cleanupTasks.push(() => rm(tmp, { recursive: true, force: true }));
      const keyPath = path.join(tmp, "id_ed25519");
      const gen = spawnSync(
        "ssh-keygen",
        ["-t", "ed25519", "-N", "", "-C", "custom-comment", "-f", keyPath],
        { encoding: "utf8" },
      );
      expect(gen.status).toBe(0);

      const pem = await readFile(keyPath, "utf8");
      const pubFromKeygen = await readFile(`${keyPath}.pub`, "utf8");
      const expectedTokens = pubFromKeygen.trim().split(/\s+/);
      expect(publicKeyLineFromOpenSshPrivateKey(pem)).toBe(
        `${expectedTokens[0]} ${expectedTokens[1]} hp_sftp\n`,
      );
    }
  });

  it("refuses every private-section or framing damage with HOST_POLICY_DENIED and never RangeError", () => {
    const validKey = generateEd25519HostKey();
    expect(publicKeyLineFromOpenSshPrivateKey(validKey.privateKeyFile)).toBe(
      validKey.publicKeyLine,
    );

    for (const { label, pem } of buildDamagedHostKeys(validKey.privateKeyFile)) {
      let caught: unknown;
      try {
        publicKeyLineFromOpenSshPrivateKey(pem);
      } catch (err) {
        caught = err;
      }
      expect(caught, label).toMatchObject({
        code: "HOST_POLICY_DENIED",
        message: "Invalid OpenSSH host private key",
      });
    }

    // Truncation at every byte offset of the decoded body never throws RangeError.
    const rawBody = Buffer.from(PINNED_SSH_KEYGEN_BODY_B64, "base64");
    for (let len = 0; len < rawBody.length; len += 1) {
      const truncatedPem = wrapOpenSshPem(rawBody.subarray(0, len));
      let caught: unknown;
      try {
        publicKeyLineFromOpenSshPrivateKey(truncatedPem);
      } catch (err) {
        caught = err;
      }
      expect(caught instanceof RangeError, `offset ${String(len)}`).toBe(false);
      expect(caught, `offset ${String(len)}`).toMatchObject({
        code: "HOST_POLICY_DENIED",
      });
    }
  });
});

describe("ensureSftpStateFiles and readSftpState", () => {
  it("refuses a missing, symlinked, or foreign-owned state directory with HOST_POLICY_DENIED", async () => {
    const uid = process.getuid?.() ?? 1000;
    const missing = path.join(os.tmpdir(), `hp-sftp-missing-${Date.now()}`);
    await expect(ensureSftpStateFiles(missing, uid)).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
    });

    const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-sftp-guard-"));
    cleanupTasks.push(() => rm(tmp, { recursive: true, force: true }));
    const realDir = path.join(tmp, "real");
    const linkDir = path.join(tmp, "link");
    await mkdir(realDir, { mode: 0o700 });
    await symlink(realDir, linkDir);

    await expect(ensureSftpStateFiles(linkDir, uid)).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
    });
    await expect(ensureSftpStateFiles(realDir, uid + 1)).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
    });

    await chmod(realDir, 0o755);
    await expect(ensureSftpStateFiles(realDir, uid)).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
    });
    await chmod(realDir, 0o700);
    const guardResult = await ensureSftpStateFiles(realDir, uid);
    expect(sshFingerprint(guardResult.publicKeyLine)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect("fingerprint" in guardResult).toBe(false);
  });

  it("writes expected file modes, never regenerates the host key, and rewrites user files in place (same inode)", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-sftp-state-"));
    cleanupTasks.push(() => rm(tmp, { recursive: true, force: true }));
    const stateDir = path.join(tmp, "sftp");
    await mkdir(stateDir, { mode: 0o700 });
    await chmod(stateDir, 0o700);
    const uid = process.getuid?.() ?? 1000;

    expect(await readSftpState(stateDir)).toBeNull();

    const user1 = makeUser({ username: "s1a2b3c4d_web", siteId: "site_a", serviceInstanceId: "svc_a" });
    const user2 = makeUser({ username: "s1a2b3c4d_ci", siteId: "site_a", serviceInstanceId: "svc_a" });

    const first = await ensureSftpStateFiles(stateDir, uid, [user1, user2]);
    expect(sshFingerprint(first.publicKeyLine)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect("fingerprint" in first).toBe(false);

    expect((await stat(path.join(stateDir, "etc"))).mode & 0o777).toBe(0o755);
    expect((await stat(path.join(stateDir, "etc", "sshd_config"))).mode & 0o777).toBe(0o444);
    expect((await stat(path.join(stateDir, "etc", "ssh_host_ed25519_key"))).mode & 0o777).toBe(0o444);
    expect((await stat(path.join(stateDir, "etc", "ssh_host_ed25519_key.pub"))).mode & 0o777).toBe(0o444);
    expect((await stat(path.join(stateDir, "users", "passwd"))).mode & 0o777).toBe(0o644);
    expect((await stat(path.join(stateDir, "users", "group"))).mode & 0o777).toBe(0o644);
    expect((await stat(path.join(stateDir, "users", "shadow"))).mode & 0o777).toBe(0o644);
    expect((await stat(path.join(stateDir, "state.json"))).mode & 0o777).toBe(0o600);

    const keyBefore = await readFile(path.join(stateDir, "etc", "ssh_host_ed25519_key"), "utf8");
    const pubBefore = await readFile(path.join(stateDir, "etc", "ssh_host_ed25519_key.pub"), "utf8");
    const passwdInoBefore = (await lstat(path.join(stateDir, "users", "passwd"))).ino;
    const groupInoBefore = (await lstat(path.join(stateDir, "users", "group"))).ino;
    const shadowInoBefore = (await lstat(path.join(stateDir, "users", "shadow"))).ino;

    // Rewrite with fewer users (tests truncate + same inode)
    const second = await ensureSftpStateFiles(stateDir, uid, [user1]);
    expect(second.publicKeyLine).toBe(first.publicKeyLine);
    expect(await readFile(path.join(stateDir, "etc", "ssh_host_ed25519_key"), "utf8")).toBe(keyBefore);
    expect(await readFile(path.join(stateDir, "etc", "ssh_host_ed25519_key.pub"), "utf8")).toBe(pubBefore);

    expect((await lstat(path.join(stateDir, "users", "passwd"))).ino).toBe(passwdInoBefore);
    expect((await lstat(path.join(stateDir, "users", "group"))).ino).toBe(groupInoBefore);
    expect((await lstat(path.join(stateDir, "users", "shadow"))).ino).toBe(shadowInoBefore);

    const passwdAfter = await readFile(path.join(stateDir, "users", "passwd"), "utf8");
    expect(passwdAfter).toContain("s1a2b3c4d_web");
    expect(passwdAfter).not.toContain("s1a2b3c4d_ci");
    expect(await readSftpState(stateDir)).toEqual({ users: [user1] });
  });

  it("rebuilds missing, empty or mismatched .pub from the existing private key without changing private key bytes", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-sftp-pub-rebuild-"));
    cleanupTasks.push(() => rm(tmp, { recursive: true, force: true }));
    const stateDir = path.join(tmp, "sftp");
    await mkdir(stateDir, { mode: 0o700 });
    await chmod(stateDir, 0o700);
    const uid = process.getuid?.() ?? 1000;

    const first = await ensureSftpStateFiles(stateDir, uid, [makeUser()]);
    const keyPath = path.join(stateDir, "etc", "ssh_host_ed25519_key");
    const pubPath = path.join(stateDir, "etc", "ssh_host_ed25519_key.pub");
    const keyBytesBefore = await readFile(keyPath);
    const pubTextBefore = await readFile(pubPath, "utf8");

    // 1. Delete .pub
    await rm(pubPath);
    const afterDelete = await ensureSftpStateFiles(stateDir, uid, [makeUser()]);
    expect(afterDelete.publicKeyLine).toBe(first.publicKeyLine);
    expect(await readFile(keyPath)).toEqual(keyBytesBefore);
    expect(await readFile(pubPath, "utf8")).toBe(pubTextBefore);
    expect((await stat(pubPath)).mode & 0o777).toBe(0o444);

    // 2. Empty .pub
    await chmod(pubPath, 0o644);
    await writeFile(pubPath, "", "utf8");
    const afterEmpty = await ensureSftpStateFiles(stateDir, uid, [makeUser()]);
    expect(afterEmpty.publicKeyLine).toBe(first.publicKeyLine);
    expect(await readFile(keyPath)).toEqual(keyBytesBefore);
    expect(await readFile(pubPath, "utf8")).toBe(pubTextBefore);
    expect((await stat(pubPath)).mode & 0o777).toBe(0o444);

    // 3. Garbage .pub
    await chmod(pubPath, 0o644);
    await writeFile(pubPath, "garbage", "utf8");
    const planGarbage = await prepareSftpStatePlan(stateDir, uid, [makeUser()]);
    expect(planGarbage.etcReady).toBe(false);
    const afterGarbage = await commitSftpStatePlan(planGarbage);
    expect(afterGarbage.publicKeyLine).toBe(first.publicKeyLine);
    expect(await readFile(keyPath)).toEqual(keyBytesBefore);
    expect(await readFile(pubPath, "utf8")).toBe(pubTextBefore);
    expect((await stat(pubPath)).mode & 0o777).toBe(0o444);

    // 4. .pub from a different keypair
    const otherKey = generateEd25519HostKey();
    await chmod(pubPath, 0o644);
    await writeFile(pubPath, otherKey.publicKeyLine, "utf8");
    const planMismatch = await prepareSftpStatePlan(stateDir, uid, [makeUser()]);
    expect(planMismatch.etcReady).toBe(false);
    const afterMismatch = await commitSftpStatePlan(planMismatch);
    expect(afterMismatch.publicKeyLine).toBe(first.publicKeyLine);
    expect(await readFile(keyPath)).toEqual(keyBytesBefore);
    expect(await readFile(pubPath, "utf8")).toBe(pubTextBefore);
    expect((await stat(pubPath)).mode & 0o777).toBe(0o444);

    // 5. Corrupt private key and every structural/cryptographic damage fail in prepareSftpStatePlan before commit
    const pubBeforeDamage = await readFile(pubPath, "utf8");
    const passwdBeforeDamage = await readFile(path.join(stateDir, "users", "passwd"));
    const shadowBeforeDamage = await readFile(path.join(stateDir, "users", "shadow"));
    const groupBeforeDamage = await readFile(path.join(stateDir, "users", "group"));
    const stateBeforeDamage = await readFile(path.join(stateDir, "state.json"));

    const validPem = await readFile(keyPath, "utf8");
    for (const { label, pem } of [
      { label: "plain text garbage", pem: "not-an-openssh-key\n" },
      ...buildDamagedHostKeys(validPem),
    ]) {
      await chmod(keyPath, 0o644);
      await writeFile(keyPath, pem, "utf8");
      await chmod(keyPath, 0o444);
      await expect(prepareSftpStatePlan(stateDir, uid, [makeUser()]), label).rejects.toMatchObject({
        code: "HOST_POLICY_DENIED",
      });
      expect(await readFile(pubPath, "utf8"), label).toBe(pubBeforeDamage);
      expect((await readFile(path.join(stateDir, "users", "passwd"))).equals(passwdBeforeDamage)).toBe(true);
      expect((await readFile(path.join(stateDir, "users", "shadow"))).equals(shadowBeforeDamage)).toBe(true);
      expect((await readFile(path.join(stateDir, "users", "group"))).equals(groupBeforeDamage)).toBe(true);
      expect((await readFile(path.join(stateDir, "state.json"))).equals(stateBeforeDamage)).toBe(true);
    }
  });

  it("refuses password change before stop/remove/create/start when host key is damaged, while no-user apply removes container and empties user files", async () => {
    const reqLog: Array<{ readonly method: string; readonly routePath: string }> = [];
    const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-sftp-r24-adapter-"));
    cleanupTasks.push(() => rm(tmp, { recursive: true, force: true }));

    const mockDaemon = await startMockDockerDaemon({
      onRequest: (method, routePath) => {
        reqLog.push({ method, routePath });
      },
    });
    cleanupTasks.push(() => mockDaemon.close());
    mockDaemon.volumeLabels.set("hp_vol_svc_a_html", { "io.hostingpanel.site_id": "site_a" });

    const sftpStateDir = path.join(tmp, "sftp");
    await mkdir(sftpStateDir, { mode: 0o700 });
    await chmod(sftpStateDir, 0o700);

    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: mockDaemon.socketPath,
      secretsRootDir: path.join(tmp, "secrets"),
      ingressRootDir: path.join(tmp, "ingress"),
      pullMissingImages: false,
      sftpStateDir,
    });
    const sftpCtr = () => [...mockDaemon.containers.values()].find((c) => c.name === SFTP_CONTAINER_NAME);

    const u1 = makeUser({ username: "s1a2b3c4d_one", passwordHash: HASH_1 });
    await adapter.applySftpAccess({ users: [u1] });
    const initialCtrId = sftpCtr()?.id;
    expect(initialCtrId).toBeTruthy();

    const keyPath = path.join(sftpStateDir, "etc", "ssh_host_ed25519_key");
    const validKeyPem = await readFile(keyPath, "utf8");
    const passwdPath = path.join(sftpStateDir, "users", "passwd");
    const shadowPath = path.join(sftpStateDir, "users", "shadow");
    const groupPath = path.join(sftpStateDir, "users", "group");
    const stateJsonPath = path.join(sftpStateDir, "state.json");

    const passwdBefore = await readFile(passwdPath);
    const shadowBefore = await readFile(shadowPath);
    const groupBefore = await readFile(groupPath);
    const stateBefore = await readFile(stateJsonPath);

    // Every structural/cryptographic key damage refuses a password change with HOST_POLICY_DENIED before any stop, remove, create, or start.
    for (const { label, pem } of buildDamagedHostKeys(validKeyPem)) {
      await chmod(keyPath, 0o644);
      await writeFile(keyPath, pem, "utf8");
      await chmod(keyPath, 0o444);

      reqLog.length = 0;
      await expect(
        adapter.applySftpAccess({ users: [{ ...u1, passwordHash: HASH_2 }] }),
        label,
      ).rejects.toMatchObject({ code: "HOST_POLICY_DENIED" });

      expect(
        reqLog.filter(
          (r) =>
            (r.method === "POST" && /\/containers\/([^/]+\/stop|create|[^/]+\/start)$/.test(r.routePath)) ||
            (r.method === "DELETE" && r.routePath.startsWith("/containers/")),
        ),
        label,
      ).toEqual([]);
      expect(sftpCtr()?.id, label).toBe(initialCtrId);
      expect(sftpCtr()?.running, label).toBe(true);
      expect((await readFile(passwdPath)).equals(passwdBefore), label).toBe(true);
      expect((await readFile(shadowPath)).equals(shadowBefore), label).toBe(true);
      expect((await readFile(groupPath)).equals(groupBefore), label).toBe(true);
      expect((await readFile(stateJsonPath)).equals(stateBefore), label).toBe(true);
    }

    // On the no-user path (R24), a damaged key (flipped seed byte) does NOT block removing hp_sftp and emptying user files.
    const flippedSeedPem = buildDamagedHostKeys(validKeyPem)[0]!.pem;
    await chmod(keyPath, 0o644);
    await writeFile(keyPath, flippedSeedPem, "utf8");
    await chmod(keyPath, 0o444);

    reqLog.length = 0;
    expect(await adapter.applySftpAccess({ users: [] })).toEqual({ applied: 0 });
    expect(
      reqLog.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.routePath}`),
    ).toEqual([
      `POST /containers/${String(initialCtrId)}/stop`,
      `DELETE /containers/${String(initialCtrId)}`,
    ]);
    expect(sftpCtr()).toBeUndefined();

    const emptyFiles = renderSftpUserFiles([]);
    expect(await readFile(passwdPath, "utf8")).toBe(emptyFiles.passwd);
    expect(await readFile(groupPath, "utf8")).toBe(emptyFiles.group);
    expect(await readFile(shadowPath, "utf8")).toBe(emptyFiles.shadow);
    expect(await readSftpState(sftpStateDir)).toEqual({ users: [] });
    // Damaged key is left untouched (not silently regenerated); re-enabling access still fails until repaired.
    expect(await readFile(keyPath, "utf8")).toBe(flippedSeedPem);
    await expect(adapter.applySftpAccess({ users: [u1] })).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
    });
    expect(sftpCtr()).toBeUndefined();
  });

  it("allows prepareSftpStatePlan + commitSftpStatePlan on the no-user path to empty user files without overwriting a damaged key", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-sftp-r24-empty-"));
    cleanupTasks.push(() => rm(tmp, { recursive: true, force: true }));
    const stateDir = path.join(tmp, "sftp");
    await mkdir(stateDir, { mode: 0o700 });
    await chmod(stateDir, 0o700);
    const uid = process.getuid?.() ?? 1000;

    await ensureSftpStateFiles(stateDir, uid, [makeUser()]);
    const keyPath = path.join(stateDir, "etc", "ssh_host_ed25519_key");
    const damagedPem = "corrupt-key-content\n";
    await chmod(keyPath, 0o644);
    await writeFile(keyPath, damagedPem, "utf8");
    await chmod(keyPath, 0o444);

    const plan = await prepareSftpStatePlan(stateDir, uid, []);
    await commitSftpStatePlan(plan);

    const emptyFiles = renderSftpUserFiles([]);
    expect(await readFile(path.join(stateDir, "users", "passwd"), "utf8")).toBe(emptyFiles.passwd);
    expect(await readFile(path.join(stateDir, "users", "group"), "utf8")).toBe(emptyFiles.group);
    expect(await readFile(path.join(stateDir, "users", "shadow"), "utf8")).toBe(emptyFiles.shadow);
    expect(await readFile(keyPath, "utf8")).toBe(damagedPem);
  });

  const uOne = makeUser({ username: "s1a2b3c4d_one", passwordHash: HASH_1, siteId: "site_a", serviceInstanceId: "svc_a" });
  const uTwo = makeUser({ username: "s1a2b3c4d_two", passwordHash: HASH_2, siteId: "site_a", serviceInstanceId: "svc_a" });
  const baseOne = renderSftpUserFiles([uOne]);

  it.each([
    {
      label: "passwd missing while group and shadow exist",
      wanted: [uOne],
      expectedChangeKind: "replace" as const,
      mutate: async (usersDir: string) => {
        await rm(path.join(usersDir, "passwd"));
      },
    },
    {
      label: "a login listed twice (same user)",
      wanted: [uOne],
      expectedChangeKind: "replace" as const,
      mutate: async (usersDir: string) => {
        await writeFile(
          path.join(usersDir, "passwd"),
          `${baseOne.passwd}s1a2b3c4d_one:x:33:33::/srv/sftp/site_a:/bin/false\n`,
          "utf8",
        );
      },
    },
    {
      label: "a login listed twice (with new user added)",
      wanted: [uOne, uTwo],
      expectedChangeKind: "replace" as const,
      mutate: async (usersDir: string) => {
        await writeFile(
          path.join(usersDir, "shadow"),
          `${baseOne.shadow}s1a2b3c4d_one:${HASH_1}:::::::\n`,
          "utf8",
        );
      },
    },
    {
      label: "no final newline",
      wanted: [uOne],
      expectedChangeKind: undefined,
      mutate: async (usersDir: string) => {
        await writeFile(path.join(usersDir, "passwd"), baseOne.passwd.slice(0, -1), "utf8");
        await writeFile(path.join(usersDir, "group"), baseOne.group.slice(0, -1), "utf8");
        await writeFile(path.join(usersDir, "shadow"), baseOne.shadow.slice(0, -1), "utf8");
      },
    },
    {
      label: "a last line cut short",
      wanted: [uOne],
      expectedChangeKind: undefined,
      mutate: async (usersDir: string) => {
        await writeFile(path.join(usersDir, "passwd"), baseOne.passwd.slice(0, -12), "utf8");
        await writeFile(path.join(usersDir, "shadow"), baseOne.shadow.slice(0, -10), "utf8");
      },
    },
    {
      label: "a last line cut short (partial removed user)",
      wanted: [uOne],
      expectedChangeKind: "replace" as const,
      mutate: async (usersDir: string) => {
        await writeFile(
          path.join(usersDir, "passwd"),
          `${baseOne.passwd}s9f8e7d6c_gone:x:33:33`,
          "utf8",
        );
        await writeFile(
          path.join(usersDir, "shadow"),
          `${baseOne.shadow}s9f8e7d6c_gone:$6$old`,
          "utf8",
        );
      },
    },
  ])(
    "prepareSftpStatePlan + commitSftpStatePlan repairs damaged user files on disk: $label",
    async ({ wanted, expectedChangeKind, mutate }) => {
      const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-sftp-damaged-"));
      cleanupTasks.push(() => rm(tmp, { recursive: true, force: true }));
      const stateDir = path.join(tmp, "sftp");
      await mkdir(stateDir, { mode: 0o700 });
      await chmod(stateDir, 0o700);
      const uid = process.getuid?.() ?? 1000;

      await ensureSftpStateFiles(stateDir, uid, [uOne]);
      const usersDir = path.join(stateDir, "users");
      await mutate(usersDir);

      const plan = await prepareSftpStatePlan(stateDir, uid, wanted);
      if (expectedChangeKind !== undefined) {
        expect(plan.userChangeKind).toBe(expectedChangeKind);
      }
      await commitSftpStatePlan(plan);

      const fresh = renderSftpUserFiles(wanted);
      expect(await readFile(path.join(usersDir, "passwd"), "utf8")).toBe(fresh.passwd);
      expect(await readFile(path.join(usersDir, "group"), "utf8")).toBe(fresh.group);
      expect(await readFile(path.join(usersDir, "shadow"), "utf8")).toBe(fresh.shadow);
    },
  );
});
