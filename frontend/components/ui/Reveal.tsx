/**
 * Scroll reveal.
 *
 * One IntersectionObserver per revealed block, disconnected the moment it fires — the animation
 * is a first-impression effect, and an observer that keeps running so content can fade back out
 * on scroll-up is the thing that makes a page feel restless.
 *
 * ## Why it does not simply start hidden
 *
 * `.reveal` sets `opacity: 0`. If JavaScript never runs — a failed chunk, a crawler, a reader
 * with scripts off — every section below the fold would stay invisible permanently. So the class
 * is added *by* the effect: the server sends visible markup, and the browser opts into animating
 * it only once it is in a position to animate it back.
 *
 * `prefers-reduced-motion` is handled in CSS rather than here, so it also covers the case where
 * the preference changes after mount.
 */

"use client";

import { useEffect, useRef, useState, type ElementType, type ReactNode } from "react";

export function Reveal({
  children,
  as: Tag = "div",
  delay = 0,
  className,
}: {
  children: ReactNode;
  as?: ElementType;
  /** Milliseconds. Used sparingly — a handful of siblings, never a long stagger. */
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const [armed, setArmed] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // Anything already on screen at mount is revealed without waiting for a scroll that may
    // never come — otherwise the hero would sit at opacity 0 on a tall desktop viewport.
    setArmed(true);

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setShown(true);
          observer.disconnect();
        }
      },
      // A little before the block's top edge arrives, so it has finished settling by the time it
      // is properly in view rather than animating under the reader's eye.
      { rootMargin: "0px 0px -12% 0px", threshold: 0.05 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const classes = [armed ? "reveal" : "", shown ? "in" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <Tag
      ref={ref}
      className={classes || undefined}
      style={delay ? ({ "--reveal-delay": `${delay}ms` } as React.CSSProperties) : undefined}
    >
      {children}
    </Tag>
  );
}
