import type { AppStackDeploymentDto, AppStackDetailDto } from "@hosting-panel/contracts";
import { format, type Locale, type Messages } from "@/i18n";
import { HealthBadge } from "./app-stack-status";
import { appStackProblemText, formatCpu, formatMemory } from "./app-stack-view";

type Components = AppStackDetailDto["components"];
const dates = (locale: Locale) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
const muted = "text-sm text-muted-foreground";

export function AppStackComponents({ components, m, locale }: { components: Components; m: Messages; locale: Locale }) {
  const t = m.apps.components;
  const date = dates(locale);
  const healthy = components.filter((c) => c.health === "healthy").length;
  return (
    <div className="space-y-3">
      <p className="text-sm">{format(t.summary, { healthy, total: components.length })}</p>
      <ul className="divide-y rounded-md border">
        {components.map((c) => (
          <li key={c.key} className="space-y-1 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono font-medium">{c.key}</span>
              <HealthBadge health={c.health} m={m} />
            </div>
            <p className="text-muted-foreground">
              {c.healthObservedAt ? (
                <time dateTime={c.healthObservedAt}>{format(t.lastCheck, { time: date.format(new Date(c.healthObservedAt)) })}</time>
              ) : (
                t.neverChecked
              )}
            </p>
            <p className="text-muted-foreground">{c.dependsOn.length ? format(t.dependsOn, { list: c.dependsOn.join(", ") }) : t.noDependencies}</p>
            {c.ingress && <p className="text-muted-foreground">{t.web}</p>}
            <p className="text-muted-foreground">{format(t.resources, { cpu: formatCpu(c.cpuMilli), memory: formatMemory(c.memoryBytes) })}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AppStackSettings({ parameters, m }: { parameters: AppStackDetailDto["parameters"]; m: Messages }) {
  if (parameters.length === 0) return <p className={muted}>{m.apps.settings.none}</p>;
  return (
    <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
      {parameters.map((p) => (
        <div key={p.key} className="contents">
          <dt className="text-muted-foreground">{p.label}</dt>
          <dd className="break-all">{String(p.value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AppStackData({ volumes, m }: { volumes: AppStackDetailDto["volumes"]; m: Messages }) {
  const t = m.apps.data;
  return (
    <div className="space-y-2">
      {volumes.length === 0 ? (
        <p className={muted}>{t.none}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {volumes.map((d) => (
            <li key={d.key} className="flex flex-wrap gap-2">
              <span className="font-mono">{d.key}</span>
              <span>{t.status[d.status]}</span>
            </li>
          ))}
        </ul>
      )}
      <p className={muted}>{t.keptNote}</p>
    </div>
  );
}

export function AppStackResources({
  cpuMilli,
  memoryBytes,
  components,
  m,
}: {
  cpuMilli: number;
  memoryBytes: string;
  components: Components;
  m: Messages;
}) {
  return (
    <div className="space-y-2 text-sm">
      <p className="font-medium">{format(m.apps.resources.total, { cpu: formatCpu(cpuMilli), memory: formatMemory(memoryBytes) })}</p>
      <ul className="space-y-1">
        {components.map((c) => (
          <li key={c.key} className="flex flex-wrap gap-2">
            <span className="font-mono">{c.key}</span>
            <span className="text-muted-foreground">
              {format(m.apps.components.resources, { cpu: formatCpu(c.cpuMilli), memory: formatMemory(c.memoryBytes) })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AppStackHistory({ deployments, m, locale }: { deployments: AppStackDeploymentDto[] | null; m: Messages; locale: Locale }) {
  const t = m.apps.history;
  if (deployments === null) return <p className={muted}>{m.apps.detail.sectionError}</p>;
  if (deployments.length === 0) return <p className={muted}>{t.empty}</p>;
  const date = dates(locale);
  const when = (iso: string) => <time dateTime={iso}>{date.format(new Date(iso))}</time>;
  return (
    <ul className="divide-y rounded-md border text-sm">
      {deployments.map((d) => {
        // Only a failed entry reads as failed; an outcome to be verified keeps its own words.
        const failed = d.status === "failed";
        // Failed with OPERATION_AMBIGUOUS: the panel closed it because its outcome could not be read (issue #183), so
        // "reload the page shortly" would never come true.
        const problem = failed && d.problem === "OPERATION_AMBIGUOUS" ? t.unconfirmed : appStackProblemText(m, d.problem);
        return (
          <li key={d.id} className="space-y-1 p-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium">{t.kind[d.kind.slice("stack.".length) as keyof typeof t.kind]}</span>
              <span>{t.status[d.status]}</span>
              {d.revisionNumber !== null && <span className="text-muted-foreground">{format(m.apps.detail.releaseLine, { n: d.revisionNumber })}</span>}
            </div>
            <p className="flex flex-wrap gap-x-3 text-muted-foreground">
              {when(d.startedAt)}
              {d.endedAt && when(d.endedAt)}
            </p>
            {problem && (failed || problem !== t.problemGeneric) && <p className={failed ? "text-destructive" : "text-muted-foreground"}>{problem}</p>}
          </li>
        );
      })}
    </ul>
  );
}
