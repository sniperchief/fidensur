/**
 * The technical grid.
 *
 * Two repeating linear gradients and a mask — no image asset, no element per line, nothing to
 * download, and it re-renders for free at any viewport. The grid spacing is a token, so it steps
 * down on smaller screens instead of turning into visual noise.
 *
 * It is absolutely positioned and `pointer-events: none`, so the parent needs `position:
 * relative` and content needs to sit in a stacking context above it — `.section > .shell` already
 * does, which is why most callers need nothing but this one line.
 */

export function GridBackground({
  fade = "center",
  strong = false,
}: {
  /**
   * Where the grid gives way to the page.
   *
   * `center` clears the middle for a reading column, `bottom` for sections whose content starts
   * at the top, `edges` for a panel that should feel framed by it.
   */
  fade?: "center" | "bottom" | "edges";
  /** Slightly higher contrast, for the three sections the grid is meant to be noticed in. */
  strong?: boolean;
}) {
  return <div className="grid-bg" data-fade={fade} data-strong={strong} aria-hidden="true" />;
}
