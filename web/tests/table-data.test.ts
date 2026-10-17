import { describe, expect, it } from "vitest";
import { createMarkdownModelCache, updateMarkdownModel, renderMarkdown } from "../src/lib/markdown";
import { tableWindowData } from "../src/lib/table-data";

describe("table model without DOM materialization", () => {
  it("reconstructs the exact safe renderer output, alignment and escaped Unicode cells", () => {
    const source = "| 中文 | code |\n| :--- | ---: |\n| **汉字** | `a\\|b` |\n| <tr> | [safe](https://example.org) |";
    const document = updateMarkdownModel(createMarkdownModelCache(), source);
    const block = document.blocks[0];
    expect(block.kind).toBe("table");
    expect(block.table!.shell.replace("<tbody></tbody>", `<tbody>${block.table!.rows.join("")}</tbody>`)).toBe(renderMarkdown(source));
    expect(block.table!.rows).toHaveLength(2);
    expect(block.table!.rows[0]).toContain('class="ta-right"');
    expect(block.table!.rows[1]).toContain("&lt;tr&gt;");
    expect(block.children[2].sourceStart).toBe(source.indexOf("| **"));
    expect(block.children.at(-1)!.sourceEnd).toBe(source.length);
  });
  it("preserves final parser semantics for incomplete tables, fences, lists and merged tails", () => {
    for (const source of ["| a | b |\n| --- | --- |\n| final", "```js\nunclosed <x>", "- first\n  continued\n- final", "prefix\n\ntail\nmerged"]) {
      const document = updateMarkdownModel(createMarkdownModelCache(), source);
      expect(document.html).toBe(renderMarkdown(source));
      for (const block of document.blocks) if (block.table) {
        expect(block.table.shell.replace("<tbody></tbody>", `<tbody>${block.table.rows.join("")}</tbody>`)).toBe(block.html);
      }
    }
  });
  it("does not split escaped user tag text into extra rows", () => {
    const data = tableWindowData('<div class="table-wrap"><table><thead></thead><tbody><tr><td>&lt;tr&gt;&amp;</td></tr></tbody></table></div>', "| header |\n| --- |\n| <tr>& |");
    expect(data.rows).toHaveLength(1);
    expect(data.cellLengths).toEqual([[5]]);
  });
});
