/**
 * 从视频流本体里读分辨率。
 *
 * 为什么需要这个：探测一个地址，如果它是 HLS 主清单，RESOLUTION 直接写在
 * #EXT-X-STREAM-INF 里，读一遍就够；但下面两种「200 在线却没分辨率」才是绝大多数：
 *
 *   1) 直播直连流（.ts / .mp4 / 无后缀）—— 一切信息都在音视频码流里，
 *      必须把流头（TS 的 PAT/PMT/PES、MP4 的 moov/stsd）拆开才拿得到宽高。
 *   2) HLS 媒体播放列表（子清单）—— 它本来就不含变体信息，得再拉一个分片去读。
 *
 * 这两件事都发生在**服务端**，纯 Node 就够了，不需要把网页打包成桌面应用
 * （浏览器里做不到，是因为拿不到原始字节流；我们的服务就在本机，字节随便读）。
 *
 * 支持：MPEG-TS（H.264 SPS）与 MP4/fMP4 容器（avc1/hvc1/av01 等视觉样本项）。
 * HEVC 裸 TS 的 SPS 解析依赖若干可选字段顺序，宁可给不出也不猜错，所以不覆盖，
 * 只在 note 里说清楚；MP4 容器里的 hvc1 走通用样本项路径，是能读出来的。
 */

/* ---------------- 位读：SPS 里全是 ue(v) / u(n) ---------------- */

class BitReader {
  constructor(buf, offset = 0) {
    this.b = buf;
    this.o = offset;
    this.bit = 0;
  }
  u1() {
    const byte = this.b[this.o] || 0;
    const v = (byte >> (7 - this.bit)) & 1;
    if (++this.bit === 8) {
      this.bit = 0;
      this.o++;
    }
    return v;
  }
  u(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.u1();
    return v;
  }
  /** 指数哥伦布编码：读到 null 表示这串位已经乱了，交给调用方放弃 */
  ue() {
    let zeros = 0;
    while (this.u1() === 0) {
      if (++zeros > 32) return null;
    }
    return (1 << zeros) - 1 + this.u(zeros);
  }
  get eof() {
    return this.o >= this.b.length;
  }
}

/** 去掉仿真阻止字节 0x03（前面两个字节必须是 00 00），还原成真正的 RBSP */
function unescapeRbsp(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x03 && out.length >= 2 && out[out.length - 2] === 0 && out[out.length - 1] === 0) continue;
    out.push(buf[i]);
  }
  return Buffer.from(out);
}

/** SPS 里那些「读到这里要按 profile 分支」的高 profile */
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/** 宽高得落在这个区间才算数，否则八成是解析串位了 */
function sane(w, h) {
  return !!w && !!h && w >= 96 && w <= 7680 && h >= 96 && h <= 4320;
}

/**
 * 解析 H.264 SPS（NAL 里 nal_unit_type === 7，首字节 0x67）。
 * @param {Buffer} nal 含起始码之后完整的一整个 NAL（0x67 开头）
 */
export function h264SpsResolution(input) {
  if (!input || input.length < 5 || (input[0] & 0x1f) !== 7) return null;
  // 仿真阻止：码流里为了避免 00 00 01 被误认成起始码，会插一个 0x03（前面必是 00 00）。
  // 不还原就直接按位读，SPS 里但凡出现一组 00 00 03，后面所有字段都错位。
  const nal = unescapeRbsp(input);
  const profile = nal[1];
  // 位流从第 4 字节起：0=nal 头、1=profile_idc、2=约束位、3=level_idc，RBSP 从第 4 个字节开始。
  // 早先写成「从 1 开始读两个字节」，等于把 level_idc 当成 RBSP 首字节，整段字段都错位。
  const br = new BitReader(nal, 4);
  const spsId = br.ue();
  if (spsId === null) return null;

  if (HIGH_PROFILES.has(profile)) {
    const chroma = br.ue();
    if (chroma === null) return null;
    if (chroma === 3) br.u(1);
    if (br.ue() === null || br.ue() === null) return null; // bit depth luma / chroma
    br.u(1);
    if (br.u(1)) {
      // seq_scaling_matrix_present：8 或 12 组 scaling list，每组要么全 0 要么 16 项 ue
      for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
        if (br.u(1)) for (let j = 0; j < 16; j++) if (br.ue() === null) return null;
      }
    }
  }

  br.ue(); // log2_max_frame_num_minus4
  const pocType = br.ue();
  if (pocType === null) return null;
  if (pocType === 0) {
    br.ue(); // log2_max_pic_order_cnt_lsb_minus4
  } else if (pocType === 1) {
    br.u(1);
    if (br.ue() === null || br.ue() === null) return null;
    const n = br.ue();
    if (n === null) return null;
    for (let i = 0; i < n; i++) if (br.ue() === null) return null;
  }
  br.ue(); // max_num_ref_frames
  br.u(1); // gaps_in_frame_num_value_allowed_flag

  const mbW = br.ue();
  const mbH = br.ue();
  if (mbW === null || mbH === null) return null;
  const frameMbsOnly = br.u1();
  if (!frameMbsOnly) br.u1(); // mb_adaptive_frame_field_flag
  br.u1(); // direct_8x8_inference_flag —— 无条件存在，漏了这 1 bit 后面全串位

  let w = (mbW + 1) * 16;
  let h = (mbH + 1) * 16 * (frameMbsOnly ? 1 : 2);

  if (br.u1()) {
    // frame_cropping_flag：4:2:0 下 crop_unit_x=1，隔行时 crop_unit_y=2
    const cl = br.ue();
    const cr = br.ue();
    const ct = br.ue();
    const cb = br.ue();
    if (cl === null || cr === null || ct === null || cb === null) return null;
    const unitY = frameMbsOnly ? 1 : 2;
    w -= 2 * (cl + cr);
    h -= 2 * ((ct + cb) * unitY);
  }

  if (!sane(w, h)) return null;
  return { width: w, height: h, codec: 'h264' };
}

