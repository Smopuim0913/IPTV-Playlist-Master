/**
 * 流探测（probe）
 *
 * 为什么不推荐用 ping 当指标：
 *   ICMP 走的是独立路径，运营商网络里 ICMP 经常被区别对待（限速/丢包/绕过 QoS），
 *   所以「延迟 8ms」完全不意味着「4K 不卡」。这里换成三个真正和播放体验相关的量：
 *
 *   1) TTFB（首字节时间）—— 点开频道后等数据的时间，直接决定「多久出画面」
 *   2) TCP 建连耗时 —— 反映源站/链路质量，且和 media 走同一条路径
 *   3) 实测吞吐 Mbps —— 下载前 64KB 算出来的通道带宽，拿来和 HLS 变体的
 *      BANDWIDTH 对比，就能预判「会不会卡」，这是 ping 永远给不了的信息
 */

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { analyzeStream, firstSegmentUri, tsServiceName } from './resolution.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 读流头去探分辨率时的两个窗口大小（字节）。
//
// 为什么是「先小后大」：H.264/H.265 的 SPS 只在关键帧（IDR）处写一次，
// 而一个 GOP 动辄 1~3MB（6 秒 1080p 约 2MB）。窗口比 GOP 小就等于开盲盒 ——
// 有些源的分片边界刚好落在两个 IDR 中间，从分片开头读永远读不到 SPS。
//
// 实测（txiptv 那类直播源，SPS 每 ~1.1MB 出现一次，分片段落在 5MB 上下）：
//   128KB 窗口 → 5 个分片 0/5 命中；1MB → 2/4；2MB → 4/4。
// 所以先按 128KB 便宜地探一次，真的看见视频却没 SPS，再加深挖一次：
// 1MB 还得靠运气（恰好把窗口盖在 IDR 上），2MB 才基本稳定。
// 只有「首窗口没读到」的通道才付这份流量和 2 秒左右的时间，读得到的通道一分不多花。
//
// 加深到此为止是刻意封顶，别随手往上涨：
// 2MB 已经盖得住绝大多数 1080p 网络流的 I 帧间隔（实测 4/4），再往上收益极小；
// 而这里是**批量探测**场景，多挖 1MB 不只贵在这一个通道身上——
// 同一份流量预算要摊给列表里成百上千条，深挖超时还会退化成「读不到」的结论，
// 把慢源白白记成可疑。再大的 GOP 超出覆盖的，交给播放器/用户自己分辨就好。
const SEG_HEAD_BYTES = 131072;
const SEG_DEEP_BYTES = 2 * 1048576;

/**
 * 伪直播（录好的循环片）识别的两条阈值。
 *
 * CLIP_MAX_SEC：清单总时长超过它就当普通点播/回看放过。实测引流循环片都在
 *   1~5 分钟（典型 01:58），10 分钟这条线留足余量又不至于误伤回看短片。
 * STALE_DAYS ：源站自认文件「这么久没动过」。真直播的清单/分片 Last-Modified
 *   永远是当前时刻，旧日期基本等于「这份文件躺在那儿没人更新过」。
 * MAX_SEQ    ：分片序号的上限。真直播滚到 4 位以上（segment-99177.ts 那种）
 *   说明它在跟时间走，不是把片子切一遍钉死的。
 */
const CLIP_MAX_SEC = 600;
const STALE_DAYS = 30;
const MAX_SEQ = 9999;

/**
 * 「窗口冻结」复查：静态证据（清单看起来是直播、分片是几片子硬缝的）凑齐之后，
 * 再原样重拉一次同一份清单，隔 WINDOW_RECHECK_MS 比一比分片列表有没有往前滑。
 *
 * 真直播的清单每出一个切片就整份重写（窗口往前滑一格），所以隔一会儿拉两份，
 * 只要内容变了就说明这路还在推。反过来，两份一模一样 —— 且它连 ENDLIST 都没有
 * —— 就是「看得到、但没有下一片」，播放器放到窗口末尾只能干等。
 *
 * 间隔取 1.5 秒：比绝大多数切片的时长还短，但对「有没有在动」已经足够灵敏
 * （不动就是不动，跟间隔长短无关；动了则隔 0 秒也能看出来，所以宁可短一点，
 * 免得整批探测凭空多花几秒）。只有可疑源才付这份等待。
 */
const WINDOW_RECHECK_MS = 1500;

/**
 * 一段「几片子硬缝」的判据。实测（大湾区卫视那条 dwq.m3u8，SRS 转封装）：
 *
 *   #EXT-X-MEDIA-SEQUENCE:2017
 *   #EXT-X-DISCONTINUITY / #EXTINF:10.432 / dwq-2017.ts
 *   #EXT-X-DISCONTINUITY / #EXTINF:8.768 / dwq-2018.ts
 *   #EXT-X-DISCONTINUITY / #EXTINF:1.130 / dwq-2019.ts   ← 1.13 秒的零碎尾巴
 *   …（10 段，每段一条 DISCONTINUITY，EXTINF 全长短不一，总 67 秒）
 *
 * 两条静态特征：
 *   ①「每段都断」—— DISCONTINUITY 数 >= 段数-1。真直播一路推下来只会在换编码参数/
 *      切节目时偶尔插一条，绝不会每一片之间都断；这么写只能是把几段独立的片子
 *      按顺序塞进窗口（HLS 播放器每断一次就要重新起解码，观感就是「画面一顿一顿拼起来」）。
 *   ②「时长零碎」—— 有远短于整段的零头（< 目标时长的 3 成），且最长/最短差 4 倍以上。
 *      真直播切片是整段 GOP 切出来的，时长都贴着目标值；零头片只出现在「缝合处」。
 *
 * 单看 ① 会误杀（有人拿 discontinuity 当切片标记用），单看 ② 更不可靠，
 * 所以两条都要有嫌疑才往下走，再拿「窗口冻不冻」做最后一道（见 detectSeamedLive）。
 */
export function analyzeClipSeams(text) {
  const { segs, durs, discont, targetDur } = parseHlsMedia(text);
  const n = segs.length;
  const empty = { seamed: false, ragged: false, suspicious: false, discont, segCount: n, minDur: 0, maxDur: 0 };
  if (n < 3 || !durs.length) return empty; // 段太少（才两三条）说明不了任何事

  const seamed = discont >= n - 1;
  const maxDur = Math.max(...durs);
  const minDur = Math.min(...durs);
  const unit = targetDur || maxDur || 10; // 没有 TARGETDURATION 就拿最长那片当参照
  const ragged = durs.some((d) => d > 0 && d < unit * 0.3) && minDur * 4 <= maxDur;

  return { seamed, ragged, suspicious: seamed || ragged, discont, segCount: n, minDur, maxDur };
}

/** 字节数 → 「2MB」这种人话，note 文案里用，免得改了常量还得改句子 */
const mbLabel = (n) => Math.round(n / 1048576) + 'MB';

// 每个请求独占一个 socket、用完即关，保证 timing 不复用、不串味
const httpAgent = new http.Agent({ keepAlive: false, maxSockets: Infinity });
const httpsAgent = new https.Agent({ keepAlive: false, maxSockets: Infinity });

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 瞬时故障：链路抖动、对方临时忙碌、DNS 解析没回——这些重试一次多半就好了。
 * 之前只给「证书校验失败」留了一次机会，别的失败一律判死，
 * 结果一批其实能放的频道被误标成红色（截图里连着几条 CHC 同时超时就是这么来的）。
 */
const TRANSIENT_CODES = new Set([
  'TIMEOUT',
  'ESOCKETTIMEDOUT',
  'SOCKETTIMEDOUT',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
]);

/** HTTP 状态码里值得重试的：源站自己抖了、或者被限流 */
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** 403 时换一套「播放器」UA 再试：不少 IPTV 源站只放行播放器/Referer */
const PLAYER_UA = 'Lavf/58.76.100';

// 每个请求独占一个 socket、用完即关，保证 timing 不复用、不串味。
// rejectUnauthorized:false 只用于「证书不可信」的第二次尝试，不愿校验失败就放弃，
// 所以给它单独一套 agent，避免污染默认 agent 的行为。
const insecureAgent = new https.Agent({ keepAlive: false, maxSockets: Infinity });

/**
 * 这类错误只代表「证书校验没过」，源本身多半是好的：
 * 国内 IPTV 源大量使用自签证书、证书域名与实际域名不一致（换域名/做 SNI 伪装），
 * 播放器照样能播，只是会告警。所以值得跳过证书校验重试一次，别直接判成死链。
 */
