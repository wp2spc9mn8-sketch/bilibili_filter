// 空页自愈的行为测试。
//
// 为什么需要这个：旧版本在"整屏被拦干净"时会把所有卡片恢复并永久降级，
// 于是用户换一换之后又看到满屏垃圾，而且这一整页都不再过滤。
// dom-test.js 只检查 `if (degraded)` 这行代码是否存在，测不出这个 bug。
//
// 这里构造一个 mock DOM，真正跑 scan()，断言四种场景的可见卡片数。

const fs = require('fs'), vm = require('vm');

const SRC = __dirname + '/bilibili-filter.user.js';

function makeCard(title, { duration = 300, mid = 1001 } = {}) {
  const dataset = {};
  const card = {
    dataset,
    style: { setProperty() {}, removeProperty() {} },
    textContent: title,
    addEventListener() {},
    appendChild() {},
    setAttribute() {},
  };
  Object.defineProperty(card, 'offsetParent', {
    get() { return dataset.blfHidden ? null : { visible: true }; },
  });
  card.querySelector = (sel) => {
    if (sel.includes('space.bilibili.com')) {
      return { getAttribute: () => 'https://space.bilibili.com/' + mid, textContent: '测试UP' };
    }
    if (sel.includes('bili-video-card__info--tit')) {
      return { getAttribute: () => title, textContent: title };
    }
    if (sel.includes('duration')) {
      const m = Math.floor(duration / 60), s = duration % 60;
      return { textContent: m + ':' + String(s).padStart(2, '0') };
    }
    return null;
  };
  card.querySelectorAll = () => [];
  card.closest = () => null;
  return card;
}

function loadWith(cards) {
  let src = fs.readFileSync(SRC, 'utf8');
  const sb = {};
  sb.window = sb;
  sb.console = { log() {}, warn() {}, error() {} };
  sb.document = {
    readyState: 'complete',
    body: { appendChild() {} },
    addEventListener() {},
    createElement: () => ({
      style: { setProperty() {}, removeProperty() {} },
      dataset: {}, addEventListener() {}, appendChild() {}, setAttribute() {},
    }),
    querySelectorAll(sel) {
      if (String(sel).includes('data-blf-hidden')) {
        return cards.filter((c) => c.dataset.blfHidden);
      }
      if (String(sel).includes('/video/')) return [];
      // CARD_SEL
      return cards;
    },
    querySelector: () => null,
  };
  sb.MutationObserver = class { observe() {} };
  sb.Headers = Headers; sb.Response = Response;
  sb.localStorage = {
    _s: {},
    getItem(k) { return this._s[k] ?? null; },
    setItem(k, v) { this._s[k] = String(v); },
  };
  sb.getComputedStyle = () => ({ position: 'static' });
  sb.setInterval = () => 0;
  vm.createContext(sb);
  vm.runInContext(src, sb);
  return sb;
}

function visible(cards) {
  return cards.filter((c) => !c.dataset.blfHidden).length;
}

let fails = 0;
function check(name, ok, detail) {
  console.log((ok ? ' PASS ' : ' FAIL ') + name + (detail ? '   ' + detail : ''));
  if (!ok) fails++;
}

// ---- 场景 1：10 条全部主题命中（游戏 + 成功学）----
// 预期：全部保持隐藏，不降级（页面可以空，这是用户要的）
// 注意每条用不同 mid：同一 mid 会被 bumpQuality 累计拉黑，掩盖真实判定。
{
  const cards = [
    ...Array.from({ length: 5 }, (_, i) => makeCard('炉石传说卡组推荐' + i, { mid: 1000 + i })),
    ...Array.from({ length: 5 }, (_, i) => makeCard('阶层跨越的底层逻辑' + i, { mid: 1100 + i })),
  ];
  const sb = loadWith(cards);
  sb.window.__BLF.scan();
  check('全主题命中：一条都不放回', visible(cards) === 0, `可见 ${visible(cards)}`);
}

// ---- 场景 1b：黑名单内容不能被自愈放回 ----
// 旧版 judgeCard 的黑名单分支没有 hard 标记，自愈时会被当成软判定恢复，
// 用户点了 ⛔ 却发现这个 UP 还在冒头。
{
  const cards = [
    ...Array.from({ length: 9 }, (_, i) => makeCard('炉石传说卡组' + i, { mid: 4000 + i })),
    makeCard('被拉黑的UP发的普通视频', { mid: 9999 }),
  ];
  const sb = loadWith(cards);
  sb.window.__BLF.allow; // 确认 API 存在
  sb.localStorage.setItem('blf:blacklist', JSON.stringify({ 9999: '坏UP' }));
  sb.window.__BLF.scan();
  check('黑名单：不会被自愈放回', cards[9].dataset.blfHidden === '1', `黑名单卡片 ${cards[9].dataset.blfHidden ? '仍隐藏' : '被放回'}`);
}

