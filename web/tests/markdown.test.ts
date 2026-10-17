import { describe, expect, it } from "vitest";
import {
  createMarkdownModelCache,
  createMarkdownStreamCache,
  renderMarkdown,
  renderMarkdownStreamUpdate,
  updateMarkdownModel,
} from "../src/lib/markdown";
import { graphemeBoundary } from "../src/components/Markdown";

describe("grapheme safe render chunks", () => {
  it("keeps combining sequences and emoji ZWJ families intact", () => {
    const combining = "e\u0301x";
    expect(combining.slice(0, graphemeBoundary(combining, 0, 1))).toBe("e\u0301");

    const family = "👨‍👩‍👧‍👦x";
    const boundary = graphemeBoundary(family, 0, 3);
    expect(family.slice(0, boundary)).toBe("👨‍👩‍👧‍👦");
    expect(family.slice(boundary)).toBe("x");
  });

  it("uses the complete grapheme oracle beyond the former 64-unit lookahead", () => {
    const combining = `e${"\u0301".repeat(96)}x`;
    const boundary = graphemeBoundary(combining, 0, 1);
    expect(boundary).toBe(combining.length - 1);
    expect(combining.slice(0, boundary)).toBe(`e${"\u0301".repeat(96)}`);

    const family = `${Array.from({ length: 12 }, (_, index) => index ? "‍👩" : "👨").join("")}x`;
    const familyBoundary = graphemeBoundary(family, 0, 2);
    expect(family.slice(familyBoundary)).toBe("x");
  });

  it("holds a grapheme split across deltas as one cluster before chunking", () => {
    const first = `prefix ${"👩‍".repeat(20)}`;
    const completed = `${first}👩 suffix`;
    const boundary = graphemeBoundary(completed, 0, 16);
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const legal = new Set([0, ...[...segmenter.segment(completed)].map((part) => part.index + part.segment.length)]);
    expect(legal.has(boundary)).toBe(true);
  });

  it("never returns an interior UTF-16 offset for varied grapheme boundaries", () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const pieces = ["A", "e\u0301", "각", "👍🏽", "🇭🇰", "👩‍❤️‍💋‍👨", "1️⃣", "🏴\u{E0067}\u{E0062}\u{E007F}"];
    const source = pieces.join("-").repeat(8);
    const boundaries = [...segmenter.segment(source)].map((part) => part.index);
    boundaries.push(source.length);
    const legal = new Set(boundaries);
    for (const start of boundaries.slice(0, -1)) {
      for (const maxChars of [1, 2, 3, 4, 7, 16, 31]) {
        const result = graphemeBoundary(source, start, maxChars);
        expect(legal.has(result), `offset ${result} splits a cluster after ${start} with limit ${maxChars}`).toBe(true);
        expect(result).toBeGreaterThan(start);
      }
    }
  });
});

/** The renderer joins block tags with newlines; strip them for assertions. */
function norm(html: string): string {
  return html.replace(/\n/g, "");
}

