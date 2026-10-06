/**
 * 频道名后缀处理。
 *
 * IPTV 列表里常见的两种「名字尾巴」：
 *   1. 手写分辨率 —— GOODTV好消息1 480p（以前靠播放器显示再手动补）
 *   2. 手写/回填延迟 —— 大爱1台 1043ms（同一频道几十条源时，靠它挑低延迟的）
 *
 * 这两个后缀都由工具代劳：探测拿到真值 → 批量清掉旧的 → 写回新的。
 * 纯函数，前端和 test/ 共用同一份，保证「测的就是页面上跑的」。
 */

/** 末尾手写分辨率后缀：480p / 1080i / 4K / （576p）/ 360p… */
export const RES_SUFFIX_RE =
  /\s*[（(]?\s*(2160p|1080p|1080i|720p|720i|576p|576i|480p|480i|360p|4K)\s*[)）]?\s*$/i;

/** 末尾延迟后缀：1043ms / 延迟135ms / [317ms] / 延时 999 毫秒 … */
export const DELAY_SUFFIX_RE =
  /[\s·\-–—]*[\[(（]?\s*(?:延迟|延时)?\s*\d{1,5}\s*(?:毫秒|ms)\s*(?:毫秒|ms)?\s*[\])）]?\s*$/i;

/** 去掉末尾延迟后缀，顺带把尾部分隔符一起抹掉 */
export function stripDelaySuffix(name) {
  return String(name || '')
    .replace(DELAY_SUFFIX_RE, '')
    .replace(/[\s·\-–—,，、]+$/, '');
}

/** 去掉末尾分辨率后缀 */
export function stripResSuffix(name) {
  return String(name || '')
    .replace(RES_SUFFIX_RE, '')
    .replace(/[\s·\-–—,，、]+$/, '');
}

/**
 * 彻底清洗：分辨率后缀和延迟后缀一起摘掉，一个字都不回填。
 * 只有「压根不想在频道名后面看到这些」的人才会用这个，
 * 和「回填分辨率 / 回填延迟」是两条独立的路。
 *
 * 顺序必须是 先延迟、再分辨率：像「CCTV-1 1080p 1043ms」这种，
 * 先摘分辨率会留下「1080p」在中间，再摘延迟就带不动它了。
 */
export function stripAllSuffix(name) {
  let out = String(name || '');
  // 来回切两遍：像「凤凰 延时 480 毫秒 576i」这种，
  // 摘掉分辨率后缀之后延迟后缀才重新露到末尾，一遍摘不干净
  for (let i = 0; i < 3; i++) {
    const next = stripResSuffix(stripDelaySuffix(out));
    if (next === out) break;
    out = next;
  }
  return out.replace(/[\s·\-–—,，、]+$/, '').trim();
}

/** 按模板生成延迟后缀，{ms} 换成毫秒数；空模板返回空串 */
export function delaySuffix(ms, tpl = '{ms}ms') {
  if (!(Number(ms) > 0)) return '';
  return String(tpl || '').replace('{ms}', Math.round(ms));
}

/** 名字末尾是否已经带了这个档位（如 "香港财经教育 1080p" 已经带 1080p） */
export function endsWithTier(name, tier) {
  const t = String(tier || '').replace(/\s/g, '');
  if (!t) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}$`, 'i').test(String(name || ''));
}

/** 名字末尾档位（只认标准档位，用于「实际 480p 但名字写 1080p」时替换） */
const TIER_AT_END_RE =
  /\s*[（(]?\s*(2160p|1080p|1080i|720p|720i|576p|576i|480p|480i|360p|4K)\s*[)）]?\s*$/i;

/** 档位 token（不含前后空白），用来在名字里定位「写着的那个分辨率」 */
const TIER_TOKEN_RE = /\b(2160p|1080p|1080i|720p|720i|576p|576i|480p|480i|360p|4K)\b/i;

/**
 * 取名字里最后一个「不在末尾」的档位 token。
 * 末尾那个交给 TIER_AT_END_RE 处理，这里只管被延迟之类后缀隔在中间的情况。
 */
function lastTier(name) {
  let found = null;
  const re = new RegExp(TIER_TOKEN_RE.source, 'gi');
  let m;
  while ((m = re.exec(name))) {
    if (m.index + m[0].length !== name.length) found = m;
  }
  return found;
}

/**
 * 用探测到的分辨率档位重写频道名。
 *
 * 关键约束：
 *   1. **没探测到就一个字都不动** —— 手写后缀是真实信息，删掉就是净损失；
 *   2. **同一个档位只会出现一次** —— 名字里已经写着另一个档位（哪怕被延迟后缀
 *      隔在中间，如「CCTV-1 综合 480p 1000ms」）就就地替换，不能再追加一个
 *      「... 1080p 1000ms 1080p」。
 *
 * @param {string} title 原频道名
 * @param {string} tier  探测档位，如 "1080p"；空表示没测出来
 */
export function rebuildResName({ title, tier = '', strip = true, append = true, force = false }) {
  const t = String(tier || '').trim();
  const raw = String(title || '');
  const clean = (s) => s.replace(/[\s·\-–—,，、]+$/, '').trim();
  const base = () => (strip ? clean(raw.replace(TIER_AT_END_RE, '')) : clean(raw));

  // 没有真值：默认不许动名字，想强行删必须显式传 force —— 那是知道代价后的选择
  if (!t) return force ? base() : clean(raw);

  // 已经写着同一个档位（含括号写法），别重复加工
  if (endsWithTier(raw, t)) return clean(raw);

  // 只清理、不回填
  if (!append) return base();

  const m = lastTier(raw);
  if (m) {
    // 就地换掉：保留它原来的位置，后面的延迟后缀也原样留着
    const head = raw.slice(0, m.index).replace(/\s+$/, '');
    return clean(`${head} ${t}${raw.slice(m.index + m[0].length)}`);
  }
  return `${base()} ${t}`;
}

/**
 * 一步到位：摘旧后缀 → 拼新后缀。
 * 因为先摘再拼，连点两次不会叠成 "135ms 135ms" —— 天然幂等。
 *
 * @param {string} title 原频道名
 * @param {number} ms    探测到的首字节延迟，0 表示没测出来
 * @param {string} tpl   后缀模板，默认 "{ms}ms"
 * @param {boolean} strip 是否先摘掉已有的延迟后缀
 * @param {boolean} append 是否追加（false 就只做清理）
 */
export function rebuildName({ title, ms = 0, tpl = '{ms}ms', strip = true, append = true }) {
  let name = strip ? stripDelaySuffix(title) : String(title || '');
  const suffix = delaySuffix(ms, tpl);
  if (append && suffix && !name.endsWith(suffix)) name = `${name} ${suffix}`;
  return name.trim();
}
