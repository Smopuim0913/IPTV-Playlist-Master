/**
 * 拼 H.264 SPS 的小工具 —— resolution / gop 两个测试共用。
 *
 * 直接拿真源站的数据最靠谱，但有些用例要造不同分辨率/隔行/crop 的 SPS，
 * 光靠真数据凑不出来，所以自己写一位一位抠比特流的 BitWriter。
 */

class BitWriter {
  constructor() {
    this.bits = [];
  }
  u1(v) {
    this.bits.push(v ? 1 : 0);
    return this;
  }
  u(n, v) {
    for (let i = n - 1; i >= 0; i--) this.bits.push((v >> i) & 1);
    return this;
  }
  ue(v) {
    // 指数哥伦布：z = 前导零个数，v = (2^z - 1) + 后面的 z 位
    const z = 31 - Math.clz32(Math.max(0, v) + 1);
    const x = v - ((1 << z) - 1);
    for (let i = 0; i < z; i++) this.bits.push(0);
    this.bits.push(1);
    for (let i = z - 1; i >= 0; i--) this.bits.push((x >> i) & 1);
    return this;
  }
  build() {
    const bytes = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | (this.bits[i + j] || 0);
      bytes.push(b);
    }
    return Buffer.from(bytes);
  }
}

/** 造一个 nal_type=7 的 SPS（含 Annex-B 起始码） */
export function makeSps({ profile = 0x42, level = 30, width = 1920, height = 1080, interlaced = false, crop = null, vui = false } = {}) {
  const w = new BitWriter();
  w.u(8, profile).u(8, 0).u(8, level);
  w.ue(0); // sps_seq_parameter_set_id
  // High profile 才会带 chroma/bit depth 这一段，主档位直接跳到 POC
  if (profile >= 100) {
    w.ue(1); // chroma_format_idc = 4:2:0
    w.ue(0);
    w.ue(0);
    w.u1(0); // seq_scaling_matrix_present = 0
  }
  w.ue(0); // log2_max_frame_num_minus4
  w.ue(2); // pic_order_cnt_type = 2（省掉后续分支）
  w.ue(1); // max_num_ref_frames
  w.u1(0); // gaps_in_frame_num_value_allowed_flag
  // 宏块数必须是整数，1080/16 这种除不尽的真源站是靠 SPS 的 crop 修正的，
  // 这里统一向下取整，断言里再按取整后的结果写
  w.ue(Math.floor(width / 16) - 1);
  w.ue(Math.floor(height / (interlaced ? 32 : 16)) - 1);
  w.u1(interlaced ? 0 : 1); // frame_mbs_only_flag
  if (interlaced) w.u1(1); // mb_adaptive_frame_field_flag
  w.u1(1); // direct_8x8_inference_flag（无条件存在，漏了就整个串位）
  w.u1(crop ? 1 : 0);
  if (crop) w.ue(crop[0]).ue(crop[1]).ue(crop[2]).ue(crop[3]);
  w.u1(vui ? 1 : 0); // vui_parameters_present_flag
  w.u1(1); // rbsp_stop_one_bit
  return Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67]), w.build()]);
}
