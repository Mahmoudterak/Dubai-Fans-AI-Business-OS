import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function Card({ className, children, ...rest }: ComponentProps<"section">) {
  return (
    <section className={cn("rounded-2xl border border-ink-700/70 bg-ink-850 p-5 shadow-[0_1px_0_0_rgba(255,255,255,0.03)_inset]", className)} {...rest}>
      {children}
    </section>
  );
}

export function CardTitle({ children, icon, action }: { children: ReactNode; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-base font-semibold text-ink-100">
        {icon && <span className="text-accent-400">{icon}</span>}
        {children}
      </h2>
      {action}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold text-ink-100">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-ink-400">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

type Tone = "neutral" | "blue" | "green" | "amber" | "red" | "gold" | "purple";
const tones: Record<Tone, string> = {
  neutral: "bg-ink-700/60 text-ink-300 ring-ink-600",
  blue: "bg-accent-500/15 text-accent-400 ring-accent-500/30",
  green: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  amber: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  red: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  gold: "bg-gold-500/15 text-gold-400 ring-gold-500/30",
  purple: "bg-violet-500/15 text-violet-300 ring-violet-500/30",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset", tones[tone], className)}>
      {children}
    </span>
  );
}

const buttonStyles = {
  primary: "bg-accent-500 text-white hover:bg-accent-400 disabled:bg-ink-600",
  gold: "bg-gold-500 text-ink-950 hover:bg-gold-400 disabled:bg-ink-600 disabled:text-ink-300",
  ghost: "bg-transparent text-ink-300 ring-1 ring-inset ring-ink-600 hover:bg-ink-800 hover:text-ink-100",
  danger: "bg-rose-600/90 text-white hover:bg-rose-500 disabled:bg-ink-600",
} as const;
export type ButtonVariant = keyof typeof buttonStyles;

export const buttonClass = (variant: ButtonVariant = "primary", className?: string) =>
  cn(
    "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed",
    buttonStyles[variant],
    className,
  );

export function LinkButton({ href, variant = "primary", children, className }: { href: string; variant?: ButtonVariant; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={buttonClass(variant, className)}>
      {children}
    </Link>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "gold" | "red" | "green" }) {
  return (
    <div className="rounded-2xl border border-ink-700/70 bg-ink-800/70 p-4">
      <p className="text-sm text-ink-400">{label}</p>
      <p
        className={cn(
          "ltr mt-2 text-end text-3xl font-bold",
          tone === "gold" ? "text-gold-400" : tone === "red" ? "text-rose-300" : tone === "green" ? "text-emerald-300" : "text-ink-100",
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-ink-400">{hint}</p>}
    </div>
  );
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-ink-700 px-6 py-12 text-center">
      {icon && <div className="text-ink-400">{icon}</div>}
      <p className="font-semibold text-ink-100">{title}</p>
      {description && <p className="max-w-md text-sm text-ink-400">{description}</p>}
      {action}
    </div>
  );
}

export function Notice({ tone = "amber", children }: { tone?: "amber" | "blue" | "red"; children: ReactNode }) {
  const t = tone === "blue" ? "border-accent-500/30 bg-accent-500/10 text-accent-400" : tone === "red" ? "border-rose-500/30 bg-rose-500/10 text-rose-200" : "border-amber-500/30 bg-amber-500/10 text-amber-200";
  return <div className={cn("rounded-xl border px-4 py-3 text-sm", t)}>{children}</div>;
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-ink-700/70">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="bg-ink-800 text-ink-400">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="px-4 py-3 text-start font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-700/60 bg-ink-850">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn("px-4 py-3 align-top", className)}>{children}</td>;
}

export function KeyValue({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="flex flex-col gap-0.5">
          <dt className="text-ink-400">{k}</dt>
          <dd className="text-ink-100">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Pre({ value }: { value: unknown }) {
  return (
    <pre className="ltr max-h-96 overflow-auto rounded-xl bg-ink-950 p-4 text-start text-xs leading-relaxed text-ink-300">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
