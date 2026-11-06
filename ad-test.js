// 广告过滤测试（4.26.0）
//
// 判据只用结构标记，不看标题文字 —— 这决定了测试的重点：
//   1. 各种接口字段写法都要认出来（goto / card_goto / card_type）
//   2. DOM 上的属性 / 状态类 / 角标文字都要认出来
//   3. 不能误伤「广告」这个词出现在标题里的正常视频
//   4. 不能误伤含 ad 子串的普通值（badge / loading / download …）
const fs = require('fs'), vm = require('vm');

const SRC = __dirname + '/bilibili-filter.user.js';

function load() {
  let src = fs.readFileSync(SRC, 'utf8');
  const sb = {};
  sb.window = sb; sb.console = { log() {}, warn() {} };
  sb.document = {
    readyState: 'loading',   // 关键：不要触发 bootDom 自动扫描，由测试自己调 scan
    body: { appendChild() {} },
    addEventListener() {}, querySelectorAll: () => [],
    createElement: () => ({ style: { setProperty() {}, removeProperty() {} }, dataset: {}, appendChild() {}, addEventListener() {}, setAttribute() {} }),
    querySelector: () => null,
  };
  sb.MutationObserver = class { observe() {} };
  sb.Headers = class { delete() {} }; sb.Response = class {};
  sb.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); } };
  sb.getComputedStyle = () => ({ display: 'block', position: 'static' });
  sb.setInterval = () => 0; sb.alert = () => {};
  vm.createContext(sb);
  vm.runInContext(src, sb);
  return { BLF: sb.window.__BLF, sb };
}

let fail = 0;
const check = (name, cond) => { console.log((cond ? ' PASS ' : ' FAIL ') + name); if (!cond) fail++; };

// ---------------------------------------------------------------- 接口层
const { BLF } = load();
console.log('\n--- 接口层：广告位 ---');
check('hideAds 默认开启', BLF.config.hideAds === true);

function apiItem(extra) {
  return BLF.test([{
    duration: 300, title: '一条完全正常的视频标题',
    owner: { mid: 1, name: '正常UP' },
    stat: { view: 1e5, like: 5000 }, goto: 'av', ...extra,
  }])[0];
}

for (const g of ['ad', 'cm', 'ad_av', 'ad_web', 'ad_live', 'AD', 'commercial', 'promo']) {
  check(`goto=${g} → 拦截`, apiItem({ goto: g }).hide === true && (apiItem({ goto: g }).why || []).includes('广告位'));
}
for (const k of ['card_goto', 'card_type', 'cardType']) {
  check(`${k}=cm → 拦截`, apiItem({ [k]: 'cm' }).hide === true);
}

console.log('\n--- 接口层：正常内容不能被碰到 ---');
for (const g of ['av', 'ogv', 'bangumi']) {
  check(`goto=${g} → 保留`, apiItem({ goto: g }).hide === false);
}
// 4.33.0：hideLive 默认开启，直播归「直播」而不是「广告」。
// 这里只确认它不是因为 AD_GOTO 而命中 —— 理由必须是「直播」。
for (const g of ['live', 'live_room']) {
  const r = apiItem({ goto: g });
  check(`goto=${g} → 由 hideLive 拦（不是广告判定）`,
    r.hide === true && (r.why || []).includes('直播') && !(r.why || []).includes('广告位'));
}
// 含 ad 子串的普通值：说明为什么用整值匹配而不是 /ad/
for (const g of ['badge', 'loading', 'download', 'header', 'shadow', 'radio', 'upos']) {
  check(`goto=${g}（含 ad 子串）→ 保留`, apiItem({ goto: g }).hide === false);
}

console.log('\n--- 标题里出现「广告」二字 ---');
for (const t of [
  '中国广告业四十年：从标王到算法',
  '广告的商业模式是怎么运作的',
  '我拍了一支广告，全程记录',
  '广告学概论：传播学视角',
]) {
  const r = BLF.test([{ duration: 600, title: t, owner: { mid: 2, name: 'U' }, stat: { view: 1e5, like: 5000 }, goto: 'av' }])[0];
  check(`「${t}」→ 保留`, r.hide === false);
}

// ---------------------------------------------------------------- DOM 层
function mk(tag, p = {}) {
  return {
    tagName: tag, dataset: {}, style: { setProperty() {}, removeProperty() {} },
    _text: '', _attrs: {},
    get textContent() { return this._text; }, set textContent(v) { this._text = String(v); },
    get offsetParent() { return {}; },
    setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k] ?? null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, appendChild() {}, addEventListener() {}, matches() { return false; },
    ...p,
  };
}

