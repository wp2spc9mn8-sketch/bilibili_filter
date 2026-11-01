// 各档位行为测试：验证 mode 切换是否按预期工作
const fs = require('fs'), vm = require('vm');

function load(mode) {
  let src = fs.readFileSync(__dirname + '/bilibili-filter.user.js', 'utf8');
  if (mode) src = src.replace("mode: 'aggressive'", "mode: '" + mode + "'");
  const sb = {};
  sb.window = sb; sb.console = console;
  sb.document = {
    readyState: 'complete',
    body: { appendChild() {} },
    addEventListener() {},
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, addEventListener() {}, appendChild() {} }),
  };
  sb.MutationObserver = class { observe() {} };
  sb.Headers = Headers; sb.Response = Response;
  sb.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); } };
  sb.getComputedStyle = () => ({ position: 'static' });
  sb.setInterval = () => 0;
  vm.createContext(sb);
  vm.runInContext(src, sb);
  return sb.window.__BLF;
}

const samples = [
  { duration: 25,  title: '震惊！这个操作太离谱了',   owner: { mid: 1 }, stat: { view: 1e6, like: 5000 },  tag: '营销号短视频' },
  { duration: 71,  title: '我和我的低能量小猫',       owner: { mid: 2, name: '普通UP主' }, stat: { view: 2e5, like: 9000 },  tag: '短视频（标题正常）' },
  { duration: 95,  title: '赛博朋克：边缘行者',       owner: { mid: 3 }, stat: { view: 8e4, like: 7000 },  tag: '正常动画剪辑' },
  { duration: 45,  title: '首型！首次！四川舰，弹了！', owner: { mid: 4, name: '央视军事' }, stat: { view: 3e5, like: 25000 }, tag: '央视军事短新闻' },
  { duration: 600, title: '【4K】挪威自驾 Day3',     owner: { mid: 5 }, stat: { view: 5e4, like: 4000 },  tag: '正常长视频' },
  { duration: 1800,title: '纯音乐｜雨声助眠 30 分钟',  owner: { mid: 6 }, stat: { view: 9e4, like: 8000 },  tag: '正常长音频' },
];

const modes = ['off', 'light', 'balanced', 'aggressive'];
const rows = {};

for (const m of modes) {
  const BLF = load(m);
  rows[m] = samples.map((s) => BLF.test([s])[0].hide);
}

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
console.log('\n' + pad('样本', 22) + modes.map((m) => pad(m, 12)).join(''));
console.log('-'.repeat(22 + modes.length * 12));
samples.forEach((s, i) => {
  console.log(pad(s.tag, 22) + modes.map((m) => pad(rows[m][i] ? '砍' : '留', 12)).join(''));
});

// 断言
let fail = 0;
const check = (name, cond) => { console.log((cond ? ' PASS ' : ' FAIL ') + name); if (!cond) fail++; };

console.log('');
check('off 档：一条都不砍', rows.off.every((v) => v === false));
check('aggressive：营销号短视频被砍', rows.aggressive[0] === true);
// 短视频走更低门槛的指纹判定，而不是按长度一刀切 ——
// 正常短视频（游戏片段、绘画、美食）同样很短，砍长度会大面积误杀
check('aggressive：正常短视频保留', rows.aggressive[1] === false);
check('aggressive：长视频保留', rows.aggressive[4] === false && rows.aggressive[5] === false);
check('aggressive：央视军事 45s 短新闻走白名单保留', rows.aggressive[3] === false);
check('balanced：标题正常的短视频被放过', rows.balanced[1] === false);
check('light：只砍标题明确的', rows.light[0] === true && rows.light[1] === false);
check('所有档位：长视频都不砍', modes.every((m) => rows[m][4] === false && rows[m][5] === false));

// 已关注豁免
const BLF = load('aggressive');
const follow = BLF.test([{ duration: 20, title: '震惊！', owner: { mid: 9 }, is_followed: true, goto: 'av' }])[0];
check('aggressive：已关注 UP 仍保留', follow.hide === false);

console.log('\n注：aggressive 对短视频用 fp>=2 的门槛；误伤的条目可在徽章面板里点 ✅ 永久放行。');
process.exit(fail ? 1 : 0);
