"""
hongguo.py - 红果短剧核心逆向协议与解密引擎（Python 版）

功能：
  1. 分享链接 -> series_id 解析
  2. 全集剧集列表拉取
  3. 单集播放直链与 spade_a 加密信息获取
  4. spade_a -> AES-128 Key 派生
  5. CENC-AES-CTR 流式解密 -> 输出标准非加密 MP4

对应原 Node 实现：src/native/hongguo.js
"""
import json
import re
import time

import requests
from Crypto.Cipher import AES

API = "https://api5-normal-sinfonlineb.fqnovel.com"
UA = "com.phoenix.read/71532 (Linux; U; Android 9; SM-N9860; Build/PQ3A.190705.10241111;tt-ok/3.12.13.20)"
VIDEO_REFERER = "https://novelquickapp.com/"

COMMON_QUERY = {
    "klink_egdi": "AAI29o4dI-eMiO73_SRSbZ_0By1v3fUSriNeu8-L951MoXhWT88pzj5B",
    "iid": "3788260546453235",
    "device_id": "538083340353620",
    "ac": "wifi",
    "channel": "oppo_8662_64",
    "aid": "8662",
    "app_name": "novelread",
    "version_code": "71532",
    "version_name": "7.1.5.32",
    "device_platform": "android",
    "os": "android",
    "ssmix": "a",
    "device_type": "SM-N9860",
    "device_brand": "Samsung",
    "language": "zh",
    "os_api": "28",
    "os_version": "9",
    "manifest_version_code": "71532",
    "resolution": "900*1600",
    "dpi": "320",
    "update_version_code": "71532",
    "host_abi": "arm64-v8a",
    "dragon_device_type": "pad",
    "pv_player": "71532",
    "compliance_status": "0",
    "need_personal_recommend": "1",
    "player_so_load": "1",
    "is_android_pad_screen": "0",
    "rom_version": "PQ3A.190705.10241111+release-keys",
    "cdid": "b4f93387-5319-4134-aab9-2cd4e9279b8f",
}

HEADERS = {
    "User-Agent": UA,
    "Accept-Encoding": "gzip",
    "Accept": "application/json; charset=utf-8,application/x-protobuf",
    "Content-Type": "application/json; charset=utf-8",
    "Host": "api5-normal-sinfonlineb.fqnovel.com",
}

DETAIL_BIZ_PARAM = {
    "detail_page_version": 0,
    "disable_digg_stat": False,
    "image_shrink_datas_str": "W3siaW1hZ2VfdHlwZSI6MywiaW1hZ2Vfd2lkdGgiOjkwMCwic2hyaW5rX3R5cGUiOjN9LHsiaW1hZ2VfdHlwZSI6NCwiaW1hZ2Vfd2lkdGgiOjcyLCJzaHJpbmtfdHlwZSI6NH1d\n",
    "need_all_video_definition": False,
    "need_mp4_align": False,
    "screen_width_px": "900",
    "source": 7,
    "use_os_player": False,
    "use_server_dns": False,
}

MODEL_BIZ_PARAM = {
    "detail_page_version": 0,
    "device_level": 3,
    "disable_digg_stat": False,
    "need_all_video_definition": True,
    "need_mp4_align": False,
    "use_os_player": False,
    "use_server_dns": False,
    "video_platform": 1024,
}


def _api_call(api_path, body, retries=3):
    """API 调用封装"""
    q = dict(COMMON_QUERY)
    q["_rticket"] = str(int(time.time() * 1000))
    last_err = None
    for i in range(retries):
        try:
            resp = requests.post(API + api_path, json=body, params=q, headers=HEADERS, timeout=25)
            if resp.status_code != 200:
                raise Exception("HTTP %d" % resp.status_code)
            return resp.json()
        except Exception as err:
            last_err = err
            if i == retries - 1:
                raise
            time.sleep(2 * (i + 1))
    raise last_err