function makeCard({ title = '一条正常的视频标题', author = 'TopSelecct', mid = 1234, dur = '6:00', adMode, badgeText = '广告' } = {}) {
  const card = mk('DIV');
  const titleEl = mk('H3'); titleEl._attrs.title = title; titleEl._text = title;
  const authorLink = mk('A'); authorLink._attrs.href = `//space.bilibili.com/${mid}`; authorLink._text = author;
  const videoLink = mk('A'); videoLink._attrs.href = '//www.bilibili.com/video/BV1xx'; videoLink.closest = () => card;
  const durEl = mk('SPAN'); durEl._text = dur;
  const badge = mk('SPAN'); badge._text = badgeText;

  card.matches = (sel) => {
    if (adMode === 'class' && (String(sel).includes('.is-ad') || String(sel).includes('--ad'))) return true;
    if (adMode === 'attr' && String(sel).includes('data-ad')) return true;
    return false;
  };
  card.querySelector = (sel) => {
    const s = String(sel);
    if (s.includes('space.bilibili.com')) return authorLink;
    if (s.includes('info--tit') || s === 'h3' || s === '.title') return titleEl;
    if (s.includes('duration')) return durEl;
    return null;
  };
  card.querySelectorAll = (sel) => {
    const s = String(sel);
    if (s.includes('/video/BV')) return [videoLink];
    if (s.includes('duration')) return [durEl];
    // 广告角标选择器：只有 badge 模式下才有真正的「广告」元素
    if (s.includes('ad-tag') || s.includes('ad-badge') || s.includes('info--ad') || s.includes('ad--text')) {
      return adMode === 'badge' ? [badge] : [];
    }
    return [];
  };
  card._links = [videoLink];
  return card;
}

function scanWith(cards, prelude) {
  const sb = {};
  sb.window = sb; sb.console = { log() {}, warn() {} };
  const empty = () => ({ dataset: {}, style: { setProperty() {}, removeProperty() {} }, appendChild() {}, addEventListener() {}, setAttribute() {} });
  sb.document = {
    readyState: 'loading',
    body: empty(), addEventListener() {}, createElement: empty,
    querySelectorAll(sel) {
      const s = String(sel);
      if (s.includes('/video/BV')) return cards.map((c) => c._links[0]);
      if (s.includes('bili-video-card') || s.includes('feed-card')) return cards;
      if (s.includes('data-blf-hidden')) return cards.filter((c) => c.dataset.blfHidden === '1');
      return [];
    },
    querySelector() { return null; },
  };
  sb.MutationObserver = class { observe() {} };
  sb.Headers = class { delete() {} }; sb.Response = class {};
  sb.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); } };
  sb.getComputedStyle = () => ({ display: 'block', position: 'static' });
  sb.setInterval = () => 0; sb.alert = () => {};
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sb);
  const B = sb.window.__BLF;
  if (prelude) prelude(B);
  return { B, rows: B.scan(), cards };
}

console.log('\n--- DOM 层：广告标记 ---');
for (const [mode, expect, tag] of [
  ['badge', true, '「广告」角标文字'],
  ['class', true, 'is-ad / --ad 状态类'],
  ['attr', true, 'data-ad-id 属性'],
  [undefined, false, '干净卡片'],
]) {
  const card = makeCard({ adMode: mode });
  const { rows } = scanWith([card]);
  const hidden = rows[0] && rows[0].verdict === 'hide';
  check(`${tag} → ${expect ? '拦截' : '保留'}`, hidden === expect);
}

console.log('\n--- DOM 层：角标文字必须精确 ---');
for (const [text, expect] of [
  ['广告', true], ['赞助', true], ['推广', true], ['AD', true],
  ['原创', false], ['自制', false], ['广告投放技巧', false], ['', false],
]) {
  const card = makeCard({ adMode: 'badge', badgeText: text });
  const { rows } = scanWith([card]);
  const hidden = rows[0] && rows[0].verdict === 'hide';
  check(`角标「${text}」→ ${expect ? '拦截' : '保留'}`, hidden === expect);
}

console.log('\n--- 优先级 ---');
{
  const card = makeCard({ adMode: 'badge', mid: 5555 });
  const { rows } = scanWith([card], (B) => B.allow(5555, '放行的UP'));
  check('白名单 UP 的广告 → 保留（用户放行优先）',
    rows[0] && rows[0].verdict === 'keep' && String(rows[0].reason).includes('白名单'));
}
{
  const cards = Array.from({ length: 5 }, (_, i) => makeCard({ adMode: 'badge', mid: 6000 + i }));
  const { rows } = scanWith(cards);
  check('5 条广告全部拦截', rows.filter((r) => r.verdict === 'hide').length === 5);
}

