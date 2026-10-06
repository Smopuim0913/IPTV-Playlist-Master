/**
 * m3u / m3u8 播放列表解析与序列化
 *
 * 设计目标：无损往返（round-trip）
 *   很多在线 m3u 编辑器会把厂商自定义属性（response-time / catchup / timeshift /
 *   raw-river / source-info …）在重新序列化时丢掉，导致再保存一次供应商给的列表就废了。
 *   这里保存每项的「原始 token」，导出时按原样写回，不做规范化。
 */

const EXTINF = '#EXTINF:';

/**
 * 文件头必须是**整行就一句** `#EXTM3U`（允许行尾空格/制表符）。
 * 早期这里写的是 `startsWith('#EXTM3U')`，结果 `#EXTM3U-TAIL:keep-me`、
 * `#EXTM3U#EXTGRP:x` 这类以它打头的行也会被当成文件头，还会把真正在第一行的
 * `#EXTM3U` 顶掉 —— 列表头变成一行 Tail 标记，导入方很可能认不出这是播放列表。
 * 其余「以 #EXTM3U 开头」的行按普通注释处理，原样留着就行。
 */
const HEADER_RE = /^#EXTM3U[ \t]*$/;
const BOM = '﻿';

let seq = 0;
export function nextId() {
  return 'e' + (++seq).toString(36) + Math.random().toString(36).slice(2, 6);
}
export function resetSeq() {
  seq = 0;
}

/**
 * 解析一整份播放列表文本。
 * @returns {{header: string|null, entries: Array, comments: Array}}
 */
export function parseM3U(text) {
  if (typeof text !== 'string') {
    throw new TypeError('parseM3U 需要字符串');
  }
  // 记住原始行尾符，导出时原样写回，保证 CRLF 文件 round-trip 字节一致
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const trailingNewline = /\n[ \t]*$/.test(text) || text.endsWith('\n');

  // UTF-8 BOM 单独记一笔：TextDecoder 解码时会把它吃掉。
  // 但只是「解码时丢弃」而不在导出时补回去，保存一遍就少 3 个字节，
  // 有些播放器（Kodi / 部分 Windows 端）认不出首行。记进 doc.bom，
  // 由 serializeM3U 原样补回，做到真正的逐字节还原。
  let hasBom = text.startsWith(BOM);
  if (hasBom) text = text.slice(BOM.length);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  let header = null;
  /** @type {string[]} EXTINF 之前的裸 # 注释行，导出时原样放最前 */
  const headComments = [];
  /** 最后一个频道之后的收尾注释（导出时压在最末尾） */
  const tailComments = [];
  const entries = [];
  /** 挂在下一个频道前面的注释行（如 #KODIPROP / #EXTGRP） */
  let pendingComments = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) continue;

    if (HEADER_RE.test(t)) {
      // 只认第一句 #EXTM3U；列表中间又冒出来一句也按注释归堆，别覆盖文件头
      if (header === null) header = t;
      continue;
    }
    if (t.startsWith(EXTINF)) {
      const e = parseExtinf(t);
      e.comments = pendingComments;
      pendingComments = [];
      // 后面紧跟的非 # 行就是播放地址
      const next = lines[i + 1];
      if (next && next.trim() && !next.trim().startsWith('#')) {
        e.url = next.trim();
        i++;
      } else {
        e.url = '';
      }
      e.id = nextId();
      e.probe = null;
      entries.push(e);
      continue;
    }
    if (t.startsWith('#')) {
      // 第一个频道之前的注释属于「文件头」（#EXTM3U / #KODIPROP 之类），
      // 挂在文件级，避免用户删掉首条频道时把这行注释一起带走。
      if (entries.length === 0) headComments.push(t);
      else pendingComments.push(t);
      continue;
    }
    // 不是注释也不是 EXTINF —— 孤立地址，忽略（部分列表会把 URL 放前面）
  }

  // 末尾残留的注释（列表最后一个频道之后的 # 行）
  if (pendingComments.length) tailComments.push(...pendingComments);

  return {
    header,
    entries,
    comments: headComments,
    tailComments,
    eol,
    trailingNewline,
    bom: hasBom,
  };
}

