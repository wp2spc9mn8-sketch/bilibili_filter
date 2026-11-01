// 离线验证：把 userscript 的判定逻辑跑在真实推荐接口数据上
// 用法：node verify.js [rcmd.json]
const fs = require('fs');
const vm = require('vm');

let src = fs.readFileSync(__dirname + '/bilibili-filter.user.js', 'utf8');
src = src.replace("mode: 'aggressive'", "mode: 'balanced'");
const dataFile = process.argv[2] || 'fixtures/rcmd-sample.json';
const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const items = raw.data.item || raw.data;

// ---- 最小 DOM 桩，让 userscript 能在 Node 里加载 ----
const sandbox = {};
sandbox.window = sandbox;
sandbox.console = console;
sandbox.document = {
  readyState: 'complete',
  body: { appendChild() {} },
  addEventListener() {},
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, addEventListener() {}, appendChild() {} }),
};
sandbox.MutationObserver = class { observe() {} };
sandbox.Headers = Headers;
sandbox.Response = Response;
sandbox.localStorage = {
  _s: {},
  getItem(k) { return k in this._s ? this._s[k] : null; },
  setItem(k, v) { this._s[k] = String(v); },
};
sandbox.getComputedStyle = () => ({ position: 'static' });
sandbox.setInterval = () => 0;

vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const BLF = sandbox.window.__BLF;
if (!BLF) { console.error('❌ 脚本未暴露 __BLF，加载失败'); process.exit(1); }

// ---- 逐条判定 ----
const scored = BLF.test(items);

console.log(`\n数据源: ${dataFile}   共 ${items.length} 条\n`);
const pad = (s, n) => { let w = 0, o = ''; for (const c of String(s)) { w += /[\u4e00-\u9fa5]/.test(c) ? 2 : 1; if (w > n) return o + '…'; o += c; } return o + ' '.repeat(Math.max(0, n - w)); };

for (const x of scored) {
  const verdict = x.hide ? '❌ 隐藏' : '✅ 保留';
  console.log(
    verdict, String(x.score).padStart(5),
    String(x.dur + 's').padStart(6), '|',
    pad(x.title, 34),
    x.why.length ? '← ' + x.why.join(' ') : ''
  );
}

const kept = BLF.filter(items);
const hiddenCount = items.length - kept.length;
console.log(`\n结果: 保留 ${kept.length} 条，隐藏 ${hiddenCount} 条 (${Math.round(hiddenCount / items.length * 100)}%)`);

// ---- 断言：核心规则必须生效 ----
let fails = 0;
const check = (name, cond) => { console.log((cond ? ' PASS ' : ' FAIL ') + name); if (!cond) fails++; };

const fake = [
  { duration: 20,  title: '震惊！！！这个操作太离谱了吧', owner: { mid: 1, name: 'x' }, stat: { view: 5e6, like: 1000 }, goto: 'av' },
  { duration: 60,  title: '建议收藏！必看干货合集',       owner: { mid: 2, name: 'y' }, stat: { view: 2e5, like: 300 },  goto: 'av' },
  { duration: 1800, title: '【纪录片】古罗马的兴衰史',     owner: { mid: 3, name: 'z' }, stat: { view: 3e5, like: 40000 }, goto: 'av' },
  { duration: 25,  title: '短但正常的内容',               owner: { mid: 4, name: 'w' }, stat: { view: 1e4, like: 800 },   goto: 'av' },
  // 真实数据里的误伤案例：官方短新闻、生活记录
  { duration: 45,  title: '首型！首次！四川舰，弹了！',    owner: { mid: 5, name: '央视军事' }, stat: { view: 339266, like: 25579 }, goto: 'av' },
  { duration: 62,  title: '第一次用彩色修正带，献丑了',    owner: { mid: 6, name: '没有蜡笔的小新' }, stat: { view: 8e4, like: 9000 }, goto: 'av' },
];
const s = BLF.test(fake);
console.log('\n--- 规则断言 ---');
check('20s + 强营销标题 → 隐藏', s[0].hide === true);
check('60s + 收藏党话术 → 隐藏', s[1].hide === true);
check('30 分钟纪录片 → 保留',    s[2].hide === false);
check('25s 但标题正常 → 保留',   s[3].hide === false);
check('45s 央视军事短新闻 → 保留（不误伤）', s[4].hide === false);
check('62s 生活记录 → 保留（不误伤）',      s[5].hide === false);

// 关注白名单 & 黑名单优先级
const followed = BLF.test([{ duration: 15, title: '震惊！！！', owner: { mid: 9, name: 'f' }, is_followed: true, goto: 'av' }]);
check('已关注 UP 永不被隐藏', followed[0].hide === false);

// 保底机制：全垃圾时不能把首页清空
const allJunk = Array.from({ length: 20 }, (_, i) => ({
  duration: 20, title: '震惊！！！太离谱了看完你就懂了', owner: { mid: 100 + i, name: 'junk' + i },
  stat: { view: 1e6, like: 500 }, goto: 'av',
}));
const keptJunk = BLF.filter(allJunk);
console.log('\n--- 白名单（误杀纠正）---');
// 一个会被规则判死的标题，加入白名单后必须放行
const junk = { duration: 40, title: '震惊！原来这才是真相，看完你就懂了', owner: { mid: 888, name: '被误判的UP' }, stat: { view: 1e5, like: 5000 }, goto: 'av' };
const before = BLF.test([junk])[0];
check('白名单前：该内容被隐藏', before.hide === true);

BLF.allow(888, '被误判的UP');
const after = BLF.test([junk])[0];
check('加入白名单后：该内容放行', after.hide === false);
check('白名单原因可追溯', (after.why || []).some((w) => String(w).includes('白名单')));

// 白名单优先级高于黑名单，避免状态矛盾
BLF.blacklist && BLF.blacklist();
check('白名单与黑名单互斥', !(888 in BLF.blacklist()));
BLF.unblock(888);

console.log('\n--- 保底机制 ---');
check('20 条全垃圾 → 仍保留 ' + BLF.config.keepAtLeast + ' 条（首页不清空）', keptJunk.length === BLF.config.keepAtLeast);

// 真实数据回归：这两条来自 fixtures/rcmd-sample.json 的实测样本
const realShip = items.find((x) => String(x.title).includes('四川舰'));
if (realShip) {
  const r = BLF.test([realShip])[0];
  check('真实数据: 央视军事 45s 短新闻 → 保留（不误伤）', r.hide === false);
}
const realCode = items.find((x) => String(x.title).includes('兑换码'));
if (realCode) {
  const r = BLF.test([realCode])[0];
  check('真实数据: 31s 兑换码营销 → 隐藏', r.hide === true);
}

// 黑名单优先级
sandbox.localStorage.setItem('blf:blacklist', JSON.stringify({ '777': '黑名单UP' }));
const bl = BLF.filter([
  { duration: 9999, title: '超长优质纪录片', owner: { mid: 777, name: '黑名单UP' }, stat: { view: 1e6, like: 3e5 }, goto: 'av' },
]);
check('黑名单 UP 即使长视频也被砍', bl.length === 0);

process.exit(fails ? 1 : 0);
