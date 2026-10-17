import { describe, expect, it } from "vitest";
import { renderedBlockEstimate, splitRenderedBlocks } from "../src/lib/html-blocks";
import { renderMarkdown } from "../src/lib/markdown";

describe("trusted rendered block splitting", () => {
  it("preserves the complete renderer oracle for nested, escaped, code and table blocks", () => {
    const source = '## 标题\n\n中 & <tag> **粗体** [链接](https://example.com/?x=1&y=2)\n\n'
      + '> 引用\n>\n> - 嵌套 **列表**\n> - 二\n\n- [x] 完成\n- [ ] 等待\n\n'
      + '---\n\n| 名 | 值 |\n| --- | --- |\n| a | `b` |\n\n```html\n<div> & </div>\n```\n';
    const html = renderMarkdown(source);
    const blocks = splitRenderedBlocks(html);
    expect(blocks).not.toBeNull();
    expect(blocks!.length).toBeGreaterThan(5);
    expect(blocks!.join("\n")).toBe(html);
    expect(blocks!.some(block => block.startsWith("<blockquote"))).toBe(true);
    expect(blocks!.some(block => renderedBlockEstimate(block).kind === "bounded")).toBe(true);
  });

  it("does not split void or SVG tags and rejects malformed or raw text fragments", () => {
    const blocks = ['<p>a<br>b<input disabled></p>', '<hr/>', '<div><svg><path d="x"/></svg></div>'];
    expect(splitRenderedBlocks(blocks.join("\n"))).toEqual(blocks);
    for (const html of ['<div><p>x</div>', '<p>x', 'raw<p>x</p>', '<p>x</p>raw', '<!--x--><p>x</p>']) {
      expect(splitRenderedBlocks(html)).toBeNull();
    }
    expect(splitRenderedBlocks("\n")).toEqual([]);
    expect(renderedBlockEstimate('<p>A &amp; &lt;x&gt; 中</p>').textLength).toBe('A & <x> 中'.length);
  });
});
