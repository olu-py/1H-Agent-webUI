// Minimal, dependency-free Markdown renderer. Safe by construction: no raw
// HTML passes through; all user content is escaped before inline processing.
// This keeps the single-binary charter (no npm, no external renderer).

const ESCAPE = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ESCAPE[ch] || ch);
}

// Block regexes (applied line-wise on top of fenced spans).
function renderInline(text) {
  let out = escapeHtml(text);
  // code spans first
  out = out.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  // bold
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // inline code handled above; italics
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // links [text](url) - only http/https/javascript-less
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return out;
}

function isFenceLine(line) {
  return /^```/.test(line.trim());
}

function renderFenced(lines) {
  // Split into fenced blocks and normal lines.
  const html = [];
  let i = 0;
  let inFence = false;
  let fenceLang = '';
  let codeBuf = [];
  while (i < lines.length) {
    const line = lines[i];
    if (isFenceLine(line)) {
      if (!inFence) {
        inFence = true;
        fenceLang = line.trim().slice(3).trim();
        codeBuf = [];
      } else {
        const lang = fenceLang ? ` class="language-${escapeHtml(fenceLang)}"` : '';
        html.push(`<pre${lang}><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
        inFence = false;
      }
    } else if (inFence) {
      codeBuf.push(line);
    } else {
      html.push(line);
    }
    i += 1;
  }
  if (inFence) {
    html.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
  }
  return html;
}

export function renderMarkdown(text) {
  const raw = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks = renderFenced(raw);
  const html = [];
  let list = null; // 'ul' | 'ol' | null
  let para = [];

  const flushPara = () => {
    if (para.length) {
      html.push(`<p>${renderInline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      html.push(`</${list}>`);
      list = null;
    }
  };

  for (const block of blocks) {
    if (block.startsWith('<pre')) {
      flushPara();
      flushList();
      html.push(block);
      continue;
    }
    const trimmed = block.trim();
    if (!trimmed) {
      flushPara();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushPara();
      flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    const ulItem = /^\s*[-*+]\s+(.*)$/.exec(trimmed);
    if (ulItem) {
      flushPara();
      if (list !== 'ul') { flushList(); html.push('<ul>'); list = 'ul'; }
      html.push(`<li>${renderInline(ulItem[1])}</li>`);
      continue;
    }
    const olItem = /^\s*\d+[.)]\s+(.*)$/.exec(trimmed);
    if (olItem) {
      flushPara();
      if (list !== 'ol') { flushList(); html.push('<ol>'); list = 'ol'; }
      html.push(`<li>${renderInline(olItem[1])}</li>`);
      continue;
    }
    if (list) {
      flushList();
    }
    para.push(block);
  }
  flushPara();
  flushList();
  return html.join('\n');
}
