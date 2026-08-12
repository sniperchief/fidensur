/**
 * Workspace shell.
 *
 * A persistent sidebar on desktop; below 1024px the same sidebar becomes an off-canvas drawer.
 * The markup is identical in both — one nav, one set of links, one active state — because a
 * second mobile-only nav is the thing that quietly drifts out of sync with the first.
 *
 * ## What the sidebar is not
 *
 * It is not a wallet UI. Treasury software is judged on whether you can find the round you were
 * looking at yesterday, so the navigation is organised by task — look at rounds, run one, claim
 * from one, audit one — rather than by contract surface.
 */

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { Brand } from "@/components/Brand";
import { ConnectButton } from "@/components/Wallet";
import {
  IconBadgeCheck,
  IconClose,
  IconGrid,
  IconInbox,
  IconList,
  IconMenu,
  IconPlus,
} from "@/components/ui/Icons";
import { COSTON2 } from "@/lib/contracts";

const GROUPS = [
  {
    label: "Workspace",
    items: [
      { href: "/dashboard", label: "Overview", Icon: IconGrid },
      { href: "/dashboard/allocations", label: "Allocations", Icon: IconList },
    ],
  },
  {
    label: "Operations",
    items: [
      { href: "/org", label: "New round", Icon: IconPlus },
      { href: "/claim", label: "Claim", Icon: IconInbox },
    ],
  },
  {
    label: "Public",
    items: [{ href: "/verify", label: "Verification", Icon: IconBadgeCheck }],
  },
];

const TITLES: Record<string, string> = {
  "/dashboard": "Overview",
  "/dashboard/allocations": "Allocations",
  "/org": "Organization console",
  "/claim": "Recipient portal",
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

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
    <div className="app-layout">
      <aside className="app-sidebar" data-open={open}>
        <Brand />

        <div>
          {GROUPS.map((group) => (
            <div className="sidebar-section" key={group.label}>
              <p className="sidebar-label">{group.label}</p>
              <nav className="sidebar-nav" aria-label={group.label}>
                {group.items.map(({ href, label, Icon }) => (
                  <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined}>
                    <Icon size={16} />
                    {label}
                  </Link>
                ))}
              </nav>
            </div>
          ))}
        </div>

        <div className="sidebar-foot">
          <span className="network-chip">
            <span className="dot" aria-hidden="true" />
            {COSTON2.name}
          </span>
          <Link className="btn btn-ghost btn-sm" href="/">
            Back to site
          </Link>
        </div>
      </aside>

      {open && (
        <button
          type="button"
          className="app-drawer-backdrop"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
        />
      )}

      <div className="app-main">
        <div className="app-topbar">
          <button
            type="button"
            className="nav-toggle drawer-toggle"
            aria-expanded={open}
            aria-label={open ? "Close navigation" : "Open navigation"}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <IconClose /> : <IconMenu />}
          </button>
          <h2 className="topbar-title">{TITLES[pathname] ?? "Fidensur"}</h2>
          <ConnectButton />
        </div>

        {/* The single `main` landmark for every workspace route, which is why the pages inside
            render a plain wrapper rather than a `main` of their own. */}
        <main className="app-content" id="main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