describe("source-addressable markdown model", () => {
  it("shares the legacy renderer semantics and tracks raw UTF-16 ranges", () => {
    const source = [
      "# Heading 🧪",
      "",
      "A paragraph with **bold** and e\u0301.",
      "",
      "> quoted line",
      "> second line",
      "",
      "| name | value |",
      "| --- | ---: |",
      "| alpha | 10 |",
      "| beta | 20 |",
      "",
      "```ts",
      "const family = '👨‍👩‍👧‍👦';",
      "console.log(family);",
      "```",
    ].join("\r\n");
    const document = updateMarkdownModel(createMarkdownModelCache(), source);
    expect(document.html).toBe(renderMarkdown(source));
    expect(document.source).toBe(source);
    for (const block of document.blocks) {
      expect(block.source).toBe(source.slice(block.sourceStart, block.sourceEnd));
      expect(block.sourceStart).toBeGreaterThanOrEqual(0);
      expect(block.sourceEnd).toBeLessThanOrEqual(source.length);
    }
    const table = document.blocks.find((block) => block.kind === "table");
    expect(table?.children.map((row) => source.slice(row.sourceStart, row.sourceEnd))).toEqual([
      "| name | value |", "| --- | ---: |", "| alpha | 10 |", "| beta | 20 |",
    ]);
    const code = document.blocks.find((block) => block.kind === "code");
    expect(code?.children.map((line) => source.slice(line.sourceStart, line.sourceEnd))).toEqual([
      "const family = '👨‍👩‍👧‍👦';", "console.log(family);",
    ]);
  });

  it("preserves completed block IDs and revises a changing tail in place", () => {
    const cache = createMarkdownModelCache();
    const first = updateMarkdownModel(cache, "completed block\n\nmutable");
    const completedId = first.blocks[0].id;
    const tailId = first.blocks[1].id;
    const tailRevision = first.blocks[1].revision;
    const extended = updateMarkdownModel(cache, "completed block\n\nmutable tail");
    expect(extended.blocks[0].id).toBe(completedId);
    expect(extended.blocks[1].id).toBe(tailId);
    expect(extended.blocks[1].revision).toBe(tailRevision + 1);
    const appended = updateMarkdownModel(cache, "completed block\n\nmutable tail\n\nnext");
    expect(appended.blocks[0].id).toBe(completedId);
    expect(appended.blocks[1].id).toBe(tailId);
    expect(appended.blocks[1].revision).toBe(extended.blocks[1].revision);
    expect(appended.blocks[2].id).not.toBe(tailId);
  });

  it("keeps non-1 ordered markers inside an interrupted paragraph", () => {
    const source = "A sentence before the marker.\n2024. continues the same paragraph";
    const document = updateMarkdownModel(createMarkdownModelCache(), source);
    expect(document.blocks).toHaveLength(1);
    expect(document.blocks[0].kind).toBe("paragraph");
    expect(document.html).toBe(renderMarkdown(source));
  });
});

