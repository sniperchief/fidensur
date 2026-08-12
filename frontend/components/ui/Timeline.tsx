/**
 * Execution timeline.
 *
 * Three states, and the distinction between them matters more than it looks: `done` is something
 * the chain has recorded, `active` is what is happening now, `pending` has not happened. A
 * timeline that renders every stage identically and just greys out the future reads as a
 * progress bar — a promise about what will happen — rather than a record of what did.
 *
 * So `pending` gets a dashed rail and an empty mark, and carries no tick. Nothing here claims a
 * stage completed until it has.
 */

import type { ReactNode } from "react";

import { IconCheck } from "./Icons";

export type StageState = "done" | "active" | "pending";

export interface TimelineStage {
  title: string;
  detail?: ReactNode;
  state: StageState;
}

export function Timeline({ stages }: { stages: TimelineStage[] }) {
  return (
    <ol className="timeline">
      {stages.map((stage) => (
        <li key={stage.title} data-state={stage.state}>
          <span className="timeline-mark" aria-hidden="true">
            {stage.state === "done" ? (
              <IconCheck size={12} />
            ) : stage.state === "active" ? (
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  background: "currentColor",
                  display: "block",
                }}
              />
            ) : null}
          </span>
          <div className="timeline-body">
            <h4>
              {stage.title}
              <span className="visually-hidden">
                {stage.state === "done"
                  ? " — completed"
                  : stage.state === "active"
                    ? " — in progress"
                    : " — not started"}
              </span>
            </h4>
            {stage.detail && <p>{stage.detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
