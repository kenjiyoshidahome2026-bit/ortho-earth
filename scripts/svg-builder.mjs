// SVG element builder for Node.js — no DOM required

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class Elem {
  constructor(tag, a = {}, text = null) {
    this.tag = tag;
    this.a = a;
    this._text = text;
    this.children = [];
  }
  elem(tag, a = {}, text = null) {
    const c = new Elem(tag, a, text);
    this.children.push(c);
    return c;
  }
  get outerHTML() {
    const as = Object.entries(this.a)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${k}="${esc(String(v))}"`)
      .join(' ');
    const inner = this.children.map(c => c.outerHTML).join('') +
      (this._text != null ? esc(String(this._text)) : '');
    return `<${this.tag}${as ? ' ' + as : ''}>${inner}</${this.tag}>`;
  }
}

export const d3 = {
  sum:   a => a.reduce((s, v) => s + (v || 0), 0),
  max:   a => Math.max(0, ...a.map(v => v || 0)),
  comma: n => Number(n).toLocaleString(),
  SVG([x, y, w, h], extra = {}) {
    return new Elem('svg', { viewBox: `${x} ${y} ${w} ${h}`, xmlns: 'http://www.w3.org/2000/svg', ...extra });
  },
};