def resolve_series_id(share_url):
    """分享链接 -> series_id"""
    trimmed = str(share_url or "").strip()
    if re.match(r"^\d+$", trimmed):
        return trimmed

    resp = requests.get(
        trimmed,
        headers={
            "User-Agent": "Mozilla/5.0 (Linux; Android 9; SM-N9860) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/88.0.4324.152 Mobile Safari/537.36",
        },
        timeout=25,
        allow_redirects=True,
    )

    final_url = resp.url or trimmed
    m = re.search(r"video_series_id=(\d+)", final_url)
    if m:
        return m.group(1)

    m = re.search(r"schemeParams[^&]*", final_url)
    if m:
        raw = requests.utils.unquote(requests.utils.unquote(m.group(0)))
        jm = re.search(r'"video_id"\s*:\s*"(\d+)"', raw)
        if jm:
            return jm.group(1)

    body_text = resp.text
    m = (re.search(r"video_series_id=(\d+)", body_text)
         or re.search(r'"video_id"\s*:\s*"(\d+)"', body_text)
         or re.search(r'"series_id"\s*:\s*"(\d+)"', body_text))
    if m:
        return m.group(1)

    raise Exception("无法从链接解析 series_id: " + final_url)


def fetch_episode_list(series_id):
    """获取全集剧集列表"""
    body = {
        "biz_param": DETAIL_BIZ_PARAM,
        "dr_scene": "preload",
        "series_id": series_id,
    }
    j = _api_call("/novel/player/multi_video_detail/preload/v1", body)
    if not j or j.get("code") != 0:
        raise Exception("detail API 失败: " + json.dumps(j or {}, ensure_ascii=False)[:200])

    d = j.get("data") or {}
    sid = next(iter(d), None)
    if not sid:
        raise Exception("未获取到剧集数据")

    vd = d[sid].get("video_data") or {}
    vl = vd.get("video_list") or []
    eps = []
    for item in vl:
        eps.append({
            "vid": str(item.get("vid")),
            "vid_index": item.get("vid_index") or 0,
            "title": item.get("title") or "",
            "series_id": str(item.get("series_id") or sid),
            "series_title": vd.get("series_title") or "",
            "cover": vd.get("series_cover") or vd.get("cover_url") or item.get("cover_url") or "",
        })
    eps.sort(key=lambda a: a["vid_index"])
    return {
        "series_id": str(sid),
        "series_title": vd.get("series_title") or "未命名短剧",
        "cover": vd.get("series_cover") or vd.get("cover_url") or (eps[0]["cover"] if eps else ""),
        "total": len(eps),
        "episodes": eps,
    }


def _stream_score(v):
    """单条视频流的清晰度评分，返回 { defNum, pixels, bitrate }"""
    meta = v.get("video_meta") or {}
    def_str = str(meta.get("definition") or "")
    def_num = 0
    m = re.search(r"(\d+)\s*p", def_str, re.I)
    if m:
        def_num = int(m.group(1))
    else:
        mp = {"4k": 2160, "2k": 1440, "fhd": 1080, "fullhd": 1080, "hd": 720, "sd": 480, "ld": 360}
        def_num = mp.get(def_str.lower(), 0)
    w = int(meta.get("vwidth") or 0)
    h = int(meta.get("vheight") or 0)
    bitrate = int(meta.get("bitrate") or meta.get("real_bitrate") or 0)
    return {"defNum": def_num, "pixels": w * h, "bitrate": bitrate}


def _parse_model_video(vm):
    """解析单个 video_model JSON，返回 (url, spade_a, codec)"""
    if not isinstance(vm, str):
        return (None, None, None)
    try:
        vmj = json.loads(vm)
    except Exception:
        return (None, None, None)

    vl = vmj.get("video_list") or []

    def rank(codec):
        if codec in ("h265", "h264", "h265_hvc1", "hevc", "hvc1", "avc1"):
            return 0
        if codec == "bytevc1":
            return 1
        return 2

    def cmp(a, b):
        if a["defNum"] != b["defNum"]:
            return a["defNum"] - b["defNum"]
        if a["pixels"] != b["pixels"]:
            return a["pixels"] - b["pixels"]
        if a["codecRank"] != b["codecRank"]:
            return b["codecRank"] - a["codecRank"]
        return a["bitrate"] - b["bitrate"]

    best = None
    best_score = None
    for v in vl:
        if not v.get("main_url"):
            continue
        codec = (v.get("video_meta") or {}).get("codec_type") or ""
        ei = v.get("encrypt_info") or {}
        s = dict(_stream_score(v))
        s["codecRank"] = rank(codec)
        if best_score is None or cmp(s, best_score) > 0:
            best_score = s
            best = (v.get("main_url"), ei.get("spade_a") or None, codec)
    return best if best else (None, None, None)