/**
 * 裸 Annex-B 扫描：从头找 00 00 01 起始码，第一个 SPS NAL 就能给宽高。
 * TS 结构解析失败时兜底用（很多源会塞些奇怪的包，但 SPS 总是在）。
 *
 * 遇到切片 NAL（type 1..5）不能立刻收工：TS 里的顺序常是 AUD → SPS → PPS → 切片，
 * 但一些编码器会先塞一个空切片/补位切片再给 SPS；而且高 profile 的 SPS 较长，
 * 头几段里也可能先撞上 SEI。撞见切片只记一笔「见到过视频切片」，继续往下找 SPS，
 * 全文找不到 SPS 才回头报这个线索。早先「一遇切片就 return 宽高 0」的写法，
 * 会让 TS 解析本来能成的流在这里被误判成「读到切片、没尺寸」。
 */
export function annexbResolution(buf) {
  let sawSlice = false;
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      const type = buf[i + 3] & 0x1f;
      if (type === 7) {
        const r = h264SpsResolution(buf.subarray(i + 3, Math.min(buf.length, i + 3 + 128)));
        if (r) return r;
      } else if (type >= 1 && type <= 5) {
        sawSlice = true;
      }
    }
  }
  return sawSlice ? { width: 0, height: 0, codec: 'h264-slice' } : null;
}

/* ---------------- MPEG-TS ---------------- */

/** 值得当视频看的 stream_type：MPEG1/2、H.264、H.265、AV1、VC-1 之外的常见值 */
const VIDEO_STREAM_TYPES = new Set([0x01, 0x02, 0x10, 0x1b, 0x24, 0xd1, 0xdb, 0xdc]);

/**
 * 值得一并记下来的音频 stream_type。
 *
 * 为什么要把音频 PID 也挑出来：探测结果里有一批「200 在线但分辨率空着」的条目，
 * 它们里有一部分**压根就没有视频轨**（纯音频台，VLC 里也是「在线但没画面」）。
 * 这类条目给多大窗口都不可能读出宽高，重挖纯属白费流量 —— 得先分清楚。
 */
const AUDIO_STREAM_TYPES = new Set([0x03, 0x04, 0x06, 0x0f, 0x11, 0x15]);

/**
 * 把一个 PMT 段（t 指着 table_id，也就是 0x02）里的视频 / 音频 elementary PID 挑出来。
 *
 * @returns {{videoPids: Set<number>, audioPids: Set<number>, landErr: number}} landErr =
 *   stream 条目结束位置与「CRC 开始位置」的偏差。真 PMT 是 0：所有条目不多不少正好排到 CRC 前。
 *   偏差越大，说明这个「段」八成是读歪了（PES 净荷、别的段）。
 */
function parsePmtSection(buf, t) {
  const videoPids = new Set();
  const audioPids = new Set();
  const secEnd = t + 3 + (((buf[t + 1] & 0x0f) << 8) | buf[t + 2]);
  if (secEnd > buf.length) return { videoPids, audioPids, landErr: Infinity };
  const pil = ((buf[t + 10] & 0x0f) << 8) | buf[t + 11];
  let o = t + 12 + pil;
  for (; o + 5 <= secEnd; o += 5 + (((buf[o + 3] & 0x0f) << 8) | buf[o + 4])) {
    const st = buf[o];
    const epid = ((buf[o + 1] & 0x1f) << 8) | buf[o + 2];
    // PID 是 13 位，越界说明这段又是读歪了（跟 PIL 那次一个毛病，别把垃圾收进来）
    if (epid <= 0 || epid > 0x1fff) continue;
    if (VIDEO_STREAM_TYPES.has(st)) videoPids.add(epid);
    else if (AUDIO_STREAM_TYPES.has(st)) audioPids.add(epid);
  }
  return { videoPids, audioPids, landErr: Math.abs(o - (secEnd - 4)) };
}

/**
 * 全表兜底扫 PMT：一个个包看过去，谁身上挂着 table_id=0x02 就按 PMT 拆。
 *
 * 为什么需要：IPTV 源站的 PAT 经常是坏的。实测过一条流，PAT 里写的是
 * PMT_PID=1，实际 PMT 却挂在 256 上（播放器照播不误，因为它会自己去扫
 * 各个 PID 找表）。只认 PAT 给的 PID，这条路就整条断了 —— 视频 PID 一个都
 * 收集不到，分辨率先是「读不到」再退化到整段 Annex-B 扫描。
 */
