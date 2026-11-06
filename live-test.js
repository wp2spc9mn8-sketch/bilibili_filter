// 直播过滤测试（4.33.0）
//
// 这条规则的坑不在判据，而在**入口**：
//   scan() 原来只抓 /video/BV 与 /video/av，直播卡指向 live.bilibili.com，
//   根本不在扫描范围内 —— 开关开着也删不掉。
//
// 所以测试重点放在：
//   1. DOM 层能不能定位到直播卡片
//   2. 定位到之后判定是否正确（混排、白名单、开关）
//   3. linkCount 是否把直播链接算进去（否则列表容器会被误判成卡片）
//   4. 旧的 !isVideo 近似被移除后，badge / loading 等垃圾值不再被误拦
const fs = require('fs'), vm = require('vm');

const SRC = __dirname + '/bilibili-filter.user.js';
const SRC_TEXT = fs.readFileSync(SRC, 'utf8');

let fail = 0;
const check = (name, cond) => { console.log((cond ? ' PASS ' : ' FAIL ') + name); if (!cond) fail++; };

function mk(tag, p = {}) {
  return {
    tagName: tag, dataset: {}, style: { setProperty() {}, removeProperty() {} },
    _text: '', _attrs: {}, className: '',
    get textContent() { return this._text; }, set textContent(v) { this._text = String(v); },
    get offsetParent() { return {}; },
    setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k] ?? null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, appendChild() {}, addEventListener() {}, matches() { return false; },
    ...p,
  };
}

function makeLiveCard(o = {}) {
  const { title = '【露脸】打把王者放松一下~', author = '某主播', mid = 2001 } = o;
  const card = mk('DIV');
  const titleEl = mk('H3'); titleEl._attrs.title = title; titleEl._text = title;
  const authorLink = mk('A'); authorLink._attrs.href = `//space.bilibili.com/${mid}`; authorLink._text = author;
  const liveLink = mk('A'); liveLink._attrs.href = '//live.bilibili.com/12345'; liveLink.closest = () => card;
  card.querySelector = (sel) => {
    const s = String(sel);
    if (s.includes('live.bilibili.com')) return liveLink;
    if (s.includes('space.bilibili.com')) return authorLink;
    if (s.includes('info--tit') || s === 'h3' || s === '.title') return titleEl;
    return null;
  };
  card.querySelectorAll = (sel) => {
    const s = String(sel);
    if (s.includes('live.bilibili.com')) return [liveLink];
    return [];
  };
  card._links = [liveLink];
  return card;
}

function makeVideoCard(o = {}) {
  const { title = '正常视频', author = 'UP', mid = 3001, dur = '6:00' } = o;
  const card = mk('DIV');
  const titleEl = mk('H3'); titleEl._attrs.title = title; titleEl._text = title;
  const authorLink = mk('A'); authorLink._attrs.href = `//space.bilibili.com/${mid}`; authorLink._text = author;
  const videoLink = mk('A'); videoLink._attrs.href = '//www.bilibili.com/video/BV1xx'; videoLink.closest = () => card;
  const durEl = mk('SPAN'); durEl._text = dur;
  card.querySelector = (sel) => {
    const s = String(sel);
    if (s.includes('live.bilibili.com')) return null;
    if (s.includes('space.bilibili.com')) return authorLink;
    if (s.includes('info--tit') || s === 'h3' || s === '.title') return titleEl;
    if (s.includes('duration')) return durEl;
    return null;
  };
  card.querySelectorAll = (sel) => {
    const s = String(sel);
    if (s.includes('live.bilibili.com')) return [];
    if (s.includes('/video/BV') || s.includes('/video/av')) return [videoLink];
    if (s.includes('duration')) return [durEl];
    return [];
  };
  card._links = [videoLink];
  return card;
}

