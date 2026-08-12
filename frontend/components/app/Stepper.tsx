/**
 * The round's progress rail.
 *
 * Five steps across the top of the console, driven entirely by the round's on-chain status. It is
 * a *readout*, not a wizard state machine — clicking a step navigates the view, but nothing here
 * decides what the round is allowed to do next. The chain does, and the console re-reads it after
 * every action.
 *
 * That distinction matters more than it sounds. A wizard that tracks its own step counter will
 * happily show step 4 to a browser that missed a receipt, and then offer an action that must
 * revert. Deriving the step from status means a stale tab corrects itself on the next read.
 *
 * Completed steps stay clickable so a user can look back at what they committed. Steps ahead of
 * the round are not, because there is nothing there yet.
 */

"use client";

import { IconCheck } from "@/components/ui/Icons";

export interface StepDef {
  id: number;
  label: string;
  short: string;
}

export const ROUND_STEPS: StepDef[] = [
  { id: 0, label: "Create round", short: "Create" },
  { id: 1, label: "Fund treasury", short: "Fund" },
  { id: 2, label: "Commit policy", short: "Policy" },
  { id: 3, label: "Compute", short: "Compute" },
  { id: 4, label: "Settle", short: "Settle" },
];

export function Stepper({
  current,
  furthest,
  onSelect,
}: {
  /** The step being shown. */
  current: number;
  /** How far the round has actually got, from chain status. Steps beyond this are unreachable. */
  furthest: number;
  onSelect: (step: number) => void;
}) {
  return (
    <ol className="stepper" role="list">
      {ROUND_STEPS.map((step) => {
        const done = step.id < furthest;
        const active = step.id === current;
        const reachable = step.id <= furthest;

        return (
          <li
            key={step.id}
            className="stepper-step"
            data-state={done ? "done" : active ? "active" : "pending"}
            data-active={active}
          >
            <button
              type="button"
              className="stepper-button"
              onClick={() => reachable && onSelect(step.id)}
              disabled={!reachable}
              aria-current={active ? "step" : undefined}
            >
              <span className="stepper-mark" aria-hidden="true">
                {done ? <IconCheck size={12} /> : String(step.id + 1).padStart(2, "0")}
              </span>
              <span className="stepper-label">
                <span className="stepper-label-full">{step.label}</span>
                <span className="stepper-label-short">{step.short}</span>
              </span>
              <span className="visually-hidden">
                {done ? " — completed" : active ? " — current step" : " — not started"}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
