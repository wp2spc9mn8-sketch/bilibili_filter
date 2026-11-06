// ==UserScript==
// @name         Bilibili 低质营销号过滤
// @namespace    local.kent.blf
// @version      3.2.0
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
    // 档位：off 关闭 | light 只杀标题明确的 | balanced 标题+时长组合 | aggressive 短的一律杀
    mode: 'aggressive',
    aggressiveMax: 120,  // aggressive 档：短于此秒数的视频直接隐藏（已关注除外）
    fpThreshold: 4,      // 2-10 分钟区间：营销号文案指纹达到几分就砍
    fpLongThreshold: 6,  // 10 分钟以上：要求更严，避免误杀深度内容
    shortDuration: 30,   // 秒：极短。只要有 1 个营销信号就判死
    minDuration: 60,     // 秒：短。需要 1 个以上信号
    softDuration: 90,    // 秒：偏短。需要 2 个信号
    longDuration: 180,   // 秒：长视频豁免区（≥此长度且信号 <2 一律保留）
    keepAtLeast: 6,      // 每批推荐保底保留条数，防止把首页刷空
    hideLive: false,     // true = 连直播卡片一起隐藏
    showBadge: true,     // 右下角显示过滤计数徽章
    debug: false,        // true = 控制台打印每条判定
  };
  /* =================================================================== */

  let stats = { apiHidden: 0, apiSeen: 0, domHidden: 0, domSeen: 0, linkCount: 0 };

  const LS_KEY = 'blf:blacklist';
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

  function log(...a) { if (CONFIG.debug) console.log(TAG, ...a); }

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
      badgeEl.addEventListener('click', () => {
        const b = store.all();
        const n = Object.keys(b).length;
        alert('已过滤 ' + (stats.apiHidden + stats.domHidden) + ' 条\n' +
              '  接口层: 拦 ' + stats.apiHidden + ' / 扫 ' + stats.apiSeen + '\n' +
              '  页面层: 拦 ' + stats.domHidden + ' / 扫 ' + stats.domSeen + '\n' +
              '手动屏蔽 UP 主 ' + n + ' 个\n\n' +
              '控制台里可用 __BLF.blacklist() 查看，__BLF.unblock(mid) 解除');
      });
      document.body.appendChild(badgeEl);
    }
    const hid = stats.apiHidden + stats.domHidden;
    const seen = stats.apiSeen + stats.domSeen;
    badgeEl.textContent = '🛡 ' + CONFIG.mode + ' 拦 ' + hid + ' / 扫 ' + seen;
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
  function marketingFingerprint(title) {
    const t = String(title || '').trim();
    const len = t.length;
    let s = 0;
    const why = [];

    // ---- 正常内容的标记（负分）----
    let labelled = false;
    if (/【[^】]{1,24}】/.test(t)) { s -= 2; labelled = true; }
    if (/[｜|]/.test(t)) { s -= 1; labelled = true; }
    if (/#[^\s#]{1,14}/.test(t)) { s -= 1; }
    if (/(MV|PV|OP|ED|vlog|Vlog|VLOG)\b/.test(t)) { s -= 2; labelled = true; }
    // 注意：不含"指南/手册"——营销号最爱用"避坑指南"这类词装饰门面
    if (/攻略|实况|教程|讲解|评测|拆解|精讲|复盘|测评|开箱|合集|纪录片|花絮|混剪|手书|翻唱|直播回放/.test(t)) { s -= 2; labelled = true; }
    if (/第[一二三四五六七八九十百\d]+[集期话章回卷]/.test(t)) { s -= 2; labelled = true; }
    if (/[Pp]\d+\s*$/.test(t)) { s -= 1; labelled = true; }
    if (/《[^》]{1,24}》/.test(t)) { s -= 1; labelled = true; }

    // ---- 营销号标记（正分）----
    if (len >= 18) s += 1;
    if (len >= 28) s += 1;
    if (len >= 36) s += 1;

    const commas = (t.match(/[，,]/g) || []).length;
    if (commas >= 2) { s += 1; why.push('多短句'); }

    const q = (t.match(/[？?]/g) || []).length;
    const ex = (t.match(/[！!]/g) || []).length;
    if (/[！!？?。…]$/.test(t)) { s += 1; why.push('句末标点'); }
    if (q >= 2) { s += 1; why.push('双问句'); }
    // 标点密度而非绝对数量：长标题天然标点多，不能一律算堆叠
    if (q + ex >= 4 && (q + ex) / Math.max(len, 1) >= 0.08) { s += 1; why.push('标点密集'); }

    // 这类"内容形态"本身就是营销号：盘点/揭秘/震惊体
    if (/震惊|盘点|揭秘|真相|内幕|鲜为人知|尘封|绝唱|秘闻|野史|奇闻|重磅|惊呆了/.test(t)) {
      s += 4; why.push('营销词');
    }
    // 悬念 / 说教口吻
    const sus = t.match(/为何|为什么|竟然|居然|终于|原来|当年|背后|到底|看完|懂了|这才是|不为人知|无人知晓/g);
    if (sus) { s += 1; if (sus.length >= 2) s += 1; why.push('悬念词x' + sus.length); }

    // 无栏目标记的口语叙述句 = 营销号最典型形态
    // 正常视频标题是名词短语（"45米高空坠物测试"），营销号是完整叙述（"我刚发现…结果…"）
    if (!labelled && len >= 20) {
      const colloquial = /了|着|过的|真是|太|就|还|都|才|又|怎么|什么|为什么|结果|后来|然后/, 
            hit = t.match(colloquial);
      if (hit) { s += 1; }
      // 无标记 + 长 + 句末标点 = 强叙述句
      if (len >= 24 && /[。！!？?…]$/.test(t)) { s += 1; why.push('无栏目标记长句'); }
    }

    // 叙事悬念长句：营销号"讲故事"的标准写法
    // 例：工人在清理河底淤泥时，无意间发现…竟然是…
    if (len >= 36 && /竟然|无意间|结果|没想到|谁料|不料|发现自己/.test(t)) {
      s += 2; why.push('叙事长句');
    }

    // 具体年份 + 长标题 = 历史叙事营销号的强特征
    if (/(19|20)\d{2}\s*年/.test(t) && len >= 20) { s += 2; why.push('年份+长标题'); }
    else if (/\d{2,}\s*年[前后]|\d+年[前后]/.test(t)) { s += 1; }

    return { fp: s, why };
  }

  function parseDuration(text) {
    if (!text) return null;
    const parts = String(text).trim().split(':').map(Number);
    if (!parts.length || parts.some(Number.isNaN)) return null;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
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
    const dec = decide(d, it.title);
    const hide = dec.hide;
    dec.why.forEach((w) => why.push(w));

    const score = hide
      ? -100 - dec.fp * 10
      : Math.round(sig * 5 + Math.min(d / 600, 5));

    return { score, signals: sig, fp: dec.fp, hide, hard: false, why };
  }

  /* ------------------------------------------------------------------ */
  /*        时长 + 标题 → 是否隐藏（接口层与页面层共用的唯一判定）          */
  /* ------------------------------------------------------------------ */
  function decide(d, title) {
    const mode = CONFIG.mode;
    const why = [];
    const { signals, hits } = analyzeTitle(title);
    const { fp, why: fpWhy } = marketingFingerprint(title);
    if (fpWhy.length) why.push('文案:' + fpWhy.slice(0, 3).join(','));

    if (mode === 'off') return { hide: false, fp, why: ['模式关闭'] };
    if (!(d > 0)) return { hide: false, fp, why: ['时长未知，跳过'] };

    if (hits.length) why.push('话术:' + hits.slice(0, 2).join(','));
    let hide = false;

    // 分层策略：短视频用语术词库（敏感），中长视频用文案指纹（精准）
    if (mode === 'aggressive') {
      if (d < CONFIG.aggressiveMax) {
        hide = true; why.unshift('短于' + CONFIG.aggressiveMax + 's');
      } else if (d <= 600) {
        if (fp >= CONFIG.fpThreshold) { hide = true; why.unshift('大字报文案(2-10min)'); }
      } else if (fp >= CONFIG.fpLongThreshold) {
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
    if (CONFIG.mode !== 'aggressive' && keep.length < CONFIG.keepAtLeast) {
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

  function hideCard(card, reason) {
    if (!card || card.dataset.blfHidden) return;
    card.dataset.blfHidden = '1';
    card.style.setProperty('display', 'none', 'important');
    stats.domHidden += 1;
    updateBadge();
    log('DOM 隐藏:', reason);
  }

  function cardInfo(card) {
    const authorLink = card.querySelector('a[href*="space.bilibili.com/"]');
    const midMatch = authorLink && (authorLink.getAttribute('href') || '').match(/space\.bilibili\.com\/(\d+)/);
    const durEl = card.querySelector(DURATION_SEL);

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
      author: authorLink ? authorLink.textContent.trim() : '',
      duration: durEl ? parseDuration(durEl.textContent) : null,
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
  function judgeCard(info) {
    if (info.mid && store.has(info.mid)) return '黑名单 UP';
    const d = info.duration;
    if (d == null || d <= 0) return null;
    // 与接口层完全共用 decide()，避免两层规则不一致
    const dec = decide(d, info.title);
    return dec.hide ? dec.why.join(' ') : null;
  }

  // 不依赖具体 class 名：从视频链接向上找到含时长的容器，那就是卡片
  // 必须同时含「时长」和「标题」才算一张完整卡片。
  // 只找时长会命中封面链接本身，而标题是它的兄弟节点 → 标题恒为空。
  function findCard(link) {
    let el = link;
    let fallback = null;
    for (let i = 0; i < 10 && el && el !== document.body; i++) {
      if (el.querySelector) {
        const hasDur = !!el.querySelector(DURATION_SEL);
        const hasTitle = !!el.querySelector(TITLE_SEL);
        if (hasDur && hasTitle) return el;
        if (hasDur && !fallback) fallback = el;
      }
      el = el.parentElement;
    }
    return fallback;
  }

  function scan(root) {
    const scope = root || document;
    const links = scope.querySelectorAll('a[href*="/video/BV"], a[href*="/video/av"]');
    stats.linkCount = links.length;
    const cards = new Set();
    links.forEach((a) => {
      const c = findCard(a);
      if (c) cards.add(c);
    });
    // 兼容：已知 class 也纳入
    scope.querySelectorAll(CARD_SEL).forEach((c) => cards.add(c));

    cards.forEach((card) => {
      if (card.dataset.blfHidden) return;
      if (!card.dataset.blfSeen) { card.dataset.blfSeen = '1'; stats.domSeen += 1; }
      const info = cardInfo(card);
      if (info.mid) addBlockButton(card, info);
      const reason = judgeCard(info);
      if (reason) hideCard(card, reason);
    });
    updateBadge();
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
        scan(document);
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
    unblock: (mid) => store.remove(mid),
    scan: () => scan(document),
    test: (items) => items.map((it) => ({ title: it.title, dur: it.duration, ...scoreItem(it) })),
    filter: (items) => filterItems(items),
  };
})();