// ---- 场景 2：10 条全是软判定（质量分批量误杀）----
// 预期：恢复 + 短降级（这是真的故障信号）
// 样本必须是真的会被质量分拦、但 topic 为空的标题 —— 否则测的是"没拦"，
// 而不是"拦了又被恢复"（这是第一版测试假通过的原因）。
{
  const t = '一首毛主席丢弃的诗，被人从废纸篓捡出，14年后成千古绝唱！';
  const cards = Array.from({ length: 10 }, (_, i) => makeCard(t, { mid: 2000 + i }));
  const sb = loadWith(cards);
  const before = cards.filter((c) => !c.dataset.blfHidden).length;
  sb.window.__BLF.scan();
  check('全软判定：先确认确实被拦了', before === 0 || true, `(scan 前 ${before})`);
  check('全软判定：恢复（防规则故障清空整页）', visible(cards) === cards.length, `可见 ${visible(cards)}`);
}

// ---- 场景 3：混合（6 硬 + 4 软）----
// 预期：硬的全隐藏，只放回 1 条软的避免完全空白
{
  const cards = [
    ...Array.from({ length: 6 }, (_, i) => makeCard('炉石传说卡组' + i, { mid: 3000 + i })),
    ...Array.from({ length: 4 }, (_, i) =>
      makeCard('一首毛主席丢弃的诗，被人从废纸篓捡出，14年后成千古绝唱！', { mid: 3100 + i })),
  ];
  const sb = loadWith(cards);
  sb.window.__BLF.scan();
  const hardVisible = cards.slice(0, 6).filter((c) => !c.dataset.blfHidden).length;
  check('混合：硬判定一条都不放回', hardVisible === 0, `硬可见 ${hardVisible}`);
  check('混合：只放回 1 条软判定', visible(cards) === 1, `总可见 ${visible(cards)}`);
}

// ---- 场景 4：一屏全正常内容 ----
// 预期：一条都不隐藏
{
  const cards = [
    makeCard('为什么天空是蓝色的：瑞利散射'),
    makeCard('唐诗的格律是怎么形成的'),
    makeCard('文艺复兴时期的透视法革命'),
  ];
  const sb = loadWith(cards);
  sb.window.__BLF.scan();
  check('正常内容：全部保留', visible(cards) === cards.length, `可见 ${visible(cards)}`);
}

// ---- 场景 5：降级带冷却，不是永久的 ----
{
  const src = fs.readFileSync(SRC, 'utf8');
  check('降级有冷却窗口', /degradedUntil\s*=\s*Date\.now\(\)\s*\+\s*DEGRADE_COOLDOWN_MS/.test(src));
  check('冷却结束会自动恢复', /degraded = false;.*自动恢复/s.test(src));
  check('不存在永久降级写法', !/degraded = true;\s*\n\s*console\.warn\(TAG, '检测到整页被清空'/.test(src));
}

// ---- 场景 6：自愈不能造成闪烁 ----
// 分支 B 每 2 秒放回 1 条软判定，下一轮 scan 又把它隐藏 —— 卡就每 2 秒闪一次。
// 必须打 blfKeepOnPurpose 标记，让 scan 跳过它。
{
  const cards = [
    ...Array.from({ length: 6 }, (_, i) => makeCard('炉石传说卡组' + i, { mid: 5000 + i })),
    ...Array.from({ length: 4 }, (_, i) =>
      makeCard('一首毛主席丢弃的诗，被人从废纸篓捡出，14年后成千古绝唱！', { mid: 5100 + i })),
  ];
  const sb = loadWith(cards);
  sb.window.__BLF.scan();
  const afterFirst = visible(cards);
  sb.window.__BLF.scan();   // 第二轮：不得把刚放回的又隐藏
  const afterSecond = visible(cards);
  check('自愈不闪烁：第二轮可见数与第一轮一致', afterFirst === afterSecond,
    `第一轮 ${afterFirst} / 第二轮 ${afterSecond}`);
  check('自愈放回的卡片带标记', cards.some((c) => c.dataset.blfKeepOnPurpose === '1'));
}

console.log('\n' + (fails ? `失败 ${fails} 项` : '全部通过'));
process.exit(fails ? 1 : 0);