function boot(cards, prelude) {
  const sb = {};
  sb.window = sb; sb.console = { log() {}, warn() {} };
  const empty = () => ({ dataset: {}, style: { setProperty() {}, removeProperty() {} }, appendChild() {}, addEventListener() {}, setAttribute() {} });
  sb.document = {
    readyState: 'loading', body: empty(), addEventListener() {}, createElement: empty,
    querySelectorAll(sel) {
      const s = String(sel);
      if (s.includes('live.bilibili.com') || s.includes('/video/BV')) return cards.flatMap((c) => c._links);
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
  vm.runInContext(SRC_TEXT, sb);
  const B = sb.window.__BLF;
  if (prelude) prelude(B, sb);
  return { B, rows: B.scan(), sb };
}

function apiItem(extra) {
  const { B } = boot([], null);
  return B.test([{
    duration: 300, title: '一条完全正常的视频标题',
    owner: { mid: 1, name: '正常UP' },
    stat: { view: 1e5, like: 5000 }, goto: 'av', ...extra,
  }])[0];
}

console.log('\n--- 配置 ---');
{
  const { B } = boot([]);
  check('hideLive 默认开启', B.config.hideLive === true);
}

console.log('\n--- 源码层：入口是否纳入直播链接 ---');
check('存在 FEED_LINK_SEL，包含 live.bilibili.com',
  /FEED_LINK_SEL\s*=\s*'[^']*live\.bilibili\.com/.test(SRC_TEXT));
check('scan 用的是 FEED_LINK_SEL（而不是只认 /video/）',
  /scope\.querySelectorAll\(FEED_LINK_SEL\)/.test(SRC_TEXT));
check('linkCount 用的是 FEED_LINK_SEL',
  /el\.querySelectorAll\(FEED_LINK_SEL\)\.length/.test(SRC_TEXT));
check('findCard 对直播卡放宽「必须有时长」',
  /isLive\s*=\s*!!el\.querySelector\('a\[href\*="live\.bilibili\.com\/"\]'\)/.test(SRC_TEXT));
check('旧的 !isVideo 近似已移除（不再把非视频 goto 一律当直播）',
  !/CONFIG\.hideLive && !isVideo/.test(SRC_TEXT));

console.log('\n--- 接口层 ---');
for (const g of ['live', 'live_room']) {
  const r = apiItem({ goto: g });
  check(`goto=${g} → 拦（理由含「直播」）`, r.hide === true && (r.why || []).includes('直播'));
}

console.log('\n--- 接口层：垃圾 goto 不能被牵连 ---');
// 旧的 !isVideo 分支会把下面这些全部当成「非视频流」拦掉
for (const g of ['badge', 'loading', 'download', 'header', 'shadow', 'radio', 'upos']) {
  check(`goto=${g} → 保留`, apiItem({ goto: g }).hide === false);
}

console.log('\n--- DOM 层 ---');
{
  const card = makeLiveCard();
  const { rows } = boot([card]);
  check('直播卡 → 隐藏', rows[0] && rows[0].verdict === 'hide');
  check('原因是「直播」', rows[0] && rows[0].reason === '直播');
  check('卡片确实被标了隐藏', card.dataset.blfHidden === '1');
}
{
  const cards = [
    makeLiveCard({ mid: 1 }), makeLiveCard({ mid: 2 }), makeLiveCard({ mid: 3 }),
    makeVideoCard({ mid: 4 }), makeVideoCard({ mid: 5 }),
  ];
  boot(cards);
  const hidden = cards.map((c) => c.dataset.blfHidden === '1');
  check('混排 3 直播 + 2 视频 → 只删直播', hidden.join(',') === 'true,true,true,false,false');
}

console.log('\n--- 优先级 ---');
{
  const card = makeLiveCard({ mid: 9999 });
  const { rows } = boot([card], (B) => B.allow(9999, '放行的主播'));
  check('白名单主播的直播 → 保留', rows[0] && rows[0].verdict === 'keep');
}
{
  // 拉黑的主播：即使 hideLive 关掉，黑名单仍应拦。
  // 确认直播判定没有把「黑名单」这条独立路径盖掉。
  const card = makeLiveCard({ mid: 7777 });
  const { rows } = boot([card], (B, sb) => {
    B.config.hideLive = false;
    sb.localStorage.setItem('blf:blacklist', JSON.stringify({ 7777: '被封的主播' }));
  });
  check('hideLive 关闭时，黑名单主播的直播仍被拦',
    rows[0] && rows[0].verdict === 'hide' && String(rows[0].reason).includes('黑名单'));
}

console.log('\n--- 开关 ---');
{
  const card = makeLiveCard();
  const { rows } = boot([card], (B) => { B.config.hideLive = false; });
  check('hideLive = false → 直播保留', rows[0] && rows[0].verdict === 'keep');
}

console.log('\n--- 时长门不适用于直播 ---');
{
  // 直播没有时长（duration = null）。若走时长门会落到「时长未知，跳过」。
  const r = apiItem({ goto: 'live', duration: 0 });
  check('0s 的直播 → 仍然拦（不因时长未知而放过）', r.hide === true);
}

console.log('\n' + (fail ? `失败 ${fail} 项` : '全部通过'));
process.exit(fail ? 1 : 0);
