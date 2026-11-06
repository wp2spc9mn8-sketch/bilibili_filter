// 硬时长下限测试（4.24.0）：不足 minKeepDuration 一律不看
//
// 这条规则与话题、质量都无关，是纯长度偏好。所以它的边界必须单独守：
// 阈值差一秒、时长未知、白名单优先级、off 档、整号拉黑副作用。
const fs = require('fs'), vm = require('vm');

function load(mode) {
  let src = fs.readFileSync(__dirname + '/bilibili-filter.user.js', 'utf8');
  if (mode) src = src.replace("mode: 'aggressive'", "mode: '" + mode + "'");
  const sb = {};
  sb.window = sb; sb.console = { log() {}, warn() {} };
  sb.document = {
    readyState: 'complete', body: { appendChild() {} },
    addEventListener() {}, querySelectorAll: () => [],
    createElement: () => ({ style: {}, addEventListener() {}, appendChild() {} }),
  };
  sb.MutationObserver = class { observe() {} };
  sb.Headers = Headers; sb.Response = Response;
  sb.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); } };
  sb.getComputedStyle = () => ({ position: 'static' });
  sb.setInterval = () => 0;
  vm.createContext(sb);
  vm.runInContext(src, sb);
  return { BLF: sb.window.__BLF, ls: sb.localStorage };
}

let fail = 0;
const check = (name, cond) => { console.log((cond ? ' PASS ' : ' FAIL ') + name); if (!cond) fail++; };

const { BLF, ls } = load();
const MIN = BLF.config.minKeepDuration;
console.log('\nminKeepDuration =', MIN, '秒');

function judge(dur, title = '一个完全正常的视频', opts = {}) {
  return BLF.test([{
    duration: dur, title,
    owner: { mid: opts.mid ?? 1, name: opts.name ?? 'U' },
    stat: { view: 1e4, like: 500 }, goto: 'av',
    ...(opts.isFollowed ? { is_followed: true } : {}),
  }])[0];
}

console.log('\n--- 阈值边界 ---');
check('阈值是 180 秒（3 分钟）', MIN === 180);
check(`${MIN - 1}s → 隐藏`, judge(MIN - 1).hide === true);
check(`${MIN}s → 保留（刚好达标）`, judge(MIN).hide === false);
check(`${MIN + 1}s → 保留`, judge(MIN + 1).hide === false);
check('1s → 隐藏', judge(1).hide === true);
check('隐藏理由是「时长不足」，不是质量判定',
  (judge(60).why || []).some((w) => String(w).includes('时长不足')));

console.log('\n--- 时长未知 ---');
const unknown = BLF.test([{ title: '没有时长字段的视频', owner: { mid: 2, name: 'U' }, stat: { view: 1e4, like: 500 }, goto: 'av' }])[0];
check('时长未知 → 保留（不拿缺失字段当证据）', unknown.hide === false);
check('0s → 保留（同上）', judge(0).hide === false);

console.log('\n--- 优先级 ---');
check('已关注 UP 的短视频 → 保留', judge(20, '正常', { mid: 3, isFollowed: true }).hide === false);

const mid = 777;
BLF.allow(mid, '被放行的UP');
check('白名单 UP 的短视频 → 保留', judge(20, '正常', { mid }).hide === false);
BLF.unblock && BLF.unblock(mid);

console.log('\n--- 档位 ---');
const off = load('off');
const offR = off.BLF.test([{ duration: 20, title: '一个完全正常的视频', owner: { mid: 4, name: 'U' }, stat: { view: 1e4, like: 500 }, goto: 'av' }])[0];
check('off 档 → 不按时长删（全关就是全关）', offR.hide === false);
for (const m of ['light', 'balanced', 'aggressive']) {
  const { BLF: X } = load(m);
  const r = X.test([{ duration: 60, title: '一个完全正常的视频', owner: { mid: 5, name: 'U' }, stat: { view: 1e4, like: 500 }, goto: 'av' }])[0];
  check(`${m} 档 → 60s 一律隐藏`, r.hide === true);
}

