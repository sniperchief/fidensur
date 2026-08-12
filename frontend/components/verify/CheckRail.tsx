/**
 * The rail: summary, navigation, and completeness check in one element.
 *
 * A long report has a structural problem that no amount of good prose fixes — a reader cannot
 * tell whether the section they are looking at is the important one, and cannot see what else
 * exists without scrolling past it.
 *
 * The rail solves all three at once. Every question the report asks is listed, each carrying its
 * own outcome. So it is the summary; it is the table of contents; and it is evidence that nothing
 * was quietly left out, because a section that could not be checked still appears, still numbered,
 * marked as unavailable rather than omitted.
 *
 * ## Why it is a nav, not a list of links
 *
 * `aria-current` tracks the section in view via an IntersectionObserver. Keyboard users get real
 * anchors that move focus; the observer only decorates.
 *
 * On desktop it sticks beside the report. Below 1080px it becomes a horizontal strip that scrolls
 * — the same markup, so the outcomes cannot drift between the two.
 */

"use client";

import { useEffect, useState } from "react";

import { IconCheck, IconClose } from "@/components/ui/Icons";
import type { SectionVerdict } from "@/lib/verdict";

const MARK: Record<SectionVerdict["state"], string> = {
  pass: "PASS",
  fail: "FAIL",
  unavailable: "N/A",
  manual: "YOU",
  info: "—",
};

export function CheckRail({ sections }: { sections: SectionVerdict[] }) {
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const targets = sections
      .map((s) => document.getElementById(`check-${s.n}`))
      .filter((el): el is HTMLElement => el !== null);

    if (targets.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // The topmost intersecting section wins, so scrolling up and down gives the same answer
        // at the same scroll position rather than depending on direction of travel.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(Number(visible[0].target.id.replace("check-", "")));
      },
      { rootMargin: "-20% 0px -60% 0px", threshold: 0 },
    );

    targets.forEach((t) => observer.observe(t));
    return () => observer.disconnect();
  }, [sections]);

  return (
    <nav className="check-rail" aria-label="Verification checks">
      <p className="rail-title">What was checked</p>
      <ol>
        {sections.map((section) => (
          <li key={section.n} data-state={section.state}>
            <a
              href={`#check-${section.n}`}
              aria-current={active === section.n ? "true" : undefined}
              title={section.note}
            >
              <span className="rail-n" aria-hidden="true">
                {String(section.n).padStart(2, "0")}
              </span>
              <span className="rail-label">{section.label}</span>
              <span className="rail-mark" data-state={section.state}>
                {section.state === "pass" ? (
                  <IconCheck size={11} />
                ) : section.state === "fail" ? (
                  <IconClose size={11} />
                ) : null}
                {MARK[section.state]}
              </span>
            </a>
          </li>
        ))}
      </ol>

      <p className="rail-foot">
        <strong>YOU</strong> marks the one check this page cannot make for you — reproducing the
        build. <strong>N/A</strong> means a check could not be reached, not that it passed.
      </p>
    </nav>
  );
}
