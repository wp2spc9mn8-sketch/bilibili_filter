// ==UserScript==
// @name         Bilibili 低质营销号过滤
// @namespace    local.kent.blf
// @charset      UTF-8
// @version      4.2.0
// @description  过滤 B 站首页推荐流里的短时长大字报 / 营销号视频：时长 + 标题话术 + UP主黑名单 组合判定
// @author       kent
// @match        https://www.bilibili.com/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ======================= 配置区（改这里就行） ======================= */
  const CONFIG = {
    // 档位：off 关闭 | light 只杀标题明确的 | balanced 标题+时长组合 | aggressive 最严
    mode: 'aggressive',
    aggressiveMax: 120,  // 短于此秒数：走更低的指纹门槛
    shortFpThreshold: 2, // 短视频门槛：大字报的标题多半带口语/标题党特征
    fpThreshold: 3,      // 2-10 分钟区间：文案指纹达到几分就砍
    fpLongThreshold: 4,  // 10 分钟以上：要求略严
    shortDuration: 30,   // 秒：极短。只要有 1 个营销信号就判死
    minDuration: 60,     // 秒：短。需要 1 个以上信号
    softDuration: 90,    // 秒：偏短。需要 2 个信号
    longDuration: 180,   // 秒：长视频豁免区（≥此长度且信号 <2 一律保留）
    keepAtLeast: 2,      // 每批推荐保底保留条数，防止把首页刷空

    // ---- 主题屏蔽（与"内容质量"无关，纯话题偏好）----
    // 命中即拦，不看时长和文案分数。规则表见 TOPICS。
    topics: {
      gender: true,        // 两性对立 / 性别引战
      relationship: true,  // 情感关系 / 婚恋八卦
      exam: true,          // 考公考研培训
      accident: true,      // 车祸事故
      comedy: true,        // 搞笑段子
      // ---- 粗俗 / 低质娱乐 ----
      vulgar: true,        // 低俗粗鄙：猎奇死亡、恶心物、擦边、粗口
      gossip: true,        // 娱乐八卦：绯闻、塌房、红毯比美
      hustle: true,        // 搞钱割韭菜：副业、月入过万、卖课
      superstition: true,  // 玄学迷信：算命、风水、转运
      gambling: true,      // 赌博博彩：赌球、彩票、盘口
      binge: true,         // 吃播暴食：大胃王、生吃、暴食
      flame: true,         // 引战撕逼：地域黑、骂战、拉踩
      lowbrow: true,       // 土味低智：社会摇、装疯卖傻、扮丑
    },

    hideLive: false,     // true = 连直播卡片一起隐藏
    showBadge: true,     // 右下角显示过滤计数徽章
    debug: false,        // true = 控制台打印每条判定
  };
  /* =================================================================== */

  const VERSION = '4.2.0';

  let stats = { apiHidden: 0, apiSeen: 0, domHidden: 0, domSeen: 0, linkCount: 0 };

  const LS_KEY = 'blf:blacklist';
  const LS_WHITE = 'blf:whitelist';
  const TAG = '[BLF]';

  /* ---------------------------- 黑名单存储 ---------------------------- */
  const store = {
    all() {
      try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }
      catch { return {}; }
    },
    has(mid) { return mid != null && String(mid) in this.all(); },
    add(mid, name) {
      if (mid == null) return;
      const b = this.all();
      b[String(mid)] = name || String(mid);
      localStorage.setItem(LS_KEY, JSON.stringify(b));
      log('已加入黑名单:', mid, name);
    },
    remove(mid) {
      const b = this.all();
      delete b[String(mid)];
      localStorage.setItem(LS_KEY, JSON.stringify(b));
    },
  };

  // 白名单：被误杀的 UP 主点 ✅ 后永不屏蔽。
  // 这是误杀的唯一可靠兜底 —— 规则再聪明也会错判个别内容。
  const allow = {
    all() {
      try { return JSON.parse(localStorage.getItem(LS_WHITE) || '{}'); }
      catch { return {}; }
    },
    has(mid) { return mid != null && String(mid) in this.all(); },
    add(mid, name) {
      if (mid == null) return;
      const w = this.all();
      w[String(mid)] = name || String(mid);
      localStorage.setItem(LS_WHITE, JSON.stringify(w));
      // 白名单和黑名单互斥，避免状态矛盾
      store.remove(mid);
      log('已加入白名单:', mid, name);
    },
    remove(mid) {
      const w = this.all();
      delete w[String(mid)];
      localStorage.setItem(LS_WHITE, JSON.stringify(w));
    },
  };

  function log(...a) { if (CONFIG.debug) console.log(TAG, ...a); }

  /* -------------------------- 低质 UP 主累计 --------------------------- */
  // 营销号是批量生产的：同一个号连续出「强营销」内容，就把它整个拉黑。
  // 只接受强信号（营销词 / 价格锚点）计数，不拿结构类分数连坐，
  // 否则一条围棋题、一篇技术讲解就能把正经 UP 主送走。
  // 权威媒体的短新闻不该被"短的一律砍"误伤。
  // 精确匹配，避免 "央视视角" 这类蹭名字的号蒙混过关。
  const OFFICIAL = /^(新华社|新华网|央视新闻|央视军事|央视网|央视财经|央视一套|人民日报|人民日报海外版|中国军号|共青团中央|观察者网|解放军报|中国日报|环球时报|中央广播电视总台|CCTV|CGTN)$/;

  const LS_COUNTS = 'blf:counts';
  const HARD_MARK = /营销词|价格锚点|顶级\+价格/;
  const countedKeys = new Set();

  function bumpQuality(mid, author, key, kind) {
    if (!mid || countedKeys.has(key)) return;
    countedKeys.add(key);
    const bucket = kind === 'topic' ? 't' : 'q';
    const threshold = kind === 'topic' ? 3 : 2;
    let c = {};
    try { c = JSON.parse(localStorage.getItem(LS_COUNTS) || '{}'); } catch { c = {}; }
    if (store.has(mid)) return;
    const k = bucket + ':' + mid;
    c[k] = (c[k] || 0) + 1;
    try { localStorage.setItem(LS_COUNTS, JSON.stringify(c)); } catch { /* 忽略 */ }
    if (c[k] >= threshold) {
      store.add(mid, author);
      log('自动拉黑 UP 主:', author, mid,
        '累计', c[k], '条', kind === 'topic' ? '指定话题内容' : '强营销内容');
    }
  }

  /* ---------------------------- 计数徽章 ------------------------------ */
  let badgeEl = null;
  function updateBadge() {
    if (!CONFIG.showBadge) return;
    if (!document.body) return;
    if (!badgeEl) {
      badgeEl = document.createElement('div');
      badgeEl.id = 'blf-badge';
      badgeEl.style.cssText = [
        'position:fixed', 'right:14px', 'bottom:14px', 'z-index:2147483000',
        'padding:5px 10px', 'border-radius:14px', 'cursor:pointer',
        'background:rgba(0,0,0,.62)', 'color:#fff', 'font-size:12px',
        'font-family:-apple-system,sans-serif', 'line-height:1.5',
        'user-select:none', 'backdrop-filter:blur(4px)',
        'border:1px solid rgba(255,255,255,.18)',
        'opacity:.55', 'transition:opacity .2s',
      ].join(';');
      badgeEl.title = 'B 站低质内容过滤：点击查看/收起明细';
      badgeEl.addEventListener('mouseenter', () => { badgeEl.style.opacity = '1'; });
      badgeEl.addEventListener('mouseleave', () => { badgeEl.style.opacity = '.55'; });
      badgeEl.addEventListener('click', () => showPanel());
      document.body.appendChild(badgeEl);
    }
    const hid = stats.apiHidden + stats.domHidden;
    const seen = stats.apiSeen + stats.domSeen;
    if (degraded) {
      badgeEl.textContent = '🛡 v' + VERSION + ' 降级（判定异常，点击查看）';
      badgeEl.style.background = 'rgba(150,40,40,.85)';
      return;
    }
    badgeEl.textContent = '🛡 v' + VERSION + ' ' + CONFIG.mode + ' 拦 ' + hid + ' / 扫 ' + seen;
  }

  /* --------------------------- 拦截记录面板 --------------------------- */
  // 卡片被隐藏后就看不见了，误杀无处申诉。这里留一份最近记录，
  // 点徽章可以逐条查看原因，并对误杀点 ✅ 永久放行。
  const recentHidden = [];
  const MAX_RECENT = 60;

  function recordHidden(info, verdict) {
    if (!info || (!info.title && info.duration == null)) return;
    const key = (info.mid || '') + '|' + (info.title || '');
    if (recentHidden.some((r) => r.key === key)) return;
    recentHidden.unshift({
      key, mid: info.mid, author: info.author, title: info.title,
      dur: info.duration, fp: verdict.fp, why: verdict.reason || '',
      topic: verdict.topic || null,
      ts: Date.now(),
    });
    if (recentHidden.length > MAX_RECENT) recentHidden.length = MAX_RECENT;
  }

  let panelEl = null;

  function showPanel() {
    if (panelEl) { panelEl.remove(); panelEl = null; return; }

    const el = document.createElement('div');
    el.id = 'blf-panel';
    el.style.cssText = [
      'position:fixed', 'right:14px', 'bottom:52px', 'width:420px',
      'max-height:70vh', 'overflow:auto', 'z-index:2147483000',
      'background:rgba(24,24,28,.96)', 'color:#eee', 'font-size:12px',
      'font-family:-apple-system,sans-serif', 'line-height:1.6',
      'border-radius:12px', 'padding:12px', 'box-shadow:0 8px 32px rgba(0,0,0,.5)',
      'border:1px solid rgba(255,255,255,.14)', 'backdrop-filter:blur(8px)',
    ].join(';');

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px';
    const bl = Object.keys(store.all()).length;
    const wl = Object.keys(allow.all()).length;
    head.innerHTML = '<b>最近拦截 ' + recentHidden.length + ' 条</b>' +
      '<span style="opacity:.6;font-size:11px">黑名单 ' + bl + ' · 白名单 ' + wl + '</span>';
    el.appendChild(head);

    if (!recentHidden.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'opacity:.6;padding:12px 0';
      empty.textContent = '这一屏没有拦截记录。';
      el.appendChild(empty);
    }

    recentHidden.forEach((r) => {
      const row = document.createElement('div');
      row.style.cssText = 'padding:7px 0;border-top:1px solid rgba(255,255,255,.09)';

      const title = document.createElement('div');
      title.textContent = r.title || '(无标题)';
      title.style.cssText = 'color:#fff;margin-bottom:2px';
      row.appendChild(title);

      const meta = document.createElement('div');
      meta.style.cssText = 'opacity:.62;font-size:11px;display:flex;gap:8px;align-items:center';
      const info = document.createElement('span');
      info.textContent = (r.author || '?') + ' · ' + (r.dur != null ? r.dur + 's' : '?') + ' · fp=' + r.fp;
      meta.appendChild(info);

      // 主题命中的格外显眼：这不是"质量差"，是"你不看的题材"
      if (r.topic) {
        const tag = document.createElement('span');
        tag.textContent = (TOPICS[r.topic] && TOPICS[r.topic].label) || r.topic;
        tag.style.cssText = [
          'background:rgba(210,110,60,.32)', 'color:#ffd9c2',
          'border:1px solid rgba(255,150,100,.35)',
          'border-radius:5px', 'padding:0 6px', 'font-size:10px',
        ].join(';');
        meta.appendChild(tag);
      }

      if (r.mid) {
        const okBtn = document.createElement('button');
        okBtn.textContent = '✅ 放行';
        okBtn.title = '把这个 UP 主加入白名单，以后永不屏蔽';
        okBtn.style.cssText = [
          'margin-left:auto', 'border:1px solid rgba(255,255,255,.25)',
          'background:rgba(80,160,90,.3)', 'color:#d8ffd8', 'cursor:pointer',
          'border-radius:6px', 'padding:1px 7px', 'font-size:11px',
        ].join(';');
        okBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          allow.add(r.mid, r.author);
          // 立刻恢复这个 UP 主当前页面上被隐藏的所有卡片
          document.querySelectorAll('a[href*="space.bilibili.com/' + r.mid + '"]')
            .forEach((a) => {
              const c = a.closest(CARD_SEL) || findCard(a);
              if (c && c.dataset.blfHidden) {
                c.style.removeProperty('display');
                delete c.dataset.blfHidden;
              }
            });
          row.style.opacity = '0.45';
          okBtn.textContent = '已放行';
          okBtn.disabled = true;
        });
        meta.appendChild(okBtn);
      }
      row.appendChild(meta);

      if (r.why) {
        const why = document.createElement('div');
        why.textContent = r.why;
        why.style.cssText = 'opacity:.45;font-size:10px;margin-top:1px';
        row.appendChild(why);
      }
      el.appendChild(row);
    });

    document.body.appendChild(el);
    panelEl = el;
  }


  /* ---------------------------- 主题屏蔽规则 ----------------------------
     用户不想看的话题类别，与内容质量无关：一条拍得挺好的情感视频照样不要。
     每类分三级：
       strong —— 命中即拦（词本身足够专指这个题材）
       weak   —— 需要同时命中 weakNeed 个才算（词有歧义，比如"分手"也可能是歌名）
       exempt —— 命中则不拦（学术讨论、正经音乐、真运动项目等）
     设计原则：宁可漏一点，也不能把正常内容大词一网打尽。          */
  const TOPICS = {
    gender: {
      label: '两性对立',
      strong: [
        /拳师|女拳|男拳/,
        /田园女权|极端女权|女权婊/,
        /直男癌|凤凰男|扶弟魔|妈宝男/,
        /性别对立|男女对立|两性对立/,
        /天价彩礼|彩礼/,
        /剩女|剩男/,
        /男人没一个好东西|女人都一个样/,
        /男女.*(战争|对立|矛盾)/,
        /男人的底线|女人的底线|男女博弈|男女关系|男女之间/,
        /抢亲|婚礼现场.*(闹|抢)/,
        /(女生|女孩|女人).*(结婚|物质|现实|拜金)/,
        /(男生|男孩|男人).*(结婚|物质|现实)/,
        /不愿意结婚|不想结婚|结婚要多少/,
      ],
      weak: [/男女/, /两性/, /性别/, /结婚/, /婚恋/, /物质/, /拜金/],
      weakNeed: 2,
      exempt: [
        /拳击|格斗|散打|UFC|MMA|搏击|拳台/,          // 真运动，不是"打拳"
        /社会学|人类学|性别研究|学术|论文|社会调查/,   // 严肃讨论
        /人口学|人口统计|人口结构|调研报告|研究报告|数据分析/,
        /平权|同工同酬|女性权益/,
      ],
    },

    relationship: {
      label: '情感关系',
      strong: [
        /出轨|劈腿|小三|婚外情|绿帽/,
        /恋爱脑|情感导师|情感专家|PUA/,
        /婆媳|婆婆和媳妇|媳妇和婆婆|婆家|娘家妈|离婚冷静期|婚内/,
        /渣男|渣女|绿茶|白莲/,
        /异地恋|相亲角|相亲市场|相亲对象/,
        /恋爱多年|恋爱五年|恋爱三年/,
      ],
      // 注意：weak 必须一词一正则。写成 /a|b|c/ 只算 1 个命中，weakNeed 永远达不到。
      weak: [/分手/, /复合/, /前任/, /暗恋/, /表白/, /相亲/, /异地恋/, /备胎/, /暧昧/],
      weakNeed: 2,   // 两个词同时出现才拦；单个词在歌名影评里太常见
      exempt: [
        /MV|PV|OP|ED|翻唱|歌曲|歌单|纯音乐|钢琴|吉他|演唱/,
        /电影|剧集|影评|纪录片|短片|动画/,
        /心理学|心理学研究|依恋理论|社会调查/,
      ],
    },

    exam: {
      label: '考公考研',
      strong: [
        /考公|公考|国考|省考|事业编|选调生/,
        /考研|初试|复试|调剂/,
        /押题|保过|包过|一对一辅导|培训班|网课|冲刺班/,
        /选岗|报考指南|岗位表|招录/,
      ],
      weak: [/备考/, /复习/, /真题/, /模拟题/, /面试技巧/, /上岸/],
      weakNeed: 2,
      exempt: [/大学|高校|教务处|招生简章(?!.*(培训|押题))/],
    },

    accident: {
      label: '车祸事故',
      strong: [
        /车祸|交通事故|追尾|相撞|撞车|肇事/,
        /事故现场|行车记录仪|监控拍下|监控视频/,
        /血肉模糊|惨烈|当场死亡/,
        /千万别跟车|别跟太近|大货车/,
      ],
      weak: [/失控/, /撞上/, /撞击/, /翻车/],
      weakNeed: 2,
      exempt: [
        /交通安全|交通法规|道路设计|安全驾驶|事故统计|事故率/,
        /责任认定|法条|立法|保险理赔|理赔流程/,
        /选购|测评|评测|开箱|推荐|怎么选/,   // 行车记录仪选购之类是数码内容
        /翻车/,      // 网络语"翻车"=出糗，不算车祸；单独出现在 weakNeed 里也不够
      ],
    },

    comedy: {
      label: '搞笑段子',
      strong: [
        /沙雕|整活|鬼畜|段子/,
        /笑死|笑不活|笑麻|笑到头掉|笑出猪叫/,
        /迷惑行为|人类迷惑|离谱操作/,
        /承包.{0,6}笑点/,
      ],
      weak: [/搞笑/, /魔性/, /爆笑/],
      weakNeed: 2,
      exempt: [
        /搞笑诺贝尔|Ig.?Nobel/,   // 正经科普，名字里带"搞笑"
        /相声|脱口秀|小品|喜剧电影|情景喜剧|喜剧片/,
        // 在讨论"怎么做出搞笑内容"，而不是搞笑内容本身
        /教程|怎么做|怎么制作|后期|幕后|创作|编剧|版权|分镜|剪辑技巧/,
      ],
    },

    // ---- 以下为"粗俗 / 低质娱乐"类：用户目标是获取知识，这些已偏离 ----

    vulgar: {
      label: '低俗粗鄙',
      strong: [
        // 猎奇死亡 / 身体伤害的围观
        /被电死|触电身亡|电死|惨死|死状|尸体|尸块|裹尸/,
        // 排泄物与恶心物
        /粪坑|屎|尿|呕吐|呕吐物|蛆|蟑螂窝|下水道里/,
        // 低俗擦边
        /擦边|软色情|福利姬|走光|偷拍|裙底|内衣秀|裸泡|真裸|脱衣/,
        // 粗口
        /傻逼|智障|狗东西|滚你|妈的|他妈的|操你/,
      ],
      weak: [/裸/, /脱/, /恶心/, /变态/, /猥琐/],
      weakNeed: 3,
      exempt: [
        // 严肃内容：医学、法医、环保、生物、解剖
        /医学|医生|医院|临床|病理|解剖|法医|尸检|尸僵/,
        /污水处理|下水道工程|环卫|环境保护|垃圾分类/,
        /昆虫|生物学|生态学|昆虫学|物种/,
        // 正经的性教育 / 两性健康科普
        /性教育|性健康|生殖健康|妇科|男科|避孕|防性侵|自我保护/,
        // 影视作品里的正常讨论
        /影评|剧评|解说|剧情|角色分析/,
      ],
    },

    gossip: {
      label: '娱乐八卦',
      strong: [
        /绯闻|恋情曝光|官宣恋情|分手内幕|离婚内幕|塌房|实锤/,
        // "爆料"单用太宽（游戏技能爆料、新品爆料），必须带八卦语境
        /(恋情|婚变|私生活|黑料|丑闻|内幕).{0,4}爆料|爆料.{0,4}(恋情|婚变|私生活|黑料|丑闻)/,
        /偷腥|夜会|密会|同回酒店|恋情坐实/,
        /红毯|颁奖礼.*(造型|翻车|比美)/,
        /私生活|情史|黑料|污点/,
      ],
      weak: [/明星/, /网红/, /爱豆/, /顶流/, /流量/, /瓜/, /吃瓜/, /热搜/],
      weakNeed: 2,
      exempt: [
        // 影视作品本身的讨论
        /影评|剧评|影史|作品|角色|演技|导演|编剧|摄影|配乐|票房/,
        /产业|市场|商业模式|经纪公司|偶像工业|粉丝经济/,
        /纪录片|访谈|专访|演讲/,
        // 游戏 / 数码领域的"爆料"完全是另一回事
        /游戏|手游|端游|干员|角色|技能|版本|更新|前瞻|预告/,
        /数码|新品|发布会|评测|开箱|显卡|手机/,
      ],
    },

    hustle: {
      label: '搞钱割韭菜',
      strong: [
        /副业|躺赚|睡后收入|被动收入|副业刚需/,
        /月入过万|月入十万|年入百万|日入\d+|轻松赚/,
        /暴富|一夜暴富|财富自由|搞钱|教你赚钱|带你赚钱/,
        /割韭菜|知识付费|私域|引流|裂变|变现/,
        /0基础.*(赚钱|变现|入门)|宝妈.*(赚钱|副业)/,
      ],
      weak: [/兼职/, /理财/, /投资/, /创业/, /课程/, /训练营/],
      weakNeed: 3,
      exempt: [
        // 正经的经济 / 商业 / 金融内容
        /经济学|金融学|宏观|微观|货币政策|财政|通货膨胀/,
        /商业模式|企业史|公司史|创业史|商业分析|财报/,
        /投资学|资产配置|风险管理|价值投资|指数基金/,
        /理财规划|家庭财务|记账|储蓄/,
      ],
    },

    superstition: {
      label: '玄学迷信',
      strong: [
        /算命|看相|批八字|紫微斗数|生辰八字|改命|转运/,
        /风水|看风水|阴宅|阳宅|堪舆/,
        /开光|符咒|法事|驱邪|招魂|通灵|前世今生/,
        /招财|旺财|桃花运|化解太岁/,
      ],
      weak: [/星座/, /运势/, /本命年/, /水逆/, /占卜/, /塔罗/, /卦/],
      weakNeed: 2,
      exempt: [
        /天文学|天文|星座图|黄道|岁差|观测/,
        /民俗|民俗学|人类学|宗教史|文化史|神话学/,
        /统计学|概率|幸存者偏差|心理暗示|巴纳姆效应/,
        /历史|考据|文献/,
      ],
    },

    gambling: {
      label: '赌博博彩',
      strong: [
        /赌球|赌场|网赌|赌博|博彩|六合彩|百家乐|老虎机|轮盘/,
        /彩票|双色球|大乐透|竞猜|盘口/,
      ],
      weak: [/押注/, /庄家/, /赔率/, /下注/, /开奖/],
      weakNeed: 2,
      exempt: [
        /概率论|博弈论|数学|统计学|期望值|随机/,
        /反赌|戒赌|赌博危害|成瘾|心理干预/,
        /模拟器|游戏|桌游|棋牌/,
        /金融|衍生品|期权|期货/,
      ],
    },

    binge: {
      label: '吃播暴食',
      strong: [
        /大胃王|吃播|暴食|催吐/,
        /一口气吃|一次吃\d+|挑战吃\d+|\d+斤.*吃完/,
        /生吃|生吞|活吃/,
      ],
      weak: [/吃到饱/, /无限量/, /管够/, /狂吃/],
      weakNeed: 2,
      exempt: [
        /美食制作|烹饪|做法|食谱|教程|厨艺|探店/,
        /营养学|食品安全|食品科学|热量|膳食/,
        /挑战赛|比赛|竞技/,
      ],
    },

    lowbrow: {
      label: '土味低智',
      strong: [
        /土味|社会摇|精神小伙|葬爱|非主流/,
        /装疯卖傻|卖傻|扮丑|发癫|发疯/,
        /土味情话|土味视频/,
      ],
      weak: [/尬/, /沙雕/, /土/, /魔性/],
      weakNeed: 3,
      exempt: [
        // 在分析这种文化现象，而不是生产它
        /社会学|文化研究|亚文化|传播学|分析|解剖|考据/,
        /教程|怎么做|制作|幕后|编剧/,
        /地方|方言|民俗|乡土|乡村/,
        /歌剧|舞剧|话剧|交响/,
      ],
    },

    flame: {
      label: '引战撕逼',
      strong: [
        /地域黑|地图炮|互撕|开撕|撕逼|骂战/,
        /网络对骂|隔空对骂|公开对线/,
        /引战|挑事|带节奏|拉踩/,
        /diss|互喷|隔空喊话/,
      ],
      weak: [/喷子/, /杠精/, /骂/, /吵/],
      weakNeed: 3,
      exempt: [
        /社会学|传播学|媒体研究|舆论|舆情分析/,
        /法律|侵权|名誉权|网络暴力|治理/,
        /辩论|辩论赛|观点交锋/,
        // "对线"是 MOBA 术语（对线期），和引战无关
        /游戏|电竞|上号|开黑|段位|对局|英雄|赛季|上分/,
      ],
    },
  };

  // 匹配优先级：越硬的冒犯越先判定，这样面板里显示的原因是准确的。
  // （「走光瞬间合集，笑死」应该报"低俗"，而不是先被"笑死"当成搞笑段子）
  const TOPIC_ORDER = [
    'vulgar', 'gambling', 'binge', 'flame',
    'gossip', 'superstition', 'hustle', 'lowbrow',
    'gender', 'relationship', 'exam', 'accident', 'comedy',
  ];

  // 返回 { key, label, hit } 或 null
  function matchTopic(title) {
    const t = String(title || '');
    if (!t) return null;
    const order = TOPIC_ORDER.filter((k) => TOPICS[k])
      .concat(Object.keys(TOPICS).filter((k) => !TOPIC_ORDER.includes(k)));
    for (const key of order) {
      if (!CONFIG.topics[key]) continue;
      const cfg = TOPICS[key];

      // 先看豁免：命中任何一条就整类跳过
      if (cfg.exempt && cfg.exempt.some((re) => re.test(t))) continue;

      const strongHit = cfg.strong.find((re) => re.test(t));
      if (strongHit) {
        const m = t.match(strongHit);
        return { key, label: cfg.label, hit: m ? m[0] : '' , strong: true };
      }

      const need = cfg.weakNeed || 2;
      const weakHits = cfg.weak.filter((re) => re.test(t));
      if (weakHits.length >= need) {
        const m = t.match(weakHits[0]);
        return { key, label: cfg.label, hit: (m ? m[0] : '') + '×' + weakHits.length, strong: false };
      }
    }
    return null;
  }

  /* ---------------------------- 标题话术库 ----------------------------
     每一项算作"营销信号"。强信号权重 2，中等 1，弱 0.5。
     判定不看单项，看信号累计 + 时长的组合，避免误伤正常短视频。      */
  const STRONG = [
    /震惊|惊呆|惊呆了/, /万万没想到/, /炸裂|炸了/, /直接封神|封神了/, /破防/,
    /太离谱|离谱/, /划走/, /速看/, /看哭了|泪目/, /绷不住/, /谁懂啊/, /真的会谢/,
    /狠狠地/, /笑不活了/, /绝了|太绝了/, /封神/,
  ];
  const MEDIUM = [
    /没想到/, /建议收藏|先收藏|收藏起来/, /一定要/, /必看|必须看|看完你就|看完这个/,
    /揭秘|内幕|真相|背后真相/, /全网/, /涨知识|冷知识/, /干货/, /新手必/,
    /别再/, /后悔/, /注意了|提醒你/, /赶紧/, /(全网|排名|销量)第一/,
    /天花板|王炸|神仙|顶配/,
    /兑换码|限时|即将过期|马上删/,
  ];
  const WEAK = [
    /原来/, /竟然|居然/, /这才是/, /第一次|首个|首款/,
  ];

  /* ------------------------------------------------------------------ */
  /*                          标题信号分析                                */
  /* ------------------------------------------------------------------ */
  function analyzeTitle(title) {
    const t = String(title || '');
    let signals = 0;
    const hits = [];
    for (const re of STRONG) { if (re.test(t)) { signals += 2; hits.push(re.source.slice(0, 6)); } }
    for (const re of MEDIUM) { if (re.test(t)) { signals += 1; hits.push(re.source.slice(0, 6)); } }
    for (const re of WEAK)   { if (re.test(t)) { signals += 0.5; } }

    const bangs = (t.match(/[!！?？]/g) || []).length;
    // 光有感叹号不算营销，只算半个信号（必须叠加话术才定罪）
    if (bangs >= 3) { signals += 0.5; hits.push('标点堆叠'); }

    // 标题极短且无标点以外的信息量：轻微信号
    if (t.trim().length <= 5 && bangs === 0) { signals += 0.5; }

    return { signals, hits };
  }

  /* ------------------------------------------------------------------ */
  /*                     营销号文案指纹（大字报专用）                      */
  /*  2-10 分钟是大字报的重灾区：时长不短，标题却是典型营销号叙述句。      */
  /*  关键区分：正常内容自带栏目标记（【IGN】/万字精讲/P3/MV），          */
  /*           营销号是无标记的纯叙述句。                                */
  /* ------------------------------------------------------------------ */
  // 结构类信号（长度、逗号、句末标点、口语叙述…）是同一个现象的多个侧面，
  // 不是独立证据。无上限累加会让"为什么超市里很少见到鹅肉"这种正经科普
  // 拿到 10 分。所以单独记账并设上限，语义信号才不受限制。
  const STRUCT_CAP = 3;

  function marketingFingerprint(title) {
    const t = String(title || '').trim();
    const len = t.length;
    let struct = 0;   // 结构分：有上限
    let sem = 0;      // 语义分：营销词/价格/叙事/悬念等，无上限
    let neg = 0;      // 正常内容的减分
    const why = [];

    // ---- 正常内容的标记（负分）----
    let labelled = false;
    if (/【[^】]{1,24}】/.test(t)) { neg -= 2; labelled = true; }
    if (/[｜|]/.test(t)) { neg -= 1; labelled = true; }
    if (/#[^\s#]{1,14}/.test(t)) { neg -= 1; }
    if (/(MV|PV|OP|ED|vlog|Vlog|VLOG)\b/.test(t)) { neg -= 2; labelled = true; }
    // 注意：不含"指南/手册"——营销号最爱用"避坑指南"这类词装饰门面
    if (/攻略|实况|教程|讲解|评测|拆解|精讲|复盘|测评|开箱|合集|纪录片|花絮|混剪|手书|翻唱|直播回放/.test(t)) { neg -= 2; labelled = true; }
    if (/第[一二三四五六七八九十百\d]+[集期话章回卷]/.test(t)) { neg -= 2; labelled = true; }
    if (/[Pp]\d+\s*$/.test(t)) { neg -= 1; labelled = true; }
    if (/《[^》]{1,24}》/.test(t)) { neg -= 1; labelled = true; }

    // ---- 抽象概念词：学术/科普内容常用，营销号很少这么写 ----
    // （"为什么热衷于理解一切是一种防御？"是被误伤的心理学内容）
    if (/防御|机制|原理|效应|规律|定理|模型|算法|协议|函数|变量|认知|神经|哲学|伦理|美学|逻辑|范式|范畴|本质|边界|诺贝尔|实验|论文|研究|数据表明|人口学|统计学|经济学|社会学/.test(t)) {
      neg -= 2; why.push('学术词');
    }

    // ---- 强正常信号：英文专名 ----
    // 中文营销号几乎不会在标题里写英文技术名词，这条能救回技术类内容
    const ABBR = /^(AI|NPC|MV|PV|OP|ED|UP|VC|VR|AR|CG|TV|PC|PS|DJ|KTV|APP|GP|FPS|RPG|ACG|VLOG|DIY|3D|4K|8K|2K|HD|BD)$/i;
    const latin = (t.match(/\b[A-Za-z][A-Za-z0-9+#.]{2,}\b/g) || [])
      .filter((w) => !ABBR.test(w));
    if (latin.length) { neg -= 2; why.push('英文专名'); }

    // ---- 营销号标记（正分）----
    // 只按长度加分是不准的：中文长标题普遍如此，围棋题、技术讲解都中招。
    if (len >= 18) struct += 1;
    if (len >= 28) struct += 1;

    const commas = (t.match(/[，,]/g) || []).length;
    if (commas >= 2) { struct += 1; why.push('多短句'); }

    const q = (t.match(/[？?]/g) || []).length;
    const ex = (t.match(/[！!]/g) || []).length;
    if (/[！!？?。…]$/.test(t)) { struct += 1; why.push('句末标点'); }
    if (q >= 2) { struct += 1; why.push('双问句'); }
    // 省略号出现两次以上 = 拼凑感，正常标题很少这么用
    if ((t.match(/…+|\.{3,}/g) || []).length >= 2) { struct += 2; why.push('省略号堆叠'); }
    // 标点密度而非绝对数量：长标题天然标点多，不能一律算堆叠
    if (q + ex >= 4 && (q + ex) / Math.max(len, 1) >= 0.08) { struct += 1; why.push('标点密集'); }

    // 短标题还堆一堆感叹号/问号 = 典型标题党
    // （"免签！消费低！风景平替瑞士？"）正常内容很少这么写
    if (len < 22 && (q + ex) >= 3) {
      sem += 2; why.push('标题党标点');
    }

    // 引导互动 / 催促动作：营销号收尾的标准姿势
    if (/收藏[并起好]|记得收藏|一键三连|点赞关注|关注我|评论区|转发给|学起来|用起来/.test(t)) {
      sem += 2; why.push('引导互动');
    }

    // 空洞抒情句：字很多但没有任何可核查的信息
    // （"我们都在寻找自己的25号底片 却忘了自己就是答案本身"）
    if (len >= 18 && /的.{0,4}(本身|意义|答案|真相|模样|样子|尽头|开始|终点)|就是(你|我|自己|答案)/.test(t)) {
      sem += 2; why.push('空洞抒情');
    }

    // 空洞升华：把一件小事拔高到价值观层面，是大字报的口号式收尾
    if (/三观|正能量|格局|境界|人生|人性|良知|底线|初心|觉醒|顿悟|通透/.test(t)) {
      sem += 2; why.push('空洞升华');
    }

    // 这类"内容形态"本身就是营销号：盘点/揭秘/震惊体
    if (/震惊|盘点|揭秘|真相|内幕|鲜为人知|不为人知|无人知晓|尘封|绝唱|秘闻|野史|奇闻|重磅|惊呆了|千万不要告诉|偷偷看/.test(t)) {
      sem += 4; why.push('营销词');
    }
    // 价格锚点：带货营销号的标准姿势（"几十块买到世界顶尖"）
    // 正常内容说价格通常带具体数字与型号，很少用这种笼统锚点
    if (/几十块|几块钱|白菜价|仅需\s*\d|只要\s*\d|不到\s*\d+\s*[块元]|\d+\s*块[钱包]?搞定/.test(t)) {
      sem += 3; why.push('价格锚点');
    }
    // "世界顶尖/顶级/最强" + 低价 = 典型带货句式
    if (/世界(顶尖|顶级|级)|行业(顶尖|顶级)|国际大牌/.test(t) && /\d/.test(t)) {
      sem += 2; why.push('顶级+价格');
    }
    // 悬念 / 说教口吻。
    // 中性疑问词（为什么/为何/怎么）在正经科普里遍地都是，只给半分的分量；
    // 强悬念词（竟然/居然/背后/到底…）才是营销号口气。
    const susStrong = t.match(/竟然|居然|终于|原来|当年|背后|到底|看完|懂了|这才是|不为人知|无人知晓/g);
    const susWeak = t.match(/为何|为什么|怎么|如何/g);
    if (susStrong) { sem += 1; if (susStrong.length >= 2) sem += 1; }
    if (susWeak) { sem += 0.5; if (susWeak.length >= 2) sem += 0.5; }
    if (susStrong || susWeak) {
      why.push('悬念词x' + ((susStrong || []).length + (susWeak || []).length));
    }

    // 无栏目标记的口语叙述句 = 营销号最典型形态
    // 正常视频标题是名词短语（"45米高空坠物测试"），营销号是完整叙述（"我刚发现…结果…"）
    if (!labelled && len >= 14) {
      const colloquial = /了|着|过的|真是|太|就|还|都|才|又|怎么|什么|为什么|结果|后来|然后|居然|竟然|原来|其实|竟然|直接|简直/,
            hit = t.match(colloquial);
      if (hit) { struct += 1; why.push('口语叙述'); }
      // 无标记 + 长 + 句末标点 = 强叙述句
      if (len >= 20 && /[。！!？?…]$/.test(t)) { struct += 2; why.push('无栏目标记长句'); }
    }

    // 叙事悬念长句：营销号"讲故事"的标准写法
    // 例：工人在清理河底淤泥时，无意间发现…竟然是…
    // 这类句式几乎只在营销号里出现，给足权重
    if (len >= 36 && /竟然|无意间|结果|没想到|谁料|不料|发现自己/.test(t)) {
      sem += 3; why.push('叙事长句');
    }

    // 具体年份 + 长标题 = 历史叙事营销号的强特征
    if (/(19|20)\d{2}\s*年/.test(t) && len >= 20) { sem += 2; why.push('年份+长标题'); }
    else if (/\d{2,}\s*年[前后]|\d+年[前后]/.test(t)) { sem += 1; }

    // ---- 客观知识信号：用户来 B 站是为了获取知识，这类内容不该被误杀 ----
    // 营销号不会写"为什么超市里很少见到鹅肉"这种可核查的解释性问题。
    const KNOWLEDGE = /生物|动物|植物|物种|生态|进化|演化|起源|宇宙|天文|星系|地球|地质|岩石|气候|气象|物理|化学|数学|几何|代数|概率|统计|方程|定律|定理|医学|生理|解剖|病理|神经|基因|细胞|免疫|病毒|细菌|历史|考古|文献|朝代|语言学|心理学|哲学|工程|机械|电子|电路|通信|数据库|算法|养殖|种植|农作物|家禽|牲畜|农业|音乐|乐理|小调|大调|和弦|音阶|编曲|作曲|摄影|构图|光圈|快门|镜头|模组|MOD/i;
    const HARD_MARKETING = /震惊|盘点|揭秘|真相|内幕|鲜为人知|尘封|绝唱|秘闻|野史|奇闻|重磅|惊呆了|千万不要告诉|偷偷看/;
    if (KNOWLEDGE.test(t) && !HARD_MARKETING.test(t)) { neg -= 3; why.push('知识内容'); }

    // 现象解释疑问句：正经科普的标准写法（"为什么超市里很少见到鹅肉"）。
    // 只认描述客观量变的词，不认情绪疑问（"为什么会爱而不得"不该被救回）。
    if (/(为什么|为何|怎么).{2,}(很少|没有|不见|越来越多|越来越少|越来越贵|越来越便宜|更便宜)/.test(t)) {
      neg -= 3; why.push('现象解释');
    }

    // 结构分封顶，语义分不封顶 —— 结构特征是同一个现象的多个侧面，
    // 不能当独立证据累加。
    const fp = Math.min(struct, STRUCT_CAP) + sem + neg;
    return { fp, why, sem, struct: Math.min(struct, STRUCT_CAP) };
  }

  function parseDuration(text) {
    if (!text) return null;
    const parts = String(text).trim().split(':').map(Number);
    if (!parts.length || parts.some(Number.isNaN)) return null;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }

  // "18.8万" → 188000，"1.2亿" → 120000000，纯数字原样
  function parseCount(text) {
    if (text == null) return null;
    const m = String(text).trim().match(/([\d.]+)\s*([万亿]?)/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (Number.isNaN(n)) return null;
    if (m[2] === '万') return Math.round(n * 10000);
    if (m[2] === '亿') return Math.round(n * 100000000);
    return Math.round(n);
  }

  /* ------------------------------------------------------------------ */
  /*                          单条视频判定                                */
  /* ------------------------------------------------------------------ */
  function scoreItem(it) {
    const why = [];
    const owner = it.owner || {};

    // 关注过的 UP 主：永远保留（最高优先级，保底机制不可覆盖）
    if (it.is_followed === true) {
      return { score: 999, signals: 0, hide: false, hard: true, why: ['已关注'] };
    }
    // 手动放行：用户点过 ✅，永不屏蔽（优先级高于黑名单与所有规则）
    if (allow.has(owner.mid)) {
      return { score: 999, signals: 0, hide: false, hard: true, why: ['白名单:' + (owner.name || owner.mid)] };
    }
    // 手动拉黑：永远隐藏（保底机制不可覆盖）
    if (store.has(owner.mid)) {
      return { score: -999, signals: 99, hide: true, hard: true, why: ['黑名单:' + (owner.name || owner.mid)] };
    }

    const goto = it.goto || 'av';
    const d = Number(it.duration) || 0;
    const { signals, hits } = analyzeTitle(it.title);
    let sig = signals;
    if (hits.length) why.push('标题:' + hits.slice(0, 3).join(','));

    // 互动异常：高播放 + 极低点赞率 = 标题党典型
    const stat = it.stat || {};
    const view = Number(stat.view) || 0;
    const like = Number(stat.like) || 0;
    if (view >= 100000) {
      const ratio = like / view;
      if (ratio < 0.003) { sig += 2; why.push('点赞率极低'); }
      else if (ratio > 0.08) { sig -= 1; why.push('高点赞率'); }
    }

    const isVideo = goto === 'av' || goto === 'ogv' || goto === 'bangumi';
    if (CONFIG.hideLive && !isVideo) {
      return { score: -999, signals: 99, hide: true, hard: false, why: ['非视频流'] };
    }

    // 统一判定（与页面层共用同一套逻辑）
    const dec = decide(d, it.title, (it.owner || {}).name, it.owner && it.owner.mid);
    const hide = dec.hide;
    dec.why.forEach((w) => why.push(w));

    // 主题命中视为硬性拦截：用户明确不想看这类话题，不该被保底机制补回来
    const hard = !!dec.topic;

    const score = hide
      ? -100 - dec.fp * 10
      : Math.round(sig * 5 + Math.min(d / 600, 5));

    return { score, signals: sig, fp: dec.fp, hide, hard, topic: dec.topic, why };
  }

  /* ------------------------------------------------------------------ */
  /*        时长 + 标题 → 是否隐藏（接口层与页面层共用的唯一判定）          */
  /* ------------------------------------------------------------------ */
  function decide(d, title, author, mid) {
    const mode = CONFIG.mode;
    if (allow.has(mid)) return { hide: false, fp: 0, why: ['白名单'] };
    const why = [];
    const { signals, hits } = analyzeTitle(title);
    const { fp, why: fpWhy, sem } = marketingFingerprint(title);
    // 4.0 起不再区分语义/结构信号：大字报的标题往往干净得没有任何营销词，
    // 结构特征（口语叙述、无栏目标记的长句、标题党标点）才是主力判据。
    // 误杀由 UP 主白名单兜底 —— 点卡片上的 ✅ 即可永久放行。
    const tMid = CONFIG.fpThreshold;
    const tLong = CONFIG.fpLongThreshold;
    if (fpWhy.length) why.push('文案:' + fpWhy.slice(0, 3).join(','));

    if (mode === 'off') return { hide: false, fp, why: ['模式关闭'] };

    // 主题屏蔽先于一切质量判断：话题不想看就是不想看，
    // 跟这条视频拍得好不好、多长、文案几分没有关系。
    const topic = matchTopic(title);
    if (topic) {
      return {
        hide: true,
        fp,
        topic: topic.key,
        why: ['主题:' + topic.label + (topic.hit ? '(' + topic.hit + ')' : '')],
      };
    }

    if (!(d > 0)) return { hide: false, fp, why: ['时长未知，跳过'] };

    if (hits.length) why.push('话术:' + hits.slice(0, 2).join(','));
    let hide = false;

    // 分层策略：短视频用语术词库（敏感），中长视频用文案指纹（精准）
    if (mode === 'aggressive') {
      if (d < CONFIG.aggressiveMax) {
        // 短视频不看时长本身 —— 大量正常内容（游戏片段、绘画、美食）同样很短。
        // 按指纹判，但门槛比中长视频低一分。
        if (OFFICIAL.test(String(author || '').trim())) {
          why.push('权威媒体短新闻，放行');
        } else if (fp >= CONFIG.shortFpThreshold) {
          hide = true; why.unshift('低质短视频');
        }
      } else if (d <= 600) {
        if (fp >= tMid) { hide = true; why.unshift('大字报文案(2-10min)'); }
      } else if (fp >= tLong) {
        hide = true; why.unshift('大字报文案(长)');
      }
      // 长视频里的话术重灾区也兜一下
      if (!hide && signals >= 4) { hide = true; why.unshift('强营销话术'); }
    } else if (mode === 'light') {
      if (d < 60 && signals >= 2) { hide = true; why.unshift('极短+话术'); }
      else if (d < 120 && signals >= 3) { hide = true; why.unshift('短+话术'); }
      else if (d <= 600 && fp >= 8) { hide = true; why.unshift('强文案'); }
    } else {
      // balanced：几乎不误杀，只砍明确的
      if (d < 60 && signals >= 1) { hide = true; why.unshift('短+话术'); }
      else if (d < 120 && (signals >= 2 || fp >= 5)) { hide = true; why.unshift('短+话术'); }
      else if (d <= 600 && (fp >= 6 || signals >= 5)) { hide = true; why.unshift('中长+文案'); }
      else if (d > 600 && (fp >= 9 || signals >= 6)) { hide = true; why.unshift('长+极强文案'); }
    }

    return { hide, fp, why };
  }

  function filterItems(items) {
    const scored = items.map((it) => ({ it, ...scoreItem(it) }));
    if (CONFIG.debug) {
      scored.forEach((x) =>
        console.log(TAG, String(x.score).padStart(5), (x.it.duration || '?') + 's',
          '|', (x.it.owner || {}).name, '|', String(x.it.title).slice(0, 32),
          x.hide ? '❌' : '✅', x.why.join(' '))
      );
    }
    const keep = scored.filter((x) => !x.hide);
    // 保底：砍太狠时按分数从高到低补回，避免首页被清空。
    // 注意：绝不补回 hard 项（黑名单 / 已关注），否则手动屏蔽就失效了。
    if (keep.length < CONFIG.keepAtLeast) {
      const dropped = scored
        .filter((x) => x.hide && !x.hard)
        .sort((a, b) => b.score - a.score);
      while (keep.length < CONFIG.keepAtLeast && dropped.length) keep.push(dropped.shift());
    }
    const keepSet = new Set(keep.map((x) => x.it));
    const out = items.filter((it) => keepSet.has(it));
    stats.apiSeen += items.length;
    stats.apiHidden += items.length - out.length;
    updateBadge();
    return out;
  }

  /* ------------------------------------------------------------------ */
  /*                        接口层：拦截推荐流                            */
  /* ------------------------------------------------------------------ */
  function isFeedApi(url) {
    if (typeof url !== 'string') return false;
    return /\/x\/web-interface\/[^?]*feed\/rcmd/.test(url);
  }

  function rewriteFeedJson(json) {
    const data = json && json.data;
    if (!data) return json;

    if (Array.isArray(data)) {
      const out = filterItems(data);
      return out.length === data.length ? json : { ...json, data: out };
    }
    if (Array.isArray(data.item)) {
      const out = filterItems(data.item);
      return out.length === data.item.length ? json : { ...json, data: { ...data, item: out } };
    }
    return json;
  }

  // ---- fetch ----
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
      const p = origFetch.apply(this, args);
      if (!isFeedApi(url)) return p;
      return p.then(async (res) => {
        try {
          const text = await res.clone().text();
          const json = JSON.parse(text);
          const out = rewriteFeedJson(json);
          if (out === json) return res;
          const headers = new Headers(res.headers);
          headers.delete('content-length');
          return new Response(JSON.stringify(out), {
            status: res.status, statusText: res.statusText, headers,
          });
        } catch (e) {
          log('fetch 重写失败，回退原始响应', e);
          return res;
        }
      });
    };
  }

  // ---- XMLHttpRequest（老接口兜底）----
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url, ...rest) {
      this.__blfUrl = url;
      return origOpen.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (...args) {
      if (isFeedApi(this.__blfUrl)) {
        this.addEventListener('readystatechange', () => {
          if (this.readyState !== 4 || this.status !== 200) return;
          const rt = this.responseType;
          if (rt && rt !== 'text' && rt !== 'json') return;
          try {
            const raw = rt === 'json' ? this.response : JSON.parse(this.responseText);
            const out = rewriteFeedJson(raw);
            if (rt === 'json') {
              Object.defineProperty(this, 'response', { configurable: true, value: out });
            } else {
              Object.defineProperty(this, 'responseText', { configurable: true, value: JSON.stringify(out) });
            }
          } catch { /* 忽略，用原始响应 */ }
        });
      }
      return origSend.apply(this, args);
    };
  }

  /* ------------------------------------------------------------------ */
  /*                       DOM 层：兜底 + 一键屏蔽                        */
  /* ------------------------------------------------------------------ */
  const CARD_SEL = '.bili-video-card, .video-card-common, .feed-card, .bili-video-card__wrap';
  const DURATION_SEL = '.bili-video-card__stats__duration, .so-imgTag_rb, [class*="duration"]';
  const TITLE_SEL = '.bili-video-card__info--tit, h3, .title';

  // 一个视频卡片最多含几个视频链接。超过这个数说明选到了列表容器，
  // 隐藏它会把整片信息流清空 —— 必须拒绝。
  const MAX_LINKS_PER_CARD = 3;

  function linkCount(el) {
    if (!el || !el.querySelectorAll) return 0;
    return el.querySelectorAll('a[href*="/video/BV"], a[href*="/video/av"]').length;
  }

  function hideCard(card, reason) {
    if (!card || card.dataset.blfHidden) return;
    // 降级模式：判定出过错，只记录不隐藏，把控制权交回用户
    if (degraded) {
      stats.domHidden += 1;
      log('降级模式，未隐藏:', reason);
      return;
    }

    // 选卡片壳，但绝不选到列表容器
    let shell = card;
    const shellCand = card.closest(CARD_SEL);
    if (shellCand && linkCount(shellCand) <= MAX_LINKS_PER_CARD) shell = shellCand;

    if (linkCount(shell) > MAX_LINKS_PER_CARD) {
      // 连卡片本身都太大了，退回到最小的可隐藏单元
      shell = card;
      if (linkCount(shell) > MAX_LINKS_PER_CARD) {
        log('拒绝隐藏：目标含 ' + linkCount(shell) + ' 个视频，疑似列表容器');
        return;
      }
    }

    card.dataset.blfHidden = '1';
    shell.dataset.blfHidden = '1';
    shell.style.setProperty('display', 'none', 'important');
    stats.domHidden += 1;
    updateBadge();
    log('DOM 隐藏:', reason);
  }

  function cardInfo(card) {
    const authorLink = card.querySelector('a[href*="space.bilibili.com/"]');
    const midMatch = authorLink && (authorLink.getAttribute('href') || '').match(/space\.bilibili\.com\/(\d+)/);
    const durEl = card.querySelector(DURATION_SEL);

    // UP 名与发布时间常常挤在同一个链接里："明玥谈棋· 10月18日"
    const rawAuthor = authorLink ? authorLink.textContent.replace(/\s+/g, ' ').trim() : '';
    const sepAt = rawAuthor.lastIndexOf('·');
    const author = (sepAt > 0 ? rawAuthor.slice(0, sepAt) : rawAuthor).trim();
    const timeText = sepAt > 0 ? rawAuthor.slice(sepAt + 1).trim() : '';

    // 播放 / 弹幕：卡片底部两个数字项，第一个是播放量
    let watch = null;
    let danmaku = null;
    const statEls = card.querySelectorAll('[class*="stats--item"], [class*="stats__item"]');
    if (statEls.length) {
      watch = parseCount(statEls[0].textContent);
      if (statEls.length > 1) danmaku = parseCount(statEls[1].textContent);
    }

    // 标题：优先专用 class，再退回 h3，最后在 [title]/alt 里取最长的一条
    let title = '';
    const dedicated = card.querySelector(TITLE_SEL);
    if (dedicated) title = (dedicated.getAttribute('title') || dedicated.textContent || '').trim();
    if (!title) {
      const cands = [];
      card.querySelectorAll('[title]').forEach((el) => {
        const v = (el.getAttribute('title') || '').trim();
        if (v.length > 4) cands.push(v);
      });
      card.querySelectorAll('img[alt]').forEach((el) => {
        const v = (el.getAttribute('alt') || '').trim();
        if (v.length > 4) cands.push(v);
      });
      cands.sort((a, b) => b.length - a.length);
      title = cands[0] || '';
    }

    return {
      mid: midMatch ? midMatch[1] : null,
      author,
      published: timeText,
      duration: durEl ? parseDuration(durEl.textContent) : null,
      watch,
      danmaku,
      title,
    };
  }

  // 卡片右上角的「屏蔽此 UP」按钮，悬停出现
  function addBlockButton(card, info) {
    if (!info.mid || card.querySelector('.blf-block-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'blf-block-btn';
    btn.textContent = '⛔';
    btn.title = '屏蔽 UP 主：' + (info.author || info.mid);
    btn.style.cssText = [
      'position:absolute', 'top:6px', 'right:6px', 'z-index:99',
      'width:22px', 'height:22px', 'line-height:20px', 'padding:0',
      'border:none', 'border-radius:50%', 'cursor:pointer',
      'background:rgba(0,0,0,.55)', 'color:#fff', 'font-size:12px',
      'opacity:0', 'transition:opacity .15s',
    ].join(';');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      store.add(info.mid, info.author);
      document.querySelectorAll('a[href*="space.bilibili.com/' + info.mid + '"]')
        .forEach((el) => hideCard(el.closest(CARD_SEL) || findCard(el), '黑名单'));
      hideCard(card, '黑名单');
    });
    if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
    card.appendChild(btn);
    card.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
    card.addEventListener('mouseleave', () => { btn.style.opacity = '0'; });
  }

  // DOM 层规则更保守：只处理高置信度的情况
  // 返回判定详情，方便回传诊断（隐藏与否、分值、理由）
  function judgeCard(info) {
    const d = info.duration;
    if (info.mid && store.has(info.mid)) {
      return { hide: true, reason: '黑名单 UP', fp: 0, sig: 0 };
    }
    // 与接口层完全共用 decide()，避免两层规则不一致。
    // 不再提前因"时长未知"放行 —— 主题屏蔽不依赖时长。
    const dec = decide(d == null ? 0 : d, info.title, info.author, info.mid);
    const fp = marketingFingerprint(info.title);
    const at = analyzeTitle(info.title);
    return {
      hide: dec.hide,
      reason: dec.hide ? dec.why.join(' ') : '',
      fp: fp.fp, fpWhy: fp.why, sig: at.signals,
      topic: dec.topic || null,
    };
  }

  // 不依赖具体 class 名：从视频链接向上找到含时长的容器，那就是卡片
  // 必须同时含「时长」和「标题」才算一张完整卡片。
  // 只找时长会命中封面链接本身，而标题是它的兄弟节点 → 标题恒为空。
  function findCard(link) {
    let el = link;
    let fallback = null;
    for (let i = 0; i < 10 && el && el !== document.body; i++) {
      if (el.querySelector) {
        // 含多个视频链接的必然是列表容器，不是单张卡片
        if (linkCount(el) > MAX_LINKS_PER_CARD) break;
        const hasDur = !!el.querySelector(DURATION_SEL);
        const hasTitle = !!el.querySelector(TITLE_SEL);
        if (hasDur && hasTitle) return el;
        if (hasDur && !fallback) fallback = el;
      }
      el = el.parentElement;
    }
    return fallback;
  }

  /* --------------------------- 空页自愈 ---------------------------
     再聪明的规则也会错判。最坏情况是把整页清空 —— 那比不过滤还糟。
     这里每次扫描后检查：如果一张可见卡片都没有，就撤销本轮所有隐藏，
     并进入降级模式（只记录、不再自动隐藏），等用户手动处理。   */
  let degraded = false;

  function visibleCardCount() {
    let n = 0;
    document.querySelectorAll(CARD_SEL).forEach((el) => {
      if (el.dataset.blfHidden) return;
      if (el.offsetParent === null) return;   // 被隐藏或脱离文档
      n++;
    });
    return n;
  }

  function recoverIfEmpty() {
    if (degraded) return false;
    if (document.querySelectorAll(CARD_SEL).length === 0) return false;
    if (visibleCardCount() > 0) return false;

    // 全被隐藏了 —— 撤销
    let restored = 0;
    document.querySelectorAll('[data-blf-hidden]').forEach((el) => {
      el.style.removeProperty('display');
      delete el.dataset.blfHidden;
      restored++;
    });
    degraded = true;
    console.warn(TAG, '检测到整页被清空，已恢复', restored, '个节点并进入降级模式');
    if (badgeEl) {
      badgeEl.textContent = '🛡 v' + VERSION + ' 已自动恢复（判定异常，请点开查看）';
      badgeEl.style.background = 'rgba(150,40,40,.85)';
    }
    return true;
  }

  function scan(root, opts) {
    const scope = root || document;
    const links = scope.querySelectorAll('a[href*="/video/BV"], a[href*="/video/av"]');
    stats.linkCount = links.length;
    const cards = new Set();
    links.forEach((a) => {
      const c = findCard(a);
      if (c) cards.add(c);
    });
    // 兼容：已知 class 也纳入。
    // 但必须过滤掉列表容器 —— 容器能 querySelector 到子卡片的标题，
    // 一旦被判为"要隐藏"，整片信息流就没了。这是真踩过的坑。
    scope.querySelectorAll(CARD_SEL).forEach((c) => {
      if (linkCount(c) <= MAX_LINKS_PER_CARD) cards.add(c);
      else log('跳过容器（含 ' + linkCount(c) + ' 个视频）');
    });

    const detail = [];
    const seenKeys = new Set();
    cards.forEach((card) => {
      const info = cardInfo(card);
      const verdict = judgeCard(info);
      if (!card.dataset.blfSeen) { card.dataset.blfSeen = '1'; stats.domSeen += 1; }
      if (info.mid) addBlockButton(card, info);
      if (verdict.hide && !card.dataset.blfHidden) {
        hideCard(card, verdict.reason);
        recordHidden(info, verdict);
      }

      // 一张卡可能被多个 BV 链接匹配到不同祖先，按 mid+标题去重
      const key = (info.mid || '') + '|' + (info.title || '');
      if (seenKeys.has(key)) return;
      seenKeys.add(key);

      // UP 主维度累计：营销号 2 条即拉黑，指定话题 3 条即拉黑。
      // 用户抱怨的是"换一换又冒出来"——屏蔽账号才能根治，屏蔽单条只是打地鼠。
      if (verdict.hide && verdict.topic) {
        bumpQuality(info.mid, info.author, key, 'topic');
      } else {
        const fpWhy = verdict.fpWhy || [];
        if (verdict.hide && fpWhy.some((w) => HARD_MARK.test(w))) {
          bumpQuality(info.mid, info.author, key, 'quality');
        }
      }

      if (info.title || info.duration != null) {
        detail.push({
          mid: info.mid, author: info.author, title: info.title,
          dur: info.duration, watch: info.watch, danmaku: info.danmaku,
          published: info.published,
          hidden: !!card.dataset.blfHidden,
          verdict: verdict.hide ? 'hide' : 'keep',
          reason: verdict.reason, fp: verdict.fp, sig: verdict.sig,
          fpWhy: verdict.fpWhy || [],
        });
      }
    });
    // 只在没有显式指定 root 的全量扫描后做检查，避免 MutationObserver
    // 处理片段时误判（那时页面本来就没几张卡片）
    if (!root) recoverIfEmpty();
    updateBadge();
    return detail;
  }

  function bootDom() {
    scan(document);
    if (CONFIG.showBadge) {
      const b = document.createElement('div');
      b.id = 'blf-alive';
      b.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(b);
      window.__BLF_ACTIVE__ = true;
      updateBadge();
    }
    // 兜底：B 站是 SPA，渲染时机不确定，定期重扫
    setInterval(() => {
      try {
        scan(document, { silent: true });
      } catch (e) {
        if (badgeEl) badgeEl.textContent = 'ERR: ' + (e && e.message ? e.message : e);
      }
    }, 2000);

    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          if (n.querySelector && n.querySelector('a[href*="/video/BV"], a[href*="/video/av"]')) scan(n);
        });
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootDom, { once: true });
  } else {
    bootDom();
  }

  /* --------------------------- 调试用控制台 API --------------------------- */
  window.__BLF = {
    config: CONFIG,
    blacklist: () => store.all(),
    whitelist: () => allow.all(),
    unblock: (mid) => store.remove(mid),
    allow: (mid, name) => allow.add(mid, name),
    panel: () => showPanel(),
    scan: () => scan(document),
    test: (items) => items.map((it) => ({ title: it.title, dur: it.duration, ...scoreItem(it) })),
    filter: (items) => filterItems(items),
  };
})();