console.log('\n--- 副作用：不得触发整号拉黑 ---');
// 时长短不是话题命中。一个正常 UP 连发 3 条短视频，不能被自动拉黑。
const { BLF: Y, ls: ls2 } = load();
for (let i = 0; i < 3; i++) {
  Y.test([{ duration: 30, title: '正常短视频 ' + i, owner: { mid: 9001, name: '正常UP' }, stat: { view: 1e4, like: 500 }, goto: 'av' }]);
}
const bl = JSON.parse(ls2.getItem('blf:blacklist') || '{}');
const counts = JSON.parse(ls2.getItem('blf:counts') || '{}');
check('3 条短视频 → 不进黑名单', !('9001' in bl));
check('3 条短视频 → 不累计话题计数', !('t:9001' in counts));
void ls;

console.log('\n--- 接口层保底 ---');
// 接口层返回空数组会让 B 站首页白屏，所以保底仍会补回 keepAtLeast 条。
// DOM 层不保底，那些卡片到页面层仍会被隐藏。
const allShort = Array.from({ length: 10 }, (_, i) => ({
  duration: 60, title: '正常短视频 ' + i, owner: { mid: 5000 + i, name: 'u' + i },
  stat: { view: 1e4, like: 500 }, goto: 'av',
}));
const kept = Y.filter(allShort);
check(`10 条全短视频 → 接口层仍兜底保留 ${Y.config.keepAtLeast} 条（防白屏）`, kept.length === Y.config.keepAtLeast);

const mixed = [
  ...Array.from({ length: 5 }, (_, i) => ({ duration: 60, title: '短' + i, owner: { mid: 6000 + i, name: 's' }, stat: { view: 1e4, like: 500 }, goto: 'av' })),
  ...Array.from({ length: 5 }, (_, i) => ({ duration: 600, title: '长' + i, owner: { mid: 7000 + i, name: 'l' }, stat: { view: 1e4, like: 500 }, goto: 'av' })),
];
check('5 短 + 5 长 → 只返回 5 条长的（保底不介入）', Y.filter(mixed).length === 5);

// 配置可关：minKeepDuration = 0 时规则失效
const offByConfig = load();
offByConfig.BLF.config.minKeepDuration = 0;
const r0 = offByConfig.BLF.test([{ duration: 20, title: '正常视频', owner: { mid: 8, name: 'U' }, stat: { view: 1e4, like: 500 }, goto: 'av' }])[0];
check('minKeepDuration = 0 → 规则关闭', r0.hide === false);

/* ==================================================================
   4.25.0：解析链路。

   “不足三分钟没被杀”的真实原因不是阈值错，而是**时长根本抓不到**：
   抓不到 → d=null → 走「时长未知，跳过」→ 不删。
   所以这里同时测三层：解析器、卡片抓取、卡片定位。
   ================================================================== */

console.log('\n--- 时长解析器 ---');
// parseDuration 没挂在 __BLF 上，从源码里取函数体单独跑
const fullSrc = fs.readFileSync(__dirname + '/bilibili-filter.user.js', 'utf8');
const fnBody = fullSrc.match(/function parseDuration\(text\) \{[\s\S]*?\n  \}/)[0];
const parseDuration = new Function('return (' + fnBody.replace('function parseDuration', 'function') + ')')();

const PARSE = [
  ['2:59', 179], ['03:00', 180], ['1:02:03', 3723], ['0:45', 45],
  // 下面这些都是 4.24.0 会返回 null 的写法，每条都会变成“时长未知”而漏网
  ['2：59', 179],          // 全角冒号
  ['2:59 HD', 179],        // 带后缀
  ['时长 2:59', 179],      // 带前缀
  [' 02:59 ', 179],        // 前后空白
  ['2:59\n', 179],        // 尾随换行
  // 不该被当成时长
  ['--:--', null], ['', null], [null, null], ['直播', null],
  ['2024:10', null], ['2024-10-18', null], ['2:60', null],
];
for (const [inp, want] of PARSE) {
  const got = parseDuration(inp);
  check(`parseDuration(${JSON.stringify(inp)}) → ${wanthint(want)}`, got === want);
}
function wanthint(v) { return v === null ? 'null' : String(v); }

