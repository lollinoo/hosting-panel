/**
 * Tasks of an application template (`x-hp-tasks`, ADR-0042): a command an administrator declares for a component, which
 * a customer runs or schedules by its key. Guards the HARNESS rule: the arguments are fixed by the validated template
 * (the rules of a component's command, no placeholder, never a shell), and a template without tasks is unchanged.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APP_TEMPLATE_ISSUE_REASON,
  APP_TEMPLATE_LIMITS,
  AppTemplateSpecSchema,
  appStackTaskArgvProblem,
  parseTemplateYaml,
  type AppImageAllowlistEntry,
  type AppTemplateIssue,
  type AppTemplateIssueCode,
  type AppTemplateSpec,
} from "@hosting-panel/contracts";
import { compileAppStackPlan } from "../src/app-template-compile.js";
import { validateAppTemplate, validateAppTemplateSource } from "../src/app-template-validation.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../contracts/test/fixtures/app-stack-notes-demo/${name}`, import.meta.url), "utf8");
const SOURCE = fixture("source.yaml");
const SPEC = JSON.parse(fixture("spec.json")) as AppTemplateSpec;
const PLAN: unknown = JSON.parse(fixture("plan.json"));
const ALLOWLIST = JSON.parse(fixture("allowlist.json")) as AppImageAllowlistEntry[];
const options = { allowlist: ALLOWLIST };

const parsed = parseTemplateYaml(SOURCE);
if (!parsed.ok) throw new Error("the fixture must parse");
const BASE = parsed.value as Record<string, unknown>;

const TIDY = { key: "tidy", label: "Tidy up", service: "app", command: ["/app/bin/tidy", "--older-than", "30d"] };
type Task = Record<string, unknown>;
const withTasks = (tasks: unknown): unknown => ({ ...structuredClone(BASE), "x-hp-tasks": tasks });
const one = (change: Task): unknown => withTasks([{ ...TIDY, ...change }]);
const without = (field: string): unknown => withTasks([Object.fromEntries(Object.entries(TIDY).filter(([key]) => key !== field))]);

const specOf = (document: unknown): AppTemplateSpec => {
  const result = validateAppTemplate(document, undefined, options);
  if (!result.ok) throw new Error(`expected a spec, got ${JSON.stringify(result.errors)}`);
  return result.spec;
};
const errorsOf = (document: unknown): AppTemplateIssue[] => {
  const result = validateAppTemplate(document, undefined, options);
  if (result.ok) throw new Error("expected the document to be refused");
  return result.errors;
};
const summary = (issues: readonly AppTemplateIssue[]) => issues.map(({ path, code }) => ({ path, code }));

const TASKS_YAML = [
  "x-hp-tasks:",
  "  - key: tidy",
  "    label: Tidy up",
  "    service: app",
  '    command: ["/app/bin/tidy", "--older-than", "30d"]',
  "  - key: digest",
  "    label: Send the daily digest",
  "    description: Mails every user the notes changed since yesterday.",
  "    service: app",
  '    command: ["/app/bin/notes", "digest", "--cost=5$$"]',
  "    timeoutSeconds: 300",
  "",
].join("\n");

describe("a template without tasks is unchanged", () => {
  it("validates to exactly spec.json, with no tasks key", () => {
    const spec = specOf(BASE);
    expect(JSON.stringify(spec)).toBe(JSON.stringify(SPEC));
    expect("tasks" in spec).toBe(false);
  });

  it("treats an empty list as no tasks", () => {
    expect(JSON.stringify(specOf(withTasks([])))).toBe(JSON.stringify(SPEC));
  });
});

describe("a template with tasks", () => {
  it("adds the tasks in the order of the source, defaults applied, and changes nothing else in the spec", () => {
    const result = validateAppTemplateSource(SOURCE + TASKS_YAML, options);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const { tasks, ...rest } = result.spec;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(SPEC));
    expect(Object.keys(result.spec).at(-1)).toBe("tasks");
    expect(tasks).toEqual([
      { key: "tidy", label: "Tidy up", description: "", service: "app", command: ["/app/bin/tidy", "--older-than", "30d"], timeoutSeconds: 60 },
      {
        key: "digest",
        label: "Send the daily digest",
        description: "Mails every user the notes changed since yesterday.",
        service: "app",
        command: ["/app/bin/notes", "digest", "--cost=5$"],
        timeoutSeconds: 300,
      },
    ]);
    expect(AppTemplateSpecSchema.safeParse(result.spec).success).toBe(true);
  });

  it("stores the arguments as they are run: every one passes the shared rule", () => {
    for (const task of specOf(withTasks([TIDY, { ...TIDY, key: "other", command: ["php", "artisan", "schedule:run"] }])).tasks ?? []) {
      expect(appStackTaskArgvProblem(task.command)).toBeNull();
    }
  });

  it("compiles to the same plan, byte for byte: a task is not part of what is deployed", () => {
    const ids = {
      stackId: "stk_0123456789abcdef0123456789abcdef",
      organizationId: "org_acme",
      hostAllocationId: "alloc_0123456789abcdef0123456789abcdef",
      templateVersionId: "atv_0123456789abcdef01234567",
      revisionId: "astr_0123456789abcdef0123456789abcdef",
    };
    const compile = (source: string) => compileAppStackPlan({ source, parameters: [], secretVersions: new Map([["app_secret", 1]]), ids }, options);
    const plain = compile(SOURCE);
    const withTasksPlan = compile(SOURCE + TASKS_YAML);
    if (!plain.ok || !withTasksPlan.ok) throw new Error("both sources must compile");
    expect(JSON.stringify(withTasksPlan.plan)).toBe(JSON.stringify(plain.plan));
    expect(withTasksPlan.plan).toEqual(PLAN);
    expect(JSON.stringify(withTasksPlan.plan)).not.toContain("tidy");
  });

  it("accepts the limits: eight tasks, a 27-character key, an 80-character label, 5 and 600 seconds", () => {
    const eight = Array.from({ length: APP_TEMPLATE_LIMITS.tasks }, (_, i) => ({ ...TIDY, key: `task-${i}` }));
    expect(specOf(withTasks(eight)).tasks).toHaveLength(8);
    const edge = specOf(
      withTasks([
        { ...TIDY, key: `a${"b".repeat(26)}`, label: "x".repeat(80), description: "y".repeat(200), timeoutSeconds: 5 },
        { ...TIDY, key: "slow", service: "cache", timeoutSeconds: 600, command: Array.from({ length: 64 }, () => "x".repeat(1024)) },
      ]),
    );
    expect(edge.tasks?.map((task) => task.timeoutSeconds)).toEqual([5, 600]);
  });
});

type Row = readonly [name: string, document: unknown, code: AppTemplateIssueCode, path: string];

describe("what a task may not be", () => {
  const rows: readonly Row[] = [
    ["nine tasks", withTasks(Array.from({ length: 9 }, (_, i) => ({ ...TIDY, key: `task-${i}` }))), "TASK_TOO_MANY", "x-hp-tasks"],
    ["not a list", withTasks({ tidy: TIDY }), "TYPE_MISMATCH", "x-hp-tasks"],
    ["an item that is not a mapping", withTasks(["tidy"]), "TYPE_MISMATCH", "x-hp-tasks[0]"],
    ["no key", without("key"), "TASK_FIELD_MISSING", "x-hp-tasks[0]"],
    ["no label", without("label"), "TASK_FIELD_MISSING", "x-hp-tasks[0]"],
    ["no service", without("service"), "TASK_FIELD_MISSING", "x-hp-tasks[0]"],
    ["no command", without("command"), "TASK_FIELD_MISSING", "x-hp-tasks[0]"],
    ["an upper-case key", one({ key: "Tidy" }), "TASK_KEY_INVALID", "x-hp-tasks[0].key"],
    ["a key with an underscore", one({ key: "tidy_up" }), "TASK_KEY_INVALID", "x-hp-tasks[0].key"],
    ["a key ending in a dash", one({ key: "tidy-" }), "TASK_KEY_INVALID", "x-hp-tasks[0].key"],
    ["a 28-character key", one({ key: `a${"b".repeat(27)}` }), "TASK_KEY_INVALID", "x-hp-tasks[0].key"],
    ["a key that is a number", one({ key: 7 }), "TASK_KEY_INVALID", "x-hp-tasks[0].key"],
    ["the same key twice", withTasks([TIDY, TIDY]), "TASK_KEY_DUPLICATE", "x-hp-tasks[1].key"],
    ["an empty label", one({ label: "" }), "TASK_LABEL_INVALID", "x-hp-tasks[0].label"],
    ["an 81-character label", one({ label: "x".repeat(81) }), "TASK_LABEL_INVALID", "x-hp-tasks[0].label"],
    ["a label with a control character", one({ label: "Tidy\u001b[2Jup" }), "TASK_LABEL_INVALID", "x-hp-tasks[0].label"],
    ["a label that is a number", one({ label: 7 }), "TASK_LABEL_INVALID", "x-hp-tasks[0].label"],
    ["a 201-character description", one({ description: "x".repeat(201) }), "TASK_DESCRIPTION_INVALID", "x-hp-tasks[0].description"],
    ["a description with a line break", one({ description: "one\ntwo" }), "TASK_DESCRIPTION_INVALID", "x-hp-tasks[0].description"],
    ["a null description", one({ description: null }), "TASK_DESCRIPTION_INVALID", "x-hp-tasks[0].description"],
    ["a service the template does not have", one({ service: "db" }), "TASK_SERVICE_UNKNOWN", "x-hp-tasks[0].service"],
    ["a volume in place of a service", one({ service: "data" }), "TASK_SERVICE_UNKNOWN", "x-hp-tasks[0].service"],
    ["a service that is a number", one({ service: 1 }), "TASK_SERVICE_UNKNOWN", "x-hp-tasks[0].service"],
    ["a command in shell form", one({ command: "/app/bin/tidy --all" }), "TYPE_MISMATCH", "x-hp-tasks[0].command"],
    ["an empty command", one({ command: [] }), "ARGV_EMPTY", "x-hp-tasks[0].command"],
    ["65 command items", one({ command: Array.from({ length: 65 }, () => "x") }), "ARGV_TOO_MANY", "x-hp-tasks[0].command"],
    ["a number as an item", one({ command: ["/app/bin/tidy", 30] }), "ARGV_ITEM_NOT_STRING", "x-hp-tasks[0].command[1]"],
    ["an empty item", one({ command: ["/app/bin/tidy", ""] }), "ARGV_ITEM_INVALID", "x-hp-tasks[0].command[1]"],
    ["a 1025-character item", one({ command: ["/app/bin/tidy", "x".repeat(1025)] }), "ARGV_ITEM_INVALID", "x-hp-tasks[0].command[1]"],
    ["a control character", one({ command: ["/app/bin/tidy", "a\u0000b"] }), "ARGV_ITEM_INVALID", "x-hp-tasks[0].command[1]"],
    ["the Docker socket", one({ command: ["curl", "--unix-socket", "/var/run/docker.sock"] }), "ARGV_ITEM_INVALID", "x-hp-tasks[0].command[2]"],
    ["a metadata address", one({ command: ["curl", "http://169.254.169.254/latest"] }), "ARGV_ITEM_INVALID", "x-hp-tasks[0].command[1]"],
    ["credentials in a URL", one({ command: ["curl", "https://user:pw@example.invalid/"] }), "ARGV_ITEM_INVALID", "x-hp-tasks[0].command[1]"],
    ["a directory as the program", one({ command: ["/app/bin/"] }), "ARGV_ITEM_INVALID", "x-hp-tasks[0].command[0]"],
    ["sh -c", one({ command: ["sh", "-c", "rm -rf /app/data/*"] }), "ARGV_SHELL_REFUSED", "x-hp-tasks[0].command[0]"],
    ["/bin/bash", one({ command: ["/bin/bash", "/app/tidy.sh"] }), "ARGV_SHELL_REFUSED", "x-hp-tasks[0].command[0]"],
    ["busybox", one({ command: ["busybox", "sh"] }), "ARGV_SHELL_REFUSED", "x-hp-tasks[0].command[0]"],
    ["env as a launcher", one({ command: ["/usr/bin/env", "php", "tidy.php"] }), "ARGV_SHELL_REFUSED", "x-hp-tasks[0].command[0]"],
    ["a shell as a later item", one({ command: ["nice", "/bin/sh"] }), "ARGV_SHELL_REFUSED", "x-hp-tasks[0].command[1]"],
    ["a placeholder as the program", one({ command: ["${worker_count}"] }), "TASK_COMMAND_PLACEHOLDER", "x-hp-tasks[0].command[0]"],
    ["a whole-item placeholder", one({ command: ["/app/bin/tidy", "${worker_count}"] }), "TASK_COMMAND_PLACEHOLDER", "x-hp-tasks[0].command[1]"],
    ["a placeholder inside an item", one({ command: ["/app/bin/tidy", "--workers=${worker_count}"] }), "TASK_COMMAND_PLACEHOLDER", "x-hp-tasks[0].command[1]"],
    ["a secret parameter", one({ command: ["/app/bin/tidy", "${app_secret}"] }), "TASK_COMMAND_PLACEHOLDER", "x-hp-tasks[0].command[1]"],
    ["a name that is not a parameter", one({ command: ["/app/bin/tidy", "${HOME}"] }), "TASK_COMMAND_PLACEHOLDER", "x-hp-tasks[0].command[1]"],
    ["a bare dollar sign", one({ command: ["/app/bin/tidy", "$HOME"] }), "INTERP_SYNTAX", "x-hp-tasks[0].command[1]"],
    ["4 seconds", one({ timeoutSeconds: 4 }), "TASK_TIMEOUT_INVALID", "x-hp-tasks[0].timeoutSeconds"],
    ["601 seconds", one({ timeoutSeconds: 601 }), "TASK_TIMEOUT_INVALID", "x-hp-tasks[0].timeoutSeconds"],
    ["half a second more", one({ timeoutSeconds: 60.5 }), "TASK_TIMEOUT_INVALID", "x-hp-tasks[0].timeoutSeconds"],
    ["a time limit as text", one({ timeoutSeconds: "60" }), "TASK_TIMEOUT_INVALID", "x-hp-tasks[0].timeoutSeconds"],
    ["a null time limit", one({ timeoutSeconds: null }), "TASK_TIMEOUT_INVALID", "x-hp-tasks[0].timeoutSeconds"],
    ["a user", one({ user: "root" }), "KEY_FORBIDDEN_SECURITY", "x-hp-tasks[0].user"],
    ["privileged", one({ privileged: true }), "KEY_FORBIDDEN_SECURITY", "x-hp-tasks[0].privileged"],
    ["a capability", one({ cap_add: ["SYS_ADMIN"] }), "KEY_FORBIDDEN_SECURITY", "x-hp-tasks[0].cap_add"],
    ["a schedule in the template", one({ schedule: "daily" }), "KEY_UNSUPPORTED", "x-hp-tasks[0].schedule"],
    ["a cron expression", one({ cron: "* * * * *" }), "KEY_UNSUPPORTED", "x-hp-tasks[0].cron"],
    ["variables of its own", one({ environment: [{ name: "A", value: "b" }] }), "KEY_UNSUPPORTED", "x-hp-tasks[0].environment"],
    ["a directory of its own", one({ working_dir: "/" }), "KEY_UNSUPPORTED", "x-hp-tasks[0].working_dir"],
    ["a terminal", one({ tty: true }), "KEY_UNSUPPORTED", "x-hp-tasks[0].tty"],
    ["a key nobody knows", one({ image: "x" }), "KEY_UNKNOWN", "x-hp-tasks[0].image"],
  ];

  it.each(rows)("%s", (_name, document, code, path) => {
    expect(errorsOf(document)).toContainEqual(expect.objectContaining({ path, code, reason: APP_TEMPLATE_ISSUE_REASON[code] }));
  });

  it("names a placeholder once, never as an unknown or a secret parameter", () => {
    expect(summary(errorsOf(one({ command: ["/app/bin/tidy", "${app_secret}", "${nope}"] })))).toEqual([
      { path: "x-hp-tasks[0].command[1]", code: "TASK_COMMAND_PLACEHOLDER" },
      { path: "x-hp-tasks[0].command[2]", code: "TASK_COMMAND_PLACEHOLDER" },
    ]);
  });

  it("adds no second issue for a task of a service that has a problem of its own", () => {
    const document = structuredClone(BASE) as { services: { cache: Record<string, unknown> } };
    document.services.cache.privileged = true;
    const errors = errorsOf({ ...document, "x-hp-tasks": [{ ...TIDY, service: "cache" }] });
    expect(summary(errors)).toEqual([{ path: "services.cache.privileged", code: "KEY_FORBIDDEN_SECURITY" }]);
  });

  it("gives every task code the reason of an invalid template", () => {
    const codes = Object.keys(APP_TEMPLATE_ISSUE_REASON).filter((code) => code.startsWith("TASK_"));
    expect(codes).toHaveLength(9);
    for (const code of codes) expect(APP_TEMPLATE_ISSUE_REASON[code as AppTemplateIssueCode]).toBe("STACK_TEMPLATE_INVALID");
  });

  it("never echoes an argument, a label or a description in a message", () => {
    const marker = "zq7-marker";
    const errors = errorsOf(
      withTasks([
        { ...TIDY, label: `${marker}\u0001`, description: `${marker}\u0001`, command: ["sh", `${marker}\u0001`, `\${${marker}}`], user: marker },
      ]),
    );
    expect(errors.length).toBeGreaterThan(3);
    expect(JSON.stringify(errors)).not.toContain(marker);
  });

  it("locates an issue in the source", () => {
    const result = validateAppTemplateSource(SOURCE + TASKS_YAML.replace('"30d"]', '"30d"]\n    user: root'), options);
    if (result.ok) throw new Error("expected the source to be refused");
    const line = SOURCE.split("\n").length + 5;
    expect(result.errors).toEqual([expect.objectContaining({ path: "x-hp-tasks[0].user", code: "KEY_FORBIDDEN_SECURITY", line, column: 5 })]);
  });
});

describe("the shared rule and the last guard", () => {
  it.each([
    [[], "empty"],
    [Array.from({ length: 65 }, () => "x"), "too_many"],
    [[""], "item"],
    [["x".repeat(1025)], "item"],
    [["/app/bin/"], "item"],
    [["tidy", 7], "item"],
    [["tidy", "a\nb"], "item"],
    [["curl", "/run/docker.sock"], "item"],
    [["curl", "http://169.254.169.254/"], "item"],
    [["sh", "-c", "x"], "shell"],
    [["/usr/bin/env", "php"], "shell"],
    [["nice", "bash"], "shell"],
    [["/app/bin/tidy", "--all"], null],
  ] as const)("appStackTaskArgvProblem(%j) is %j", (argv, problem) => {
    expect(appStackTaskArgvProblem(argv)).toBe(problem);
  });

  const stored = (tasks: unknown): boolean => AppTemplateSpecSchema.safeParse({ ...SPEC, tasks }).success;
  const task = { key: "tidy", label: "Tidy up", description: "", service: "app", command: ["/app/bin/tidy"], timeoutSeconds: 60 };

  it("accepts a stored spec with a task and refuses one the validator would never produce", () => {
    expect(stored([task])).toBe(true);
    expect(stored([])).toBe(false);
    expect(stored([task, task])).toBe(false);
    expect(stored(Array.from({ length: 9 }, (_, i) => ({ ...task, key: `task-${i}` })))).toBe(false);
    expect(stored([{ ...task, service: "db" }])).toBe(false);
    expect(stored([{ ...task, command: ["sh", "-c", "x"] }])).toBe(false);
    expect(stored([{ ...task, command: [] }])).toBe(false);
    expect(stored([{ ...task, timeoutSeconds: 601 }])).toBe(false);
    expect(stored([{ ...task, label: "" }])).toBe(false);
    expect(stored([{ ...task, user: "root" }])).toBe(false);
    expect(stored([{ key: "tidy", label: "Tidy up", service: "app", command: ["/app/bin/tidy"] }])).toBe(false);
  });
});

// ADR-0042 §7: the clean-up finds what a run started by "HP_TASK_RUN=" as text anywhere in a process's environment, so
// no value of a component may hold that text, whoever wrote it. The rule is PR #74's (the closed list of the platform's
// process marks, which names HP_TASK_RUN); the cases marked skip pass once main, with PR #74, is merged into this branch:
// the coder of that merge switches them on.
describe("the mark of a task run is never in the environment of a component", () => {
  const ids = {
    stackId: "stk_0123456789abcdef0123456789abcdef",
    organizationId: "org_acme",
    hostAllocationId: "alloc_0123456789abcdef0123456789abcdef",
    templateVersionId: "atv_0123456789abcdef01234567",
    revisionId: "astr_0123456789abcdef0123456789abcdef",
  };
  /** Replaces `from`, which must be present, so a stale edit cannot pass silently. */
  const edit = (source: string, from: string, to: string): string => {
    if (!source.includes(from)) throw new Error(`not in the source: ${from}`);
    return source.replace(from, () => to);
  };
  // A customer's text parameter that lands in an environment value of the component "app".
  const titled = edit(
    edit(SOURCE, "x-hp-parameters:\n", 'x-hp-parameters:\n  - key: title\n    label: Title\n    type: string\n    default: "Notes"\n    customer: true\n'),
    "        value: cache\n",
    '        value: cache\n      - name: TITLE\n        value: "${title}"\n',
  );
  const compile = (source: string, title: string) =>
    compileAppStackPlan({ source, parameters: [{ key: "title", value: title }], secretVersions: new Map([["app_secret", 1]]), ids }, options);

  it("lands a customer's ordinary text in the environment as it is", () => {
    const result = compile(titled, "My notes");
    if (!result.ok) throw new Error(`expected a plan, got ${JSON.stringify(result.issues)}`);
    expect(result.plan.components.find((c) => c.key === "app")?.environment).toContainEqual({ name: "TITLE", value: "My notes" });
  });

  it.skip("refuses a customer's text that holds the mark of a task run [switch on once PR #74 is merged]", () => {
    for (const title of ["HP_TASK_RUN=srun_", "x HP_TASK_RUN=srun_0123456789abcdef01234567"]) {
      const result = compile(titled, title);
      expect(result.ok, title).toBe(false);
      if (!result.ok) expect(summary(result.issues), title).toEqual([{ path: "parameters.title", code: "PARAM_VALUE_FORBIDDEN_CONTENT" }]);
    }
  });

  it.skip("refuses a template whose own environment value holds the mark of a task run [switch on once PR #74 is merged]", () => {
    const source = edit(SOURCE, "        value: cache\n", "        value: cache\n      - name: MODE\n        value: x HP_TASK_RUN=srun_1\n");
    const result = validateAppTemplateSource(source, options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(summary(result.errors)).toContainEqual({ path: "services.app.environment[1].value", code: "ENV_VALUE_PROCESS_MARK" });
  });
});