def fetch_play_url_single(vid):
    """获取单集播放直链与 spade_a 加密 key"""
    body = {
        "biz_param": MODEL_BIZ_PARAM,
        "dr_scene": "preload",
        "mixed_video_id_map": {"1004": [vid]},
    }
    try:
        j = _api_call("/novel/player/multi_video_model/preload/v1", body)
        item = (j.get("data") or {}).get(vid) or {}
        url, spade_a, codec = _parse_model_video(item.get("video_model"))
        return {"url": url, "spadeA": spade_a, "codec": codec}
    except Exception:
        return {"url": None, "spadeA": None, "codec": None}


_B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"


def _av_base64_decode(s):
    """FFmpeg 兼容 Base64 解码（在遇到非法字符时按已解析位数收尾）"""
    table = {c: i for i, c in enumerate(_B64_CHARS)}
    out = bytearray()
    i = 0
    while i + 4 <= len(s):
        vals = []
        ok = True
        for j in range(4):
            ch = s[i + j]
            if ch in table:
                vals.append(table[ch])
            else:
                ok = False
                break
        if not ok:
            v = 0
            for x in vals:
                v = (v << 6) | x
            if len(vals) == 3:
                out.append((v >> 10) & 0xff)
                out.append((v >> 2) & 0xff)
            elif len(vals) == 2:
                out.append((v >> 4) & 0xff)
            break
        v = (vals[0] << 18) | (vals[1] << 12) | (vals[2] << 6) | vals[3]
        out.append((v >> 16) & 0xff)
        out.append((v >> 8) & 0xff)
        out.append(v & 0xff)
        i += 4
    return bytes(out)


def derive_key(spade_a):
    """spade_a -> 16 字节 AES Key"""
    if not spade_a:
        return None
    buf = _av_base64_decode(spade_a)
    length = len(buf)
    if length < 3:
        return None

    key0 = buf[0] ^ buf[1] ^ buf[2]
    x27 = key0 - 0x30
    w22 = length - key0 + 0x2f
    if x27 < 2 or w22 < 2 or w22 > length - 1:
        return None

    x21 = bytearray(buf[1:1 + w22])
    w11 = 0x55
    w12 = 0xfa
    w10 = 0xeb
    for i in range(len(x21)):
        w13 = x21[i]
        pc = bin(i).count("1")
        w14 = w12 if (i & 1) == 0 else w11
        if (i & 1) == 1:
            w11 = w13
        else:
            w12 = w13
        w13_xor = w14 ^ x21[i]
        w14_sub = w10 - pc
        x21[i] = (w14_sub + w13_xor) & 0xff

    c0 = x21[0]
    hval = 0
    if 0x30 <= c0 <= 0x39:
        hval = c0 - 0x30
    elif 0x61 <= c0 <= 0x7a:
        hval = c0 - 0x57
    else:
        return None

    w9 = w22 - hval
    if w9 < 2:
        return None

    str_a = bytes(x21[1:w9]).decode("ascii")
    if len(str_a) != 32:
        return None

    try:
        return bytes.fromhex(str_a)
    except ValueError:
        return None


def _aes128_ecb_encrypt(key16, data):
    """AES-128-ECB 加密（无填充，data 长度需为 16 的倍数）"""
    cipher = AES.new(key16, AES.MODE_ECB)
    return cipher.encrypt(data)


def _decrypt_sample(key, nonce, cipher):
    """CENC-AES-CTR 解密单个 sample"""
    if not cipher:
        return b""
    nblocks = (len(cipher) + 15) // 16
    full = bytearray(nblocks * 16)
    for k in range(nblocks):
        full[k * 16:k * 16 + 8] = nonce[0:8]
        full[k * 16 + 8:k * 16 + 16] = k.to_bytes(8, "big")
    ks = _aes128_ecb_encrypt(key, bytes(full))
    return bytes(c ^ ks[i] for i, c in enumerate(cipher))


_CONTAINER_BOXES = ("moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta", "meta")