function scanPmtByBruteForce(buf, from, strict = false) {
  let best = { videoPids: new Set(), audioPids: new Set() };
  let bestErr = Infinity;
  for (let i = from; i + 188 <= buf.length; i += 188) {
    if (buf[i] !== 0x47) continue;
    let p = i + 4;
    const afc = (buf[i + 3] >> 4) & 3;
    if (afc === 2) continue;
    if (afc === 3) p += 1 + buf[i + 4];
    if (p >= i + 188) continue;
    // 段起始包前面有个 pointer_field，它是 0 时 table_id 才在下一字节。
    //
    // 这里最容易写错的地方：pointer_field 是**一定存在**的（PUSI 包的净荷第一字节
    // 就是它，值为 0 表示段从下一字节开始）。早先写过「buf[p] !== 0x02 就跳过」，
    // 等于把「buf[p] 恰好等于 0x02」当成 PMT —— 而视频 PES 净荷的第一个字节就经常
    // 是 0x02，于是全片的视频包都被当成 PMT 去拆，解出一堆假 PID（实测一条 11MB
    // 分片里有 30 个这种包），第一个假命中就把整条兜底扫描短路掉了。
    if (buf[p] !== 0x00) continue; // 段不是从这一包开头起（续包）
    p++;
    if (buf[p] !== 0x02) continue; // table_id 不是 PMT
    const { videoPids, audioPids, landErr } = parsePmtSection(buf, p);
    if (!videoPids.size && !audioPids.size) continue;
    if (strict && landErr > 0) continue; // 只收结构自洽的（条目正好排到 CRC 前）
    // 宽松模式：不急着收第一个看着像的段，挑排布误差最小的那个 —— 真 PMT 的误差是 0
    if (landErr < bestErr) {
      bestErr = landErr;
      best = { videoPids, audioPids };
    }
  }
  return best;
}

/** 找出所有 188 字节对齐的 TS 包里，视频 elementary PID 是哪些 */
function parseTsTables(buf) {
  const len = buf.length;
  let sync = -1;
  for (let i = 0; i + 188 <= len; i++) {
    if (buf[i] === 0x47 && (i === 0 || buf[i + 188] === 0x47)) {
      sync = i;
      break;
    }
  }
  if (sync < 0) return null;

  let pmtPid = null;
  const videoPids = new Set();
  const audioPids = new Set();
  // 这一窗到底「见没见过 PMT」。它决定「一个视频 PID 都没认出来」该怪谁：
  // 见过 PMT 却一条视频流都没列 = 流描述里真没视频（no-video，再挖也没用）；
  // 连 PMT 的影子都没有 = 这一窗压根没带节目信息表（no-psi，把窗口加大很可能就碰上）。
  // 这两种混成一个「no-video」会把大量好 stream 冤枉成「源站压根没视频」。
  let sawPmt = false;
  /** 段收尾的 CRC 从哪开始（段长得自己把 4 字节 CRC 算进去） */
  const secEndOf = (t) => {
    const secLen = ((buf[t + 1] & 0x0f) << 8) | buf[t + 2];
    return t + 3 + secLen - 4;
  };

  for (let i = sync; i + 188 <= len; i += 188) {
    if (buf[i] !== 0x47) {
      // 重同步：跳过脏字节，找下一个看着像包首的 0x47
      let j = i + 1;
      for (; j + 188 <= len; j++) if (buf[j] === 0x47) break;
      i = j - 188;
      continue;
    }

    const pusi = (buf[i + 1] & 0x40) !== 0;
    const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
    let p = i + 4;
    const afc = (buf[i + 3] >> 4) & 3;
    // afc=1 是「纯净荷」—— 适配字段不在场，净荷直接接着包首 4 字节。
    // afc=2/3 才是真有适配字段，长度域再占一字节。
    if (afc === 2) continue; // 只有适配字段，这一包没内容
    if (afc === 3) p += 1 + buf[i + 4];
    if (p >= i + 188) continue;

    // PSI 段在「段起始包」里前面还有一个 pointer_field，跳过去才是 table_id；
    // 不跳的话 t 会指着 pointer_field，段长按它后面的 0xb0 头字节算，直接跑飞
    if (pusi && buf[p] === 0x00 && buf[p + 1] < 0x10 && (buf[p + 2] & 0xf0) === 0xb0) p++;

    // t 指着 table_id（payload 里前面可能还有 1 字节 pointer_field）
    const t = p;
    if (pid === 0 && pusi && buf[t] === 0x00) {
      // PAT：table_id(1) + 头(2) + tsid(2) + version/区间(3) = 8 字节，program 每个 4 字节。
      //
      // 循环边界必须卡在 CRC **之前**：单 program 的 PAT 一共就 13 字节段长，
      // 一个 program 占完 t+8..t+11，t+12 起就只剩 CRC 了。早先边界写成 sectionEnd
      // （含 CRC），于是最后一轮把 CRC 当成第二条 program 读一遍，把正确的
      // PMT_PID 覆盖成一串垃圾数字 —— 实测 112.123.243.37 那条源就把 PMT_PID
      // 从 256 改成了 5036，主路径因此整条落空（文件里根本没有 PID 5036 的包）。
      // 这种「时好时坏」的 bug 特别阴：CRC 低 16 位刚好落在 0 时，continue 掉了就看不出来。
      for (let o = t + 8; o + 4 <= secEndOf(t); o += 4) {
        const id = buf[o] << 8 | buf[o + 1];
        if (id === 0) continue; // NIT
        pmtPid = ((buf[o + 2] & 0x1f) << 8) | buf[o + 3];
      }
    } else if (pmtPid !== null && pid === pmtPid && pusi && buf[t] === 0x02) {
      // PMT：program_number 后面是 program_info_length，再往后是 stream_type(1)+PID(2)+长度(2) 循环
      //
      // program_info_length 住在 table_id 之后 **+10/+11** 两个字节（高 4 位是保留位）。
      // 早先写成 +8/+9，那俩字节其实是 reserved(3)+PCR_PID(13) —— 于是 PIL 读到 17，
      // stream 起点被算到 +27，解出来的 PID 是 4305、ES_info_length 是 3736（都超过
      // 字段本身能表达的范围），视频 PID 4113 压根没进 videoPids，
      // 结果「流里明明写好了 1920x1080」却解析不出来。
      // 歪多少取决于 PCR_PID 的高 4 位，所以这 bug 时好时坏：PCR_PID 高位为 0 的源
      // 反而是对的，才导致只在这一类源上暴露。
      const parsed = parsePmtSection(buf, t);
      // 一条流都没列出也算「见过 PMT」—— 那说明我们确实读到这个源发的节目信息表
      // （只是它列了个空表），跟「整段连表的影子都没有」是两回事。
      // 判据用结构自洽度而不是空不空：landErr 是解析停下来的位置离段尾（CRC 前）多远，
      // 0 表示这条段排得规规矩矩，是真表而不是撞巧的 0x02 字节。
      if (parsed.videoPids.size || parsed.audioPids.size || parsed.landErr <= 2) sawPmt = true;
      for (const vpid of parsed.videoPids) videoPids.add(vpid);
      for (const apid of parsed.audioPids) audioPids.add(apid);
    }
  }

  // PAT 给不出来（或给错了）时，全表扫一遍找 PMT。
  // 标准流在这里一次都不走，只对「PAT 坏了」这种源多花几毫秒。
  // 先按「结构自洽」挑一遍（条目得不多不少排到 CRC 前），全窗找不到再看宽松的，
  // 免得一个碰巧自洽的垃圾段就把真 PMT 挤掉。
  const brute = (strict) => {
    const best = scanPmtByBruteForce(buf, sync, strict);
    for (const vpid of best.videoPids) videoPids.add(vpid);
    for (const apid of best.audioPids) audioPids.add(apid);
  };
  if (!videoPids.size) brute(true);
  if (!videoPids.size) brute(false);

  return { videoPids, audioPids, sync, sawPmt };
}

