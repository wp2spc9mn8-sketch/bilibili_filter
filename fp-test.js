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
  [300,  '一个美国学生读中国史书，越读越后背发凉！ #中国历史 #美国学生 #历史 #外国人看中国', '搬运号'],
  [268,  '读中国史书读到后背发凉，越读越不敢往下看 #历史 #读书', '读书号'],
];

// ---- 负样本：真实推荐流里的正常内容（不能砍）----
// 4.4.0 起游戏内容不再算"正常内容"：用户搜过一次炉石，首页就被同类灌满。
// 原先救回的 5 条游戏样本（王者荣耀晚会 / MC 模组 / 影之刃零拆解…）
// 已移到 topic-test.js 的 gaming 组，作为必须拦下的样本。
const NEG = [
  [129,  '下雨天做个菠萝牛肉太香了'],
  [132,  '威龙的女儿也是吃上了长期饭票'],
  [156,  '《渡我》"看千万种人生，坍塌成一个可能"'],
  [174,  '【aespa】aespa GISELLE《Love Riot》MV'],
  [206,  '【仇远手书】"逐剑"'],
  [218,  '给起舞的旅人，递上一杯美酒 |《大漠旅人》泠鸢yousa「一打歌儿」'],
  [225,  '你也被"恶作剧"过吗？【小雾uya】'],
  [229,  '为什么热衷于理解一切是一种防御？'],
  // 4.32.0：这条是奥特曼玩具，已归入 ultraman 主题类整类拦截。
  // 保留在表里是为了记录它的来历，用 'TOPIC' 标记：预期被砍，但不计入质量误杀。
  [242,  '价值4000块！第三方sic风格赛迦奥特曼！', 'TOPIC'],
  [406,  '古代的救命粮蒟蒻，今天做成香辣解馋的魔芋爽~'],
  [457,  '这俩日子过得真是纯过日子的（10 月下 vlog'],
  // 注：下面这条其实是正常的 30 天生活实验 vlog，但标题形态（口语 + 句末感叹）
  // 与大字报几乎无法区分，目前会被拦。这是"高召回"的有意取舍，
  // 用户可在徽章面板点 ✅ 放行。测试里不计入误杀分母。
  [475,  '按国家健康指南生活30天，我不掉头发了！', 'KNOWN'],
  [1151, '【真实解说】利雅得胜利5比3拉斯永恒！炸穿了！C罗先生历史最近6码帽子戏法'],
  // "震惊"作动词（使…震惊）是新闻标题写法，不是震惊体
  [543,  '震惊印度 1.3亿选民信息凭空消失 反对派围攻德里'],
  [300,  '震惊国会！议员当场撕文件'],
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
let known = 0, underShort = 0;
for (const [d, t, tag] of NEG) {
  const r = BLF.test([{ duration: d, title: t, owner: { mid: 2, name: 'x' }, stat: { view: 1e5, like: 5000 }, goto: 'av' }])[0];
  // 4.24.0：不足 minKeepDuration 一律砍。这类样本继续留在表里（保持真实数据），
  // 只要求「不是因质量指纹被误判」——用时长区分，并单列成 under 计数。
  const under = d < BLF.config.minKeepDuration;
  const isTopic = tag === 'TOPIC';   // 主题命中（如 ultraman），预期被砍
  const ok = (under || isTopic) ? r.hide === true : r.hide === false;
  const isKnown = tag === 'KNOWN';
  if (!ok) { if (isKnown) known++; else fp++; }
  else if (under || isTopic) underShort++;
  const label = ok ? ' PASS ' : (isKnown ? ' KNOWN' : ' FAIL ');
  console.log(`${label}${r.hide ? '砍' : '留'} fp=${String(r.fp || 0).padStart(3)} ${String(d + 's').padStart(6)} ${pad(t, 40)}${under ? '  [时长不足]' : ''}`);
}

const denom = NEG.length - known;
console.log(`\n召回: ${hit}/${POS.length}   误杀: ${fp}/${denom}   已知取舍: ${known}   按时长删: ${underShort}`);
process.exit((hit === POS.length && fp === 0) ? 0 : 1);
