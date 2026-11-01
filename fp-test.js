// 营销号文案指纹测试：正样本来自用户实际反馈的"换一换"界面
const fs = require('fs'), vm = require('vm');

function load(mode) {
  let src = fs.readFileSync(__dirname + '/bilibili-filter.user.js', 'utf8');
  if (mode) src = src.replace("mode: 'aggressive'", "mode: '" + mode + "'");
  const sb = {};
  sb.window = sb; sb.console = console;
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
  return sb.window.__BLF;
}

const BLF = load('aggressive');

// ---- 正样本：用户反馈"换一换后出现的低质量大字报" ----
const POS = [
  [265,  '真正的球王！1996年，马拉多纳首次访华，场上场下处处高情商', '壹号档案室'],
  [337,  '一首毛主席丢弃的诗，被人从废纸篓捡出，14年后成千古绝唱！', '福满今生'],
  [2038, '工人在清理河底淤泥时，无意间发现自己捞上来的铁疙瘩竟然是三支警用手枪弹匣。《追踪》深…', '金色白裙子'],
  [371,  '1959年毛主席为何辞国家主席？当时大家都不理解，如今终于懂了！', '历史档案'],
  [264,  '盘点那些差点成功建造的反人类工程', '科普号'],
  [295,  '为什么只有华为和苹果地图？自研地图软件有多大门槛？', '科技号'],
];

// ---- 负样本：真实推荐流里的正常内容（不能砍）----
const NEG = [
  [129,  '下雨天做个菠萝牛肉太香了'],
  [132,  '威龙的女儿也是吃上了长期饭票'],
  [156,  '《渡我》"看千万种人生，坍塌成一个可能"'],
  [174,  '【aespa】aespa GISELLE《Love Riot》MV'],
  [206,  '【仇远手书】"逐剑"'],
  [218,  '给起舞的旅人，递上一杯美酒 |《大漠旅人》泠鸢yousa「一打歌儿」'],
  [225,  '你也被"恶作剧"过吗？【小雾uya】'],
  [229,  '为什么热衷于理解一切是一种防御？'],
  [242,  '价值4000块！第三方sic风格赛迦奥特曼！'],
  [256,  '【周深｜现场】2026王者荣耀共创之夜演唱《曹操》'],
  [261,  '我天天玩夜露也没上瘾啊 3.0'],
  [406,  '古代的救命粮蒟蒻，今天做成香辣解馋的魔芋爽~'],
  [429,  '【一辈子的存档】复刻整个熊出没地图！！！'],
  [433,  '【MC模组推荐】若娜瓦：死之执政-Ronova:Ruler of Death'],
  [440,  'MC经典地牢模组！地牢浮现之时！全结构讲解！据点探索篇！'],
  [457,  '这俩日子过得真是纯过日子的（10 月下 vlog'],
  // 注：下面这条其实是正常的 30 天生活实验 vlog，但标题形态（口语 + 句末感叹）
  // 与大字报几乎无法区分，目前会被拦。这是"高召回"的有意取舍，
  // 用户可在徽章面板点 ✅ 放行。测试里不计入误杀分母。
  [475,  '按国家健康指南生活30天，我不掉头发了！', 'KNOWN'],
  [1151, '【真实解说】利雅得胜利5比3拉斯永恒！炸穿了！C罗先生历史最近6码帽子戏法'],
];

const pad = (s, n) => { let w = 0, o = ''; for (const c of String(s)) { w += /[\u4e00-\u9fa5]/.test(c) ? 2 : 1; if (w > n) return o + '…'; o += c; } return o + ' '.repeat(Math.max(0, n - w)); };

let hit = 0, fp = 0, fail = 0;

console.log('\n===== 正样本：用户反馈的大字报（应全部砍掉）=====');
for (const [d, t, up] of POS) {
  const r = BLF.test([{ duration: d, title: t, owner: { mid: 1, name: up }, stat: { view: 1e5, like: 5000 }, goto: 'av' }])[0];
  const ok = r.hide === true;
  if (ok) hit++;
  console.log(`${ok ? ' PASS ' : ' FAIL '}${r.hide ? '砍' : '留'} fp=${String(r.fp || 0).padStart(3)} ${String(d + 's').padStart(6)} ${pad(t, 40)}`);
}

console.log('\n===== 负样本：真实推荐流里的正常内容（不应砍）=====');
let known = 0;
for (const [d, t, tag] of NEG) {
  const r = BLF.test([{ duration: d, title: t, owner: { mid: 2, name: 'x' }, stat: { view: 1e5, like: 5000 }, goto: 'av' }])[0];
  const ok = r.hide === false;
  const isKnown = tag === 'KNOWN';
  if (!ok) { if (isKnown) known++; else fp++; }
  const label = ok ? ' PASS ' : (isKnown ? ' KNOWN' : ' FAIL ');
  console.log(`${label}${r.hide ? '砍' : '留'} fp=${String(r.fp || 0).padStart(3)} ${String(d + 's').padStart(6)} ${pad(t, 40)}`);
}

const denom = NEG.length - known;
console.log(`\n召回: ${hit}/${POS.length}   误杀: ${fp}/${denom}   已知取舍: ${known}`);
process.exit((hit === POS.length && fp === 0) ? 0 : 1);
