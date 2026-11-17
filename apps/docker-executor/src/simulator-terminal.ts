import type { TerminalShell, TerminalShellSink } from "./terminal-sessions.js";

const PROMPT = "/var/www/html $ ";

/** A fake /bin/sh for the simulator: prompt, echo, `id`, `echo`, `exit`, Ctrl-C and Ctrl-D. */
export function startSimulatedShell(sink: TerminalShellSink): TerminalShell {
  let line = "";
  let done = false;
  let lastCr = false;
  const out = (text: string) => sink.data(Buffer.from(text, "utf8"));
  const exit = () => {
    done = true;
    sink.exit("shell_exited");
  };
  const run = (cmd: string) => {
    const [name = "", ...args] = cmd.trim().split(/\s+/);
    if (name === "exit") return exit();
    if (name === "id") out("uid=33(www-data) gid=33(www-data) groups=33(www-data)\r\n");
    else if (name === "echo") out(`${args.join(" ")}\r\n`);
    else if (name) out(`/bin/sh: 1: ${name}: not found\r\n`);
    out(PROMPT);
  };
  out(PROMPT);
  return {
    write(bytes) {
      for (const ch of bytes.toString("utf8")) {
        if (done) return;
        const cr = lastCr;
        lastCr = ch === "\r";
        if (ch === "\n" && cr) continue; // CR LF is one Enter
        if (ch === "\r" || ch === "\n") {
          out("\r\n");
          const cmd = line;
          line = "";
          run(cmd);
        } else if (ch === "\x03") {
          line = "";
          out(`^C\r\n${PROMPT}`);
        } else if (ch === "\x04") {
          if (!line) exit();
        } else {
          line += ch;
          out(ch);
        }
      }
    },
    async kill() {
      done = true;
      return true;
    },
  };
}
