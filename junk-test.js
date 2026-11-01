const fs=require('fs'),vm=require('vm');
let src=fs.readFileSync(__dirname + '/bilibili-filter.user.js','utf8');
src=src.replace("mode: 'aggressive'", "mode: 'balanced'");
const sb={};sb.window=sb;sb.console=console;
sb.document={readyState:'complete',body:{appendChild(){},querySelectorAll:()=>[]},addEventListener(){},querySelectorAll:()=>[],createElement:()=>({style:{},addEventListener(){},appendChild(){}})};
sb.MutationObserver=class{observe(){}};sb.Headers=Headers;sb.Response=Response;
sb.localStorage={_s:{},getItem(k){return this._s[k]??null},setItem(k,v){this._s[k]=String(v)}};
sb.getComputedStyle=()=>({position:'static'});
sb.setInterval=()=>0;
vm.createContext(sb);vm.runInContext(src,sb);
const BLF=sb.window.__BLF;

const cases=[
 [28,'震惊！原来这才是真相，看完你就懂了',true,'典型震惊体'],
 [35,'万万没想到，居然是这样',true,'没想到'],
 [52,'建议收藏！这三个技巧一定要知道',true,'收藏党'],
 [40,'全网都在找的答案，终于揭秘了',true,'全网+揭秘'],
 [22,'破防了家人们，看哭了',true,'情绪体'],
 [30,'太离谱了！这个操作直接封神',true,'离谱+封神'],
 [45,'兄弟们，这个必须看，不看后悔一辈子',true,'必须看+后悔'],
 [60,'绝了！这才是真正的天花板',true,'绝了'],
 [38,'注意了！明天开始一定要注意这个',true,'注意了'],
 [55,'涨知识了，冷知识大全',true,'冷知识'],
 [25,'赶紧看！马上就要删了',true,'速删体'],
 [48,'别再被骗了，真相只有一个',true,'别再+真相'],
 // 以下为不该被砍的正常内容
 [50,'第一视角：开箱这台老相机',false,'正常第一视角'],
 [1800,'纯音乐｜雨声助眠 30 分钟',false,'正常长音频'],
 [600,'【4K】挪威自驾 Day3｜松恩峡湾',false,'正常Vlog'],
 [240,'用 Rust 重写了一遍解析器，性能提升 3 倍',false,'正常技术视频'],
];
let fail=0,recall=0,recallTotal=0,fp=0;
for(const [dur,title,expect,tag] of cases){
  const r=BLF.test([{duration:dur,title,owner:{mid:1,name:'t'},stat:{view:5e4,like:3e3},goto:'av'}])[0];
  const ok=r.hide===expect;
  if(expect){recallTotal++;if(r.hide)recall++;}
  if(!expect&&r.hide)fp++;
  if(!ok)fail++;
  console.log((ok?' PASS ':' FAIL ')+(r.hide?'砍':'留'),String(r.signals).padStart(4),dur+'s',title.slice(0,28).padEnd(30),tag);
}
console.log(`\n召回: ${recall}/${recallTotal} 营销号被砍   误杀: ${fp} 条正常内容   断言失败: ${fail}`);
process.exit(fail?1:0);
