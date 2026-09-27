'use strict';

(function () {
  const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
  const xml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const children = (node) => Array.from(node && node.children || []);
  const wrap = (name, body) => '<m:' + name + '>' + (body || '') + '</m:' + name + '>';
  const run = (text, italic) => '<m:r>' + (italic ? '<m:rPr><m:sty m:val="p"/></m:rPr>' : '') + '<m:t>' + xml(text) + '</m:t></m:r>';
  const content = (node) => convertChildren(node).join('');
  const transparent = new Set(['math', 'semantics', 'mrow', 'mstyle', 'mpadded', 'menclose']);
  const nary = new Set(['∑', '∏', '∫', '∬', '∭', '∮', '⋃', '⋂']);

  function naryChar(node) {
    if (!node) return '';
    if (node.localName === 'mo') return node.textContent.trim();
    if (transparent.has(node.localName)) return naryChar(children(node).find((x) => x.localName !== 'annotation' && x.localName !== 'annotation-xml'));
    return '';
  }

  function convertChildren(node) {
    return Array.from(node && node.childNodes || []).map(convertNode).flat().filter(Boolean);
  }

  function convertNode(node) {
    if (!node) return '';
    if (node.nodeType === 3) return node.textContent.trim() ? run(node.textContent.trim(), false) : '';
    if (node.nodeType !== 1 || node.localName === 'annotation' || node.localName === 'annotation-xml') return '';
    const tag = node.localName;
    if (transparent.has(tag)) return content(node);
    if (tag === 'mi') return run(node.textContent, !['normal', 'bold'].includes(node.getAttribute('mathvariant') || ''));
    if (tag === 'mn' || tag === 'mo' || tag === 'mtext' || tag === 'ms') return run(node.textContent.replace(/[\u2061-\u2064]/g, ''), false);
    if (tag === 'mspace') return run(' ', false);
    if (tag === 'mfrac') {
      const p = children(node);
      return '<m:f><m:fPr><m:type m:val="bar"/></m:fPr>' + wrap('num', content(p[0])) + wrap('den', content(p[1])) + '</m:f>';
    }
    if (tag === 'msup' || tag === 'msub' || tag === 'msubsup') return script(node, tag);
    if (tag === 'msqrt' || tag === 'mroot') {
      const p = children(node);
      return '<m:rad><m:radPr><m:degHide m:val="' + (tag === 'mroot' ? '0' : '1') + '"/></m:radPr>' + wrap('deg', tag === 'mroot' ? content(p[1]) : '') + wrap('e', content(p[0])) + '</m:rad>';
    }
    if (tag === 'mtable') return matrix(node, '', '');
    if (tag === 'mfenced') return fenced(node);
    if (tag === 'mover' || tag === 'munder' || tag === 'munderover') return limit(node, tag);
    return content(node);
  }

  function script(node, tag) {
    const p = children(node);
    if (tag === 'msup') return '<m:sSup><m:sSupPr/><m:e>' + content(p[0]) + '</m:e><m:sup>' + content(p[1]) + '</m:sup></m:sSup>';
    if (tag === 'msub') return '<m:sSub><m:sSubPr/><m:e>' + content(p[0]) + '</m:e><m:sub>' + content(p[1]) + '</m:sub></m:sSub>';
    return '<m:sSubSup><m:sSubSupPr/><m:e>' + content(p[0]) + '</m:e><m:sub>' + content(p[1]) + '</m:sub><m:sup>' + content(p[2]) + '</m:sup></m:sSubSup>';
  }

  function fenced(node) {
    const p = children(node), sep = node.getAttribute('separators') || '';
    return run(node.getAttribute('open') || '(', false) + p.map((x, i) => content(x) + (i < p.length - 1 ? run(sep[i] || sep[sep.length - 1] || ',', false) : '')).join('') + run(node.getAttribute('close') || ')', false);
  }

  function matrix(node, open, close) {
    const rows = children(node).filter((x) => x.localName === 'mtr' || x.localName === 'mlabeledtr');
    const count = Math.max(1, ...rows.map((r) => children(r).filter((x) => x.localName === 'mtd').length));
    const body = rows.map((row) => {
      const cells = children(row).filter((x) => x.localName === 'mtd');
      return '<m:mr>' + cells.map((cell) => wrap('e', content(cell))).join('') + Array.from({ length: count - cells.length }, () => wrap('e', '')).join('') + '</m:mr>';
    }).join('');
    return '<m:m><m:mPr><m:mcs><m:mc><m:mcPr><m:count m:val="' + count + '"/></m:mcPr></m:mc></m:mcs>' + (open || close ? '<m:begChr m:val="' + xml(open) + '"/><m:endChr m:val="' + xml(close) + '"/>' : '') + '</m:mPr>' + body + '</m:m>';
  }

  function limit(node, tag) {
    const p = children(node), op = naryChar(p[0]);
    if (nary.has(op)) {
      const sub = tag === 'mover' ? '' : content(p[1]);
      const sup = tag === 'munder' ? '' : content(p[tag === 'munderover' ? 2 : 1]);
      return '<m:nary><m:naryPr><m:chr m:val="' + xml(op) + '"/><m:limLoc m:val="undOvr"/></m:naryPr><m:sub>' + sub + '</m:sub><m:sup>' + sup + '</m:sup><m:e>' + content(p[0]) + '</m:e></m:nary>';
    }
    if (tag === 'mover' && node.getAttribute('accent') === 'true') return '<m:acc><m:accPr><m:chr m:val="' + xml((p[1] && p[1].textContent) || '¯') + '"/></m:accPr><m:e>' + content(p[0]) + '</m:e></m:acc>';
    if (tag === 'mover') return '<m:limUpp><m:e>' + content(p[0]) + '</m:e><m:lim>' + content(p[1]) + '</m:lim></m:limUpp>';
    if (tag === 'munder') return '<m:limLow><m:e>' + content(p[0]) + '</m:e><m:lim>' + content(p[1]) + '</m:lim></m:limLow>';
    return '<m:limUpp><m:e><m:limLow><m:e>' + content(p[0]) + '</m:e><m:lim>' + content(p[1]) + '</m:lim></m:limLow></m:e><m:lim>' + content(p[2]) + '</m:lim></m:limUpp>';
  }

  function officeHtml(math) {
    const clone = math.cloneNode(true);
    clone.querySelectorAll('annotation, annotation-xml').forEach((x) => x.remove());
    clone.setAttribute('xmlns', 'http://www.w3.org/1998/Math/MathML');
    const mathml = new XMLSerializer().serializeToString(clone);
    return '<html><head><meta charset="utf-8"></head><body><!--StartFragment-->' + mathml + '<!--EndFragment--></body></html>';
  }

  function mathmlText(math) {
    const clone = math.cloneNode(true);
    clone.querySelectorAll('annotation, annotation-xml').forEach((x) => x.remove());
    clone.setAttribute('xmlns', 'http://www.w3.org/1998/Math/MathML');
    return new XMLSerializer().serializeToString(clone);
  }

  function plainText(math) { return math.querySelector('annotation')?.textContent || math.textContent || ''; }

  async function browserCopy(html, plain) {
    if (navigator.clipboard && window.ClipboardItem && window.isSecureContext !== false) {
      try { await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([plain], { type: 'text/plain' }) })]); return true; } catch (e) {}
    }
    const onCopy = (e) => { e.preventDefault(); e.clipboardData.setData('text/html', html); e.clipboardData.setData('text/plain', plain); };
    document.addEventListener('copy', onCopy, true);
    const holder = document.createElement('textarea'); holder.value = plain || ' '; holder.style.cssText = 'position:fixed;left:-9999px;top:0'; document.body.appendChild(holder); holder.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
    document.removeEventListener('copy', onCopy, true); holder.remove(); return ok;
  }

  async function copy(button, math) {
    const html = officeHtml(math);
    const plain = plainText(math);
    const ok = await browserCopy(html, plain);
    if (ok) { button.classList.add('copied'); setTimeout(() => button.classList.remove('copied'), 1400); if (window.toast) window.toast('已复制 MathML，可粘贴到 Word'); }
    else if (window.toast) window.toast('复制失败，请重试', true);
    return ok;
  }

  window.OCOfficeFormula = { copy, officeHtml };
})();