const TLS_RETRYABLE = new Set([
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED',
  'CERT_SIGNATURE_FAILURE',
  'CERT_UNTRUSTED',
  'CERT_NOT_BEFORE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

/** 把 Node 的原始错误码翻成人话，并顺带说一句「该怎么办」 */
const ERROR_HINT = {
  ERR_TLS_CERT_ALTNAME_INVALID: '证书上的域名和实际访问的域名对不上（源站换域名或做了 SNI 伪装），播放器通常仍能播',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书链不完整/自签，跳过校验通常能播',
  DEPTH_ZERO_SELF_SIGNED_CERT: '源站用的是自签名证书',
  SELF_SIGNED_CERT_IN_CHAIN: '证书链里含自签名证书',
  CERT_HAS_EXPIRED: '证书已过期',
  CERT_SIGNATURE_FAILURE: '证书签名校验失败',
  ENOTFOUND: '域名不存在，源站已下线或地址写错',
  EAI_AGAIN: 'DNS 解析失败（解析服务临时故障，稍后重试可能就好）',
  ECONNREFUSED: '端口不通，源服务没起来或拒绝了本机',
  ECONNRESET: '连接被对端重置，多半被运营商/防火墙掐了',
  ETIMEDOUT: '连接超时，对方根本不回包',
  EHOSTUNREACH: '主机不可达，本机到源站这一段不通',
  ENETUNREACH: '网络不可达',
  TIMEOUT: '超时未响应，源站卡住或把你限速了',
  BAD_SCHEME: '只支持 http/https 开头的地址',
  BAD_URL: '地址解析失败（含空格/中文/非法字符？）',
  REDIRECT_LOOP: '重定向次数过多，源站跳来跳去停不下来',
  EXCEPTION: '探测内部异常',
};

export function requestOnce(rawUrl, { timeout = 8000, probeBytes = 65536, rejectUnauthorized, alt = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let req = null;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (req) req.destroy();
      // 记下「这次是用播放器 UA 换来的」，403 重试才不会无限换下去
      if (payload) payload.uaswitchDone = !!alt;
      resolve(payload);
    };

    let u;
    try {
      u = new URL(rawUrl);
    } catch {
      return finish({ error: true, code: 'BAD_URL', status: 0 });
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return finish({ error: true, code: 'BAD_SCHEME', status: 0 });
    }

    const secure = u.protocol === 'https:';
    const mod = secure ? https : http;
    const agent = secure ? httpsAgent : httpAgent;

    const t0 = now();
    const timing = { dns: 0, tcp: 0, ttfb: 0, end: 0 };
    let bytes = 0;
    let ip = '';
    const chunks = [];
    // 保留多少字节 = 我们愿意收多少字节（probeBytes）。
    //
    // 早先写死「最多留 8 个网络块」，这是个假上限：块多大由 TCP 分块决定，不是我们
    // 能控制的事。实测某运营商源（112.123.243.37 那条）每块才 3~4KB，于是
    // probeBytes=400000 明明收了 400KB，body 里只剩 29KB（不到 15%）——
    // 分片开头的 PAT/PMT/SPS 全落在被丢掉的部分里，分辨率就「读不到」了；
    // 换个时刻块大一点，同样的代码又能读出来，结果全看运气。
    // 改成按字节算：收满 probeBytes 才停手，拿到的和自己付过的流量对得上。
    let kept = 0;

    const onError = (err) => {
      timing.end = now() - t0;
      if (!timing.ttfb) timing.ttfb = timing.end;
      finish({
        error: true,
        code: (err && err.code) || (err && err.message) || 'UNKNOWN',
        status: 0,
        ms: timing.end,
        timing,
        bytes,
        ip,
        // 已经收下的那点数据还是交出去：很多情况是我们自己掐断了连接
        // （够 probeBytes 就 destroy），这之后 socket 报个错很常见，
        // 别让「我们主动收的样本」跟着错误一起丢掉。
        body: Buffer.concat(chunks),
        truncated: chunks.length > 0,
      });
    };
    const fail = (code) => onError({ code });
    const done = (status, headers, extra = {}) => {
      timing.end = now() - t0;
      finish({
        error: false,
        status,
        headers,
        ms: timing.end,
        timing,
        bytes,
        ip,
        ...extra,
      });
    };

    try {
      req = mod.request(
        u,
        {
          method: 'GET',
          // 跳过证书校验：仅第二次尝试会带这个参数，平时走严格校验
          agent: rejectUnauthorized === false ? insecureAgent : agent,
          ...(rejectUnauthorized === false ? { rejectUnauthorized: false } : null),
          headers: alt
            ? // 403 的第二次尝试：伪装成播放器（ffmpeg/播放器系 UA 常被 IPTV 源站放行）
              { 'User-Agent': PLAYER_UA, Accept: '*/*', Referer: `${u.protocol}//${u.host}/` }
            : {
                'User-Agent': UA,
                Accept: '*/*',
                'Accept-Language': 'zh-CN,zh;q=0.9',
                'Icy-MetaData': '1',
              },
        },
        (res) => {
          const code = res.statusCode || 0;

          if (code >= 300 && code < 400 && res.headers.location) {
            res.resume();
            return finish({
              redirect: true,
              location: new URL(res.headers.location, u).toString(),
              status: code,
            });
          }

          res.on('data', (c) => {
            bytes += c.length;
            // 只留 probeBytes 以内的数据：既省内存，也保证保留量不小于它
            if (kept < probeBytes) {
              chunks.push(c);
              kept += c.length;
            }
            if (bytes >= probeBytes) {
              try {
                res.destroy();
              } catch {}
            }
          });
          res.on('aborted', () => {
            // 截断的是我们自己：够 probeBytes 就 destroy，浏览器侧只会看到 aborted
            done(code, res.headers, { body: Buffer.concat(chunks), truncated: true });
          });
          res.on('end', () => {
            done(code, res.headers, { body: Buffer.concat(chunks) });
          });
          res.on('error', onError);
          timing.ttfb = now() - t0;
        },
      );
    } catch (e) {
      return onError(e);
    }

    req.on('socket', (socket) => {
      socket.once('lookup', (_err, address) => {
        timing.dns = now() - t0;
        if (address && !Array.isArray(address)) ip = address;
        else if (Array.isArray(address) && address.length) ip = address[0];
      });
      socket.once('connect', () => {
        timing.tcp = now() - t0;
      });
    });
    req.on('timeout', () => fail('TIMEOUT'));
    req.on('error', onError);

    req.end();
    timer = setTimeout(() => fail('TIMEOUT'), timeout);
  });
}

/**
 * 解析 HLS 变体清单，取码率最高的那条。
 *
 * `uri` 是这条变体在清单里的相对地址（按 baseUrl 拼过），
 * 主清单只标 BANDWIDTH、没标 RESOLUTION 时，就得顺着它下钻到子清单去读分片。
 */
export function parseHlsVariants(text, baseUrl) {
  const lines = String(text).split(/\r?\n/);
  let best = null;
  let isMaster = false;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    const inf = i > 0 ? lines[i - 1].trim() : '';

    if (l.startsWith('#EXT-X-STREAM-INF:')) {
      isMaster = true;
      const bw = /BANDWIDTH=(\d+)/i.exec(l);
      const res = /RESOLUTION=(\d+)\s*[x×]\s*(\d+)/i.exec(l);
      const item = {
        bandwidth: bw ? Number(bw[1]) : null,
        width: res ? Number(res[1]) : null,
        height: res ? Number(res[2]) : null,
        uri: null,
      };
      // 变体 URI 紧跟在 #EXT-X-STREAM-INF 之后那一行（中间可能夹了 #EXT-X-MEDIA 之类的空行）
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const cand = lines[j].trim();
        if (cand && !cand.startsWith('#')) {
          item.uri = cand;
          break;
        }
        if (cand.startsWith('#EXT-X-STREAM-INF:')) break;
      }
      if (!best || (item.bandwidth || 0) > (best.bandwidth || 0)) best = item;
      if (best.uri && baseUrl) {
        try {
          best.uri = new URL(best.uri, baseUrl).toString();
        } catch {
          /* 拼不出来就保持相对地址，交给上层判 */
        }
      }
    }
    if (l.startsWith('#EXT-X-ENDLIST')) best = best || { bandwidth: null, width: null, height: null };
  }

  return { isMaster, best };
}

/* ------------------------------------------------------------------ *
 * 伪直播（循环片）识别
 * ------------------------------------------------------------------ */

/**
 * 分片名是不是「写死的递增小序号」：output000.ts / opt1.ts / chunk2.m4s。
 *
 * 这是拿脚本把一段录好的片子切一遍、原样丢到源站上的产物。真直播的 HLS
 * 分片名一定带「当前时刻」的味道：时间戳（seg_1730000000.ts）、大序号
 * （segment-99177.ts）、随机会话串；就算复用同一套文件名，它的清单也会
 * 每隔几秒吐出一份不一样的（分片列表在往前滑）。
 *
 * 所以单看文件名不算证据 —— 真直播也常用 1.ts/2.ts 循环覆盖，得配合
 * 「清单是完整的」一起看（见 detectStaticClip）。顺带把两种常见误刺剔掉：
 * 名字里混了时间戳或哈希的（主干都各不相同），以及序号不从 0/1 起头的。
 */