/**
 * 解析单个 #EXTINF 行。
 * 返回 { duration, attrs: [{key, value, raw}], attrMap, title, raw }
 */
export function parseExtinf(line) {
  const body = line.slice(EXTINF.length);
  let i = 0;

  // 1) 时长：前导数字（绝大多数 IPTV 列表是 -1）
  const numRe = /^\s*([+-]?(?:\d+\.?\d*|\.\d+))/.exec(body);
  const duration = numRe ? numRe[1].trim() : '';
  if (numRe) i = numRe[0].length;

  const attrs = [];
  const attrMap = Object.create(null);

  // 2) 属性：从当前位置一直吃掉 key=value 对，直到遇到第一个逗号
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    if (i >= body.length) break;

    const ch = body[i];
    if (ch === ',') break; // 逗号后面是频道显示名

    const kvRe = /^([A-Za-z_][\w.\-]*)=/.exec(body.slice(i));
    if (!kvRe) {
      // 既不是属性也不是逗号 —— 可能是私有写法，直接停手，交给 raw 兜底
      break;
    }

    const key = kvRe[1];
    let j = i + kvRe[0].length;
    let value = '';
    let raw;

    if (body[j] === '"') {
      const end = body.indexOf('"', j + 1);
      if (end === -1) {
        value = body.slice(j + 1);
        j = body.length;
      } else {
        value = body.slice(j + 1, end);
        j = end + 1;
      }
      raw = `${key}="${value}"`;
    } else if (body[j] === "'") {
      const end = body.indexOf("'", j + 1);
      if (end === -1) {
        value = body.slice(j + 1);
        j = body.length;
      } else {
        value = body.slice(j + 1, end);
        j = end + 1;
      }
      raw = `${key}='${value}'`;
    } else {
      // 无引号值：按「空白 或 逗号」截断。
      // 逗号是 EXTINF 的属性边界（后面就是显示名），不能贪婪吞进去：
      // 否则 `response-time={18}ms,CCTV-9 纪录` 会变成
      // response-time="{18}ms,CCTV-9" + 标题「纪录」，把频道名吃掉。
      const m = /^[^\s,]*/.exec(body.slice(j));
      value = m[0];
      j += m[0].length;
      raw = value ? `${key}=${value}` : key;
    }

    attrs.push({ key, value, raw });
    attrMap[key] = value;
    i = j;
  }

  // 3) 显示名：逗号之后的全部内容
  let rest = body.slice(i);
  const title = rest.startsWith(',') ? rest.slice(1) : rest.replace(/^,/, '');

  return { duration, attrs, attrMap, title, raw: line };
}

/** 序列化单个 EXTINF 行 */
function serializeExtinf(e) {
  const attrStr = (e.attrs || []).map((a) => a.raw).join(' ');
  // 时长缺失（undefined/null）要兜成 -1：直接拼字符串会在行首吐出
  // `#EXTINF:undefined ...` 这种东西，一眼看上去就是坏列表。
  const dur = e.duration == null || e.duration === '' ? '-1' : e.duration;
  const line = EXTINF + dur;
  return attrStr ? `${line} ${attrStr},${e.title}` : `${line},${e.title}`;
}

/**
 * 文件名是不是 `.m3u8`。
 *
 * 主要给导出用：RFC 8216 只管 `.m3u8`——明文 MUST 是 UTF-8、MUST NOT 带 BOM，
 * 带 BOM 的客户端 SHOULD 直接报错；`.m3u` 是 Winamp 那个年代的事实标准，
 * 从来没规定过编码，BOM 转义不转义都算合法，所以两条路不能一刀切。
 *
 * @param {string} name
 */
export function isM3U8Name(name) {
  return /\.m3u8$/i.test(String(name ?? '').trim());
}