def _parse_boxes(data, start, end):
    """MP4 Box 结构解析"""
    boxes = []
    off = start
    while off + 8 <= end:
        size = int.from_bytes(data[off:off + 4], "big")
        typ = data[off + 4:off + 8].decode("latin1")
        hdr = 8
        if size == 1:
            size = int.from_bytes(data[off + 8:off + 16], "big")
            hdr = 16
        elif size == 0:
            size = end - off
        if size < hdr or off + size > end:
            break
        children = None
        if typ in _CONTAINER_BOXES:
            children = _parse_boxes(data, off + hdr, off + size)
        boxes.append({"typ": typ, "off": off, "size": size, "hdr": hdr, "children": children})
        off += size
    return boxes


def _rebuild_moov(data, moov_off, moov_size, top):
    """重建 moov box（去除 CENC 加密信息，还原标准编码类型）"""
    moov_box = next((b for b in top if b["typ"] == "moov"), None)
    if not moov_box:
        raise Exception("no moov box")

    def clone(box):
        return {
            "typ": box["typ"],
            "off": box["off"],
            "size": box["size"],
            "hdr": box["hdr"],
            "children": [clone(c) for c in box["children"]] if box["children"] else None,
        }

    def prune(box):
        if not box["children"]:
            return box
        keep = []
        for c in box["children"]:
            if c["typ"] in ("senc", "saio", "saiz", "sgpd", "sbgp"):
                continue
            keep.append(prune(c))
        box["children"] = keep
        return box

    tree = prune(clone(moov_box))

    def walk_children(box):
        for c in (box["children"] or []):
            yield c
            for x in walk_children(c):
                yield x

    patches = {}
    for b in walk_children(tree):
        if b["typ"] == "stsd":
            content = b["off"] + 8
            count = int.from_bytes(data[content + 4:content + 8], "big")
            p = content + 8
            entries = []
            for _ in range(count):
                esize = int.from_bytes(data[p:p + 4], "big")
                etyp = data[p + 4:p + 8].decode("latin1")
                if etyp in ("encv", "enca"):
                    new_type = b"hvc1" if etyp == "encv" else b"mp4a"
                    hdr_size = 78 if etyp == "encv" else 28
                    entry = bytearray(8 + hdr_size)
                    entry[4:8] = new_type
                    entry[8:8 + hdr_size] = data[p + 8:p + 8 + hdr_size]

                    entry_extra = bytearray()
                    q = p + 8 + hdr_size
                    while q + 8 <= p + esize:
                        s2 = int.from_bytes(data[q:q + 4], "big")
                        t2 = data[q + 4:q + 8].decode("latin1")
                        if s2 == 1:
                            s2 = int.from_bytes(data[q + 8:q + 16], "big")
                        elif s2 == 0:
                            s2 = p + esize - q
                        if t2 != "sinf":
                            entry_extra += data[q:q + s2]
                        q += s2

                    full_entry = bytes(entry) + bytes(entry_extra)
                    full_entry = len(full_entry).to_bytes(4, "big") + full_entry[4:]
                    entries.append(full_entry)
                else:
                    entries.append(bytes(data[p:p + esize]))
                p += esize

            stsd_hdr = bytearray(data[b["off"]:b["off"] + 16])
            stsd_hdr[12:16] = len(entries).to_bytes(4, "big")
            full_stsd = bytes(stsd_hdr) + b"".join(entries)
            full_stsd = len(full_stsd).to_bytes(4, "big") + full_stsd[4:]
            patches[b["off"]] = full_stsd

    def serialize(box):
        if not box["children"]:
            if box["off"] in patches:
                return patches[box["off"]]
            return bytes(data[box["off"]:box["off"] + box["size"]])
        body = b"".join(serialize(c) for c in box["children"])
        hdrb = bytearray(data[box["off"]:box["off"] + box["hdr"]])
        if box["hdr"] == 8:
            hdrb[0:4] = (8 + len(body)).to_bytes(4, "big")
        else:
            hdrb[0:4] = (1).to_bytes(4, "big")
            hdrb[8:16] = (16 + len(body)).to_bytes(8, "big")
        return bytes(hdrb) + body

    first = serialize(tree)
    delta = moov_size - len(first)

    for b in walk_children(tree):
        if b["typ"] == "stco":
            nc = int.from_bytes(data[b["off"] + 12:b["off"] + 16], "big")
            for i in range(nc):
                idx = b["off"] + 16 + i * 4
                v = int.from_bytes(data[idx:idx + 4], "big")
                if v >= delta:
                    data[idx:idx + 4] = (v - delta).to_bytes(4, "big")

    return serialize(tree)


