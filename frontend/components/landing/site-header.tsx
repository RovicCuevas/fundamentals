"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { cn } from "@/lib/cn";

const LINKS = [
  { href: "#services", label: "Services" },
  { href: "#how-it-works", label: "How services works" },
  { href: "#doctors", label: "Doctors" },
];

export function SiteHeader() {
  const [open, setOpen] = useState(false);

  return (
    <header className="motion-page-in sticky top-0 z-40 border-b border-divider bg-card/95 shadow-card backdrop-blur-sm">
      <div className="mx-auto flex h-[72px] max-w-[1200px] items-center justify-between px-5 sm:px-8">
        <Link href="/" className="motion-interactive shrink-0">
          <Logo subtitle="Dental Clinic" markClassName="h-10 w-10 rounded-[12px] bg-tint-2 text-primary" />
        </Link>

        <nav className="hidden items-center gap-8 md:flex">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="motion-interactive text-[14px] font-medium text-slate hover:text-heading"
            >
              {link.label}
            </a>
          ))}
          <Link
            href="/login"
            className="motion-interactive rounded-pill border border-border bg-card px-4 py-2 text-[13px] font-semibold text-heading shadow-card hover:bg-page"
          >
            Sign in
          </Link>
          <ThemeToggle />
        </nav>

        <button
          type="button"
          className="motion-interactive rounded-btn p-2 text-heading md:hidden"
          aria-label="Open menu"
          onClick={() => setOpen(true)}
        >
          <Menu className="h-5 w-5" />
        </button>
      </div>

      {open ? (
        <div className="motion-fade-up fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-heading/40"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
          />
          <div className="motion-slide-in-right relative ml-auto h-full w-[min(100%,300px)] bg-card p-5 shadow-raised">
            <div className="mb-6 flex items-center justify-between">
              <Logo subtitle="Dental Clinic" />
              <button
                type="button"
                className="motion-interactive rounded-btn p-1 text-heading"
                aria-label="Close"
                onClick={() => setOpen(false)}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex flex-col gap-1">
              {LINKS.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className={cn(
                    "motion-interactive rounded-btn px-3 py-2.5 text-[14px] font-medium text-heading hover:bg-page",
                  )}
                >
                  {link.label}
                </a>
              ))}
              <Link
                href="/login"
                className="motion-interactive mt-3 rounded-pill border border-border px-4 py-2.5 text-center text-[13px] font-semibold text-heading"
              >
                Sign in
              </Link>
              <ThemeToggle className="mt-3 justify-center" />
            </div>
          </div>
        </div>
      ) : null}
    </header>
  );
}