/**
 * 在一个 PES 净荷里找 SPS（PES 头已经剥掉）。
 *
 * PES 头之后是 Annex-B 码流，直接扫 00 00 01 起始码就行。
 * SPS（nal_unit_type 7）只挂在关键帧上，所以这里找不到也不能说「没视频」。
 */
function scanSpsInPes(data) {
  if (!data || data.length < 10) return null;
  // PES：00 00 01 <stream_id> <len2> <flags2> <header_len> … 之后才是净荷
  if (!(data[0] === 0 && data[1] === 0 && data[2] === 1)) return null;
  const sid = data[3];
  if (sid < 0xe0 || sid > 0xef) return null; // 视频流 0xE0~0xEF
  if (data[6] !== 0x80) return null; // '10' 标记位，不对就是没解析对
  const hlen = data[8]; // PES_header_data_length
  const start = 9 + hlen;
  if (start >= data.length) return null;

  for (let k = start; k + 4 <= data.length; k++) {
    if (data[k] === 0 && data[k + 1] === 0 && data[k + 2] === 1) {
      if ((data[k + 3] & 0x1f) === 7) {
        const r = h264SpsResolution(data.subarray(k + 3, Math.min(data.length, k + 3 + 256)));
        if (r) return r;
      }
    }
  }
  return null; // 这个 PES 里没 SPS（SPS 只出现在关键帧）
}

/**
 * 在视频 PID 的 PES 流里找 SPS：**单趟扫过前 maxPes 个 PES**，谁身上有 SPS 用谁。
 *
 * 为什么不能只看第一个 PES：实测（112.123.243.37 那条 txiptv 直播源）分片里
 * 第一个视频 PES 在 11.3KB，身上一律只有 SEI + 视频切片，真正的 SPS 在 604KB 处，
 * 得等后头的 PES 才跟着 IDR 一起到（SPS 只挂在关键帧上）。只扫第一个 PES 的话
 * tsResolution 恒为 null —— TS 这条比 Annex-B 全文兜底更靠得住的结构化路径
 * 就成了常年摆设，每条流都是靠 `annexbResolution` 兜底才出结果的。
 *
 * 为什么是单趟、不是「取完第一个 PES 没 SPS 就从头再取第二个」：后者每取一个
 * 都要重扫一遍包，maxPes=64 时是 O(n²)，2MB 窗口（≈1.1 万个包）下白烧几十毫秒。
 * 这里一遍走完，把每个 PES 的净荷顺手攒起来扫掉。
 */
