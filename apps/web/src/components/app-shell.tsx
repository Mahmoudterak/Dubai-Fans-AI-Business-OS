import Link from "next/link";
import {
  BarChart3,
  Bot,
  CalendarDays,
  CheckCircle2,
  Inbox,
  LayoutDashboard,
  ListChecks,
  Network,
  PenSquare,
  Plug,
  Settings,
  Users,
} from "lucide-react";
import { t } from "@/i18n/ar";
import { NavLink } from "./nav-link";
import { SignOutButton } from "./sign-out";

const NAV = [
  { href: "/", label: t.nav.dashboard, icon: LayoutDashboard },
  { href: "/agents", label: t.nav.agents, icon: Bot },
  { href: "/tasks", label: t.nav.tasks, icon: ListChecks },
  { href: "/approvals", label: t.nav.approvals, icon: CheckCircle2 },
  { href: "/content", label: t.nav.content, icon: PenSquare },
  { href: "/calendar", label: t.nav.calendar, icon: CalendarDays },
  { href: "/integrations", label: t.nav.integrations, icon: Plug },
  { href: "/settings", label: t.nav.settings, icon: Settings },
];

// Shown so the roadmap is visible, but they are not links: nothing behind them yet.
const LATER = [
  { label: t.nav.crm, icon: Users },
  { label: t.nav.inbox, icon: Inbox },
  { label: t.nav.analytics, icon: BarChart3 },
];

export function AppShell({
  children,
  orgName,
  userName,
  role,
  pendingApprovals,
  devMode,
}: {
  children: React.ReactNode;
  orgName: string;
  userName: string;
  role: string;
  pendingApprovals: number;
  devMode: boolean;
}) {
  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <aside className="border-b border-ink-700/70 bg-ink-900 lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-64 lg:shrink-0 lg:flex-col lg:border-b-0 lg:border-e">
        <div className="flex items-center justify-between gap-3 px-4 py-4 lg:flex-col lg:items-stretch">
          <Link href="/" className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-gold-500 text-ink-950">
              <Network className="size-5" />
            </span>
            <span>
              <span className="block font-bold text-ink-100">{t.appName}</span>
              <span className="block text-xs text-ink-400">{t.appTagline}</span>
            </span>
          </Link>
          {devMode && <span className="rounded-md bg-amber-500/15 px-2 py-1 text-center text-[11px] text-amber-300">وضع التطوير — تسجيل دخول تجريبي</span>}
        </div>
        {/* On desktop the menu takes the remaining height and scrolls, so the user box below never covers it. */}
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:min-h-0 lg:flex-1 lg:flex-col lg:overflow-x-visible lg:overflow-y-auto">
          {NAV.map((n) => (
            <NavLink key={n.href} href={n.href}>
              <n.icon className="size-4 shrink-0" />
              <span className="whitespace-nowrap">{n.label}</span>
              {n.href === "/approvals" && pendingApprovals > 0 && (
                <span className="ltr ms-auto rounded-full bg-gold-500 px-2 text-xs font-bold text-ink-950">{pendingApprovals}</span>
              )}
            </NavLink>
          ))}
          <div className="mt-4 hidden px-3 text-[11px] font-medium text-ink-400 lg:block">{t.nav.later}</div>
          {LATER.map((n) => (
            <span key={n.label} aria-disabled className="hidden items-center gap-3 rounded-xl px-3 py-2 text-sm text-ink-600 lg:flex">
              <n.icon className="size-4" />
              {n.label}
            </span>
          ))}
        </nav>
        <div className="hidden shrink-0 border-t border-ink-700/70 px-4 py-4 text-sm lg:block">
          <p className="truncate font-medium text-ink-100">{userName}</p>
          <p className="truncate text-xs text-ink-400">
            {orgName} · {role}
          </p>
          <SignOutButton />
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-8">{children}</main>
    </div>
  );
}