console.log('\n--- 卡片时长抓取 ---');
// 只在 4.24.0 只看 querySelector 第一个匹配时，这些卡片会因解析失败而漏网
const CARD_CASES = [
  { durText: '2:59', durMode: 'class', expectHide: true, tag: '标准写法 2:59' },
  { durText: '2：59', durMode: 'class', expectHide: true, tag: '全角冒号' },
  { durText: '2:59 HD', durMode: 'class', expectHide: true, tag: '带后缀' },
  { durText: '3:00', durMode: 'class', expectHide: false, tag: '3:00 整（达标）' },
  { durText: '2:59', durMode: 'textOnly', expectHide: true, tag: 'class 全丢，靠文本兜底' },
  { durText: '3:05', durMode: 'textOnly', expectHide: false, tag: 'class 全丢，长视频' },
  { durText: '--:--', durMode: 'class', expectHide: false, tag: '未加载（未知，保守放行）' },
];
for (const c of CARD_CASES) {
  const card = makeDurCard(c);
  const { BLF: Z } = loadWithCards([card]);
  const rows = Z.scan();
  const hidden = card.dataset.blfHidden === '1';
  check(`${c.tag} → ${c.expectHide ? '拦' : '留'}（dur=${rows[0] && rows[0].dur}）`, hidden === c.expectHide);
}

function makeDurCard({ durText, durMode }) {
  const mk = (p = {}) => ({
    tagName: 'DIV', dataset: {}, style: { setProperty() {}, removeProperty() {} },
    _text: '', _attrs: {},
    get textContent() { return this._text; }, set textContent(v) { this._text = String(v); },
    get offsetParent() { return {}; },
    setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k] ?? null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, appendChild() {}, addEventListener() {}, matches() { return false; },
    ...p,
  });
  const card = mk();
  const titleEl = mk(); titleEl._attrs.title = '影史公认无法复制的五大奇迹神作'; titleEl._text = titleEl._attrs.title;
  const authorLink = mk(); authorLink._attrs.href = '//space.bilibili.com/1234'; authorLink._text = 'TopSelecct';
  const videoLink = mk(); videoLink._attrs.href = '//www.bilibili.com/video/BV1xx'; videoLink.closest = () => card;
  const durEl = mk(); durEl._text = durText;
  card._text = durMode === 'textOnly' ? titleEl._text + ' ' + durText : titleEl._text;
  card.querySelector = (sel) => {
    if (String(sel).includes('space.bilibili.com')) return authorLink;
    if (String(sel).includes('info--tit') || sel === 'h3' || sel === '.title') return titleEl;
    if (String(sel).includes('duration')) return durMode === 'textOnly' ? null : durEl;
    return null;
  };
  card.querySelectorAll = (sel) => {
    if (String(sel).includes('/video/BV')) return [videoLink];
    if (String(sel).includes('duration')) return durMode === 'textOnly' ? [] : [durEl];
    return [];
  };
  card._links = [videoLink];
  return card;
}

function loadWithCards(cards) {
  const sb = {};
  sb.window = sb; sb.console = { log() {}, warn() {} };
  const empty = () => ({ dataset: {}, style: { setProperty() {}, removeProperty() {} }, appendChild() {}, addEventListener() {}, setAttribute() {} });
  sb.document = {
    readyState: 'complete', body: empty(), addEventListener() {}, createElement: empty,
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
  vm.runInContext(fullSrc, sb);
  return { BLF: sb.window.__BLF };
}

console.log('\n' + (fail ? `失败 ${fail} 项` : '全部通过'));
process.exit(fail ? 1 : 0);