function pesResolution(buf, videoPids, sync, maxPes = 64) {
  const limit = buf.length;
  /** 正在攒的那个 PES 的净荷分片（PES 不按 TS 包对齐，SPS 会跨包） */
  let parts = null;
  let seen = 0;

  /** 把攒够的净荷扫一遍；SPS 可能横跨包，所以要拼起来再看 */
  const flush = () => {
    if (!parts) return null;
    const data = parts.length === 1 ? parts[0] : Buffer.concat(parts);
    parts = null;
    return scanSpsInPes(data);
  };

  for (let i = sync; i + 188 <= limit; i += 188) {
    if (buf[i] !== 0x47) {
      // 重同步：跳过脏字节，找下一个看着像包首的 0x47
      let j = i + 1;
      for (; j + 188 <= limit; j++) if (buf[j] === 0x47) break;
      i = j - 188;
      continue;
    }
    const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
    if (!videoPids.has(pid)) continue;
    const pusi = (buf[i + 1] & 0x40) !== 0;
    let p = i + 4;
    const afc = (buf[i + 3] >> 4) & 3;
    if (afc === 2) continue; // 只有适配字段，这包没净荷
    if (afc === 3) p += 1 + buf[i + 4];
    if (p >= i + 188) continue;

    if (pusi) {
      // 上一个 PES 扫完还没 SPS，才继续往下看下一个
      const r = flush();
      if (r) return r;
      if (seen >= maxPes) return null;
      seen++;
      parts = [Buffer.from(buf.subarray(p, i + 188))];
    } else if (parts && parts.length < 4) {
      // 最长的一个 SPS 也不会跨过 4 个 TS 包
      parts.push(Buffer.from(buf.subarray(p, i + 188)));
    }
  }
  return flush();
}

/** 拆 TS：先读 PAT/PMT 定位视频 PID，再在视频 PES 流里找 SPS */
export function tsResolution(buf) {
  return analyzeTs(buf).res;
}

/**
 * 拆 TS 的同时回答「读不出分辨率是为什么」。
 *
 * reason 的取值直接决定界面上要不要给「重挖一次」的入口，所以宁可多给一个字段，
 * 也不要让上层猜：
 *   ''            读出来了（res NotNull）
 *   'audio-only'  有音频 PID、没有视频 PID —— 纯音频台，挖多大窗口都不该再来一次
 *   'no-video'    PMT 拆得出来，可里面一条 elementary stream 都没有 —— 流描述里真没视频
 *   'no-psi'      这一窗连 PAT/PMT 的影子都没扫到（切片开头不发节目信息表，表在更后面）
 *                 —— 不是「没视频」，是「还没看到哪儿有视频」，加大窗口就是解药
 *   'long-gop'    有视频 PID、也扫到了视频切片，只是窗口里没盖到 SPS（关键帧太长）
 *                 —— 这一类才是「值得再挖一次」的
 *   'no-pmt'      PAT/PMT 根本拆不出来，连流类型都判断不了
 */
export function analyzeTs(buf) {
  const t = parseTsTables(buf);
  if (!t) return { res: null, reason: 'no-pmt' };

  // 尽量挑 H.264 那条流（有的源同时挂了多路视频）
  let res = null;
  for (const pid of t.videoPids) {
    const r = pesResolution(buf, new Set([pid]), t.sync);
    if (r && r.width) {
      res = r;
      break;
    }
  }
  if (res) return { res, reason: '' };

  if (!t.videoPids.size) {
    if (t.audioPids.size) return { res: null, reason: 'audio-only' };
    // 「没列出视频轨」和「这一窗压根没带节目信息表」是两回事，必须分开报：
    // 前者是源站说了没有，后者只说明我们看的这段太短/太靠前（实测某个 IPTV 直播源
    // 的分片开头 128KB 里 PAT/PMT/SDT 一个都不发，全在 1MB 之后），
    // 混成一个 no-video 会把一堆 1080p 直接判成「源站没视频」，还因为它不可重挖
    // 连「加大窗口重试」的入口都不给 —— 分辨率和流内服务名就一起丢了。
    if (!t.sawPmt) return { res: null, reason: 'no-psi' };
    return { res: null, reason: 'no-video' };
  }
  // 有视频轨、没尺寸：视频切片扫到了但没 SPS，说明画面在、只是关键帧不在探测窗口里。
  // Annex-B 全文兜底扫下来还是同样的结论（它只有看到切片才给 codec 线索），
  // 所以这里不用再扫一遍，直接判 long-gop。
  return { res: null, reason: 'long-gop' };
}

/* ---------------- MPEG-TS 里的服务名（SDT） ---------------- */

const SDT_TABLE_ID = 0x42; // SDT 的 table_id
const SDT_SERVICE_DESC_TAG = 0x48; // service_descriptor（ISO 13818-1）

/**
 * 从 MPEG-TS 的 SDT（Service Description Table）里读服务名 —— 也就是播放器
 * 媒体信息里显示的那个频道名（VLC 报的「dftvHD」就是它）。
 *
 * 为什么值得读：HLS 的媒体清单（子清单）里连 `#EXTINF` 的标题都可能是占位的
 * `no desc`，m3u 里 `tvg-name` 也常常是空的；但流自己往往把节目名写在 SDT 里。
 * 多这条线索，自动填 tvg-id / 频道名就多一个不依赖 m3u 文本的依据。
 *
 * SDT 段的布局（t 指 table_id）—— 注意头比 PAT/PMT 长 3 个字节：
 *   +0 table_id(8) | +1..2 段长(12) | +3..4 transport_stream_id | +5 版本/段号(8)
 *   +6 段号(8) | +7 末段号(8) | +8..9 original_network_id(16)
 *   +10 末段号(8) | +11 末子段号(8)
 *   之后每个 service：service_id(16) + descriptor_loop_length(12) + 描述符循环
 *     每个描述符：tag(8) + length(8) + body
 * service 循环是从 **+12** 起的（少了那 3 字节，算出来的描述符长度会大到几百，
 * 直接判定越界、名字一个也读不出来 —— 见 parseSdtSection 里的说明）。
 *       tag=0x48 是 service_descriptor：
 *         service_type(8) + provider_name_length(8) + provider_name
 *                         + service_name_length(8) + service_name
 * 实测（112.123.243.37 那条直播源）字节序列是
 *   `… 0b 48 09 01 00 06 "dftvHD"` —— 0x0b 是描述符循环长度、0x48 是 tag、
 *   0x09 是描述符长、0x01 是 service_type（数字电视）、provider 名为空、名长 6。
 *
 * @param {Buffer|Uint8Array} input 一段以 TS 包开头的字节（分片头部即可）
 * @returns {string} 服务名；读不到就返回空串（宁可空着也不猜）
 */
