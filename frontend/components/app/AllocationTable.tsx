/**
 * The allocation table.
 *
 * Below 768px the table is replaced outright by a stack of cards — not left to scroll sideways,
 * and not collapsed by hiding columns. Both renderings come from the same `listings` array, so a
 * row cannot say one thing on desktop and another on a phone.
 *
 * ## Column order
 *
 * Round, status, funded, allocated, recipients, deadline. That is the order the four questions
 * arrive in: what is this, what state is it in, how much is involved, and when does it stop
 * mattering. Amounts are right-aligned in tabular figures so a column can be compared by shape.
 */

"use client";

import Link from "next/link";

import { IconChevronRight, IconInbox } from "@/components/ui/Icons";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { abbreviateHex } from "@/components/ui/Mono";
import { NATIVE_TOKEN } from "@/lib/contracts";
import { formatCount, formatDate, formatTokenAmount } from "@/lib/format";
import type { RoundListing } from "@/lib/rounds";

function symbolFor(token: string): string {
  return token === NATIVE_TOKEN ? "C2FLR" : "tokens";
}

export function AllocationTable({ listings }: { listings: RoundListing[] }) {
  if (listings.length === 0) return <NoRounds />;

  return (
    <>
      <div className="table-scroll">
        <table className="alloc-table">
          <thead>
            <tr>
              <th scope="col">Round</th>
              <th scope="col">Status</th>
              <th scope="col" className="numeric">
                Funded
              </th>
              <th scope="col" className="numeric">
                Allocated
              </th>
              <th scope="col" className="numeric">
                Recipients
              </th>
              <th scope="col">Claim closes</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {listings.map(({ id, round }) => (
              <tr key={String(id)}>
                <th scope="row">
                  <span className="cell-primary">Round {String(id)}</span>
                  <span className="cell-sub">{abbreviateHex(round.organization, 6, 4)}</span>
                </th>
                <td>
                  <StatusBadge status={round.status} />
                </td>
                <td className="numeric">
                  {formatTokenAmount(round.funded)}{" "}
                  <span className="cell-unit">{symbolFor(round.token)}</span>
                </td>
                <td className="numeric">
                  {round.totalAllocated > 0n ? formatTokenAmount(round.totalAllocated) : "—"}
                </td>
                <td className="numeric">
                  {round.recipientCount ? formatCount(round.recipientCount) : "—"}
                </td>
                <td>{formatDate(round.claimDeadline)}</td>
                <td>
                  <Link className="row-action" href={`/verify/${id}`}>
                    Report
                    <IconChevronRight size={13} />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile rendering of the same rows. */}
      <div className="alloc-cards">
        {listings.map(({ id, round }) => (
          <Link className="alloc-card" href={`/verify/${id}`} key={String(id)}>
            <div className="alloc-card-head">
              <div>
                <span className="alloc-card-title">Round {String(id)}</span>
                <span className="cell-sub">{abbreviateHex(round.organization, 6, 4)}</span>
              </div>
              <StatusBadge status={round.status} />
            </div>

            <div className="alloc-card-facts">
              <div>
                <span className="fact-label">Funded</span>
                <span className="fact-value">
                  {formatTokenAmount(round.funded)} {symbolFor(round.token)}
                </span>
              </div>
              <div>
                <span className="fact-label">Allocated</span>
                <span className="fact-value">
                  {round.totalAllocated > 0n ? formatTokenAmount(round.totalAllocated) : "—"}
                </span>
              </div>
              <div>
                <span className="fact-label">Recipients</span>
                <span className="fact-value">
                  {round.recipientCount ? formatCount(round.recipientCount) : "—"}
                </span>
              </div>
              <div>
                <span className="fact-label">Claim closes</span>
                <span className="fact-value">{formatDate(round.claimDeadline)}</span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}

export function NoRounds() {
  return (
    <div className="empty-state">
      <span className="empty-mark" aria-hidden="true">
        <IconInbox size={20} />
      </span>
      <h3>No allocation rounds yet</h3>
      <p>
        Nothing has been created on this deployment. A round starts in the console, where you fund
        it and commit an encrypted allocation policy to it.
      </p>
      <Link className="btn btn-primary" href="/org">
        Create the first round
      </Link>
    </div>
  );
}
