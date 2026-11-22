import { useMessages } from "@/i18n/provider";

export const WIZARD_STEPS = ["choose", "configure", "domains", "review", "install"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** Uses the messages context: render it inside a client component (AppWizard). */
export function WizardSteps({ current }: { current: WizardStep }) {
  const m = useMessages();
  const at = WIZARD_STEPS.indexOf(current);
  return (
    <ol aria-label={m.apps.wizard.stepsLabel} className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
      {WIZARD_STEPS.map((step, i) => (
        <li
          key={step}
          aria-current={i === at ? "step" : undefined}
          className={i === at ? "font-semibold text-foreground" : "text-muted-foreground"}
        >
          {m.apps.wizard.step[step]}
          {i < at && (
            <>
              {" "}
              <span aria-hidden>✓</span>
              <span className="sr-only">{m.apps.wizard.done}</span>
            </>
          )}
        </li>
      ))}
    </ol>
  );
}