export function tsServiceName(input) {
  const buf = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) : input);
  if (!buf || buf.length < 188) return '';

  // 找同步字：第一个 0x47，且它后面那个包首也是 0x47（排除正巧撞上一个 0x47 的脏数据）
  let sync = -1;
  for (let i = 0; i + 188 <= buf.length; i++) {
    if (buf[i] === 0x47 && (i === 0 || buf[i + 188] === 0x47)) {
      sync = i;
      break;
    }
  }
  if (sync < 0) return '';

  for (let i = sync; i + 188 <= buf.length; i += 188) {
    if (buf[i] !== 0x47) continue;
    const pusi = (buf[i + 1] & 0x40) !== 0;
    let p = i + 4;
    const afc = (buf[i + 3] >> 4) & 3;
    if (afc === 2) continue; // 只有适配字段，这包没净荷
    if (afc === 3) p += 1 + buf[i + 4];
    if (p >= i + 188 || !pusi) continue;
    // 段起始包前面有个 pointer_field，它是 0 时 table_id 才在下一字节
    if (buf[p] === 0x00) p++;
    if (buf[p] !== SDT_TABLE_ID) continue;
    const name = parseSdtSection(buf, p);
    if (name) return name;
  }
  return '';
}

/**
 * 解一个 SDT 段（t 指 table_id），返回第一个服务名。
 * 段内可能有多个 service，取 service_id 最小的那个（一般流里就一个）。
 */
function parseSdtSection(buf, t) {
  const secLen = ((buf[t + 1] & 0x0f) << 8) | buf[t + 2];
  const secEnd = t + 3 + secLen;
  // 11 字节头 + 至少 4 字节 service 头，再短就不是 SDT 了
  if (secEnd > buf.length || secLen < 15) return '';

  let best = '';
  // t+12 起是 service 循环；每个 service 先 2 字节 service_id、再 2 字节描述符循环长度
  //
  // 起点为什么是 +12 而不是 +8：SDT 的头比 PAT/PMT 多 original_network_id(2)、
  // segment_last_section_number(1)、segment_last_sub_section_number(1) 三个字节。
  // 早先按 PAT 的 8 字节头起跳，service_id 读到了 0x0000、描述符循环长度读到了
  // 3840，越界判定直接 break，源头（112.123.243.37 那条）的服务名一个都读不出来。
  for (let o = t + 12; o + 4 <= secEnd - 4; ) {
    let loopLen = ((buf[o + 2] & 0x0f) << 8) | buf[o + 3];
    let d = o + 4;
    let e = d + loopLen;
    if (e > secEnd - 4) break; // 段长给大了，别越界去读别的东西

    for (; d + 2 <= e; ) {
      // 描述符：tag(1) + length(1) + body(length 字节)
      const tag = buf[d];
      const len = buf[d + 1];
      if (d + 2 + len > e) break; // 长度不对，别越界去读别的东西

      if (tag === SDT_SERVICE_DESC_TAG && len >= 4) {
        // body：service_type(1) + provider_name_length(1) + provider_name
        //                     + service_name_length(1) + service_name
        let k = d + 2; // 指向 service_type
        const plen = buf[k];
        k += 1 + plen; // 越过 service_type 与 provider_name
        if (k < e && buf[k] > 0) {
          const nLen = buf[k];
          const name = decodeServiceName(buf, k + 1, k + 1 + nLen);
          // 多语言流里服务名会出现好几个，挑最短的那个更接近「频道名」，
          // 也避开把一整串描述都当名字塞进来的写法。
          if (name && (!best || name.length < best.length)) best = name;
        }
      }
      d += 2 + len;
    }

    o += 4 + loopLen;
  }
  return best;
}

