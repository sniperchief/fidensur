/**
 * Marketing header.
 *
 * Sticky, translucent over the grid, and it collapses to a single menu button below 768px rather
 * than shrinking five links until they collide.
 *
 * The section links carry the `/` prefix on purpose. This header also renders on /verify, where
 * a bare `#how-it-works` would scroll to nothing; `/#how-it-works` navigates home and then to the
 * section, which is what a reader clicking "How it works" from a report expects.
 */

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { Brand } from "@/components/Brand";
import { IconClose, IconMenu } from "@/components/ui/Icons";

const LINKS = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#verification", label: "Verification" },
  { href: "/#use-cases", label: "Use cases" },
  { href: "/verify", label: "Explorer" },
];

export function SiteNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // A route change with the menu still open leaves it covering the new page.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="site-header">
      <div className="shell header-inner">
        <Brand />

        <nav className="site-nav" aria-label="Main">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={pathname === link.href ? "page" : undefined}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="header-actions">
          <Link className="btn btn-primary btn-sm" href="/dashboard">
            Launch app
          </Link>
          <button
            type="button"
            className="nav-toggle"
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <IconClose /> : <IconMenu />}
          </button>
        </div>
      </div>

      <nav className="mobile-nav" id="mobile-nav" data-open={open} aria-label="Main">
        {LINKS.map((link) => (
          <Link key={link.href} href={link.href}>
            {link.label}
          </Link>
        ))}
        <Link className="btn btn-primary" href="/dashboard">
          Launch app
        </Link>
      </nav>
    </header>
  );
}