describe("tables", () => {
  it("renders a basic GFM table", () => {
    const html = renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(html).toBe(
      '<div class="table-wrap"><table class="md-table">' +
        "<thead><tr><th>a</th><th>b</th></tr></thead>" +
        "<tbody><tr><td>1</td><td>2</td></tr></tbody>" +
        "</table></div>",
    );
  });

  it("renders column alignment from the delimiter row", () => {
    const html = norm(
      renderMarkdown("| l | c | r |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |"),
    );
    expect(html).toContain('<th class="ta-center">c</th>');
    expect(html).toContain('<th class="ta-right">r</th>');
    expect(html).toContain('<td class="ta-center">2</td>');
    expect(html).toContain('<td class="ta-right">3</td>');
    expect(html).toContain("<th>l</th>");
  });

  it("supports escaped pipes and inline syntax in cells", () => {
    const html = norm(
      renderMarkdown(
        "| a\\|b | c |\n| --- | --- |\n| x \\| y | **z** |",
      ),
    );
    expect(html).toContain("<th>a|b</th>");
    expect(html).toContain("<td>x | y</td>");
    expect(html).toContain("<td><strong>z</strong></td>");
  });

  it("pads short rows and drops extra cells", () => {
    const html = norm(
      renderMarkdown("| a | b | c |\n| --- | --- | --- |\n| 1 |\n| 1 | 2 | 3 | 4 |"),
    );
    expect(html).toContain("<tr><td>1</td><td></td><td></td></tr>");
    expect(html).toContain("<tr><td>1</td><td>2</td><td>3</td></tr>");
    expect(html).not.toContain("<td>4</td>");
  });

  it("accepts rows without outer pipes", () => {
    const html = norm(renderMarkdown("a | b\n--- | ---\n1 | 2"));
    expect(html).toContain("<thead><tr><th>a</th><th>b</th></tr></thead>");
    expect(html).toContain("<td>1</td>");
  });

  it("ends the table at a plain paragraph line", () => {
    const html = norm(
      renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |\nplain text"),
    );
    expect(html).toContain("</tbody></table></div>");
    expect(html).toContain("<p>plain text</p>");
  });

  it("renders a header-only partial (streaming) as a paragraph, not a table", () => {
    const html = renderMarkdown("| a | b |");
    expect(html).toBe("<p>| a | b |</p>");
  });

  it("renders consecutive tables separated by a blank line", () => {
    const html = renderMarkdown("| a |\n| - |\n| 1 |\n\n| b |\n| - |\n| 2 |");
    expect((html.match(/<table/g) ?? []).length).toBe(2);
  });

  it("escapes HTML inside cells", () => {
    const html = norm(
      renderMarkdown(
        "| <script> | b |\n| - | - |\n| <img src=x onerror=alert(1)> | y |",
      ),
    );
    expect(html).toContain("<th>&lt;script&gt;</th>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
  });
});

describe("incremental stream renderer", () => {
  it("streams closed inline formatting without reparsing committed words", () => {
    const cache = createMarkdownStreamCache();
    const deltas = [
      "**text** 中文 benchmark. ".repeat(6),
      "**text** 中文 benchmark. ".repeat(6),
      "**text** 中文 bench",
      "mark. **tail** done ",
    ];
    let source = "";
    let committed = "";
    let live = "";
    let sawAppend = false;
    for (let index = 0; index < deltas.length; index += 1) {
      source += deltas[index];
      const update = renderMarkdownStreamUpdate(cache, source, 18, true, {
        id: "inline", revision: index + 1, delta: deltas[index],
      });
      if (update.inlineStart) {
        committed = update.inlineStart.committedHtml;
        live = update.inlineStart.liveHtml;
      } else if (update.inlineAppend) {
        sawAppend = true;
        committed += update.inlineAppend.committedHtml;
        live = update.inlineAppend.liveHtml;
      } else {
        committed = "";
        live = update.tailHtml.slice(3, -4);
      }
      expect(`<p>${committed}${live}</p>`, `delta ${index}`).toBe(renderMarkdown(source, 0, 18));
    }
    expect(sawAppend).toBe(true);
    const final = renderMarkdownStreamUpdate(cache, source, 0, true, {
      id: "inline", revision: deltas.length, delta: deltas[deltas.length - 1],
    });
    expect(final.tailHtml).toBe(renderMarkdown(source));
  });

  it("falls back cleanly when a formatted paragraph gains a link or newline", () => {
    const cache = createMarkdownStreamCache();
    const deltas = [
      "**one** ~~two words~~ `three four` **five** tail ",
      "**six** more ",
      "https",
      "://example.test\nnext line",
    ];
    let source = "";
    let committed = "";
    let live = "";
    for (let index = 0; index < deltas.length; index += 1) {
      source += deltas[index];
      const update = renderMarkdownStreamUpdate(cache, source, 18, true, {
        id: "mixed-inline", revision: index + 1, delta: deltas[index],
      });
      if (update.inlineStart) {
        committed = update.inlineStart.committedHtml;
        live = update.inlineStart.liveHtml;
      } else if (update.inlineAppend) {
        committed += update.inlineAppend.committedHtml;
        live = update.inlineAppend.liveHtml;
      } else {
        committed = "";
        live = update.tailHtml.slice(3, -4);
      }
      const actual = update.inlineStart || update.inlineAppend
        ? `<p>${committed}${live}</p>`
        : update.tailHtml;
      expect(actual, `delta ${index}`).toBe(renderMarkdown(source, 0, 18));
    }
  });

  it("keeps malformed chunk-boundary emphasis exact across repeated SSE payloads", () => {
    const cache = createMarkdownStreamCache();
    const payload = "**text** 中文 benchmark. ".repeat(12).slice(0, 256);
    let source = "";
    let committed = "";
    let live = "";
    let fastUpdates = 0;
    for (let index = 0; index < 32; index += 1) {
      source += payload;
      const update = renderMarkdownStreamUpdate(cache, source, 18, true, {
        id: "sse-pattern", revision: index + 1, delta: payload,
      });
      if (update.inlineStart) {
        committed = update.inlineStart.committedHtml;
        live = update.inlineStart.liveHtml;
      } else if (update.inlineAppend) {
        fastUpdates += 1;
        committed += update.inlineAppend.committedHtml;
        live = update.inlineAppend.liveHtml;
      } else {
        committed = "";
        live = update.tailHtml.slice(3, -4);
      }
      expect(`<p>${committed}${live}</p>`, `chunk ${index}`).toBe(renderMarkdown(source, 0, 18));
    }
    expect(fastUpdates).toBeGreaterThan(25);
  });

  it("patches only the last table row and matches the full parser through partial rows", () => {
    const cache = createMarkdownStreamCache();
    const deltas = [
      "| a\\|b | c |\n| :--- | ---: |\n| x | **y** |\n",
      "| 1 | [li",
      "nk](https://example.test) |\n| 2 | <script> |\n",
      "| 3 | next |",
      "\n\nend",
    ];
    let source = "";
    let stable = "";
    let tail = "";
    let patched = 0;
    for (let index = 0; index < deltas.length; index += 1) {
      source += deltas[index];
      const update = renderMarkdownStreamUpdate(cache, source, 18, true, {
        id: "table", revision: index + 1, delta: deltas[index],
      });
      stable += update.stableHtml;
      if (update.tableAppend) {
        patched += 1;
        const tbodyEnd = tail.indexOf("</tbody>");
        const lastRow = tail.lastIndexOf("<tr>", tbodyEnd);
        expect(lastRow).toBeGreaterThan(0);
        tail = tail.slice(0, lastRow) + update.tableAppend.rowsHtml + tail.slice(tbodyEnd);
      } else {
        tail = update.tailHtml;
      }
      expect(stable + tail, `delta ${index}`).toBe(renderMarkdown(source, 0, 18));
    }
    expect(patched).toBeGreaterThan(1);
    const final = renderMarkdownStreamUpdate(cache, source, 0, true, {
      id: "table", revision: deltas.length, delta: deltas[deltas.length - 1],
    });
    expect(stable + final.tailHtml).toBe(renderMarkdown(source));
  });

  it("matches the complete parser while blocks become stable", () => {
    const samples = [
      "plain **paragraph**\n\n# heading\n\nnext line",
      "- first\n  continuation\n\n- second\n\nparagraph",
      "| a | b |\n| --- | --- |\n| 1 | 2 |\n\nend",
      "> quoted\n> **bold**\n\nend",
      "```ts\nconst x = '<script>';\n```\n\nafter",
      "```ts\nopen code\n\nstill code\n```\n\nfinished",
      "中文 e\u0301 👩‍💻 and [link](https://example.test)\n\n尾部",
      "paragraph\n\n1. ordered item\n\nend",
    ];

    for (const sample of samples) {
      const cache = createMarkdownStreamCache();
      let stable = "";
      let source = "";
      for (const scalar of sample) {
        source += scalar;
        const update = renderMarkdownStreamUpdate(cache, source);
        stable += update.stableHtml;
        const actual = stable + update.tailHtml;
        expect(actual, source).toBe(renderMarkdown(source));
      }
      expect(stable + renderMarkdownStreamUpdate(cache, source).tailHtml, sample)
        .toBe(renderMarkdown(sample));
    }
  });

  it("resets committed blocks when history is replaced or edited", () => {
    const cache = createMarkdownStreamCache();
    const first = renderMarkdownStreamUpdate(cache, "one\n\ntwo");
    expect(first.stableHtml).toBe("<p>one</p>");
    const replacement = renderMarkdownStreamUpdate(cache, "replacement");
    expect(replacement.reset).toBe(true);
    expect(replacement.tailHtml).toBe(renderMarkdown("replacement"));
  });

  it("rejects a longer non-prefix replacement on the append-only path", () => {
    const cache = createMarkdownStreamCache();
    renderMarkdownStreamUpdate(cache, "one\n\ntwo", 0, true);
    const replacement = renderMarkdownStreamUpdate(cache, "replacement is longer", 0, true);
    expect(replacement.reset).toBe(true);
    expect(replacement.stableHtml).toBe("");
    expect(replacement.tailHtml).toBe(renderMarkdown("replacement is longer"));
  });

  it("uses the reducer's contiguous stream delta without rechecking the full prefix", () => {
    const cache = createMarkdownStreamCache();
    let text = "";
    let stable = "";
    const deltas = ["first\n\n", "second", " tail"];
    for (let index = 0; index < deltas.length; index += 1) {
      const delta = deltas[index];
      text += delta;
      const update = renderMarkdownStreamUpdate(cache, text, 0, true, {
        id: "syn-1",
        revision: index + 1,
        delta,
      });
      stable += update.stableHtml;
      expect(stable + update.tailHtml).toBe(renderMarkdown(text));
    }
  });

  it("normalizes CRLF split between trusted stream deltas exactly once", () => {
    const cache = createMarkdownStreamCache();
    const deltas = ["line one\r", "\n\r", "\nline two"];
    let source = "";
    let stable = "";
    for (let index = 0; index < deltas.length; index += 1) {
      const delta = deltas[index];
      source += delta;
      const update = renderMarkdownStreamUpdate(cache, source, 0, true, {
        id: "syn-crlf",
        revision: index + 1,
        delta,
      });
      stable += update.stableHtml;
      expect(stable + update.tailHtml, JSON.stringify(source)).toBe(renderMarkdown(source));
    }
  });

  it("streams unclosed fenced code as escaped text and commits the exact final block", () => {
    const cache = createMarkdownStreamCache();
    const deltas = ["```text\n", "const x = '<script>';\n", "line two\n", "```\n\n"];
    let source = "";
    let stable = "";
    for (let index = 0; index < deltas.length; index += 1) {
      const delta = deltas[index];
      source += delta;
      const update = renderMarkdownStreamUpdate(cache, source, 0, true, {
        id: "syn-code",
        revision: index + 1,
        delta,
      });
      stable += update.stableHtml;
      if (update.fenceAppend !== undefined) {
        expect(update.tailHtml).toBe("");
        expect(renderMarkdown(cache.tailSource)).toBe(renderMarkdown(source));
      } else {
        expect(stable + update.tailHtml).toBe(renderMarkdown(source));
      }
    }
    expect(stable + renderMarkdownStreamUpdate(cache, source).tailHtml).toBe(renderMarkdown(source));
    expect(stable).not.toContain("<script>");
  });

  it("appends plain no-break text while keeping the full committed text selectable", () => {
    const cache = createMarkdownStreamCache();
    const deltas = ["plain words ".repeat(40), "中文 e\u0301 👩‍💻 ".repeat(24), "ending"];
    let source = "";
    let committed = "";
    for (let index = 0; index < deltas.length; index += 1) {
      const delta = deltas[index];
      source += delta;
      const update = renderMarkdownStreamUpdate(cache, source, 18, true, {
        id: "syn-plain",
        revision: index + 1,
        delta,
      });
      if (update.plainStart) committed += update.plainStart.committedText;
      else if (update.plainAppend) committed += update.plainAppend.committedText;
      else throw new Error("expected the bounded plain streaming path");
      expect(committed + cache.plainPending).toBe(source);
    }
    const replay = renderMarkdownStreamUpdate(cache, source, 18, true, {
      id: "syn-plain",
      revision: deltas.length,
      delta: deltas[deltas.length - 1],
    });
    expect(replay.reset).toBe(false);
    expect(replay.plainAppend?.committedText).toBe("");
    const final = renderMarkdownStreamUpdate(cache, source, 0, true, {
      id: "syn-plain",
      revision: deltas.length,
      delta: deltas[deltas.length - 1],
    });
    expect(final.reset).toBe(true);
    expect(final.tailHtml).toBe(renderMarkdown(source));
  });

  it("falls back to the complete parser when a plain stream becomes a link", () => {
    const cache = createMarkdownStreamCache();
    const first = renderMarkdownStreamUpdate(cache, "visit https", 18, true, {
      id: "syn-url", revision: 1, delta: "visit https",
    });
    expect(first.plainStart).toBeDefined();
    const source = "visit https://example.test";
    const update = renderMarkdownStreamUpdate(cache, source, 18, true, {
      id: "syn-url", revision: 2, delta: "://example.test",
    });
    expect(update.reset).toBe(true);
    expect(update.tailHtml).toBe(renderMarkdown(source, 0, 18));
  });

  it("normalizes CRLF split across append-only deltas", () => {
    const cache = createMarkdownStreamCache();
    const sample = "first\r\n\r\nsecond";
    let source = "";
    let stable = "";
    for (const scalar of sample) {
      source += scalar;
      const update = renderMarkdownStreamUpdate(cache, source, 0, true);
      stable += update.stableHtml;
      expect(stable + update.tailHtml, source).toBe(renderMarkdown(source));
    }
  });
});

describe("blockquotes", () => {
  it("renders a basic quote", () => {
    expect(renderMarkdown("> quoted")).toBe("<blockquote><p>quoted</p></blockquote>");
  });

  it("renders nested quotes", () => {
    expect(renderMarkdown("> > deep")).toBe(
      "<blockquote><blockquote><p>deep</p></blockquote></blockquote>",
    );
  });

  it("supports code blocks inside quotes", () => {
    const html = renderMarkdown("> look\n> ```rust\n> let x = 1;\n> ```");
    expect(html).toContain("<blockquote>");
    expect(html).toContain('<pre class="code-block" data-lang="rust">');
    expect(html).toContain('<code class="code-body">let x = 1;</code>');
    expect(html).toContain("</blockquote>");
  });

  it("supports tables inside quotes", () => {
    const html = norm(
      renderMarkdown("> | a | b |\n> | - | - |\n> | 1 | 2 |"),
    );
    expect(html).toContain("<blockquote><div class=\"table-wrap\"><table");
  });

  it("caps nesting depth and escapes beyond it", () => {
    const deep = `> ${"> ".repeat(9)}x`;
    const html = norm(renderMarkdown(deep));
    expect((html.match(/<blockquote>/g) ?? []).length).toBe(7);
    expect(html).toContain("<p>&gt; &gt; &gt; x</p>");
  });
});

describe("headings and rules", () => {
  it("renders h1 through h6", () => {
    const html = norm(renderMarkdown("# a\n## b\n### c\n#### d\n##### e\n###### f"));
    expect(html).toContain("<h1>a</h1>");
    expect(html).toContain("<h4>d</h4>");
    expect(html).toContain("<h6>f</h6>");
  });

  it("renders horizontal rules in all marker forms", () => {
    const html = renderMarkdown("---\n\n***\n\n___\n\n- - -");
    expect((html.match(/<hr>/g) ?? []).length).toBe(4);
  });

  it("does not turn ***text*** into a rule (bold+italic instead)", () => {
    const html = renderMarkdown("***bold***");
    expect(html).not.toContain("<hr>");
    expect(html).toContain("<em><strong>bold</strong></em>");
  });
});

describe("lists", () => {
  it("renders nested lists from indentation", () => {
    const html = norm(renderMarkdown("- a\n  - b\n    - c\n- d"));
    expect(html).toBe(
      "<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>",
    );
  });

  it("renders ordered lists with a start attribute", () => {
    const html = norm(renderMarkdown("3. x\n4. y"));
    expect(html).toBe('<ol start="3"><li>x</li><li>y</li></ol>');
  });

  it("switches list types across nesting levels", () => {
    const html = norm(renderMarkdown("- a\n  1. b\n- c"));
    expect(html).toContain("<ul><li>a<ol><li>b</li></ol></li><li>c</li></ul>");
  });

  it("renders task list items", () => {
    const html = norm(renderMarkdown("- [x] done\n- [ ] todo"));
    expect(html).toContain(
      '<li class="task"><input type="checkbox" disabled checked>done',
    );
    expect(html).toContain('<li class="task"><input type="checkbox" disabled>todo');
  });

  it("keeps 2024. out of lists when interrupting a paragraph", () => {
    const html = renderMarkdown("The year:\n2024. was busy\n\n1. but this is a list");
    expect(html).not.toContain("<li>was");
    expect(html).toContain("<li>but this is a list");
  });

  it("continues a list item on the next line (lazy continuation)", () => {
    const html = norm(renderMarkdown("- item\n  second line"));
    expect(html).toBe("<ul><li>item<br>second line</li></ul>");
  });

  it("ends the list at a blank line before a paragraph", () => {
    const html = norm(renderMarkdown("- item\n\nmore"));
    expect(html).toContain("</li></ul>");
    expect(html).toContain("<p>more</p>");
    expect(html).not.toContain("<li>more");
  });
});

describe("inline rendering", () => {
  it("renders strikethrough", () => {
    expect(renderMarkdown("~~gone~~")).toBe("<p><del>gone</del></p>");
  });

  it("autolinks bare URLs, keeping balanced parens", () => {
    const html = renderMarkdown("see https://x.com/a_(b) now");
    expect(html).toContain('<a href="https://x.com/a_(b)"');
    expect(html).toContain(">https://x.com/a_(b)</a>");
  });

  it("trims trailing punctuation from autolinks and keeps it visible", () => {
    const html = renderMarkdown("go to https://x.com/a. ok");
    expect(html).toContain('<a href="https://x.com/a"');
    expect(html).toContain(">https://x.com/a</a>. ok");
  });

  it("renders images as links, never as <img>", () => {
    const html = renderMarkdown("![alt](https://x.com/i.png)");
    expect(html).toContain('<a href="https://x.com/i.png"');
    expect(html).toContain(">alt</a>");
    expect(html).not.toContain("<img");
  });

  it("keeps emphasis out of code spans", () => {
    const html = renderMarkdown("`a**b` and `c**d`");
    expect(html).toContain("<code>a**b</code>");
    expect(html).toContain("<code>c**d</code>");
    expect(html).not.toContain("<strong>");
  });

  it("refuses non-http link schemes", () => {
    const html = renderMarkdown("[x](javascript:alert(1))");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain('href="javascript');
    expect(html).toContain("[x](javascript:alert(1))");
  });

  it("keeps the legacy inline syntax working", () => {
    expect(renderMarkdown("`code`")).toBe("<p><code>code</code></p>");
    expect(renderMarkdown("**bold** and *ital*")).toBe(
      "<p><strong>bold</strong> and <em>ital</em></p>",
    );
    expect(renderMarkdown("[t](https://x.com)")).toBe(
      '<p><a href="https://x.com" target="_blank" rel="noopener noreferrer">t</a></p>',
    );
  });
});

describe("paragraphs and misc", () => {
  it("renders single newlines as <br>", () => {
    expect(renderMarkdown("line1\nline2")).toBe("<p>line1<br>line2</p>");
  });

  it("separates paragraphs on blank lines and handles CRLF", () => {
    const html = renderMarkdown("line1\r\nline2\r\n\r\npara2");
    expect(html).toBe("<p>line1<br>line2</p>\n<p>para2</p>");
  });

  it("strips hard-break trailing spaces", () => {
    expect(renderMarkdown("line1  \nline2")).toBe("<p>line1<br>line2</p>");
  });

  it("escapes raw HTML in paragraphs", () => {
    expect(renderMarkdown("<script>alert(1)</script>")).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
  });

  it("keeps fenced blocks and the unclosed-fence behavior", () => {
    const fenced = renderMarkdown("```js\nconst x = 1;\n```");
    expect(fenced).toContain('<pre class="code-block" data-lang="js">');
    expect(fenced).toContain('<code class="code-body">const x = 1;</code>');
    const unclosed = renderMarkdown("```js\nconst x = 1;");
    expect(unclosed).toContain('<code class="code-body">const x = 1;</code>');
  });

  it("returns empty output for empty input", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown(undefined as unknown as string)).toBe("");
  });
});