/** 服务名按 UTF-8 编（service_type 0x01 的数字电视就是），源站写错编码时退回 latin1 保字节 */
function decodeServiceName(buf, s, e) {
  const slice = buf.subarray(s, Math.min(e, buf.length));
  if (slice.length <= 0) return '';
  try {
    const txt = new TextDecoder('utf-8', { fatal: true }).decode(slice);
    if (txt && txt.trim() && !txt.includes('�')) return txt.replace(/[\x00-\x1f\x7f]+/g, '').trim();
  } catch {
    /* 源站写的是 GBK/别的，落到下面保字节 */
  }
  return slice.toString('latin1').replace(/[^\x20-\x7e\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+/g, ' ').trim();
}

/* ---------------- MP4 / fMP4 ---------------- */

const VIDEO_SAMPLE_TYPES = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp09', 'mp4v', 'mvc1']);

/** 列出 [start, end) 范围内的所有 box */
function boxes(buf, start, end) {
  const list = [];
  let o = start;
  while (o + 8 <= end) {
    const size = buf.readUInt32BE(o);
    const header = size === 1 ? 16 : 8;
    if (size < header || o + size > end) {
      // 大小不对（截断的 moov / 分片），当作到末尾为止
      list.push({ o, size: end - o, type: buf.toString('latin1', o + 4, o + 8) });
      break;
    }
    list.push({ o, size, type: buf.toString('latin1', o + 4, o + 8) });
    o += size;
  }
  return list;
}

const findBox = (buf, start, end, type) => boxes(buf, start, end).find((b) => b.type === type);

/** 在 box 内部找第一个指定类型的子 box */
const findChild = (buf, box, type) => findBox(buf, box.o + 8, box.o + box.size, type);

/**
 * 视觉样本项（avc1/hvc1/av01…）里宽度高度的位置。
 * 规范上在 box 起始 +32 处，实际文件里也见过 +24 的写法，两种都试，靠 sane() 兜底。
 */
function readSampleEntryDims(buf, entry) {
  for (const at of [entry.o + 32, entry.o + 24]) {
    if (at + 2 > buf.length) continue;
    const w = buf.readUInt16BE(at);
    const h = buf.readUInt16BE(at + 2);
    if (sane(w, h)) return { width: w, height: h, codec: 'mp4' };
  }
  return null;
}

/** 解析 MP4/fMP4：moov → trak → mdia → minf → stbl → stsd → 视觉样本项 */
export function mp4Resolution(buf) {
  const moov = findBox(buf, 0, buf.length, 'moov');
  if (moov) {
    for (const trak of boxes(buf, moov.o + 8, moov.o + moov.size)) {
      if (trak.type !== 'trak') continue;
      const mdia = findChild(buf, trak, 'mdia');
      if (!mdia) continue;
      const minf = findChild(buf, mdia, 'minf');
      if (!minf) continue;
      const stbl = findChild(buf, minf, 'stbl');
      if (!stbl) continue;
      const stsd = findChild(buf, stbl, 'stsd');
      if (!stsd) continue;
      // stsd 体：version/flags(4) + entry_count(4)，之后才是各样本项
      let o = stsd.o + 8 + 8;
      const end = stsd.o + stsd.size;
      while (o + 8 <= end) {
        const size = buf.readUInt32BE(o);
        const type = buf.toString('latin1', o + 4, o + 8);
        if (VIDEO_SAMPLE_TYPES.has(type)) {
          const r = readSampleEntryDims(buf, { o, size });
          if (r) return r;
        }
        if (size < 8 || o + size > end) break;
        o += size;
      }
    }
  }
  // fMP4（CMAF）没有 moov：styp/sidx/moof，视频样本在 trun 里 → 按 stsd 兜底扫一遍顶层
  const stsd = findBox(buf, 0, buf.length, 'stsd');
  if (stsd) {
    let o = stsd.o + 8 + 8;
    const end = stsd.o + stsd.size;
    while (o + 8 <= end) {
      const size = buf.readUInt32BE(o);
      const type = buf.toString('latin1', o + 4, o + 8);
      if (VIDEO_SAMPLE_TYPES.has(type)) {
        const r = readSampleEntryDims(buf, { o, size });
        if (r) return r;
      }
      if (size < 8 || o + size > end) break;
      o += size;
    }
  }
  return null;
}

/* ---------------- fMP4 里的 avcC ---------------- */

/** SPS 就写在初始化段开头，按字面找 avcC 只消扫这一小段，不必往整个分片上扫 */
const AVC_C_SCAN_LIMIT = 512 * 1024;

/**
 * 在字节流里按字面找 avcC —— 给 avcC box 定位用的最后一条路。
 *
 * 起因：光靠逐层下钻的盒子树走不进 avcC。fMP4 里 avcC 的实际位置是
 * `stsd → avc1/avc3 → avcC`，而 avc1/avc3 这两个视觉样本项前面有 78 字节的
 * 固定保留位（含 data_reference_index），盒子树一钻进去就读到 0 字节大小，
 * 只能当「这块不是合法 box」掉头走 —— 于是 avcC 永远藏在那 78 字节后面。
 *
 * 早先的写法是「逐层收集所有 box、深度限制 8 层」，那既走不进去、又不安全：
 * size 读出来不对（截断的分片、对着 0x41 铺满的 Annex-B 分片去扫 box 都很常见）
 * 时若还继续往下钻，每个 readUInt32BE 都是个几十亿的大数，几层之后指数展开直接栈溢出。
 * 按字面找没有递归、没有越界风险，命中后还是按 box 的规矩校验 size，错就跳过。
 */
function scanAvcC(buf, limit) {
  const end = Math.min(buf.length, limit);
  for (let o = 4 + 8; o + 8 <= end; o++) {
    // 先用四个字符比一次，别对整段码流做 readUInt32BE
    if (buf[o] !== 0x61 || buf[o + 1] !== 0x76 || buf[o + 2] !== 0x63 || buf[o + 3] !== 0x43) continue;
    const at = o - 4; // o 指着 type，size 在它前面 4 字节
    const size = buf.readUInt32BE(at);
    if (size < 8 || at + size > buf.length) continue; // 大小不对（撞上随机二进制了），换下一个
    const r = readAvcCSps(buf, { o: at, size, type: 'avcC' });
    if (r) return r;
  }
  return null;
}

/**
 * 从 avcC box 里直接把 SPS 抠出来算宽高 —— fMP4 / CMAF 的 init 段就这么写分辨率。
 *
 * avcC 体（o 指向 box 的 size 字段）：
 *   +0 configurationVersion(1) | +1 profile | +2 compat | +3 level
 *   +4 lengthSizeMinusOne(1) | +5 高 3 位保留 + 低 5 位是 SPS 个数
 *   之后：<u16 长度><SPS NAL> 重复 SPS_COUNT 次
 *
 * 为什么要单独补这一条：老的读法走 stsd 的视觉样本项（avc1 里 +24/+32 那两个 u16），
 * 但不少分段下发（CMAF）会把 avc1 样本项拆薄、只留 avcC，或者干脆用 avc3 ——
 * 那时候 stsd 那两个 u16 读出来是 0，分辨率就莫名其妙空着。avcC 里的 SPS 是
 * 完整的一整个 NAL，直接喂给 h264SpsResolution 就行，几十行、几乎不花流量。
 */
function readAvcCSps(buf, box) {
  const body = box.o + 8;
  const end = box.o + box.size;
  if (body + 6 > end || body + 6 > buf.length) return null;
  const count = buf[body + 5] & 0x1f; // 高 3 位（0xE0）是保留位
  let o = body + 6;
  for (let i = 0; i < count; i++) {
    if (o + 2 > end) return null;
    const len = buf.readUInt16BE(o);
    o += 2;
    if (len <= 0 || o + len > end) continue;
    const r = h264SpsResolution(buf.subarray(o, o + len));
    if (r) return r;
    o += len;
  }
  return null;
}

/** 在一段 MP4/fMP4 字节里找第一个 avcC 能算出的宽高（scanAvcC 直接给结果） */
export function mp4AvcCResolution(buf) {
  if (!buf || buf.length < 16) return null;
  return scanAvcC(buf, AVC_C_SCAN_LIMIT);
}

/**
 * 总入口：给一段字节，尽量读出宽高。
 * @param {Buffer|Uint8Array} input
 */
export function readResolution(input) {
  if (!input || !input.length) return null;
  const buf = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) : input);
  if (buf[0] === 0x47) {
    // TS：先按结构拆，拆不出再把整段当 Annex-B 扫一遍
    const ts = tsResolution(buf);
    if (ts) return ts;
  }
  const mp4 = mp4Resolution(buf);
  if (mp4) return mp4;
  const avcC = mp4AvcCResolution(buf);
  if (avcC) return avcC;
  return annexbResolution(buf);
}

