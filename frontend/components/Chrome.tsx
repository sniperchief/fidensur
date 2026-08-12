/**
 * Which chrome a route gets.
 *
 * Two shells, chosen by path:
 *
 *   - **Workspace** (`/dashboard`, `/org`, `/claim`) — sidebar, topbar, wallet. Somewhere you go
 *     to do work, and come back to.
 *   - **Public site** (everything else, including `/verify`) — marketing header and footer.
 *
 * The verification explorer deliberately sits on the public side. It is read by strangers
 * auditing someone else's round; wrapping it in an authenticated-looking workspace with a
 * "Connect wallet" button would suggest it needs permission to look, and it does not.
 *
 * `children` is passed through from the server layout untouched, so pages keep whatever
 * server/client nature they already had — only the surrounding shell is client-side.
 */

"use client";

import { usePathname } from "next/navigation";

import { AppShell } from "@/components/app/AppShell";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { SiteNav } from "@/components/marketing/SiteNav";

const WORKSPACE_ROUTES = ["/dashboard", "/org", "/claim"];

export function Chrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isWorkspace = WORKSPACE_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );

  if (isWorkspace) return <AppShell>{children}</AppShell>;

  return (
    <>
      <SiteNav />
      {/* `tabIndex={-1}` makes this a valid target for the skip link — without it the browser
          scrolls but focus stays in the header, so the next Tab returns to the navigation. */}
      <div id="main" tabIndex={-1}>
        {children}
      </div>
      <SiteFooter />
    </>
  );
}
