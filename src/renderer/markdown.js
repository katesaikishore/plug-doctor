'use strict';

/**
 * A deliberately tiny Markdown renderer for assistant replies that builds
 * DOM nodes directly, so nothing the model writes is ever parsed as HTML.
 * Supports paragraphs, headings, bullet/numbered lists, fenced code,
 * inline code, **bold**, *italic* and https links.
 */
(function () {
  function inline(text, parent, openExternal) {
    const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\(https:\/\/[^)\s]+\))|(https:\/\/[^\s)]+)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      const tok = m[0];
      let node;
      if (m[1]) {
        node = document.createElement('code');
        node.textContent = tok.slice(1, -1);
      } else if (m[2]) {
        node = document.createElement('strong');
        node.textContent = tok.slice(2, -2);
      } else if (m[3]) {
        node = document.createElement('em');
        node.textContent = tok.slice(1, -1);
      } else {
        const [, label, href] = m[4] ? tok.match(/^\[([^\]]+)\]\((.+)\)$/) : [null, tok, tok];
        node = document.createElement('a');
        node.textContent = label;
        node.href = '#';
        node.title = href;
        node.addEventListener('click', (e) => {
          e.preventDefault();
          openExternal(href);
        });
      }
      parent.append(node);
      last = m.index + tok.length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  function render(md, openExternal) {
    const root = document.createElement('div');
    root.className = 'md';
    const lines = String(md).replace(/\r/g, '').split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        code.textContent = buf.join('\n');
        pre.append(code);
        root.append(pre);
        continue;
      }
      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        const h = document.createElement(`h${Math.min(6, heading[1].length + 2)}`);
        inline(heading[2], h, openExternal);
        root.append(h);
        i++;
        continue;
      }
      if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d/.test(line);
        const list = document.createElement(ordered ? 'ol' : 'ul');
        while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i])) {
          const li = document.createElement('li');
          inline(lines[i].replace(/^\s*([-*]|\d+[.)])\s+/, ''), li, openExternal);
          list.append(li);
          i++;
        }
        root.append(list);
        continue;
      }
      if (!line.trim()) {
        i++;
        continue;
      }
      const p = document.createElement('p');
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+[.)])\s+)/.test(lines[i])) buf.push(lines[i++]);
      inline(buf.join(' '), p, openExternal);
      root.append(p);
    }
    return root;
  }

  window.renderMarkdown = render;
})();
