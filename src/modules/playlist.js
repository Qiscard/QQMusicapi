/**
 * 歌单 / 专辑 / 歌手相关 API.
 *
 * 歌单与专辑走 QQ 经典 fcg 接口 (无需 zzc 签名):
 * - 歌单: i.y.qq.com/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg
 *   公开歌单可匿名访问; 登录后 Client.request 会自动注入 uin/qm_keyst Cookie,
 *   g_tk 按musickey 计算, 因此私有歌单也可读取.
 * - 专辑: i.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg
 * - 歌手: music.web_singer_info_svr (musicu.fcg, 走标准 Request 描述符)
 */

import { ApiModule } from "./base.js";
import { Platform } from "../versioning.js";
import { hash33 } from "../utils/common.js";
import { ApiDataError } from "../exceptions.js";

const PLAYLIST_FCG = "https://i.y.qq.com/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg";
const ALBUM_FCG = "https://i.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg";
const USER_CREATED_FCG = "https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss";
const USER_COLLECTED_FCG = "https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg";
const SINGER_PAGE_SIZE = 50;

/**
 * 歌单 ID 说明: 用户创建歌单的 dirid 不能用于歌曲列表接口,
 * 必须使用其 tid 字段 (公开歌单的 disstid 与 tid 一致).
 */

export class PlaylistApi extends ApiModule {
  /**
   * 归一化歌曲对象 (fcg 接口的字段与 musicu 接口不同).
   */
  static normalizeTrack(s) {
    if (!s || typeof s !== "object") return s;
    return {
      mid: s.songmid || s.mid || "",
      id: s.songid ?? s.id ?? 0,
      name: s.songname || s.name || "",
      singer: (s.singer || []).map((x) => x.name).join(" / "),
      albumMid: s.albummid || s.album?.mid || "",
      albumName: s.albumname || s.album?.name || "",
      interval: s.interval ?? 0,
      pay: s.pay ?? null,
      sizes: {
        mp3_128: s.size128 ?? 0,
        mp3_320: s.size320 ?? 0,
        flac: s.sizeflac ?? 0,
        ogg: s.sizeogg ?? 0,
      },
    };
  }

  /** 请求歌单分页. begin 为起始索引; 不传 song_num 时服务端倾向返回整单. */
  async _fetchPlaylistPage(disstid, begin) {
    const cred = this._client.credential;
    const gtk = cred?.musickey ? hash33(cred.musickey, 5381) : 5381;
    const params = {
      type: 1,
      json: 1,
      utf8: 1,
      onlysong: 0,
      nosign: 1,
      disstid,
      song_begin: begin,
      g_tk: gtk,
      loginUin: cred?.musicid ? String(cred.musicid) : 0,
      hostUin: 0,
      format: "json",
      inCharset: "GB2312",
      outCharset: "utf-8",
      notice: 0,
      platform: "yqq",
      needNewCode: 0,
    };
    if (begin > 0) params.song_num = 100;
    const resp = await this._client.request("GET", PLAYLIST_FCG, null, null, {
      params,
      headers: { Referer: "https://y.qq.com/" },
    });
    const data = resp.data;
    if (typeof data === "string") {
      throw new ApiDataError(`歌单接口返回异常: ${data.slice(0, 120)}`);
    }
    return data;
  }

  /**
   * 获取歌单内歌曲列表.
   * @param {string|number} disstid 歌单 ID (数字)
   * @returns {Promise<{name, cover, creator, songnum, tracks: Array}>}
   */
  async getTracks(disstid) {
    const id = String(disstid ?? "").trim();
    if (!/^\d+$/.test(id)) {
      throw new ApiDataError("disstid 必须为数字歌单 ID (可从歌单链接中提取)");
    }
    const first = await this._fetchPlaylistPage(id, 0);
    const cd = first?.cdlist?.[0];
    if (!cd) throw new ApiDataError("歌单不存在或无权访问");
    let tracks = cd.songlist ?? [];
    const total = Number(cd.songnum ?? tracks.length) || tracks.length;
    // 分页补齐 (极端情况下服务端未一次性返回全部)
    let guard = 0;
    while (tracks.length < total && guard < 20) {
      const page = await this._fetchPlaylistPage(id, tracks.length);
      const list = page?.cdlist?.[0]?.songlist ?? [];
      if (list.length === 0) break;
      tracks = tracks.concat(list);
      guard++;
    }
    return {
      disstid: id,
      name: cd.dissname || "",
      cover: cd.logo || "",
      creator: cd.nickname || cd.creator?.nick || "",
      songnum: total,
      tracks: tracks.map(PlaylistApi.normalizeTrack),
    };
  }