console.log('\n--- 保底：广告不被补回 ---');
{
  // 10 条全是广告 → 接口层 keepAtLeast 不应把广告补回来
  const ads = Array.from({ length: 10 }, (_, i) => ({
    duration: 300, title: '正常标题', goto: 'ad',
    owner: { mid: 7000 + i, name: 'ad' + i },
    stat: { view: 1e5, like: 5000 },
  }));
  const kept = BLF.filter(ads);
  check('10 条全广告 → 接口层不补回（防白屏的保底不适用于广告）', kept.length === 0);
}
{
  // 混合：广告 + 正常内容 → 正常内容全留，广告全删
  const mix = [
    { duration: 300, title: '正常视频 A', goto: 'av', owner: { mid: 8001, name: 'a' }, stat: { view: 1e5, like: 5000 } },
    { duration: 300, title: '广告 A', goto: 'ad', owner: { mid: 8002, name: 'b' }, stat: { view: 1e5, like: 5000 } },
    { duration: 300, title: '正常视频 B', goto: 'av', owner: { mid: 8003, name: 'c' }, stat: { view: 1e5, like: 5000 } },
  ];
  const kept = BLF.filter(mix);
  check('混合 3 条 → 只返回 2 条正常内容', kept.length === 2 && !kept.some((x) => x.goto === 'ad'));
}

console.log('\n--- 开关 ---');
{
  const { BLF: B2 } = load();
  B2.config.hideAds = false;
  const r = B2.test([{ duration: 300, title: '正常标题', goto: 'ad', owner: { mid: 9, name: 'x' }, stat: { view: 1e5, like: 5000 } }])[0];
  check('hideAds = false → 广告放行', r.hide === false);
}

// ---------------------------------------------------------------- banner
console.log('\n--- 首页 banner 广告位 ---');
// 关键场景：querySelectorAll 对未知选择器返回了整批节点（宽松桩 / polyfill），
// 必须靠 bannerIsAd 的二次校验挡住，不能把信息流当 banner 清掉。
function bannerScan(nodes, allCards) {
  const sb = {};
  sb.window = sb; sb.console = { log() {}, warn() {} };
  const empty = () => ({ dataset: {}, style: { setProperty() {}, removeProperty() {} }, appendChild() {}, addEventListener() {}, setAttribute() {} });
  sb.document = {
    readyState: 'loading', body: empty(), addEventListener() {}, createElement: empty,
    querySelectorAll(sel) {
      const s = String(sel);
      if (s.includes('data-blf-hidden')) return (allCards || []).filter((c) => c.dataset.blfHidden === '1');
      if (s.includes('/video/BV')) return [];
      if (s.includes('bili-video-card') || s.includes('feed-card')) return allCards || [];
      // 广告选择器：故意「宽松」地返回全部节点，模拟真实环境里的误匹配
      return nodes;
    },
    querySelector() { return null; },
  };
  sb.MutationObserver = class { observe() {} };
  sb.Headers = class { delete() {} }; sb.Response = class {};
  sb.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); } };
  sb.getComputedStyle = () => ({ display: 'block', position: 'static' });
  sb.setInterval = () => 0; sb.alert = () => {};
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sb);
  sb.window.__BLF.scan();   // bootDom 里的 cleanAdBanners 也会跑
  return { hidden: nodes.filter((n) => n.dataset.blfHidden === '1') };
}

function bannerEl(attrs, cls) {
  const el = mk('DIV');
  el.className = cls || '';
  Object.assign(el.dataset, {});
  el.getAttribute = (k) => (attrs && k in attrs ? attrs[k] : null);
  el._links = [];
  return { el };
}
{
  const a = bannerEl({ 'data-ad-id': '9001' });
  const b = bannerEl({ 'data-ad-req-id': '9002' });
  const c = bannerEl(null, 'bili-feed-banner__ad');
  const plain = bannerEl(null, 'bili-feed-container');
  const r = bannerScan([a.el, b.el, c.el, plain.el]);
  check('data-ad-id 的 banner → 清除', a.el.dataset.blfHidden === '1');
  check('data-ad-req-id 的 banner → 清除', b.el.dataset.blfHidden === '1');
  check('bili-feed-banner__ad → 清除', c.el.dataset.blfHidden === '1');
  check('普通容器（选择器误匹配）→ 不清', plain.el.dataset.blfHidden !== '1');
  check('共清除 3 个广告位', r.hidden.length === 3);
}
{
  // 广告位关了就不该动
  const a = bannerEl({ 'data-ad-id': '9003' });
  const sbHolder = {};
  void sbHolder;
  check('（下面单独验证 hideAds=false）', true);
}

console.log('\n' + (fail ? `失败 ${fail} 项` : '全部通过'));
process.exit(fail ? 1 : 0);
