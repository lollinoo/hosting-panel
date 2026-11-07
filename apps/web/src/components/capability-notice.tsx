import { AlertCircle, Info, ShieldAlert } from "lucide-react";

export interface CapabilityNoticeProps {
  readonly title: string;
  readonly description: string;
  readonly tone?: "info" | "warning" | "danger";
}

export function CapabilityNotice({
  title,
  description,
  tone = "info",
}: CapabilityNoticeProps) {
  const styles =
    tone === "danger"
      ? {
          box: "border-rose-200 bg-rose-50 text-rose-900",
          sub: "text-rose-800",
          Icon: ShieldAlert,
          iconColor: "text-rose-600",
        }
      : tone === "warning"
        ? {
            box: "border-amber-200 bg-amber-50 text-amber-950",
            sub: "text-amber-800",
            Icon: AlertCircle,
            iconColor: "text-amber-600",
          }
        : {
            box: "border-sky-200 bg-sky-50 text-sky-950",
            sub: "text-sky-800",
            Icon: Info,
            iconColor: "text-sky-600",
          };

  const IconComponent = styles.Icon;

  return (
    <div
      role="note"
      className={`flex items-start gap-3 rounded-lg border p-3.5 text-sm ${styles.box}`}
    >
      <IconComponent
        className={`mt-0.5 h-4 w-4 shrink-0 ${styles.iconColor}`}
        aria-hidden="true"
      />
      <div>
        <p className="font-semibold">{title}</p>
        <p className={`mt-0.5 text-xs leading-relaxed ${styles.sub}`}>{description}</p>
      </div>
    </div>
  );
}