describe("streaming fade tail", () => {
  function spanStyles(html: string): { opacity: number; blur: number }[] {
    return [
      ...html.matchAll(/class="fch" style="opacity:([\d.]+);filter:blur\(([\d.]+)px\)"/g),
    ].map((m) => ({ opacity: parseFloat(m[1]), blur: parseFloat(m[2]) }));
  }

  it("wraps the trailing N chars with graded opacity and blur", () => {
    const html = renderMarkdown("0123456789", 0, 4);
    expect(html).toContain("<p>012345");
    expect(html).toMatch(/<span class="fch"[^>]*>6<\/span>/);
    expect(html.endsWith("</span></p>")).toBe(true);
    const styles = spanStyles(html);
    expect(styles).toHaveLength(4);
    // DOM order is oldest → newest: opacity decreases, blur increases.
    for (let k = 1; k < styles.length; k++) {
      expect(styles[k - 1].opacity).toBeGreaterThan(styles[k].opacity);
      expect(styles[k - 1].blur).toBeLessThan(styles[k].blur);
    }
    expect(styles[0].opacity).toBeLessThan(1); // window edge not fully solid
    expect(styles[3].opacity).toBeGreaterThanOrEqual(0.15); // newest visible
    expect(styles[3].blur).toBeCloseTo(1.4); // newest most blurred
  });

  it("keeps entities whole while fading", () => {
    const html = renderMarkdown("a<b'c", 0, 3);
    expect(html).toContain("&#39;");
    expect((html.match(/<span class="fch"/g) ?? []).length).toBe(3);
  });

  it("fades inside closing tags of lists, code blocks and tables", () => {
    const list = renderMarkdown("- 一二三", 0, 2);
    expect(list).toContain('<span class="fch"');
    expect(norm(list).endsWith("</li></ul>")).toBe(true);

    const code = renderMarkdown("```\nabc\n```", 0, 2);
    expect(code).toContain('<span class="fch"');
    expect(norm(code).endsWith("</code></pre>")).toBe(true);

    const table = renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |", 0, 2);
    expect(table).toContain('<span class="fch"');
    expect(norm(table).endsWith("</tbody></table></div>")).toBe(true);
  });

  it("reaches into blockquotes via the outer pass", () => {
    const html = renderMarkdown("> 引用文字", 0, 2);
    expect(html).toContain('<span class="fch"');
    expect(norm(html).endsWith("</blockquote>")).toBe(true);
  });

  it("skips fade when there is no trailing text", () => {
    expect(renderMarkdown("---", 0, 3)).not.toContain("fch");
    expect(renderMarkdown("- [ ] ", 0, 3)).not.toContain("fch");
  });

  it("fadeTail=0 leaves output byte-identical", () => {
    const md = "段落 **bold** `code` [链接](https://x.com)";
    expect(renderMarkdown(md, 0, 0)).toBe(renderMarkdown(md));
  });
});
