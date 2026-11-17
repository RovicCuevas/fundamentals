"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, Menu, X } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { useAuth } from "@/components/auth/auth-provider";
import { NAV_ICONS } from "@/components/layout/nav-icons";
import { cn } from "@/lib/cn";
import type { NavItem } from "@/lib/nav";
import type { Role } from "@/lib/auth";
import { fetchNotifications, type NotificationItem } from "@/lib/notifications";

type AppShellProps = {
  role: Role;
  brandSubtitle: string;
  brandStacked?: boolean;
  items: NavItem[];
  helpHref?: string;
  helpLabel?: string;
  logoutLabel?: string;
  logoutDanger?: boolean;
  children: React.ReactNode;
  headerRight?: React.ReactNode;
  sidebarExtraTop?: React.ReactNode;
  sidebarExtraBottom?: React.ReactNode;
  showPatientCard?: boolean;
  showBell?: boolean;
};

function isActive(pathname: string, href: string) {
  if (href === "/clerk" || href === "/dentist" || href === "/admin") {
    return pathname === href;
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

function notificationLabel(template: string) {
  const labels: Record<string, string> = {
    booking_received: "Booking request received",
    appointment_confirmed: "Appointment confirmed",
    appointment_cancelled: "Appointment cancelled",
    appointment_rescheduled: "Appointment rescheduled",
    payment_received: "Payment received",
    reminder_24h: "Appointment reminder",
    reminder_2h: "Appointment reminder",
    password_reset: "Password reset",
    email_verification: "Email verification",
  };
  return labels[template] ?? "Clinic notification";
}

function notificationDate(value: string) {
  const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}+08:00`);
  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Manila",
  }).format(parsed);
}

function NavLinks({
  items,
  pathname,
  onNavigate,
  variant,
}: {
  items: NavItem[];
  pathname: string;
  onNavigate?: () => void;
  variant: Role;
}) {
  return (
    <nav className="flex flex-col gap-1">
      {items.map((item) => {
        const Icon = NAV_ICONS[item.icon];
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              "motion-interactive flex items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-[13px] font-medium transition-colors",
              variant === "admin"
                ? active
                  ? "bg-primary text-white shadow-card"
                  : "text-slate hover:bg-tint-2"
                : active
                  ? "bg-tint-2 text-primary"
                  : "text-slate hover:bg-page",
            )}
          >
            <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
            <span className="flex-1">{item.label}</span>
            {item.badge ? (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-pill bg-[#7C3AED] px-1.5 text-[11px] font-bold text-white">
                {item.badge}
              </span>
            ) : null}
            {item.dot && !item.badge ? (
              <span className="h-2 w-2 rounded-full bg-info-2" />
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

export function AppShell({
  role,
  brandSubtitle,
  brandStacked = true,
  items,
  helpHref,
  helpLabel = "Help & Support",
  logoutLabel = "Log Out",
  logoutDanger = false,
  children,
  headerRight,
  sidebarExtraTop,
  sidebarExtraBottom,
  showPatientCard = false,
  showBell = true,
}: AppShellProps) {
  const pathname = usePathname();
  const { session, logout } = useAuth();
  const [openAtPath, setOpenAtPath] = useState<string | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationsError, setNotificationsError] = useState<string | null>(null);
  const notificationsRef = useRef<HTMLDivElement>(null);
  const open = openAtPath === pathname;

  useEffect(() => {
    if (!notificationsOpen) return;
    function closeOnOutsideClick(event: MouseEvent) {
      if (notificationsRef.current && !notificationsRef.current.contains(event.target as Node)) {
        setNotificationsOpen(false);
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setNotificationsOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [notificationsOpen]);

  async function toggleNotifications() {
    if (notificationsOpen) {
      setNotificationsOpen(false);
      return;
    }
    setNotificationsOpen(true);
    setNotificationsLoading(true);
    setNotificationsError(null);
    try {
      setNotifications(await fetchNotifications());
    } catch (error) {
      setNotificationsError(error instanceof Error ? error.message : "Could not load notifications.");
    } finally {
      setNotificationsLoading(false);
    }
  }

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="px-4 pb-6 pt-5">
        <Logo subtitle={brandSubtitle} stacked={brandStacked} />
      </div>
      {sidebarExtraTop}
      <div className="flex-1 px-3">
        {role === "admin" ? (
          <p className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.14em] text-muted">
            Clinical Navigation
          </p>
        ) : null}
        <NavLinks items={items} pathname={pathname} onNavigate={() => setOpenAtPath(null)} variant={role} />
      </div>
      <div className="mt-auto px-3 pb-4 pt-3">
        {sidebarExtraBottom}
        {showPatientCard && session ? (
          <div className="mb-3 flex items-center gap-2.5 rounded-[10px] bg-tint-2 px-3 py-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-primary shadow-card">
              <NAV_ICONS.userPlus className="h-4 w-4" />
            </span>
            <span>
              <span className="block text-[13px] font-semibold text-heading">{session.name}</span>
              <span className="block font-mono text-[11px] text-muted">
                Patient ID: {session.pid}
              </span>
            </span>
          </div>
        ) : null}
        <div className="border-t border-divider pt-3">
          {helpHref ? (
            <Link
              href={helpHref}
              className="flex items-center gap-2.5 rounded-[10px] px-3 py-2 text-[13px] font-medium text-slate hover:bg-page"
            >
              <NAV_ICONS.help className="h-4 w-4" />
              {helpLabel}
            </Link>
          ) : null}
          <button
            type="button"
            onClick={logout}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-[13px] font-medium hover:bg-page",
              logoutDanger ? "text-danger" : "text-slate",
            )}
          >
            <NAV_ICONS.logout className="h-4 w-4" />
            {logoutLabel}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-page">
      <aside className="fixed inset-y-0 left-0 z-30 hidden h-screen w-[248px] overflow-hidden border-r border-divider bg-white lg:block">
        {sidebar}
      </aside>

      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-heading/40"
            aria-label="Close menu"
            onClick={() => setOpenAtPath(null)}
          />
          <div className="motion-slide-in-right relative z-10 h-full w-[min(100%,280px)] bg-white shadow-raised">
            <button
              type="button"
              className="motion-interactive absolute right-3 top-3 rounded-btn p-1.5 text-slate"
              onClick={() => setOpenAtPath(null)}
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
            {sidebar}
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col lg:ml-[248px]">
        <header className="flex h-14 items-center justify-between gap-3 border-b border-divider bg-white px-4 shadow-card lg:h-[56px] lg:px-6">
          <button
            type="button"
            className="motion-interactive rounded-btn p-1.5 text-heading lg:hidden"
            onClick={() => setOpenAtPath(pathname)}
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="hidden lg:block" />
          <div className="ml-auto flex items-center gap-3">
            {headerRight}
            <ThemeToggle className="hidden sm:inline-flex" />
            <ThemeToggle className="px-2 sm:hidden" />
            {showBell ? (
              <div ref={notificationsRef} className="relative z-50">
                <button
                  type="button"
                  className="motion-interactive relative rounded-full p-1.5 text-slate hover:bg-page"
                  aria-label="Notifications"
                  aria-expanded={notificationsOpen}
                  onClick={toggleNotifications}
                >
                  <Bell className="h-4 w-4" />
                  {notifications.length > 0 ? (
                    <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-danger" />
                  ) : null}
                </button>
                {notificationsOpen ? (
                  <div className="absolute right-0 top-10 z-50 w-[min(90vw,360px)] rounded-[12px] border border-divider bg-white p-3 shadow-raised">
                    <div className="mb-2 flex items-center justify-between">
                      <h2 className="text-sm font-bold text-heading">Notifications</h2>
                      <span className="text-[11px] text-muted">{notifications.length}</span>
                    </div>
                    {notificationsLoading ? <p className="py-4 text-sm text-muted">Loading notifications...</p> : null}
                    {notificationsError ? <p className="py-4 text-sm text-danger">{notificationsError}</p> : null}
                    {!notificationsLoading && !notificationsError && notifications.length === 0 ? (
                      <p className="py-4 text-sm text-muted">No notifications yet.</p>
                    ) : null}
                    {!notificationsLoading && !notificationsError && notifications.length > 0 ? (
                      <ul className="max-h-80 space-y-2 overflow-y-auto">
                        {notifications.map((notification) => (
                          <li key={notification.id} className="rounded-[10px] bg-tint-2 px-3 py-2">
                            <p className="text-sm font-semibold text-heading">{notificationLabel(notification.template)}</p>
                            <p className="mt-0.5 text-xs text-muted">
                              {notificationDate(notification.createdAt)}
                            </p>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            {role === "admin" && session ? (
              <div className="motion-interactive flex items-center gap-2 rounded-btn px-2 py-1 hover:bg-page">
                  {session.profileImageUrl ? (
                    <img src={session.profileImageUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
                  ) : (
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-tint-2 text-[12px] font-bold text-primary">
                      {session.name.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <span className="text-right">
                    <span className="block text-[11px] font-bold uppercase tracking-[0.12em] text-heading">{session.name}</span>
                    <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">{session.title}</span>
                  </span>
              </div>
            ) : null}
          </div>
        </header>
        <main className="motion-page-in flex-1">{children}</main>
      </div>
    </div>
  );
}