/** 去掉文本开头的 UTF-8 BOM（不存在就原样返回） */
export function stripBom(text) {
  return typeof text === 'string' && text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

/**
 * 序列化回文本（无损）。
 *
 * @param {{header?:string|null, entries:Array}} doc
 * @param {{stripBom?:boolean}} [opts] `stripBom` 为真时不补 BOM —— 导成 `.m3u8`
 *   时按 RFC 8216 应当不带 BOM（默认行为仍是原样补回，覆盖保存要用得上）。
 */
export function serializeM3U(doc, opts = {}) {
  const nl = doc.eol === '\r\n' ? '\r\n' : '\n';
  const out = [];
  if (doc.header) out.push(doc.header);
  for (const c of doc.comments || []) out.push(c);
  for (const e of doc.entries) {
    for (const c of e.comments || []) out.push(c);
    out.push(serializeExtinf(e));
    if (e.url) out.push(e.url);
  }
  for (const c of doc.tailComments || []) out.push(c);
  // 末尾换行：原文件有就补回来，没有就不补
  const body = out.join(nl) + (doc.trailingNewline ? nl : '');
  // UTF-8 BOM：原文件开头有就补回去（解码时 TextDecoder 吃掉过一次）。
  // 除非明确要求去 BOM——那条路是「导出 .m3u8」，RFC 8216 要求正文不带 BOM。
  if (opts.stripBom) return body;
  return doc.bom && !body.startsWith(BOM) ? BOM + body : body;
}

/** 常用取字段的快捷方式 */
export const getAttr = (e, key) => (e.attrMap ? e.attrMap[key] ?? '' : '');
export const logoOf = (e) => getAttr(e, 'tvg-logo');
export const groupOf = (e) => getAttr(e, 'group-title') || '';
export const nameOf = (e) => e.title || getAttr(e, 'tvg-name') || '';

/** 收集全部分组（保持出现顺序 + 计数） */
export function collectGroups(entries) {
  const map = new Map();
  for (const e of entries) {
    const g = groupOf(e) || '（未分组）';
    map.set(g, (map.get(g) || 0) + 1);
  }
  return [...map.entries()];
}

/** 候选字符集：UTF-8 优先，其次 GBK / GB18030，再回落到 latin（避免乱码字节直接丢） */
const ENCODINGS = ['utf-8', 'gb18030', 'iso-8859-1'];

/** 同时吃 Node Buffer 和浏览器 Uint8Array / ArrayBuffer */
function toBytes(src) {
  if (src == null) return null;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(src)) return new Uint8Array(src);
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  if (src instanceof Uint8Array) return src;
  return null;
}

/** 猜编码：utf-8 优先，其次 gb18030，再回落到 latin1（保字节不丢字） */
export function detectEncoding(src) {
  const bytes = toBytes(src);
  if (!bytes) return 'utf-8';
  for (const enc of ENCODINGS) {
    try {
      const txt = new TextDecoder(enc, { fatal: true }).decode(bytes);
      if (!txt.includes('�')) return enc;
    } catch {
      /* 试下一个 */
    }
  }
  return 'utf-8';
}

/**
 * 解码字节 -> 字符串。
 * TextDecoder 会**自动吃掉**开头的 UTF-8 BOM，这里原样补回去，
 * 否则「读一份带 BOM 的文件 → 编辑 → 保存」会静默少 3 个字节。
 * parseM3U 会把 BOM 记进 doc.bom，导出时再补出来，整份文件逐字节还原。
 *
 * 顺带说明：直接 `parseM3U(fs.readFileSync(f))`（绕开解码那一步）也能保住 BOM，
 * parseM3U 自己认开头那个 U+FEFF 并记进 doc.bom，和上面这条路殊途同归。
 */
export function decodeBuffer(src) {
  const bytes = toBytes(src);
  if (!bytes) return '';
  const enc = detectEncoding(bytes);
  let txt;
  try {
    txt = new TextDecoder(enc).decode(bytes);
  } catch {
    // latin1 兜底：一个字节一个字符，绝不丢字节
    txt = Array.from(bytes)
      .map((b) => String.fromCharCode(b))
      .join('');
  }
  // TextDecoder 已经把开头那三个 EF BB BF 吃了，这里按**原始字节**判一次再补回，
  // 不能判 txt.startsWith(BOM) —— 那会儿 txt 里压根没有 BOM，永远补不上。
  return bytesHasUtf8Bom(bytes) ? BOM + txt : txt;
}

/** 字节流开头是不是 UTF-8 BOM */
export function bytesHasUtf8Bom(bytes) {
  const b = toBytes(bytes);
  return !!b && b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
}
