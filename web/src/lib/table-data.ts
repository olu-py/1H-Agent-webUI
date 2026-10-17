function splitMarkdownTableCells(line: string): string[] {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\" && value[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (value[index] === "|") {
      cells.push(current.trim());
      current = "";
    } else current += value[index];
  }
  cells.push(current.trim());
  return cells;
}

/** Column constraints inspect every source row, including rows outside the mounted window. */
export function markdownTableColumnWidths(source: string): number[] {
  const rows = source.split(/\r?\n/).filter((line) => line.includes("|") && !/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line));
  const columns = Math.max(1, ...rows.map((line) => splitMarkdownTableCells(line).length));
  const widths = new Array<number>(columns).fill(40);
  for (const row of rows) {
    splitMarkdownTableCells(row).forEach((cell, index) => {
      const visible = cell.replace(/[*_~`\[\]]/g, "");
      const width = [...visible].reduce((sum, character) => sum + (/\p{Script=Han}/u.test(character) ? 15 : 8), 0) + 24;
      widths[index] = Math.max(widths[index], width);
    });
  }
  return widths;
}

export function extendTableColumnWidths(widths: number[], line: string): boolean {
  if (!line.includes("|") || /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line)) return false;
  let changed = false;
  splitMarkdownTableCells(line).forEach((cell, index) => {
    const visible = cell.replace(/[*_~`\[\]]/g, "");
    const width = [...visible].reduce((sum, character) => sum + (/\p{Script=Han}/u.test(character) ? 15 : 8), 0) + 24;
    if (index >= widths.length) widths.push(40);
    if (width > widths[index]) { widths[index] = width; changed = true; }
  });
  return changed;
}


export interface TableWindowData {
  shell: string;
  rows: string[];
  cellLengths: number[][];
  widths: number[];
}
/** Input is exclusively the safe renderer's generated HTML, never raw Markdown. */
export function renderedTableRows(html: string): string[] {
  return html.match(/<tr>[^]*?<\/tr>/g) ?? [];
}
export function tableRowCellLengths(html: string): number[] {
  return [...html.matchAll(/<td(?: class="[^"]*")?>([^]*?)<\/td>/g)]
    .map((cell) => cell[1].replace(/<[^>]*>/g, "").replace(/&(?:#\d+|#x[\da-f]+|\w+);/gi, "x").length);
}
export function tableWindowData(html: string, source: string): TableWindowData {
  const body = /<tbody>([^]*)<\/tbody>/.exec(html);
  const rows = renderedTableRows(body?.[1] ?? "");
  return { shell: html.replace(/<tbody>[^]*<\/tbody>/, "<tbody></tbody>"),
    rows, cellLengths: rows.map(tableRowCellLengths), widths: markdownTableColumnWidths(source) };
}
