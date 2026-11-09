import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, stat, utimes, writeFile, readFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SITE_MAIL_FILES, ensureSiteMailFiles, siteMailBinds } from "../src/site-mail.js";

const hasPhp = spawnSync("php", ["--version"]).status === 0;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hp-site-mail-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("site mail files", () => {
  it("siteMailBinds lists exactly the three read-only binds", () => {
    expect(siteMailBinds("/d")).toEqual([
      "/d/hp-mail.php:/var/www/html/wp-content/mu-plugins/hp-mail.php:ro",
      "/d/hp-mail.ini:/usr/local/etc/php/conf.d/zz-hp-mail.ini:ro",
      "/d/hp-sendmail.php:/usr/local/lib/hp-mail/hp-sendmail.php:ro",
    ]);
  });

  it("mu-plugin is a default that a later SMTP plugin overrides", () => {
    const plugin = SITE_MAIL_FILES["hp-mail.php"];
    expect(plugin).toContain("PHP_INT_MIN");
    expect(plugin).toContain("$m->Host = 'hp-mail'");
    expect(plugin).toContain("addReplyTo");
    expect(SITE_MAIL_FILES["hp-mail.ini"]).toBe(
      'sendmail_path = "/usr/local/bin/php -n /usr/local/lib/hp-mail/hp-sendmail.php"\n',
    );
  });

  it("ensureSiteMailFiles writes 0644 under umask 0007 and rewrites in place", async () => {
    const dir = path.join(await tempDir(), "site-mail");
    const previous = process.umask(0o007);
    try {
      await ensureSiteMailFiles(dir);
      expect((await stat(dir)).mode & 0o777).toBe(0o755);
      for (const name of Object.keys(SITE_MAIL_FILES)) {
        expect((await stat(path.join(dir, name))).mode & 0o777).toBe(0o644);
      }

      const file = path.join(dir, "hp-mail.php");
      const inode = (await stat(file)).ino;
      await writeFile(file, "tampered");
      await ensureSiteMailFiles(dir);
      expect((await stat(file)).ino).toBe(inode);
      expect(await readFile(file, "utf8")).toBe(SITE_MAIL_FILES["hp-mail.php"]);

      const past = new Date(Date.now() - 60_000);
      await utimes(file, past, past);
      const before = (await stat(file)).mtimeMs;
      await ensureSiteMailFiles(dir);
      expect((await stat(file)).mtimeMs).toBe(before);
    } finally {
      process.umask(previous);
    }
  });
});

interface FakeSmtp {
  readonly port: number;
  readonly commands: string[];
  readonly data: string[];
}

async function fakeSmtp(endOfDataReply: string): Promise<FakeSmtp> {
  const state: FakeSmtp = { port: 0, commands: [], data: [] };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = "";
    let inData = false;
    socket.write("220 fake\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          state.data.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write(`${endOfDataReply}\r\n`);
          continue;
        }
        const eol = buffer.indexOf("\r\n");
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        state.commands.push(line);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "DATA") {
          inData = true;
          socket.write("354 go\r\n");
        } else if (verb === "QUIT") {
          socket.end("221 bye\r\n");
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => {
    sockets.forEach((s) => s.destroy());
    server.close(() => resolve());
  }));
  return { ...state, port: (server.address() as net.AddressInfo).port, commands: state.commands, data: state.data };
}

async function runShim(
  port: number,
  message: string,
  args: string[] = [],
): Promise<{ code: number | null; stderr: string }> {
  const dir = await tempDir();
  const script = path.join(dir, "hp-sendmail.php");
  await writeFile(script, SITE_MAIL_FILES["hp-sendmail.php"]);
  const child = spawn("php", ["-n", script, ...args], {
    env: { ...process.env, HP_MAIL_HOST: "127.0.0.1", HP_MAIL_PORT: String(port) },
  });
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
  child.stdin.end(message);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, stderr };
}

describe("sendmail shim (real php)", () => {
  const message = "To: a@x.it\r\nCc: b@x.it\r\nBcc: c@x.it\r\nSubject: s\r\n\r\n.hello";

  it.skipIf(!hasPhp)("delivers to To, Cc and Bcc, drops Bcc and dot-stuffs", async () => {
    const smtp = await fakeSmtp("250 queued");
    const result = await runShim(smtp.port, message, ["-f", "noreply@x.it"]);
    expect(result.code).toBe(0);
    expect(smtp.commands).toContain("MAIL FROM:<noreply@x.it>");
    for (const r of ["a", "b", "c"]) {
      expect(smtp.commands).toContain(`RCPT TO:<${r}@x.it>`);
    }
    expect(smtp.data[0]).not.toMatch(/^bcc:/im);
    expect(smtp.data[0]).toContain("Cc: b@x.it");
    expect(smtp.data[0]).toContain("\r\n\r\n..hello");
  });

  it.skipIf(!hasPhp)("exits 1 when the server refuses the message", async () => {
    const smtp = await fakeSmtp("451 try later");
    const result = await runShim(smtp.port, message);
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain("hello");
  });
});
