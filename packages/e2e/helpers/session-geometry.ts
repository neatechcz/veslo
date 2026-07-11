export type SessionGeometryRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type SessionGeometryInput = {
  viewport: { width: number; height: number };
  root: SessionGeometryRect;
  center: SessionGeometryRect;
  composer: SessionGeometryRect;
  messageRows: SessionGeometryRect[];
  overlays?: SessionGeometryRect[];
  overflowTolerance?: number;
};

export type SessionOverflowInput = {
  content: { scrollWidth: number; clientWidth: number };
  nearestHorizontalScroller?: { overflowX: string } | null;
  tolerance?: number;
};

const rectIsPositive = (rect: SessionGeometryRect) => rect.width > 0 && rect.height > 0;

const overlaps = (left: SessionGeometryRect, right: SessionGeometryRect) =>
  left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;

export function sessionGeometryFailures(input: SessionGeometryInput): string[] {
  const failures: string[] = [];
  const tolerance = input.overflowTolerance ?? 2;
  if (!rectIsPositive(input.center)) failures.push('center pane has no positive geometry');
  if (!rectIsPositive(input.composer)) failures.push('composer has no positive geometry');
  if (input.root.right > input.viewport.width + tolerance) failures.push('root overflows the viewport horizontally');
  if (input.root.bottom > input.viewport.height + tolerance) failures.push('root overflows the viewport vertically');
  if (input.composer.left < -tolerance || input.composer.right > input.viewport.width + tolerance ||
      input.composer.top < -tolerance || input.composer.bottom > input.viewport.height + tolerance) {
    failures.push('composer is outside the viewport');
  }
  if (input.messageRows.some((row) => row.left < input.center.left - tolerance || row.right > input.center.right + tolerance)) {
    failures.push('message row escapes the center pane');
  }
  if ((input.overlays ?? []).some((overlay) => overlaps(overlay, input.composer))) {
    failures.push('overlay covers the composer');
  }
  return failures;
}

export function hasIntentionalHorizontalScroller(input: SessionOverflowInput): boolean {
  const tolerance = input.tolerance ?? 2;
  if (input.content.scrollWidth <= input.content.clientWidth + tolerance) return true;
  const overflowX = input.nearestHorizontalScroller?.overflowX ?? '';
  return overflowX === 'auto' || overflowX === 'scroll';
}