const SEG_NUM_RE = /^(.*?)(\d+)\.(ts|m4s|mp4|ts\?.*)$/i;
export function segNameShape(segs) {
  if (!segs.length) return null;
  const stems = new Set();
  const nums = [];
  for (const raw of segs) {
    const m = SEG_NUM_RE.exec(String(raw).split(/[?#]/)[0]);
    if (!m) return null; // 名字里压根没序号（比如 abc.ts）→ 不认
    const stem = m[1] || '';
    // 主干里带的若是时间戳或哈希，那每次生成都会不一样，不算「写死」
    if (/[0-9a-f]{8,}/i.test(stem) || /\d{9,}/.test(stem)) return null;
    stems.add(stem);
    nums.push(Number(m[2]));
  }
  if (stems.size !== 1) return null; // 主干各不相同 = 名字是变的
  const sorted = nums.slice().sort((a, b) => a - b);
  const from = sorted[0] === 0 || sorted[0] === 1 ? sorted[0] : -1; // 只允许从 0 号或 1 号起
  if (from < 0) return null;
  if (nums.some((n) => n > MAX_SEQ)) return null; // 位数太大的就是滚动序号了
  for (let i = 0; i < sorted.length; i++) if (sorted[i] !== from + i) return null; // 必须连着
  return { from, to: sorted[sorted.length - 1] };
}

/**
 * 媒体清单（非变体清单）里的分片与总时长 —— 顺手把「清单封口了没」一起记下来。
 *
 * durs / discont / targetDur 是给「几片子硬缝」那套检测用的（见 analyzeClipSeams）：
 * 光有分片列表看不出这些片是「一路推下来的」还是「几段独立片子硬缝的」，
 * 得看每片的时长、断点有几处、源站自己声明的目标是多久。
 */
export function parseHlsMedia(text) {
  const lines = String(text || '').split(/\r?\n/);
  const segs = [];
  const durs = [];
  let durSec = 0;
  let pending = null; // 上一行 #EXTINF 读到的时长，紧跟其后的那行才是分片 URI
  let endlist = false;
  let mediaSeq = null;
  let targetDur = 0;
  let discont = 0;
  for (const raw of lines) {
    const s = raw.trim();
    if (/^#EXT-X-DISCONTINUITY/.test(s)) {
      discont++;
      continue;
    }
    const inf = /^#EXTINF:\s*(-?[0-9.]+)/.exec(s);
    if (inf) {
      pending = +inf[1] || 0;
      continue;
    }
    if (!s || s[0] === '#') continue;
    if (pending !== null) {
      segs.push(s);
      durs.push(pending);
      durSec += pending;
      pending = null;
    }
  }
  endlist = /#EXT-X-ENDLIST/.test(String(text || ''));
  const ms = /^#EXT-X-MEDIA-SEQUENCE:\s*(\d+)/m.exec(String(text || ''));
  if (ms) mediaSeq = Number(ms[1]);
  const td = /^#EXT-X-TARGETDURATION:\s*(\d+(\.\d+)?)/m.exec(String(text || ''));
  if (td) targetDur = +td[1] || 0;
  return { segs, durs, durSec, endlist, mediaSeq, targetDur, discont };
}

/** 源站自认文件有多旧（天）；不回 Last-Modified 或读不懂就返回 -1 */
function lastModifiedAge(headers) {
  const lm = String((headers && (headers['last-modified'] || '')) || '').trim();
  if (!lm) return -1;
  const d = Date.parse(lm);
  if (!Number.isFinite(d)) return -1;
  return Math.floor((Date.now() - d) / 86400000);
}

/** 118 → "01:58"，note 里说「一共多长」时用 */
const clockLabel = (sec) => {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const x = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(x)}` : `${pad(m)}:${pad(x)}`;
};

/** 陈旧天数 → 「3 年前 / 8 个月前」 */
function ageLabel(days) {
  if (days >= 365) return `${Math.floor(days / 365)} 年前`;
  if (days >= 60) return `${Math.floor(days / 30)} 个月前`;
  return `${days} 天前`;
}

/**
 * 伪直播检测：一条被当成直播源加进列表的地址，其实是一段录好的循环片。
 *
 * 典型长这样（实测）：点开是「下载 XX APP 看直播」的带二维码引流短片，
 * 1~2 分钟一循环，清单规规矩矩写着 RESOLUTION=1920x1080，分片是真 TS，
 * 于是它在现有那套归因里**一条都不命中** —— 能连上、能播、分辨率也读得到，
 * 表格上就是个完美的「200 在线 · 1080p」，要播满三分钟才发现永远是同一张脸。
 *
 * 三条证据，组合起来才够硬（单看任何一条都会误杀）：
 *   ① 清单是「完整点播」—— 带 #EXT-X-ENDLIST。真直播的窗口清单永远不会写完，
 *      一旦看到 ENDLIST，这条流在时间上就是封口的（这是充分条件的地基）。
 *   ② 分片名写死（output000.ts … output023.ts：主干相同、序号从 0/1 起连续）。
 *   ③ 源站自认文件是陈的（Last-Modified 超过 STALE_DAYS 天没动过）。
 *      这条只是加分项 —— 动态生成的清单不回 Last-Modified，①②照样成立。
 *
 * 只认短片：总时长超过 CLIP_MAX_SEC 就当普通点播/回看放过。几十分钟往上走
 * 的基本都是真的回看源，那种误杀的代价（把真回看打成假直播）比漏放还大。
 *
 * @returns {{yes:boolean, why:string, durSec:number, segCount:number, staleDays:number}}
 */
export function detectStaticClip(text, headers) {
  const { segs, durSec, endlist } = parseHlsMedia(text);
  const shape = endlist ? segNameShape(segs) : null;
  const staleDays = lastModifiedAge(headers);
  const base = { durSec, segCount: segs.length, staleDays };
  // 变体清单（master，一行一个变体、没有 #EXTINF）和「没封口」的直播清单都在这儿落空
  if (!shape) return { yes: false, why: '', ...base };
  if (durSec > CLIP_MAX_SEC) return { yes: false, why: '', ...base };

  const bits = [
    `清单是已写完的点播（带 #EXT-X-ENDLIST）`,
    `${segs.length} 段共 ${clockLabel(durSec)}`,
    `分片名 ${shape.from} 号写死到 ${shape.to} 号、不滚动`,
  ];
  if (staleDays >= STALE_DAYS) {
    // 具体哪天得用响应头里那个 Last-Modified，别拿当前日期糊弄过去 ——
    // 那会印出「最后修改于 2026-10-06（3 年前）」这种自相矛盾的话
    const lm = String((headers && (headers['last-modified'] || '')) || '');
    const at = Number.isFinite(Date.parse(lm)) ? new Date(Date.parse(lm)).toISOString().slice(0, 10) : '';
    bits.push(`源站声明最后修改于 ${at}${at ? '（' : ''}${at ? ageLabel(staleDays) : ''}${at ? '）' : ''}`);
  }
  return {
    yes: true,
    why: `这是录好的循环片、不是实时直播：${bits.join('，')}`,
    ...base,
  };
}

/**
 * 第三类假源：**几段历史切片拼起来、假装成直播**（大湾区卫视那条 dwq.m3u8 实测形态）。
 *
 * 和「循环片」（detectStaticClip）不是一回事：循环片是带 ENDLIST 的录播短片，
 * 一篇一个样；这种是**没有 ENDLIST 的滚动窗口**，看着像直播，分辨率、码率、
 * 延迟全都正常，探测一路上挑不出毛病，只有播起来才现原形 —— 一怼一顿像
 * 「几段别的节目接起来」，放到最后一片就整个停住（窗口里再没有新片进来）。
 *
 * 判据分两层：
 *
 * ①静态（零成本，说了算）：analyzeClipSeams 那两条 —— 每段之间都写 DISCONTINUITY、
 *   时长零碎到没有一片是整段。真直播一路推下来只有换编码参数时会偶尔插一条断点，
 *   绝不会每一片之间都断；切片也是整段 GOP 切出来的，时长都贴着 TARGETDURATION。
 *   这两条凑齐，基本可以断定「是几段独立的片子按顺序缝进了窗口」。
 *
 * ②窗口还在不在滚（默认会复查一次，只作加强）：真直播的窗口每出一个切片就整份重写，
 *   两份隔一会儿拉来的清单内容不同。若一字未变 —— 而它连 ENDLIST 都没有 ——
 *   那就不是「慢」，是压根没有新数据了，播到末尾必然卡死。
 *
 *   为什么不能拿「没滚动」单独当证据：真直播 10 秒出一片，隔 1.5 秒重拉当然也
 *   纹丝不动，那样判会一竿子打翻一船真源。所以必须等上「至少一片」的功夫才敢说，
 *   而等一个切片周期（十几秒）对批量探测太贵 —— 于是这里宁可保守：
 *   静态那两条已经能把这类源拎出来标上「拼接」，滚动与否只用来把话说死
 *   （「放完最后一片就会停住」），不作为单独判据。
 *
 * @param {string} text     媒体清单正文
 * @param {string} [againText] 隔一会儿重拉来的那份（没拉到就传 null）
 */
export function detectSeamedLive(text, againText) {
  const { segs, durSec, endlist, discont, targetDur } = parseHlsMedia(text);
  const ev = analyzeClipSeams(text);
  const base = { ...ev, durSec, segCount: segs.length, endlist };
  // 段太少说不清，或者清单本身就是写完的点播（那叫回看，不叫假直播）
  if (!ev.suspicious || endlist) return { yes: false, frozen: false, why: '', ...base };

  const frozen = againText != null && parseHlsMedia(againText).segs.join('\n') === segs.join('\n');
  const segsTxt = segs.length === 1 ? `${segs[0]}` : `${segs[0]}…${segs[segs.length - 1]}`;
  const detail = [
    ev.seamed ? `这 ${segs.length} 段之间每一段都写了 #EXT-X-DISCONTINUITY（${discont} 处断点，一路没有衔接）` : '',
    ev.ragged
      ? `时长从 ${ev.minDur} 秒到 ${ev.maxDur} 秒参差、没有一片是整段（源站自己声明的目标时长 ${targetDur} 秒）`
      : '',
  ].filter(Boolean);

  const bits = [`这不是实时直播，是几段历史切片缝起来的：${detail.join('，')}，共 ${Math.round(durSec)} 秒`];
  if (frozen) {
    // 说死「放完就停」这件事，用户才好决定删不删 —— 光说「拼接」他还得自己去播一遍
    bits.push(
      `窗口已经停住：隔 ${(WINDOW_RECHECK_MS / 1000).toFixed(1)} 秒重拉清单，分片列表一字未变（还是 ${segsTxt}），` +
        `放到最后一片就再没下一片，画面必然卡死`,
    );
  } else if (againText != null) {
    bits.push(`这次复查时窗口还在滚（同一时刻拉来的清单已经换了内容），但内容依旧是这几段硬缝的`);
  }
  return { yes: true, frozen, why: `${bits.join('；')}。`, ...base };
}

/**
 * 有些源站不管客户端有没有声明，直接把 m3u8 压成 gzip/br 下发（虽然不合规），
 * 这时候 body 是一坨二进制，toString 出来解析不出任何变体，
 * 分辨率列就会莫名其妙地空着。这里按 Content-Encoding 解一层。
 */
function maybeDecompress(buf, headers) {
  const enc = String((headers && (headers['content-encoding'] || '')) || '').toLowerCase();
  if (!buf.length) return null;
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
    if (enc === 'deflate') return zlib.inflateSync(buf);
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
  } catch {
    return null; // 声明了但解不开的，交给上层按原文判
  }
  return null;
}