def decrypt_mp4_file(src_path, dst_path, key):
    """解密 MP4 文件并保存"""
    with open(src_path, "rb") as f:
        data = bytearray(f.read())
    total = len(data)
    top = _parse_boxes(data, 0, total)
    moov = next((b for b in top if b["typ"] == "moov"), None)
    if not moov:
        raise Exception("no moov box found in MP4")

    def get_box(boxes, typ):
        return next((b for b in (boxes or []) if b["typ"] == typ), None)

    def walk_boxes(boxes):
        for b in boxes:
            if b["children"]:
                for x in walk_boxes(b["children"]):
                    yield x
            yield b

    stbls = [b for b in walk_boxes(top) if b["typ"] == "stbl"]
    track_info = []
    for stbl in stbls:
        stsz = get_box(stbl["children"], "stsz")
        stco = get_box(stbl["children"], "stco")
        stsc = get_box(stbl["children"], "stsc")
        senc = get_box(stbl["children"], "senc")
        if not stsz or not stco or not stsc:
            continue

        ss = int.from_bytes(data[stsz["off"] + 12:stsz["off"] + 16], "big")
        n = int.from_bytes(data[stsz["off"] + 16:stsz["off"] + 20], "big")
        if ss == 0:
            sizes = [int.from_bytes(data[stsz["off"] + 20 + i * 4:stsz["off"] + 24 + i * 4], "big") for i in range(n)]
        else:
            sizes = [ss] * n

        nc = int.from_bytes(data[stco["off"] + 12:stco["off"] + 16], "big")
        chunk_offs = [int.from_bytes(data[stco["off"] + 16 + i * 4:stco["off"] + 20 + i * 4], "big") for i in range(nc)]

        ns = int.from_bytes(data[stsc["off"] + 12:stsc["off"] + 16], "big")
        stsc_tab = []
        for i in range(ns):
            base = stsc["off"] + 16 + i * 12
            stsc_tab.append([
                int.from_bytes(data[base:base + 4], "big"),
                int.from_bytes(data[base + 4:base + 8], "big"),
                int.from_bytes(data[base + 8:base + 12], "big"),
            ])

        ivs = []
        if senc:
            sc = int.from_bytes(data[senc["off"] + 12:senc["off"] + 16], "big")
            for i in range(sc):
                ivs.append(bytes(data[senc["off"] + 16 + i * 8:senc["off"] + 24 + i * 8]))

        chunk_spc = {}
        for i in range(len(stsc_tab)):
            fc = stsc_tab[i][0]
            spc = stsc_tab[i][1]
            nxt = stsc_tab[i + 1][0] if i + 1 < len(stsc_tab) else (nc + 1)
            for ci in range(fc - 1, nxt - 1):
                chunk_spc[ci] = spc

        sample_offs = []
        si = 0
        for ci in range(nc):
            off = chunk_offs[ci]
            spc = chunk_spc.get(ci, 1)
            for _ in range(spc):
                if si >= n:
                    break
                sample_offs.append(off)
                off += sizes[si]
                si += 1

        track_info.append({"sizes": sizes, "offs": sample_offs, "ivs": ivs, "stco": stco})

    for ti in track_info:
        for i in range(len(ti["offs"])):
            off = ti["offs"][i]
            sz = ti["sizes"][i]
            if off + sz > total:
                continue
            if i < len(ti["ivs"]):
                nonce = ti["ivs"][i][0:8]
                cipher = bytes(data[off:off + sz])
                plain = _decrypt_sample(key, nonce, cipher)
                data[off:off + sz] = plain

    new_moov = _rebuild_moov(data, moov["off"], moov["size"], top)
    out = []
    off = 0
    while off < total:
        size = int.from_bytes(data[off:off + 4], "big")
        typ = data[off + 4:off + 8].decode("latin1")
        hdr = 8
        if size == 1:
            size = int.from_bytes(data[off + 8:off + 16], "big")
            hdr = 16
        elif size == 0:
            size = total - off
        if typ == "moov":
            out.append(new_moov)
        else:
            out.append(bytes(data[off:off + size]))
        off += size

    with open(dst_path, "wb") as f:
        f.write(b"".join(out))
