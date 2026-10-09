// Where desktop icons sit. Each icon has a cell (column, row). Saved cells are kept when they are still inside the
// grid and not shared; every other icon takes the next free cell, going down each column in turn.
export type Cell = [number, number];

export function allocate(ids: string[], saved: Record<string, Cell>, cols: number, rows: number): { cells: Map<string, Cell>; changed: boolean } {
  const cells = new Map<string, Cell>();
  const taken = new Set<string>();
  const at = (c: number, r: number) => `${c},${r}`;
  let changed = false;

  for (const id of ids) {
    const cell = saved[id];
    if (cell && cell[0] < cols && cell[1] < rows && !taken.has(at(cell[0], cell[1]))) {
      cells.set(id, cell);
      taken.add(at(cell[0], cell[1]));
    }
  }
  let col = 0;
  let row = 0;
  for (const id of ids) {
    if (cells.has(id)) continue;
    // A grid too small for every icon (a tiny window) shares its last cell rather than dropping an icon.
    while (taken.has(at(col, row)) && col < cols) {
      row++;
      if (row >= rows) {
        row = 0;
        col++;
      }
    }
    const cell: Cell = [Math.min(col, Math.max(0, cols - 1)), row];
    cells.set(id, cell);
    taken.add(at(cell[0], cell[1]));
    changed = true;
  }
  return { cells, changed };
}

/** The nearest cell to a point, clamped to the grid. */
export function cellAt(x: number, y: number, cellW: number, cellH: number, cols: number, rows: number): Cell {
  return [
    Math.max(0, Math.min(cols - 1, Math.floor(x / cellW))),
    Math.max(0, Math.min(rows - 1, Math.floor(y / cellH))),
  ];
}
