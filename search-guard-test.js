// 搜索区域保护测试
//
// 守住 4.42.0 那个事故：`[class*="--ad"]` 会匹配 `search-panel--advance`
// 这类 class，把搜索下拉面板当广告隐藏。而 B 站复用同一 DOM 节点，
// inline 的 display:none !important 不会自己消失 ——
// 从此点搜索框什么都不出现。
//
// 这个测试用一个极简但真实的选择器引擎，直接验证两条：
//   1. 搜索面板不能被 cardIsAd 判成广告
//   2. 搜索面板必须被 isSearchArea 认出来，从而在 hideCard 里被拒绝
'use strict';

const fs = require('fs');
const vm = require('vm');

/* ---------------------- 极简选择器引擎 ----------------------
   支持本项目实际用到的语法，不追求完整实现：
     tag / .class / #id / [attr] / [attr="v"] / [attr*="v"]
   逗号分隔的并集。 */

function parseSimple(sel) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  let s = String(sel).trim();
  const tagM = s.match(/^([a-zA-Z][\w-]*)/);
  if (tagM) { out.tag = tagM[1].toLowerCase(); s = s.slice(tagM[0].length); }
  const re = /(?:#([\w-]+))|(?:\.([\w-]+))|(?:\[\s*([\w-]+)\s*(?:([*^$|~]?=)\s*"([^"]*)"\s*)?\])/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) out.id = m[1];
    else if (m[2]) out.classes.push(m[2]);
    else if (m[3]) out.attrs.push({ name: m[3], op: m[4] || null, val: m[5] ?? null });
  }
  return out;
}

function matchSimple(el, simple) {
  if (!el) return false;
  if (simple.tag && String(el.tagName || '').toLowerCase() !== simple.tag) return false;
  if (simple.id && el.id !== simple.id) return false;
  const cls = String(el.className || '');
  const tokens = cls.split(/\s+/).filter(Boolean);
  for (const c of simple.classes) if (!tokens.includes(c)) return false;
  for (const a of simple.attrs) {
    const v = el.getAttribute ? el.getAttribute(a.name) : null;
    if (v == null) return false;
    // 注意：parseSimple 捕获的是**完整操作符**（`*=` / `=` / `^=` …），
    // 不是去掉等号的半边。写成 `a.op === '*'` 会永远不成立，
    // 导致 `[class*="x"]` 退化成无条件真 —— 测试会假绿。
    if (a.op === '*=' && !String(v).includes(a.val)) return false;
    if (a.op === '=' && String(v) !== a.val) return false;
  }
  return true;
}

function matchSel(el, selector) {
  return String(selector).split(',').some((part) => {
    const p = part.trim();
    if (!p) return false;
    return matchSimple(el, parseSimple(p));
  });
}

/* ---------------------- DOM 桩 ---------------------- */