const isHlsBody = (buf, headers, url) => {
  const ct = (headers['content-type'] || headers['content-type '.trim()] || '').toLowerCase();
  if (ct.includes('mpegurl') || ct.includes('x-mpegURL')) return true;
  if (/^#EXTM3U/.test(buf.toString('utf8', 0, Math.min(buf.length, 64)))) return true;
  return /\.m3u8(\?|$)/i.test(url);
};

/**
 * 少于这个字节数就不算吞吐：探测最多只读 64KB，
 * 拿几十 KB 去除以传输时间，得出的数字毫无参考价值（常见表现是「0.01M」）。
 */
const MIN_THROUGHPUT_BYTES = 32768;

/**
 * 顺手读一遍流里的 SDT 服务名（TS 里那个节目名，播放器媒体信息就显示它）。
 *
 * 为什么顺手（不多花一分流量）：SDT 在流里每 ~1MB 重复一次，默认的 128KB 浅窗口
 * 命中率只有一成上下；但多扫几百个 TS 包是微秒级的事，命中就白赚一条线索 ——
 * HLS 媒体清单（子清单）的 #EXTINF 标题经常是占位的 `no desc`，
 * m3u 里 tvg-name / tvg-id 也常是空的，而流自己往往写着真名。
 * 这条线索可以直接拿去自动填 tvg-id / 频道名。
 */
function appendServiceName(out, body) {
  if (!body || body.length < 188) return;
  const name = tsServiceName(body);
  if (!name) return;
  out.serviceName = name;
  out.note = (out.note ? out.note + '；' : '') + `流内 SDT 服务名「${name}」`;
}

/**
 * 「分辨率为什么空着」的人话。
 *
 * 这一张表是**局部重试点是否存在**的唯一依据：界面上只给 retryable 那两类条目
 * 挂 ⟳ 按钮。之所以要区分得这么细，是因为「能连上却没读到分辨率」这一批里
 * 混着好几类完全不同的东西 —— 一半挖多深都没用（纯音频台、源站压根没写），
 * 给它们一个按钮，点下去只会让人误以为「连挖 8MB 也读不到」，
 * 从这个统计里根本看不出窗口该不该加大。
 *
 *   retryable（值得用更大的窗口再挖一次）：
 *     long-gop  视频轨在，SPS 落在下一个 IDR，窗口没盖到 —— 加大窗口就是解药
 *     seg-fail  分片/变体没取到（直播窗口滚走、源站闪断），换个时刻重挖可能就命中
 *     no-psi    这一窗连 PAT/PMT 都没扫到（切片开头不发节目信息表，表在 1MB 之后）。
 *               判成「没视频」是冤枉源站，加大窗口才碰得上，所以它也是解药。
 *
 *   挖多深也没用的（不给按钮）：
 *     audio-only  纯音频台，压根没有视频轨
 *     no-video    流描述里就没视频轨（PMT 拆得出来，里面没列视频）
 *     no-pmt      码流结构认不出来，不是窗口大小的问题
 *     m3u-note    源站清单里本来就没写这个信息
 */
export const NO_RES_TEXT = {
  'audio-only': '这条流只有音频、没有视频轨（纯音频台），再挖多深也不可能读出分辨率',
  'no-video': '能连上但没读到视频轨（源站的流描述里就没有视频），不是探测没挖到',
  'no-psi': '这份切片开头连 PAT/PMT 都没带（节目信息表在更后面），目前看不出有没有视频轨 —— 加大窗口重挖才可能读到',
  'no-pmt': '码流结构认不出来（不是标准 TS / MP4），分辨率没法判断',
  'long-gop': '视频轨在，只是探测窗口没盖到关键帧（SPS 在下一个 IDR 处），值得用更大的窗口再挖一次',
  'seg-fail': '取不到具体分片/变体（直播窗口已滚走，或源站闪了一下），换个时刻重挖可能就命中',
  'm3u-note': '源站的清单里压根没写分辨率（物理上没有这个信息），重挖也没用',
  'no-data': '收到了响应但一个字节的码流都没拿到，分辨率无从判断',
};

/**
 * 只有这一类才值得给「再挖一次」的入口。
 *
 * no-psi 也在里面：实测某 IPTV 直播源（112.123.243.37 那条 txiptv 分片）开头
 * 128KB 只发音视频包，PAT/PMT/SDT 全在 1MB 之后 —— 首窗判出来的「没视频轨」
 * 是假象，深挖到 2MB 就能连 SPS 带服务名一起捞回来。
 */
export const RES_RETRYABLE = new Set(['long-gop', 'seg-fail', 'no-psi']);

/**
 * 记下「没分辨率的原因」。先来的算数：一轮探测里可能先后碰到好几条线索
 * （先取不到分片、后又确认是纯音频），最终原因要落到**最终结论**上，
 * 所以真读出了分辨率时由调用方清掉，读不出时只写一次。
 */
/** 一段字节是不是播放清单（#EXTM3U 开头）—— 用来分辨「没取到分片」和「取来的是清单」 */
const isPlaylistBody = (b) => !!b && b.length >= 5 && b.slice(0, 5).toString('latin1') === '#EXTM';

/** 常见音频文件的 URL 后缀（.mp4/.m4s 不在内，那俩是视频容器） */
const AUDIO_URL_RE = /\.(mp3|m4a|aac|flac|opus|oga|mka|wma|ac3|eac3)(?:[?#]|$)/i;

/**
 * 源站自己「自证」这条流是纯音频的，满足任意一条就算数：
 *
 *   ct     content-type 是 audio/*（最硬的一条）
 *   url    URL 后缀是常见音频文件（.mp3 / .m4a / .aac …）
 *   icy    带了 icy-* 元数据头（SHOUTcast 电台的标配：icy-name / icy-br / icy-genre）
 *
 * 纯音频台不可能有分辨率，所以这是**硬证据**，不信 analyzeStream 的判法：
 * 它在一整段 mp3 字节里既可能瞎撞出 `00 00 01` 报 long-gop，也可能因为找不到
 * TS/MP4 结构报 no-pmt —— 两种都会让界面在电台那栏挂个「?」让人点开问一句
 * 「为什么不挖」，而答案本来就该是三个字：纯音频。
 */
function audioStreamProof(ct, url, headers) {
  if (/^audio\//i.test(String(ct || ''))) return 'ct';
  const path = String(url || '').split(/[?#]/)[0];
  if (AUDIO_URL_RE.test(path)) return 'url';
  for (const k of Object.keys(headers || {})) {
    if (/^icy-/i.test(k)) return 'icy';
  }
  return '';
}
const setNoRes = (out, code) => {
  if (!code || out.noRes) return;
  out.noRes = code;
  out.noResText = NO_RES_TEXT[code] || '';
};

/** 读出分辨率了就把归因清干净（免得上一轮的旧结论挂在成功的结果上） */
const clearNoRes = (out) => {
  out.noRes = '';
  out.noResText = '';
};

/** 把分辨率归约为 480p / 720p / 1080i 这种播放器认识的说法 */
export function formatLabel(width, height) {
  if (!width || !height) return '';
  const h = Math.round(height / 2) * 2;
  if (h >= 2160) return `${width}x${height} (4K)`;
  if (h >= 1080) return `${width}x${height} (1080p)`;
  if (h >= 720) return `${width}x${height} (720p)`;
  if (h >= 576) return `${width}x${height} (576i/SD)`;
  if (h >= 480) return `${width}x${height} (480p)`;
  return `${width}x${height}`;
}

/** 这类响应值不值得再试一次 */
function canRetry(last) {
  if (!last) return false;
  if (last.redirect) return false;
  if (last.error) {
    // 证书类已经跳过校验试过一轮了，再重试没意义
    if (TLS_RETRYABLE.has(last.code)) return false;
    return TRANSIENT_CODES.has(last.code);
  }
  const s = last.status || 0;
  if (RETRY_STATUS.has(s)) return true;
  // 403 只换一次 UA，连着两次都 403 那就是真的不放行
  return s === 403 && !last.uaswitchDone;
}

/**
 * 探测单个播放地址（内部带失败重试）。
 * @returns {Promise<Object>} 结构化结果
 */
export async function probeUrl(rawUrl, opts = {}) {
  const { timeout = 8000, probeBytes = 65536, maxRedirects = 3, retries = 2 } = opts;
  const out = {
    url: rawUrl,
    ok: false,
    status: 0,
    code: '',
    delayMs: 0,
    totalMs: 0,
    dnsMs: 0,
    tcpMs: 0,
    ttfbMs: 0,
    mbps: 0,
    bytes: 0,
    ip: '',
    format: '',
    width: 0,
    height: 0,
    bandwidthMbps: 0,
    stallRisk: '',
    isHls: false,
    tlsInsecure: false,
    uaswitch: false,
    serviceName: '', // 流内 SDT 服务名（节目名），读不到就空着，别猜
    noRes: '', // 分辨率空着的原因（见 NO_RES_TEXT）；空串 = 读到了
    noResText: '', // 上面那条的中文原话，界面直接显示
    fakeLive: false, // 伪直播：其实是录好的循环片（详见 detectStaticClip）
    fakeLiveWhy: '', // 上面那条的中文原话 + 依据，界面 tooltip 直接显示
    clipSec: 0, // 循环片总时长（秒）；不是循环片时没意义
    clipSegs: 0, // 循环片分片数
    clipSeams: false, // 静态证据：分片是几段独立片子硬缝的（每段都断 / 时长零碎）
    seamLive: false, // 假源第二路：缝起来的「假直播」（详见 detectSeamedLive）
    seamLiveWhy: '', // 上面那条的中文原话 + 依据，界面 tooltip 直接显示
    windowFrozen: false, // 复查确认：两次拉取之间分片列表一字未变（没有新片进来）
    attempts: 0,
    retried: 0,
    note: '',
  };

  // 证书类重试单独记账：它的结论和「普通重试后仍失败」不一样，提示语得分开说
  let tlsRetryFailed = false;
  let tlsRetryCode = '';

  /**
   * 这趟拿到的 body 该以哪个地址当基准去拼相对路径（分片 URI、变体 URI）。
   *
   * 必须用「跟随完重定向的最终地址」，不能用用户给的原始地址 ——
   * 实测 GSLB 源（38.75.136.137:98 那条 cctv16hd.m3u8）第一个请求就是 302，
   * 把人换到另一台机器、另一个端口上（host/port/path/query 全换），
   * 清单里的相对分片拿原始地址去拼就会打回原来那台机器：
   * 清单本身 200 在线，分片却 404，「有分辨率信息」和「没有」全看那台机器认不认。
   */
  let baseUrl = rawUrl;

  /** 一轮完整尝试：跟随重定向 + 证书类失败时跳过校验再试一次 */
  const attempt = async (extra = {}) => {
    out.attempts++;
    let current = rawUrl;
    let redirects = 0;
    let last = null;

    while (redirects <= maxRedirects) {
      last = await requestOnce(current, { timeout, probeBytes, ...extra });
      if (!last.redirect) break;
      redirects++;
      current = last.location;
    }
    if (last.redirect) return { last, retryable: false, finalUrl: current };

    if (last.error && !extra.noInsecureRetry && TLS_RETRYABLE.has(last.code)) {
      // 证书类失败 → 跳过证书校验再试一次。成了就是「可用但有告警」，不是死链。
      const retry = await requestOnce(current, { timeout, probeBytes, rejectUnauthorized: false, ...extra });
      if (!retry.error && retry.status >= 200 && retry.status < 400) {
        retry.tlsRecovered = true;
        last = retry;
      } else {
        // 重试也没救回来：这条已经证明「证书不可信 ≠ 源还活着」，
        // 别再把「播放器通常仍能播」这种话印在失败提示上，那会误导人去留着它。
        tlsRetryFailed = true;
        tlsRetryCode = retry.code || '';
      }
    }
    return { last, retryable: canRetry(last), finalUrl: current };
  };

  let { last, retryable, finalUrl: firstFinal } = await attempt();
  if (firstFinal) baseUrl = firstFinal;
  // 退避重试：抖动的链路往往几百毫秒就缓过来，别一上来就判死
  let backoff = 300;
  while (retryable && out.attempts <= retries) {
    out.retried++;
    await sleep(backoff + Math.random() * 150);
    backoff = Math.round(backoff * 1.8);
    const next = await attempt(last.status === 403 ? { alt: true } : {});
    last = next.last;
    retryable = next.retryable;
    if (next.finalUrl) baseUrl = next.finalUrl;
  }
  out.uaswitch = !!last.uaswitchDone;

  if (!last || last.redirect) {
    out.code = 'REDIRECT_LOOP';
    out.note = ERROR_HINT.REDIRECT_LOOP;
    return out;
  }

  const timing = last.timing || { dns: 0, tcp: 0, ttfb: 0, end: last.ms || 0 };
  out.dnsMs = Math.round(timing.dns);
  out.tcpMs = Math.round(timing.tcp);
  out.ttfbMs = Math.round(timing.ttfb || last.ms || 0);
  out.totalMs = Math.round(timing.end || last.ms || 0);
  out.delayMs = out.ttfbMs;
  out.status = last.status || 0;
  out.bytes = last.bytes || 0;
  out.ip = last.ip || '';

  if (last.status >= 300 && last.status < 400) {
    out.code = `HTTP_${last.status}`;
    out.note = '仍在重定向';
    return out;
  }

  if (last.error || last.status === 0) {
    const code = last.code || 'ERROR';
    out.code = code;
    if (tlsRetryFailed) {
      // 跳过证书校验也连不上 = 源已经死了，证书只是它死因的一部分。
      out.note = `跳过证书校验重试后仍连不上${tlsRetryCode ? `（${tlsRetryCode}）` : ''}，源已失效`;
    } else {
      // 原始错误码是给开发者看的（ERR_TLS_CERT_ALTNAME_INVALID 这种），
      // 直接甩到界面上等于没报错，这里换成能看懂的说法。
      out.note = ERROR_HINT[code] || (code === 'TIMEOUT' ? '超时未响应' : code);
    }
    if (out.retried) out.note += `（重试 ${out.retried} 次仍失败）`;
    return out;
  }

  if (last.status >= 400) {
    out.code = `HTTP_${last.status}`;
    out.note =
      (last.status === 403 && out.retried
        ? 'HTTP 403：换播放器 UA 重试仍被拒（多半是 Referer / 授权校验，多半不是源死）'
        : `HTTP ${last.status}`) + (out.retried ? `（重试 ${out.retried} 次仍失败）` : '');
    return out;
  }

  const ttfb = Math.max(1, out.ttfbMs);
  let body = last.body || Buffer.alloc(0); // 可能被解压替换掉，所以必须是 let

  // HLS 主清单只有几 KB，实测吞吐测的只是拉清单的速度，不是通道带宽 → 直接不算。
  if (isHlsBody(body, last.headers || {}, rawUrl)) {
    out.mbps = 0;
  } else if (body.length > 0) {
    // 只读到几十 KB 就掐断的（直播 ts 流、被限速的源），算出来的 Mbps 是噪音
    // —— 截图上「0.01M」就是这么来的。样本不够就不给数，宁可空着。
    if (out.bytes >= MIN_THROUGHPUT_BYTES) {
      const transferMs = Math.max(1, out.totalMs - ttfb);
      out.mbps = +((out.bytes * 8) / transferMs / 1e6).toFixed(2);
    } else {
      out.mbps = 0;
      out.note = (out.note ? out.note + '；' : '') + '样本不足，不作带宽测算';
    }
  }

  const ct = (last.headers && (last.headers['content-type'] || '')) || '';

  let hls = isHlsBody(body, last.headers || {}, rawUrl);
  if (hls) {
    const dec = maybeDecompress(body, last.headers || {});
    if (dec) body = dec;
    // 解压后再判一次：原本靠 URL 后缀认出来的，解压后能真的读到 #EXTM3U 才算数
    if (dec && /^#EXTM3U/.test(body.toString('utf8', 0, Math.min(body.length, 64)))) hls = true;
  }

  if (hls) {
    out.isHls = true;
    const text = body.toString('utf8');
    const { isMaster, best } = parseHlsVariants(text, baseUrl);
    out.width = best && best.width;
    out.height = best && best.height;
    out.format = formatLabel(out.width, out.height);
    out.bandwidthMbps = best && best.bandwidth ? +(best.bandwidth / 1e6).toFixed(2) : 0;

    // 主清单只写码率不写分辨率（CCTV/省级源里很常见 —— 变体行只有 BANDWIDTH 和 CODECS）
    // 时，必须顺着码率最高的那条变体下钻到它的子清单，那里才是能读出分辨率的地方。
    // 早先到这儿就收工了，界面上就是一句「主清单只标了码率 3.5M 未标 RESOLUTION」，
    // 明明子清单里的分片就能读出 720p。
    let src = text;
    let drilled = false; // 下钻过码率最高的变体了吗（会改掉 note 的措辞）
    // 当前这份清单是从哪个地址拿的（下钻后会换成变体子清单的地址）——
    // 后面「重拉一次清单再试」要沿着它走，不然会把主清单重拉一遍、
    // 又把第一个变体 URI 当成分片 URI 拉一次（多打一次没用的请求）
    let srcUrl = baseUrl;
    // 这份清单的响应头（下钻过就是子清单那次响应的）：伪直播检测要看
    // Last-Modified 判断源站自认文件有多旧，它得对得上手里这份清单
    let srcHeaders = last.headers || {};
    const drill = async (from, base) => {
      const v = parseHlsVariants(from, base);
      if (!v.isMaster || !v.best || v.best.width || !v.best.uri) return null;
      try {
        const sub = await requestOnce(v.best.uri, { timeout: Math.min(timeout, 8000), probeBytes: 65536 });
        if (sub.error || !sub.body || !sub.body.length || !isPlaylistBody(sub.body)) return null;
        return { text: sub.body.toString('utf8'), url: v.best.uri, headers: sub.headers };
      } catch {
        return null; // 下钻失败就留在主清单上，下面的分片读取照走，只是多半也取不到
      }
    };
    if (isMaster && best && !best.width && best.uri) {
      const sub = await drill(text, baseUrl);
      if (sub) {
        src = sub.text;
        srcUrl = sub.url;
        srcHeaders = sub.headers || srcHeaders;
        drilled = true;
      }
    }

    if (!out.format) {
      // 分辨率拿不到必须说清是哪种拿不到，否则界面上就是一个干巴巴的「—」，
      // 用户分不清「工具没解析」还是「源站没给」。
      if (!isMaster) {
        out.note = '媒体播放列表（非变体清单），HLS 子清单里不含分辨率信息';
      } else if (drilled) {
        // 下钻过就先不下结论 —— 这一路到底能不能读出分辨率，要等后面读完分片才知道。
        // 在这儿写「也没读出分辨率」，读到了就会变成一句自相矛盾的 note。
      } else if (out.bandwidthMbps > 0) {
        out.note = `主清单只标了码率 ${out.bandwidthMbps}M 未标 RESOLUTION，无法得知分辨率`;
      } else {
        out.note = '主清单未标 RESOLUTION，无法得知分辨率';
      }
    } else if (!isMaster) {
      out.note = '媒体播放列表（非变体清单）';
    } else if (drilled) {
      out.note = `主清单未标 RESOLUTION，已下钻码率最高的变体（${out.bandwidthMbps}M）读它的分片流头得到`;
    }

    // 子清单里没有 RESOLUTION 时，再拉一个分片去读流头 —— 这是「200 在线却没分辨率」
    // 最常见的一种，不做这一步就只能干瞪眼。
    //
    /** 从分片流头读出分辨率时那句 note —— 下钻过变体就别说「子清单没写分辨率」了 */
    function gotFromSegmentNote() {
      return drilled
        ? `主清单${
            out.bandwidthMbps > 0 ? `只标了码率 ${out.bandwidthMbps}M 未标 RESOLUTION，` : '未标 RESOLUTION，'
          }已下钻码率最高的变体、从它的分片流头读到`
        : '子清单没写分辨率，已读第一个分片流头得到';
    }

    /** 没读出尺寸时把「为什么」说人话：扫到切片但没 SPS，不等于压根没视频 */
    function noSpsReason(res, why) {
      if ((res && res.codec === 'h264-slice') || why === 'long-gop') {
        return '分片扫到 H.264 视频轨道，但抓到的这段里从头到尾没有 SPS（源未写入，或关键帧间隔大于探测窗口）';
      }
      // 一窗之内连 PAT/PMT 都没见着 —— 这是「我们看得不够远」，不是「这条流没视频」。
      // 早先它和 no-video 混在一起，界面上就变成「源站的流描述里就没有视频」，
      // 一个 1080p 被判成死路，还因为不可重挖连 ⟳ 都不给。
      if (why === 'no-psi') {
        return '分片开头没带 PAT/PMT（节目信息表在更后面），这一窗看不出有没有视频轨 —— 加大窗口重挖才可能读到';
      }
      return '分片拉到了但里头没读到视频 SPS（可能是纯音频切片）';
    }

    //
    // 直播清单还有个坑：分片会随播放推进滚出窗口。像 CGTN 那种只留 6 个 4 秒分片（共 24 秒）
    // 的，从「读到清单」到「请求分片」之间哪怕只差几百毫秒，清单上列的第一条也常常已经 404。
    // 所以失败一轮就重新拉一次清单再试，最多两轮；两轮都拿不到就把话说清楚，
    // 别留一句「子清单里不含分辨率信息」让人以为又是源站没给。
    if (!out.format) {
      // 局部重挖时前端会传一个比 2MB 更大的 probeBytes：深挖那一档要跟着往上顶，
      // 否则「突破 2MB」只体现在首窗口，深挖还是按 2MB 收手，等于没破例。
      const probeBytesOverride = probeBytes > SEG_DEEP_BYTES ? probeBytes : 0;
      let seg = null; // 最近一次成功取到的分片，深挖时复用（清单可能已滚出窗口）
      // src 上面可能已经下钻到码率最高的变体那个子清单了（主清单没写 RESOLUTION 时）
      let sawVideo = false; // 扫到过视频切片：画面在，缺的只是 SPS
      // 一窗之内连 PAT/PMT 都没见着：别急着判「没视频」，把窗口加大再看一眼。
      // 实测某个直播源的分片前 128KB 只发音视频包，表全在 1MB 之后。
      let sawNoPsi = false;
      let reason = ''; // 最后一轮的失败原因，收尾时一句说清，别撒在中途
      // 没读出分辨率时顺手记下的归因：它决定界面上要不要给「再挖一次」的入口。
      // 纯音频台、源站没写这类线索一冒头就别再被后面的覆盖（setNoRes 只写第一次）。
      let segReason = '';
      const noteReason = (code) => {
        setNoRes(out, code);
        if (!segReason) segReason = code;
      };
      for (let round = 0; round < 2 && !out.format; round++) {
        if (round > 0) {
          try {
            const re = await requestOnce(srcUrl, { timeout, probeBytes: 32768 });
            if (re.error || !re.body || !re.body.length) break;
            src = re.body.toString('utf8');
            // 重拉回来还是变体清单（下钻没成功过）就再钻一次；下钻成功过的话
            // srcUrl 已经是那个变体子清单，重拉它自己就够了。
            if (!drilled) {
              const sub = await drill(src, baseUrl);
              if (sub) {
                src = sub.text;
                srcUrl = sub.url;
                drilled = true;
              }
            }
          } catch {
            break;
          }
        }
        // 基准要跟着 src 走：下钻过的话这份清单是变体子清单给的，
        // 它的分片（`seg0.ts`）得拼在子清单那个目录下，不是原来那个 master 上
        seg = firstSegmentUri(src, srcUrl);
        if (!seg) break;
        try {
          const r2 = await requestOnce(seg, { timeout: Math.min(timeout, 8000), probeBytes: SEG_HEAD_BYTES });
          if (r2.error || r2.status < 200 || r2.status >= 400) {
            if (round === 1) {
              out.note = (out.note ? out.note + '；' : '') + `分片取不到（${r2.status || r2.code || '失败'}），分辨率读不到`;
              noteReason('seg-fail');
            }
            continue;
          }
          const analyzed = analyzeStream(r2.body || Buffer.alloc(0));
          const res = analyzed.res;
          // 「分片」取回来的是清单本身（子清单里没写分片、或分片 URI 指向另一个清单）：
          // 这不是「码流结构认不出来」，是源站手里压根没这份信息 —— 报 no-pmt 会让人
          // 以为该换更大的窗口重挖，其实挖到天荒地老也一样。
          const why = isPlaylistBody(r2.body) ? 'm3u-note' : analyzed.reason;
          appendServiceName(out, r2.body);
          if (res && res.width) {
            out.width = res.width;
            out.height = res.height;
            out.format = formatLabel(out.width, out.height);
            out.note = (out.note ? out.note + '；' : '') + gotFromSegmentNote();
            clearNoRes(out);
          } else {
            // 扫到切片 / 认出视频轨，说明这一路确实是视频，只是窗口里没有 SPS ——
            // 后面那次深挖还认它，别在这就把它当成「没有视频」而放弃。
            if (res && (res.codec === 'h264-slice' || res.codec === 'h264-spsext')) sawVideo = true;
            if (why === 'long-gop') sawVideo = true;
            if (why === 'no-psi') sawNoPsi = true;
            // 只在最后一轮把话说死；「取回来的是清单」不算没读到 SPS，那句 human 话
            // 在上面那句「源站压根没写」里已经说过了，别再补一句自相矛盾的。
            if (round === 1 && why !== 'm3u-note') reason = noSpsReason(res, why);
            if (why) noteReason(why);
          }
        } catch {
          /* 分片拉不到就算了，下一轮/收尾会把原因补上 */
        }
      }

      // 首窗口盖不住一个 GOP 时的补救：把同一个分片读得更深一点重来一次。
      // 只在「明明看见视频、却没读到 SPS」或「这一窗压根没带节目信息表」时发生
      // —— 前者缺的是关键帧，后者缺的是 PAT/PMT，多读一点都换得回来；
      // 本就探不到分辨率的通道也只会白费这一次，不会波及到别的。
      if (!out.format && seg && (sawVideo || sawNoPsi)) {
        try {
          // 窗口越深越要给它时间读完，否则慢源上永远停在「超时未读完」，
          // 重挖一笔流量、什么结论都没换回来。
          const deepMs = probeBytesOverride ? Math.min(timeout, 25000) : Math.min(timeout, 10000);
          const r3 = await requestOnce(seg, { timeout: deepMs, probeBytes: probeBytesOverride || SEG_DEEP_BYTES });
          const { res, reason: why3 } = analyzeStream(r3.body || Buffer.alloc(0));
          appendServiceName(out, r3.body);
          if (res && res.width) {
            out.width = res.width;
            out.height = res.height;
            out.format = formatLabel(out.width, out.height);
            clearNoRes(out);
            out.note =
              (out.note ? out.note + '；' : '') +
              (sawNoPsi && !sawVideo
                ? // 这一路没见着视频切片，只是节目信息表在后面 —— 别把话说成「没盖到关键帧」
                  `${gotFromSegmentNote()}（这一窗开头没带 PAT/PMT，已加深到 ${mbLabel(
                    probeBytesOverride || SEG_DEEP_BYTES,
                  )} 再读一次才捞到）`
                : `${gotFromSegmentNote()}（首窗口没盖到关键帧，已加深到 ${mbLabel(
                    probeBytesOverride || SEG_DEEP_BYTES,
                  )} 再挖一次）`);
          } else if (r3.error && !res) {
            if (why3) noteReason(why3);
          } else if (why3) {
            noteReason(why3);
          }
          if (r3.error && !res) {
            // 慢源上深挖常常读不完就被超时掐断 —— 这时候说「源没写 SPS」是冤枉人家，
            // 得说清是没读完（这类也归 seg-fail，换个时刻重挖可能就撑到了关键帧）。
            reason =
              reason ||
              (sawNoPsi && !sawVideo
                ? '加深读分片也没扫到 PAT/PMT（这条分片压根没带节目信息表），分辨率无从判断'
                : '分片扫到 H.264 视频切片，但加深读流头时超时未读完（源慢或限流），没能读到 SPS');
          }
        } catch {
          /* 深挖失败就算了，收尾把首轮的 reason 补上 */
        }
      }

      if (!out.format && !out.noRes) {
        // 一条具体线索都没拿到（比如压根没有分片 URI），那就是源站清单里本来就空着
        noteReason('m3u-note');
      }

      if (!out.format && drilled && !/下钻码率最高的变体/.test(out.note || '')) {
        // 下钻过了还是空手：把这一路的来龙去脉补上（下钻本身是额外一次请求，得交代清楚）
        out.note =
          (out.note ? out.note + '；' : '') +
          `主清单${out.bandwidthMbps > 0 ? `只标了码率 ${out.bandwidthMbps}M 未标 RESOLUTION，` : '未标 RESOLUTION，'}已下钻码率最高的变体也没读出分辨率`;
      }

      if (!out.format && reason) {
        out.note = (out.note ? out.note + '；' : '') + reason;
      }
    }

    // 伪直播（录好的循环片）检测。
    //
    // 必须放在 `if (!out.format)` 之外：主清单常常规规矩矩写着 RESOLUTION，
    // 这类源「能连上、能播、分辨率也读得到」，是现有那套归因里唯一挑不出毛病的一路。
    // 早先只在读不到分辨率时才顺手看清单，结果一条 1920x1080 的引流循环片
    // 在表格里就是个完美的「在线」，得播满两分钟才发现永远是同一张脸。
    //
    // 检测要落在**媒体清单**（真正列分片那份）上看：master 里既没分片也没有
    // ENDLIST，只看 master 等于没看，而上面那条「有 RESOLUTION 就不下钻」恰好
    // 把这种最常见的情况卡住了（单档 master 写死 1920x1080 是引流片的标配）。
    // 所以这里给单档 master 补拉一次子清单 —— 单档本身就是个可疑信号
    // （真直播的 master 一般给 2~6 档码率），而这一枪只有几 KB。
    let clipSrc = src;
    let clipHeaders = srcHeaders;
    if (!drilled && isMaster && best && best.uri) {
      try {
        const sub = await requestOnce(best.uri, { timeout: Math.min(timeout, 8000), probeBytes: 65536 });
        if (!sub.error && sub.body && sub.body.length && isPlaylistBody(sub.body)) {
          clipSrc = sub.body.toString('utf8');
          clipHeaders = sub.headers || clipHeaders;
        }
      } catch {
        /* 补拉失败就留在 master 上判，master 里没分片，照旧判不出「循环片」 */
      }
    }
    const clip = detectStaticClip(clipSrc, clipHeaders);
    if (clip.yes) {
      out.fakeLive = true;
      out.fakeLiveWhy = clip.why;
      out.clipSec = clip.durSec;
      out.clipSegs = clip.segCount;
      out.note = (out.note ? out.note + '；' : '') + clip.why;
    }

    // 假源第二路：**几段历史切片缝起来假装成直播**（dwq.m3u8 那条实测形态）。
    //
    // 只在清单**没封口**时才查：写完的点播清单归上面 detectStaticClip 管，
    // 而且点播源的长相本来就跟「硬缝」一个样，套这套判据会误杀一整个回看源。
    //
    // 顺带说清为什么这里要等一下（WINDOW_RECHECK_MS）再重拉：真直播 10 秒才出一
    // 片，同一片周期内拉两份当然是同一份，那样判「没滚动」等于把活源也判死。
    // 所以静态那两条（analyzeClipSeams）说了算，滚动与否只用来把「放完就卡死」
    // 这句话坐实 —— 复查没拉到也无所谓，note 里照样有静态那部分。
    if (!clip.yes && !/#EXT-X-ENDLIST/.test(clipSrc)) {
      const seams = analyzeClipSeams(clipSrc);
      if (seams.suspicious) {
        let again = null;
        try {
          await sleep(WINDOW_RECHECK_MS);
          const rr = await requestOnce(srcUrl, { timeout: 8000, probeBytes: 65536 });
          if (!rr.error && rr.body && rr.body.length) again = rr.body.toString('utf8');
        } catch {
          again = null;
        }
        const d = detectSeamedLive(clipSrc, again);
        out.clipSeams = true;
        // 「是几片子缝起来的」（静态，说了算，见 detectSeamedLive）与
        // 「窗口已经停了、放完就卡死」（复查，只影响文案）是两件事，别混成一起判
        out.seamLive = d.yes;
        out.windowFrozen = d.frozen;
        out.seamLiveWhy = d.why;
        if (d.why) out.note = (out.note ? out.note + '；' : '') + d.why;
      }
    }
  } else {
    out.note = `直播直连流 ${ct || ''}`.trim();
    // 直连流：宽高就藏在码流里（TS 的 PES → SPS，或 MP4 的 moov/stsd），读一遍就出来
    const { res, reason: why } = analyzeStream(body || Buffer.alloc(0));
    appendServiceName(out, body);
    // 源站自证是纯音频流的（audio/* 声明、.mp3/.m4a 后缀、icy 电台头）—— 硬证据，
    // 不信下面那套字节扫描的结论，详见 audioStreamProof 的注释。
    const audioProof = audioStreamProof(ct, rawUrl, last ? last.headers : {});

    if (audioProof && res && res.width && res.height) {
      // 音频字节里瞎撞出一套「SPS」：源站都说是音频了，这个宽高不能采信，
      // 不然界面会在电台那栏偶尔冒出一个 1920x1080，样本随机、时有时无。
      out.note =
        (out.note ? out.note + '；' : '') +
        `源站自证是纯音频流（${
          audioProof === 'icy' ? 'icy 电台头' : audioProof === 'url' ? 'URL 是音频文件' : 'Content-Type 是 audio/*'
        }），这段字节里扫出的宽高是巧合，不采信`;
      out.width = 0;
      out.height = 0;
      out.format = '';
      setNoRes(out, 'audio-only');
    } else if (res && res.width && res.height) {
      out.width = res.width;
      out.height = res.height;
      out.format = formatLabel(out.width, out.height);
      out.note = (out.note ? out.note + '；' : '') + '分辨率读自视频流头';
      clearNoRes(out);
    } else if (audioProof) {
      // 「纯音频」和「字节扫不出东西」两件事得一起说清，所以直接定性，
      // 不再看 analyzeStream 回的是 long-gop 还是 no-pmt —— 音频字节里两种都可能
      // 出现（撞见 00 00 01 报 long-gop、找不到结构报 no-pmt），
      // 而两种在界面上都会退化成一个「?」，让人点开问「为什么不挖」。
      setNoRes(out, 'audio-only');
    } else {
      // 直连流这里能直接分清「压根没视频」和「有视频只是关键帧没盖到」——
      // 后者才值得给重挖按钮（加大窗口就是解药），前者点了也是白挖。
      setNoRes(out, why || 'no-pmt');
    }
  }

  if (last.tlsRecovered) {
    out.tlsInsecure = true;
    out.note = (out.note ? out.note + '；' : '') + '证书校验未通过，已跳过校验（源可用）';
  }

  // 换了播放器 UA 才拿到的 200：说出来，不然用户以为 403 是真被拒
  if (out.uaswitch) {
    out.note = (out.note ? out.note + '；' : '') + '首次 403（浏览器 UA 被拒），换播放器 UA 后放行';
  }

  // 卡顿预判：实测吞吐 vs HLS 变体标称码率
  const need = out.bandwidthMbps;
  if (need > 0 && out.mbps > 0) {
    const ratio = out.mbps / need;
    if (ratio < 0.75) {
      out.stallRisk = 'high';
      out.note = (out.note ? out.note + '；' : '') + `带宽不足（需 ${need}M，实测 ${out.mbps}M）`;
    } else if (ratio < 1.35) {
      out.stallRisk = 'mid';
    } else {
      out.stallRisk = 'low';
    }
  } else if (out.status === 200 && out.ttfbMs > 3000) {
    out.stallRisk = 'mid';
    out.note = (out.note ? out.note + '；' : '') + '首字节很慢，起播容易白屏';
  }

  out.ok = true;
  return out;
}

/**
 * 同一个域名的最小请求间隔。
 *
 * 一张 120 条的列表里往往几十条同源（CHC 那几条一起超时就是被自己的并发请求
 * 打到限流/排队了）。给同源加个小间隔，命中率立刻好看，代价只是慢零点几秒。
 */
function makeHostGate(gapMs) {
  const hosts = new Map();

  return {
    /**
     * 拿一张「同域名通行令牌」：同一时刻只发给一个请求，用 release() 归还。
     * 纯时间戳排队会被并发的几条绕过（它们会在同一 tick 里一起检查、一起放行），
     * 所以这里用链式锁，保证后一条一定等前一条真的发完。
     */
    acquire(url) {
      let host = '';
      try {
        host = new URL(url).hostname;
      } catch {
        return Promise.resolve({ release: () => {} });
      }
      if (!host || !gapMs) return Promise.resolve({ release: () => {} });

      const known = hosts.has(host);
      const prev = (known ? hosts.get(host).chain : Promise.resolve()).catch(() => {});
      let release = () => {};
      const mine = new Promise((r) => {
        release = r;
      });
      hosts.set(host, { chain: prev.then(() => mine) });
      // 轮到自己之后还要再歇一个 gap（第一条不用等），别两条请求贴着发
      return prev.then(() => sleep(known ? gapMs : 0)).then(() => ({ release }));
    },
  };
}

/**
 * 批量探测，带并发上限与可中断。
 * @param {Array<{id:string,url:string}>} targets
 * @param {{concurrency?:number, timeout?:number, hostGap?:number, onResult?:(r:Object)=>void}} opts
 */
export async function probeMany(targets, opts = {}) {
  const { concurrency = 8, timeout = 8000, maxRedirects = 3, hostGap = 200, bytes } = opts;
  const queue = targets.map((t) =>
    // 单条「重挖」时前端会指定 bytes（比如 4MB）：批量探测默认只读 64KB 就收手，
    // 而局部重补就是要破例往下多读一点。每条自己带自己的额度，互不影响。
    t && t.bytes ? { ...t, probeBytes: t.bytes } : t,
  );
  const results = [];
  let cancelled = false;
  let total = targets.length;
  let doneCount = 0;
  const gate = makeHostGate(hostGap);

  const worker = async () => {
    const stopped = () => cancelled || (opts.isCancelled && opts.isCancelled());
    while (queue.length && !stopped()) {
      const t = queue.shift();
      let token = { release: () => {} };
      try {
        token = await gate.acquire(t.url);
        const r = await probeUrl(t.url, {
          timeout,
          maxRedirects,
          // 整批统一给一份额度（bytes），或者这一条自己带着更深的额度
          ...(t.probeBytes || bytes ? { probeBytes: t.probeBytes || bytes } : null),
        });
        const row = { id: t.id, target: t.url, ...r };
        results.push(row);
        if (opts.onResult) opts.onResult(row, doneCount + 1, total);
      } catch (e) {
        const row = { id: t.id, target: t.url, ok: false, code: 'EXCEPTION', note: String(e && e.message) };
        results.push(row);
        if (opts.onResult) opts.onResult(row, ++doneCount, total);
      } finally {
        token.release();
        doneCount++;
      }
      if (!cancelled) doneCount = Math.max(doneCount, doneCount);
    }
  };

  const workers = [];
  const n = Math.max(1, Math.min(concurrency, targets.length || 1));
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);

  return { results, cancelled, done: results.length, total };
}

export function cancelProbe() {
  // 由调用方通过 abort controller 处理；这里保留兼容入口
}
