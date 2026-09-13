import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/lib/markdown";

/** The renderer joins block tags with newlines; strip them for assertions. */
function norm(html: string): string {
  return html.replace(/\n/g, "");
}

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
