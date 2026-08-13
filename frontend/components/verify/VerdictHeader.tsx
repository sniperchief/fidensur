/**
 * The report's answer, before its evidence.
 *
 * Someone opening a verification report wants to know the outcome in one glance and then decide
 * whether to read the argument. Making them scroll six sections to find out is not rigour, it is
 * just bad structure — the rigour is that the glance is *earned*, and that the sections below it
 * show every value it was computed from.
 *
 * ## What this will not do
 *
 * Say "verified" unless every check ran and passed. `deriveVerdict` decides that, from the same
 * results the body renders. There is no prop here that lets a caller assert an outcome.
 *
 * The three outcomes are also distinguished by word and by mark, never by colour alone — the
 * report is meant to survive being printed, screenshotted in greyscale, and read by someone who
 * cannot tell the green from the amber.
 */

import { IconCheckAnimated, IconChip, IconClose, IconLock } from "@/components/ui/Icons";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type { ReportVerdict } from "@/lib/verdict";

export function VerdictHeader({
  roundId,
  status,
  verdict,
}: {
  roundId: string;
  status: number;
  verdict: ReportVerdict;
}) {
  return (
    <header className="verdict-header" data-outcome={verdict.overall}>
      <div className="verdict-top">
        <div>
          <p className="verdict-eyebrow">Verification report</p>
          <h1>Round {roundId}</h1>
        </div>
        <StatusBadge status={status} />
      </div>

      <div className="verdict-body">
        {/* A cross means broken. A simulated enclave is not broken, it is unproven — so it gets
            the hardware glyph and the amber treatment, not the red one. */}
        <span className="verdict-mark-lg" aria-hidden="true">
          {verdict.overall === "verified" ? (
            <IconCheckAnimated size={26} />
          ) : verdict.overall === "failed" ? (
            <IconClose size={24} />
          ) : verdict.overall === "simulated" ? (
            <IconChip size={24} />
          ) : (
            <IconLock size={22} />
          )}
        </span>

        <div>
          <p className="verdict-headline">{verdict.headline}</p>
          <p className="verdict-detail">{verdict.detail}</p>
        </div>
      </div>

      {verdict.note && <p className="verdict-note">{verdict.note}</p>}

      {/* The tally, so the headline can be audited against the sections without scrolling. */}
      <dl className="verdict-tally">
        <div>
          <dt>Passed</dt>
          <dd>{verdict.passed}</dd>
        </div>
        <div>
          <dt>Failed</dt>
          <dd>{verdict.failed}</dd>
        </div>
        <div>
          <dt>Unavailable</dt>
          <dd>{verdict.unavailable}</dd>
        </div>
      </dl>
    </header>
  );
}