  /**
   * 获取专辑内歌曲列表.
   * @param {string} albummid 专辑 mid
   * @returns {Promise<{name, albumMid, tracks: Array}>}
   */
  async getAlbumTracks(albummid) {
    const mid = String(albummid ?? "").trim();
    if (!mid) throw new ApiDataError("albummid 必填");
    const resp = await this._client.request("GET", ALBUM_FCG, null, null, {
      params: {
        platform: "h5page",
        albummid: mid,
        uin: this._client.credential?.musicid ? String(this._client.credential.musicid) : 0,
        g_tk: this._client.credential?.musickey
          ? hash33(this._client.credential.musickey, 5381)
          : 5381,
        format: "json",
        inCharset: "utf-8",
        outCharset: "utf-8",
        notice: 0,
        needNewCode: 1,
      },
      headers: { Referer: "https://y.qq.com/" },
    });
    const data = resp.data;
    if (typeof data === "string" || !data?.data) {
      throw new ApiDataError("专辑接口返回异常");
    }
    return {
      albumMid: mid,
      name: data.data.name || "",
      tracks: (data.data.list ?? []).map(PlaylistApi.normalizeTrack),
    };
  }

  /**
   * 获取用户创建的歌单 (Qzone fcg_user_created_diss).
   * 匿名可查公开部分; 服务带登录态时读取更完整.
   * 注意: music.songlist.UserSonglistService (musicu) 已被 QQ 收紧
   * (固定返回 subcode 860100001), 因此使用该老接口.
   * @returns {Promise<{hostname, total, lists: Array}>}
   */
  async getUserCreatedPlaylists(uin) {
    const id = String(uin ?? "").trim();
    if (!/^\d+$/.test(id)) {
      throw new ApiDataError("uin 必须为数字 QQ 号");
    }
    const cred = this._client.credential;
    const resp = await this._client.request("GET", USER_CREATED_FCG, null, null, {
      params: {
        hostUin: 0,
        hostuin: id,
        sin: 0,
        size: 200,
        g_tk: cred?.musickey ? hash33(cred.musickey, 5381) : 5381,
        loginUin: cred?.musicid ? String(cred.musicid) : 0,
        format: "json",
        inCharset: "utf8",
        outCharset: "utf-8",
        notice: 0,
        platform: "yqq.json",
        needNewCode: 0,
      },
      headers: { Referer: "https://y.qq.com/portal/profile.html" },
    });
    const d = resp.data;
    if (typeof d === "string" || d?.code !== 0) {
      throw new ApiDataError(`获取用户歌单失败: ${typeof d === "string" ? d.slice(0, 100) : d?.message ?? `code ${d?.code}`}`);
    }
    const lists = (d.data?.disslist ?? []).map((it) => ({
      // 歌曲列表接口只认 tid; dirid 是目录 ID, tid 为 0 的系统目录不可读
      disstid: (it.tid ?? 0) > 0 ? String(it.tid) : null,
      dirid: it.dirid,
      name: it.diss_name ?? it.dissname ?? "",
      cover: it.diss_cover ?? it.logo ?? "",
      songcnt: it.song_cnt ?? it.songnum ?? 0,
      listenNum: it.listen_num ?? 0,
      visible: (it.dir_show ?? 1) === 1,
    }));
    return {
      hostname: d.data?.hostname ?? "",
      total: d.data?.totoal ?? lists.length, // 上游字段即拼写为 totoal
      lists,
    };
  }

  /**
   * 获取用户收藏的歌单 (fcg_get_profile_order_asset, 需要登录态).
   * 对他人查询会返回 privacy, 此时静默返回空列表.
   * @returns {Promise<{total, lists: Array}>}
   */
  async getUserCollectedPlaylists(uin) {
    const id = String(uin ?? "").trim();
    if (!/^\d+$/.test(id)) {
      throw new ApiDataError("uin 必须为数字 QQ 号");
    }
    const cred = this._client.credential;
    const resp = await this._client.request("GET", USER_COLLECTED_FCG, null, null, {
      params: {
        ct: 20,
        cid: 205360956,
        userid: id,
        reqtype: 3,
        sin: 0,
        ein: 100,
        g_tk: cred?.musickey ? hash33(cred.musickey, 5381) : 5381,
        format: "json",
      },
      headers: { Referer: "https://y.qq.com/" },
    });
    const d = resp.data;
    // 隐私限制 (4000) / 未登录 (1000) 时静默为空
    if (typeof d === "string" || (d?.code && d.code !== 0)) {
      return { total: 0, lists: [] };
    }
    const lists = (d.data?.cdlist ?? []).map((it) => ({
      disstid: it.disstid ? String(it.disstid) : null,
      dirid: it.dirid,
      name: it.dissname ?? it.diss_name ?? "",
      cover: it.logo ?? it.diss_cover ?? it.picurl ?? "",
      songcnt: it.songnum ?? it.song_cnt ?? 0,
      listenNum: it.listen_num ?? 0,
      visible: true,
      collected: true,
    }));
    return { total: d.data?.totaldiss ?? lists.length, lists };
  }

  /**
   * 获取歌手信息与热门歌曲 (走标准 musicu 描述符).
   */
  getSingerInfo(singermid) {
    const mid = String(singermid ?? "").trim();
    if (!mid) throw new ApiDataError("singermid 必填");
    return this._buildRequest(
      "music.web_singer_info_svr",
      "get_singer_detail_info",
      { sort: 5, singermid: mid, sin: 0, num: SINGER_PAGE_SIZE },
      { platform: Platform.WEB },
    );
  }
}