/**
 * 读宽高的同时回答「读不到是为什么」（reason 取值见 analyzeTs，另加：
 *   'no-data'    一段字节都没收到
 *   'm3u-note'   源站清单里压根没写分辨率 —— 不是流的问题，重挖也没用
 *   'no-pmt'     结构认不出来
 *   'no-video'   有连接、没有视频轨
 *   'audio-only' 纯音频台
 *   'long-gop'   有视频轨，关键帧没盖到 —— **唯一值得重挖的一类**）。
 *
 * 这个字段是界面上「只给该重试的条目显示 ⟳」的依据，所以一定要说人话的那一边
 * 拿去显示，别让上层拿一串码自己拼句子。
 */
export function analyzeStream(input) {
  if (!input || !input.length) return { res: null, reason: 'no-data' };
  const buf = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) : input);
  if (buf[0] === 0x47) {
    const a = analyzeTs(buf);
    if (a.res) return a;
    // 旧 readResolution 的老路得留着：TS 结构拆不动（PMT 坏、只挂着裸 PES）时，
    // 它还会把整段当 Annex-B 再扫一遍。以前靠这条兜底才读得出分辨率的流，
    // 不能在换了归因而后就没了这条退路。
    const annexb = annexbResolution(buf);
    if (annexb && annexb.width) return { res: annexb, reason: '' };
    // 扫完还是没尺寸：用 analyzeTs 那句结论（纯音频 / 没视频轨 / long-gop）
    return a;
  }
  const mp4 = mp4Resolution(buf);
  if (mp4) return { res: mp4, reason: '' };
  const avcC = mp4AvcCResolution(buf);
  if (avcC) return { res: avcC, reason: '' };
  const annexb = annexbResolution(buf);
  if (annexb && annexb.width) return { res: annexb, reason: '' };
  // 扫到视频切片却没 SPS（Annex-B 兜底那一路）：视频在，缺的是关键帧 —— 跟 TS 的
  // long-gop 是同一件事，别报成「结构认不出来」，那会让人误以为加大窗口也没用。
  if (annexb && annexb.codec) return { res: null, reason: 'long-gop' };
  return { res: null, reason: 'no-pmt' };
}

/** HLS 媒体播放列表里的第一个分片 URI（绝对地址） */
export function firstSegmentUri(text, baseUrl) {
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l || l.startsWith('#')) continue;
    // 媒体播放列表里除注释行之外，剩下的就是分片 URI（可能带 ./ 也可能不带）
    try {
      return new URL(l, baseUrl).toString();
    } catch {
      return null;
    }
  }
  return null;
}