function makeEl(tag, cls, opts) {
  const o = opts || {};
  const el = {
    tagName: String(tag).toUpperCase(),
    className: cls || '',
    id: o.id || '',
    children: [],
    parentElement: null,
    dataset: {},
    _attrs: Object.assign({}, o.attrs || {}),
    _text: '',
    style: {
      _m: {},
      setProperty(k, v) { this._m[k] = v; },
      removeProperty(k) { delete this._m[k]; },
      get display() { return this._m.display; },
    },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    setAttribute(k, v) { this._attrs[k] = v; },
    // class 也是属性。不特殊处理的话，`[class*="--ad"]` 在桩里永远取到 null，
    // 而浏览器里它是真实属性 —— 桩与真实行为不一致，测试就假了。
    getAttribute(k) {
      if (k === 'class') return this.className || null;
      if (k === 'id') return this.id || null;
      return this._attrs[k] ?? null;
    },
    appendChild(c) { c.parentElement = this; this.children.push(c); return c; },
    addEventListener() {},
    closest(sel) {
      let cur = this;
      while (cur) { if (matchSel(cur, sel)) return cur; cur = cur.parentElement; }
      return null;
    },
    matches(sel) { return matchSel(this, sel); },
    querySelector(sel) {
      const all = this.querySelectorAll(sel);
      return all.length ? all[0] : null;
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => {
        for (const c of node.children) {
          if (matchSel(c, sel)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
  };
  return el;
}

/* ---------------------- 加载脚本 ---------------------- */

const src = fs.readFileSync(__dirname + '/bilibili-filter.user.js', 'utf8');
const sb = {};
sb.window = sb;
sb.console = console;
sb.document = {
  readyState: 'loading',
  body: makeEl('body'),
  addEventListener() {},
  querySelectorAll: () => [],
  createElement: (t) => makeEl(t),
};
sb.MutationObserver = class { observe() {} };
sb.Headers = class { delete() {} };
sb.Response = class {};
sb.localStorage = {
  _s: {},
  getItem(k) { return this._s[k] ?? null; },
  setItem(k, v) { this._s[k] = String(v); },
};
sb.getComputedStyle = () => ({ display: 'block', position: 'static' });
sb.setInterval = () => 0;

vm.createContext(sb);
vm.runInContext(src, sb);
const BLF = sb.window.__BLF;

/* ---------------------- 断言 ---------------------- */

let bad = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? ' PASS ' : ' FAIL '}${name.padEnd(52)} 期望 ${want}  实际 ${got}`);
}

/* ---- 场景一：B 站搜索下拉面板（事故现场） ----
   真实结构简化版：容器带 --advance 修饰类，
   里面有搜索输入框、若干搜索词，还有视频推荐（带 BV 链接）。 */
{
  const panel = makeEl('div', 'search-panel--advance');
  const input = makeEl('input', 'nav-search-input');
  panel.appendChild(input);
  const rec = makeEl('a', 'search-recommend', { attrs: { href: '/video/BV1xx411c7mD' } });
  panel.appendChild(rec);

  const r = BLF.adCheck(panel);
  check('搜索面板不被判成广告（--advance 不再咬 --ad）', r.isAd, false);
  check('搜索面板被 isSearchArea 认出', r.isSearchArea, true);
}

/* ---- 场景二：--advanced / --adjust / --admin 变体 ---- */
for (const cls of ['bili-header__search--advanced', 'nav-search--adjust', 'x--admin']) {
  const el = makeEl('div', cls);
  check(`class="${cls}" 不被判成广告`, BLF.adCheck(el).isAd, false);
}

/* ---- 场景三：真广告仍然要拦 ---- */
{
  const card = makeEl('div', 'bili-video-card');
  const inner = makeEl('div', 'bili-video-card__info--ad');
  card.appendChild(inner);
  check('真广告类 bili-video-card__info--ad 仍判为广告', BLF.adCheck(card).isAd, true);
}
{
  const card = makeEl('div', 'card--ad');
  check('card--ad 仍判为广告', BLF.adCheck(card).isAd, true);
}
{
  const card = makeEl('div', 'video-card', { attrs: { 'data-ad-id': '123' } });
  check('data-ad-id 仍判为广告', BLF.adCheck(card).isAd, true);
}
{
  const card = makeEl('div', 'video-card');
  const tag = makeEl('span', 'ad-tag');
  tag.textContent = '广告';
  card.appendChild(tag);
  check('ad-tag 角标文字仍判为广告', BLF.adCheck(card).isAd, true);
}

/* ---- 场景四：普通视频卡不应被判成广告或被当成搜索区 ---- */
{
  const card = makeEl('div', 'bili-video-card');
  const title = makeEl('h3');
  title.textContent = '高等数学 第十二讲';
  card.appendChild(title);
  const r = BLF.adCheck(card);
  check('普通视频卡不是广告', r.isAd, false);
  check('普通视频卡不是搜索区', r.isSearchArea, false);
}

/* ---- 场景五：repairSearchArea 能恢复旧版本留下的隐藏 ---- */
{
  const panel = makeEl('div', 'search-panel');
  const input = makeEl('input', 'nav-search-input');
  panel.appendChild(input);
  panel.dataset.blfHidden = '1';
  panel.style.setProperty('display', 'none');

  sb.document.querySelectorAll = (sel) => {
    if (String(sel).includes('data-blf-hidden')) return panel.dataset.blfHidden ? [panel] : [];
    return [];
  };
  const n = BLF.repairSearch();
  check('repairSearch 恢复了被误隐藏的面板', n, 1);
  check('恢复后 display 已被移除', panel.style.display, undefined);
  check('恢复后 blfHidden 标记已清除', panel.dataset.blfHidden, undefined);
}

console.log(`\n${bad === 0 ? '全部通过' : `失败 ${bad} 项`}`);
process.exit(bad === 0 ? 0 : 1);
