// 覆盖率审计：量化"低价值类别"的拦截率，并断言知识类不被误伤。
//
// 为什么需要这个：脚本靠一条条加主题规则工作，每加一类都可能误伤相邻的知识内容。
// 这个测试把两类样本固定下来：
//   1. 知识类（必须全留）—— 硬断言，任何一条被拦都算失败
//   2. 低价值类（覆盖率报告）—— 只统计，不断言，用来观察规则集是否在变好
//
// 用法：node coverage-test.js
//       退出码非 0 = 知识类被误伤，必须修。

const fs = require('fs'), vm = require('vm');

let src = fs.readFileSync(__dirname + '/bilibili-filter.user.js', 'utf8');
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
sb.localStorage = {
  _s: {},
  getItem(k) { return this._s[k] ?? null; },
  setItem(k, v) { this._s[k] = String(v); },
};
sb.getComputedStyle = () => ({ position: 'static' });
sb.setInterval = () => 0;
vm.createContext(sb);
vm.runInContext(src, sb);
const BLF = sb.window.__BLF;

function judge(title, duration = 300) {
  return BLF.test([{
    duration, title,
    owner: { mid: 1, name: '测试UP' },
    stat: { view: 1e5, like: 5000 },
    goto: 'av',
  }])[0];
}

// ---- 知识类：一条都不能拦 ----
const KNOWLEDGE_MUST_KEEP = [
  // 物理 / 数学
  '为什么天空是蓝色的：瑞利散射',
  '量子力学中的观察者效应',
  '相对论是怎么被验证的',
  '概率论入门：期望值是什么',
  // 文学 / 艺术
  '唐诗的格律是怎么形成的',
  '文艺复兴时期的透视法革命',
  '贝多芬第九交响曲的结构分析',
  '文学史：从诗经到唐诗的演变',
  '艺术史入门：文艺复兴三杰',
  // 历史 / 社会
  '中国考古学百年：从疑古到重建',
  '基尼系数与社会流动性：一份实证研究',
  '社会学：精英再生产理论是怎么提出的',
  '布迪厄的文化资本理论',
  // 认知科学
  '认知心理学：工作记忆的容量极限',
  '认知失调：为什么人会为自己的错误辩护',
  // 职业体验（不是情感体验）
  '在故宫修文物是怎样的体验',
  '当外科医生是怎样的体验',
  // 游戏作为文化（不是玩游戏）
  '游戏设计中的关卡节奏：为什么马里奥第一关这么好玩',
  '电子游戏史：从《太空侵略者》到开放世界',
];

// ---- 低价值类：只报告覆盖率 ----
const LOW_VALUE = {
  '职场叙事': [
    '我裸辞后的一年，彻底想通了',
    '35岁被裁员，我做了这个决定',
    '在大厂打工的真实一天',
    '月薪三千怎么活出月入三万的样子',
  ],
  '育儿鸡汤': [
    '孩子发脾气时，聪明妈妈都这样做',
    '婆婆帮我带娃三年，最后闹翻了',
    '要不要给孩子报补习班',
  ],
  '颜值穿搭': [
    '这个秋冬最显白的穿搭公式',
    '脸型不完美怎么修容',
    '我花三万块做了这些医美',
  ],
  '减肥身材': [
    '一个月瘦20斤，我只做了三件事',
    '减脂期到底该怎么吃',
    '为什么你喝水都胖',
  ],
  '装修家居': [
    '装修踩过的12个坑，全是血泪',
    '小户型怎么装出大空间',
  ],
  '心理测试': [
    '测测你的MBTI人格类型',
    '选一张图看出你的隐藏性格',
    '焦虑自测量表',
  ],
  '网络热点': [
    '这件事反转了，真相是什么',
    '全网都在吵的那个视频，我想说几句',
  ],
  '生活方式': [
    '独居第五年，我的生活是这样的',
    '极简生活一年，我扔掉了这些东西',
  ],
  '明星动态': [
    '他凭什么红，我想不通',
    '这个组合解散后各自怎样了',
  ],
  '军事爽文': [
    '美军这次栽了，原因很现实',
    '这场战争背后的真正原因',
  ],
  '探店美食': [
    '这家店排队两小时，值不值',
    '在家复刻米其林三星',
    '街头小吃探访',
  ],
  '成功学话术': [
    '身处顶尖0.01%的人群，我发现他们想的和普通人完全不一样',
    '顶尖1%的人都在想什么',
    '认知觉醒：为什么你越努力越穷',
    '阶层跨越的底层逻辑',
    '混得好的人都有这几个习惯',
  ],
  '游戏内容': [
    '炉石传说新版本卡组推荐，这套战士上分太稳了',
    '影之刃零全流程攻略，无伤通关BOSS战',
    '我的世界地牢探索，全结构讲解',
  ],
};

let bad = 0;
console.log('\n===== 知识类：必须保留（硬断言）=====');
for (const t of KNOWLEDGE_MUST_KEEP) {
  const r = judge(t);
  const pass = r.hide === false;
  if (!pass) bad++;
  console.log(`${pass ? ' PASS ' : ' FAIL '}${r.hide ? '砍' : '留'} ${t}${r.hide ? '  ← ' + r.why.join(' ') : ''}`);
}

console.log('\n===== 低价值类：覆盖率报告（不断言）=====');
let tot = 0, hit = 0;
for (const [group, titles] of Object.entries(LOW_VALUE)) {
  const res = titles.map((t) => ({ t, r: judge(t) }));
  const n = res.filter((x) => x.r.hide).length;
  tot += titles.length; hit += n;
  const flag = n === titles.length ? '✅' : (n === 0 ? '❌' : '△ ');
  console.log(`\n${flag} 【${group}】 ${n}/${titles.length}`);
  res.filter((x) => !x.r.hide).forEach((x) => console.log('     漏:', x.t));
}
console.log(`\n低价值总覆盖率: ${hit}/${tot} = ${Math.round(hit / tot * 100)}%`);
console.log(`知识类误伤: ${bad}/${KNOWLEDGE_MUST_KEEP.length}`);

process.exit(bad === 0 ? 0 : 1);
