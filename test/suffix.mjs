/**
 * 频道名后缀：清洗分辨率 / 回填延迟。
 * 直接测 src/suffix.js —— 和浏览器里跑的是同一份代码。
 */
import { rebuildName, rebuildResName, stripDelaySuffix, stripResSuffix, stripAllSuffix, delaySuffix } from '../src/suffix.js';

let pass = 0;
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${extra ? ' → ' + extra : ''}`);
  }
};

console.log('频道名后缀');

/* ---------- 摘延迟后缀 ---------- */
ok('去 1043ms', stripDelaySuffix('香港财经教育 1080p 1043ms') === '香港财经教育 1080p', stripDelaySuffix('香港财经教育 1080p 1043ms'));
ok('去 延迟135ms', stripDelaySuffix('大爱1台 延迟135ms') === '大爱1台', stripDelaySuffix('大爱1台 延迟135ms'));
ok('去 [317ms]', stripDelaySuffix('CCTV 5 [317ms]') === 'CCTV 5', stripDelaySuffix('CCTV 5 [317ms]'));
ok('不改变无后缀频道名', stripDelaySuffix('唯心 WXTV') === '唯心 WXTV');
ok('不误伤纯数字频道名', stripDelaySuffix('翡翠台 700') === '翡翠台 700', stripDelaySuffix('翡翠台 700'));
ok('不误伤分辨率后缀', stripDelaySuffix('晓心WXTV 480p') === '晓心WXTV 480p', stripDelaySuffix('晓心WXTV 480p'));
ok('去 延时 480 毫秒', stripDelaySuffix('凤凰 延时 480 毫秒') === '凤凰', stripDelaySuffix('凤凰 延时 480 毫秒'));

/* ---------- 摘分辨率后缀 ---------- */
ok('去 480p', stripResSuffix('GOODTV好消息1 480p') === 'GOODTV好消息1');
ok('彻底清洗：分辨率+延迟一起摘', stripAllSuffix('CCTV-1 1080p 1043ms') === 'CCTV-1', stripAllSuffix('CCTV-1 1080p 1043ms'));
ok('彻底清洗：只留名字', stripAllSuffix('大爱1台 [延迟317ms]') === '大爱1台', stripAllSuffix('大爱1台 [延迟317ms]'));
ok('彻底清洗：本身干净就不动', stripAllSuffix('唯心 WXTV') === '唯心 WXTV');
ok('彻底清洗：延迟后缀在前也能摘干净', stripAllSuffix('凤凰 延时 480 毫秒 576i') === '凤凰', stripAllSuffix('凤凰 延时 480 毫秒 576i'));
ok('去 (1080p)', stripResSuffix('CCTV-1 综合 (1080p)') === 'CCTV-1 综合');
ok('不误伤频道名里的数字', stripResSuffix('CCTV-5 体育 2') === 'CCTV-5 体育 2', stripResSuffix('CCTV-5 体育 2'));

/* ---------- 生成后缀 ---------- */
ok('默认模板 {ms}ms', delaySuffix(1043) === '1043ms', delaySuffix(1043));
ok('模板 {ms}ms 替换', delaySuffix(135, '{ms}ms') === '135ms');
ok('模板 [延迟{ms}ms]', delaySuffix(317, '[延迟{ms}ms]') === '[延迟317ms]', delaySuffix(317, '[延迟{ms}ms]'));
ok('ms=0 返回空串', delaySuffix(0) === '');
ok('小数毫秒取整', delaySuffix(317.6) === '318ms', delaySuffix(317.6));

/* ---------- 回填（含幂等） ---------- */
const filled = rebuildName({ title: '大爱1台 1043ms', ms: 135, tpl: '{ms}ms' });
ok('先摘后填', filled === '大爱1台 135ms', filled);
ok('连点两次不叠后缀', rebuildName({ title: filled, ms: 135, tpl: '{ms}ms' }) === filled, rebuildName({ title: filled, ms: 135, tpl: '{ms}ms' }));
ok('换模板会重写', rebuildName({ title: filled, ms: 135, tpl: '[延迟{ms}ms]' }) === '大爱1台 [延迟135ms]', rebuildName({ title: filled, ms: 135, tpl: '[延迟{ms}ms]' }));
ok('没测出延迟且 append 时原样保留', rebuildName({ title: '大爱1台', ms: 0, tpl: '{ms}ms' }) === '大爱1台');
ok('append=false 只做清理', rebuildName({ title: '大爱1台 999ms', ms: 135, tpl: '{ms}ms', append: false }) === '大爱1台');
ok('模板留空时只清理', rebuildName({ title: '大爱1台 999ms', ms: 135, tpl: '', append: true }) === '大爱1台');
ok('空频道名也能安全处理', rebuildName({ title: '', ms: 100, tpl: '{ms}ms' }) === '100ms', rebuildName({ title: '', ms: 100, tpl: '{ms}ms' }));

/* ---------- 挑低延迟的场景：同一个频道名多个源 ---------- */
const sameName = '香港财经教育';
const picked = [1043, 135, 1398, 317].map((ms) => rebuildName({ title: sameName, ms, tpl: '{ms}ms' }));
ok('四个源各带自己的延迟', new Set(picked).size === 4, picked.join(' | '));
ok('最小的那个排在名字末尾时最短', picked[1] === '香港财经教育 135ms', picked[1]);

/* ---------- 清洗时「没探测出分辨率就不许动名字」 ---------- */
ok('有探测值时用真值覆盖手写后缀', rebuildResName({ title: 'GOODTV好消息1 480p', tier: '1080p' }) === 'GOODTV好消息1 1080p', rebuildResName({ title: 'GOODTV好消息1 480p', tier: '1080p' }));
ok('没探测值时原样保留（不静默丢信息）', rebuildResName({ title: 'GOODTV好消息1 480p', tier: '' }) === 'GOODTV好消息1 480p', rebuildResName({ title: 'GOODTV好消息1 480p', tier: '' }));
ok('没探测值但 strip 开着也不动（force 缺省）', rebuildResName({ title: 'GOODTV好消息1 480p', tier: '', strip: true }) === 'GOODTV好消息1 480p');
ok('显式 force 才删（知道代价）', rebuildResName({ title: 'GOODTV好消息1 480p', tier: '', strip: true, force: true }) === 'GOODTV好消息1');
ok('同档位不重复追加', rebuildResName({ title: '晓心WXTV 480p', tier: '480p' }) === '晓心WXTV 480p', rebuildResName({ title: '晓心WXTV 480p', tier: '480p' }));
ok('干净名字追加档位', rebuildResName({ title: '大爱1台', tier: '1080p' }) === '大爱1台 1080p');
ok('名字写的档位和实际不符时会被纠正', rebuildResName({ title: '香港财经教育 1080p', tier: '480p' }) === '香港财经教育 480p', rebuildResName({ title: '香港财经教育 1080p', tier: '480p' }));
ok('append=false 时只清理', rebuildResName({ title: '大爱1台 480p', tier: '1080p', append: false }) === '大爱1台');
// 名字里已经挂着手写分辨率、末尾又是延迟后缀的情况（真实列表里很常见）
ok(
  '手写字尾被延迟后缀隔开时，就地替换不叠加',
  rebuildResName({ title: 'CCTV-1 综合 480p 1000ms', tier: '1080p' }) === 'CCTV-1 综合 1080p 1000ms',
  rebuildResName({ title: 'CCTV-1 综合 480p 1000ms', tier: '1080p' }),
);
ok(
  '已经是最新档位就不重复加工',
  rebuildResName({ title: 'CCTV-1 综合 1080p 1000ms', tier: '1080p' }) === 'CCTV-1 综合 1080p 1000ms',
  rebuildResName({ title: 'CCTV-1 综合 1080p 1000ms', tier: '1080p' }),
);
ok(
  '名字中间写着档位也是只留一个',
  rebuildResName({ title: 'CCTV-5 1080p 体育', tier: '720p' }) === 'CCTV-5 720p 体育',
  rebuildResName({ title: 'CCTV-5 1080p 体育', tier: '720p' }),
);

console.log(failed ? `\n${failed} 项失败` : `\n${pass} 项全部通过`);
process.exit(failed ? 1 : 0);
