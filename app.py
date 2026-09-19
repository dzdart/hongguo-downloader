"""
app.py - 红果短剧下载器 Web 服务端（Python + Flask 版）

功能：
  1. 提供 Web 页面（dist-react 构建产物）
  2. 红果短剧解析（分享链接 / series_id -> 全剧集列表）
  3. 批量提交下载任务到下载队列
  4. 并发下载：流式下载播放直链 -> spade_a 派生 AES Key -> CENC-AES-CTR 解密 -> 输出 mp4
  5. 下载管理：进度推送（SSE）、暂停/取消、重试、删除
  6. 设置：下载目录、命名规则、并发数（JSON 文件持久化）

环境变量：
  PORT         服务监听端口（默认 8080）
  DOWNLOAD_DIR 默认下载根目录（默认 ./downloads）
  DATA_FILE    数据持久化文件路径（默认 ./data/data.json）

对应原 Node 实现：server.js
"""
import os
import re
import json
import time
import random
import threading
import queue as queue_mod
from collections import deque
from functools import cmp_to_key

import requests
from flask import Flask, request, jsonify, Response, send_from_directory, stream_with_context

import hongguo
import store

APP_NAME = "红果短剧下载器"
APP_VERSION = "1.0.0"

PORT = int(os.environ.get("PORT") or 8080)
DOWNLOAD_ROOT = (
    (os.environ.get("DOWNLOAD_DIR") or "").strip()
    or os.path.join(os.getcwd(), "downloads")
)
DATA_FILE = os.environ.get("DATA_FILE") or os.path.join(os.getcwd(), "data", "data.json")

app = Flask(__name__, static_folder=None)

# ===== 下载任务管理 =====
download_tasks = []
download_queue = deque()
tasks_lock = threading.Lock()
queue_lock = threading.Lock()
active_downloads = 0
MAX_CONCURRENT_DOWNLOADS = 3

# ===== SSE 实时事件客户端 =====
sse_clients = set()
sse_lock = threading.Lock()


def broadcast(event, payload):
    frame = "event: %s\ndata: %s\n\n" % (event, json.dumps(payload, ensure_ascii=False))
    with sse_lock:
        clients = list(sse_clients)
    for q in clients:
        try:
            q.put(frame)
        except Exception:
            pass


# ===== 设置 =====
def get_default_settings():
    return {
        "root": DOWNLOAD_ROOT,
        # 文件命名模板：可用变量 剧名(series_title) 集数(vid_index) 标题(ep_title)
        "name_format": "剧名 集数",
        "max_concurrent": 3,
    }


def get_current_settings():
    global MAX_CONCURRENT_DOWNLOADS
    saved = store.get_settings() or {}
    merged = dict(get_default_settings())
    merged.update(saved)
    try:
        mc = int(merged.get("max_concurrent", 3))
    except (TypeError, ValueError):
        mc = 3
    if not (1 <= mc <= 10):
        mc = 3
    MAX_CONCURRENT_DOWNLOADS = mc
    merged["max_concurrent"] = mc
    return merged


def sanitize_folder_name(name):
    """净化文件夹/文件名称（移除非法字符、结尾的点和空格）"""
    s = str(name or "")
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", s)
    s = re.sub(r"[. ]+$", "", s)
    return s.strip()[:80]


def render_name(format_, series_title, vid_index, ep_title):
    """按命名模板渲染文件名，返回 名称(不含扩展名) 或 None"""
    fmt = str(format_ or "").strip()
    if not fmt:
        return None
    vars_ = {
        "series_title": str(series_title or "").strip(),
        "vid_index": str(vid_index).zfill(3),
        "ep_title": str(ep_title or "").strip(),
    }
    zh_map = {"剧名": "series_title", "集数": "vid_index", "标题": "ep_title"}
    name = re.sub(r"剧名|集数|标题", lambda m: zh_map.get(m.group(0), m.group(0)), fmt)

    def repl_tok(m):
        tok = m.group(0)
        return vars_.get(tok, tok)

    name = re.sub(r"([A-Za-z]+(?:_[A-Za-z]+)*)", repl_tok, name)
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name or None


# ===== 加载/保存下载任务 =====
def load_download_tasks():
    global download_tasks
    saved = store.get_tasks() or []
    saved.sort(key=lambda t: t.get("startTime") or 0, reverse=True)
    download_tasks = []
    for task in saved:
        t = dict(task)
        if t.get("status") in ("downloading", "pending"):
            t["status"] = "failed"
            t["error"] = "服务重启时任务中断"
        download_tasks.append(t)


_NON_SERIALIZABLE = ("cancelSource", "writer")


def save_download_tasks():
    store.save_tasks([
        {k: v for k, v in task.items() if k not in _NON_SERIALIZABLE}
        for task in download_tasks
    ])


# ===== 下载队列调度（并发 MAX_CONCURRENT_DOWNLOADS） =====
def process_download_queue():
    global active_downloads
    with queue_lock:
        if active_downloads >= MAX_CONCURRENT_DOWNLOADS or not download_queue:
            return
        task = download_queue.popleft()
        active_downloads += 1
    t = threading.Thread(target=_download_worker, args=(task,), daemon=True)
    t.start()


def _download_worker(task):
    global active_downloads
    try:
        execute_download(task)
    except Exception as e:
        print("[Download Queue] 下载失败:", e)
    finally:
        with queue_lock:
            active_downloads -= 1
        process_download_queue()


# ===== 下载分发 =====
def execute_download(task):
    if task.get("type") == "hongguo":
        execute_hongguo_download(task)
        return
    raise Exception("未知任务类型: " + str(task.get("type")))


# ===== 红果短剧下载 =====
def execute_hongguo_download(task):
    task_id = task.get("id")
    hongguo_info = task.get("hongguoInfo") or {}
    vid = hongguo_info.get("vid")
    series_title = hongguo_info.get("series_title")
    vid_index = hongguo_info.get("vid_index")
    filename = task.get("filename")

    try:
        print("[Hongguo] 开始下载《%s》第%s集:" % (series_title, vid_index), vid)
        task["status"] = "downloading"
        task["progress"] = 0
        broadcast("download-progress", {"id": task_id, "progress": 0, "receivedBytes": 0, "totalBytes": 0})

        # 1. 获取播放直链与 spade_a 加密信息
        play_info = hongguo.fetch_play_url_single(vid)
        if not play_info or not play_info.get("url"):
            raise Exception("未获取到有效播放地址")

        # 2. 下载目录
        settings = get_current_settings()
        root = str(settings.get("root") or "").strip() or DOWNLOAD_ROOT
        series_folder = sanitize_folder_name(series_title) or "未命名短剧"
        download_dir = task.get("customDir") or os.path.join(root, "红果短剧", series_folder)
        os.makedirs(download_dir, exist_ok=True)

        final_path = task.get("savePath") or os.path.join(download_dir, filename)
        task["savePath"] = final_path

        # 目标已存在且大小合格，跳过重下
        if os.path.exists(final_path) and os.path.getsize(final_path) > 1024 * 100:
            print("[Hongguo] 文件已存在，直接完成:", final_path)
            task["status"] = "completed"
            task["progress"] = 100
            task["endTime"] = int(time.time() * 1000)
            save_download_tasks()
            broadcast("download-completed", {"id": task_id, "path": final_path})
            return

        tmp_path = final_path + ".enc.tmp"

        # 3. HTTP 流式下载
        headers = {"User-Agent": hongguo.UA}
        resp = requests.get(play_info["url"], headers=headers, stream=True, timeout=(60, 300))
        if resp.status_code == 403:
            resp.close()
            headers["Referer"] = hongguo.VIDEO_REFERER
            resp = requests.get(play_info["url"], headers=headers, stream=True, timeout=(60, 300))
        if resp.status_code >= 400:
            resp.close()
            raise Exception("HTTP %d" % resp.status_code)

        total_length = int(resp.headers.get("content-length") or 0)
        task["totalBytes"] = total_length

        received = 0
        with open(tmp_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=64 * 1024):
                if task.get("cancelled"):
                    break
                if not chunk:
                    continue
                f.write(chunk)
                received += len(chunk)
                task["receivedBytes"] = received
                progress = int(received * 100 / total_length) if total_length else 0
                task["progress"] = progress
                broadcast("download-progress", {
                    "id": task_id,
                    "progress": progress,
                    "receivedBytes": received,
                    "totalBytes": total_length,
                })
        resp.close()

        if task.get("cancelled"):
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass
            task["status"] = "stopped"
            task["endTime"] = int(time.time() * 1000)
            save_download_tasks()
            broadcast("download-stopped", {"id": task_id})
            return

        # 4. CENC-AES-CTR 解密
        if play_info.get("spadeA"):
            print("[Hongguo] 正在派生 AES Key 并解密 MP4...")
            key = hongguo.derive_key(play_info["spadeA"])
            if not key:
                raise Exception("Key 派生失败")
            hongguo.decrypt_mp4_file(tmp_path, final_path, key)
            try:
                os.remove(tmp_path)
            except Exception:
                pass
        else:
            os.replace(tmp_path, final_path)

        task["status"] = "completed"
        task["progress"] = 100
        task["endTime"] = int(time.time() * 1000)
        save_download_tasks()

        print("[Hongguo] 下载完成:", final_path)
        broadcast("download-completed", {"id": task_id, "path": final_path})
    except Exception as error:
        print("[Hongguo] 下载失败:", error)
        task["status"] = "failed"
        task["error"] = str(error)
        save_download_tasks()
        broadcast("download-failed", {"id": task_id, "error": str(error)})


def delete_one_task(task_id):
    """删除单个任务（内部方法）"""
    global download_tasks, download_queue
    idx = next((i for i, t in enumerate(download_tasks) if t.get("id") == task_id), -1)
    if idx == -1:
        return
    task = download_tasks[idx]
    if task.get("status") == "downloading":
        task["cancelled"] = True
    del download_tasks[idx]
    with queue_lock:
        download_queue = deque([t for t in download_queue if t.get("id") != task_id])


# ===== 任务序列化与排序 =====
STATUS_ORDER = {
    "downloading": 0,
    "pending": 1,
    "failed": 2,
    "stopped": 3,
    "completed": 4,
}


def _cmp_tasks(a, b):
    wa = STATUS_ORDER.get(a.get("status"), 99)
    wb = STATUS_ORDER.get(b.get("status"), 99)
    if wa != wb:
        return wa - wb
    if wa <= 1:
        av = (a.get("hongguoInfo") or {}).get("vid_index") or 0
        bv = (b.get("hongguoInfo") or {}).get("vid_index") or 0
        if av != bv:
            return av - bv
        return (a.get("startTime") or 0) - (b.get("startTime") or 0)
    ae = a.get("endTime") or a.get("startTime") or 0
    be = b.get("endTime") or b.get("startTime") or 0
    return be - ae


def get_sorted_tasks():
    sorted_tasks = sorted(download_tasks, key=cmp_to_key(_cmp_tasks))
    return [
        {k: v for k, v in task.items() if k not in _NON_SERIALIZABLE}
        for task in sorted_tasks
    ]


# ===== 辅助：ID 生成 =====
_B36_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"


def _base36(n):
    if n == 0:
        return "0"
    s = ""
    while n:
        n, r = divmod(n, 36)
        s = _B36_DIGITS[r] + s
    return s


def _rand36(n):
    return "".join(random.choice(_B36_DIGITS) for _ in range(n))


# ===== API：应用信息 =====
@app.route("/api/app-info")
def api_app_info():
    return jsonify({"version": APP_VERSION, "appName": APP_NAME, "brand": APP_NAME})


# ===== API：红果解析与批量下载 =====
@app.route("/api/resolve", methods=["POST"])
def api_resolve():
    try:
        data = request.get_json(silent=True) or {}
        input_ = data.get("input")
        series_id = hongguo.resolve_series_id(input_)
        result = hongguo.fetch_episode_list(series_id)
        return jsonify({"success": True, "data": result})
    except Exception as error:
        print("[Hongguo] 解析失败:", error)
        return jsonify({"success": False, "error": str(error)})


@app.route("/api/download", methods=["POST"])
def api_download():
    try:
        data = request.get_json(silent=True) or {}
        series_id = data.get("seriesId")
        series_title = data.get("seriesTitle")
        episodes = data.get("episodes")
        if not isinstance(episodes, list) or len(episodes) == 0:
            return jsonify({"success": False, "error": "未选择集数"})

        settings = get_current_settings()
        root = str(settings.get("root") or "").strip() or DOWNLOAD_ROOT
        clean_series_title = sanitize_folder_name(series_title) or "红果短剧"
        download_dir = os.path.join(root, "红果短剧", clean_series_title)
        try:
            os.makedirs(download_dir, exist_ok=True)
        except Exception:
            pass

        batch_id = "hongguobatch_" + _base36(int(time.time() * 1000)) + _rand36(5)
        first_cover = (episodes[0] or {}).get("cover") or ""

        batch_info = {
            "batchId": batch_id,
            "platform": "hongguo",
            "nickname": "《%s》" % clean_series_title,
            "avatar": first_cover,
            "totalCount": len(episodes),
            "createTime": int(time.time() * 1000),
        }

        for ep in episodes:
            task_id = str(int(time.time() * 1000)) + _rand36(9)
            ep_index_str = str(ep.get("vid_index")).zfill(3)
            name_part = render_name(settings.get("name_format"), clean_series_title, ep.get("vid_index"), ep.get("title"))
            base_name = name_part or "%s_第%s集" % (clean_series_title, ep_index_str)
            filename = "%s.mp4" % base_name
            final_path = os.path.join(download_dir, filename)

            task = {
                "id": task_id,
                "batchId": batch_id,
                "batchInfo": batch_info,
                "savePath": final_path,
                "customDir": download_dir,
                "title": "《%s》第%s集%s" % (clean_series_title, ep_index_str, (" " + ep.get("title")) if ep.get("title") else ""),
                "filename": filename,
                "platform": "hongguo",
                "type": "hongguo",
                "status": "pending",
                "progress": 0,
                "receivedBytes": 0,
                "totalBytes": 0,
                "startTime": int(time.time() * 1000),
                "videoInfo": {
                    "author": clean_series_title,
                    "title": "《%s》第%s集" % (clean_series_title, ep_index_str),
                    "cover": ep.get("cover") or first_cover,
                    "aweme_id": ep.get("vid"),
                },
                "hongguoInfo": {
                    "vid": ep.get("vid"),
                    "series_id": series_id,
                    "series_title": clean_series_title,
                    "vid_index": ep.get("vid_index"),
                    "ep_title": ep.get("title"),
                },
            }

            with tasks_lock:
                download_tasks.insert(0, task)
            with queue_lock:
                download_queue.append(task)
            broadcast("download-task-added", task)

        save_download_tasks()
        process_download_queue()
        return jsonify({"success": True, "count": len(episodes)})
    except Exception as error:
        print("[Hongguo] 提交批量下载失败:", error)
        return jsonify({"success": False, "error": str(error)})


# ===== API：设置 =====
@app.route("/api/settings")
def api_get_settings():
    return jsonify(get_current_settings())


@app.route("/api/settings", methods=["POST"])
def api_save_settings():
    try:
        merged = dict(get_default_settings())
        merged.update(request.get_json(silent=True) or {})
        store.save_settings(merged)
        get_current_settings()  # 刷新并发数
        return jsonify({"success": True})
    except Exception as error:
        return jsonify({"success": False, "error": str(error)})


# ===== API：文件系统目录浏览 =====
@app.route("/api/fs/list")
def api_fs_list():
    try:
        target = str(request.args.get("path") or "").strip() or "/"
        try:
            resolved = os.path.abspath(target)
        except Exception:
            return jsonify({"success": False, "error": "路径无效"})
        try:
            if not os.path.isdir(resolved):
                return jsonify({"success": False, "error": "不是目录"})
        except Exception:
            return jsonify({"success": False, "error": "路径不存在"})

        dirs = []
        for name in os.listdir(resolved):
            if name.startswith("."):
                continue
            full = os.path.join(resolved, name)
            if os.path.isdir(full):
                dirs.append({"name": name, "path": full})
        dirs.sort(key=lambda d: d["name"])

        parent = os.path.dirname(resolved)
        return jsonify({
            "success": True,
            "path": resolved,
            "parent": None if parent == resolved else parent,
            "dirs": dirs,
        })
    except Exception as error:
        return jsonify({"success": False, "error": str(error)})


# ===== API：下载管理 =====
@app.route("/api/tasks")
def api_get_tasks():
    return jsonify(get_sorted_tasks())


@app.route("/api/tasks/retry", methods=["POST"])
def api_retry_tasks():
    data = request.get_json(silent=True) or {}
    ids = data.get("ids")
    if not isinstance(ids, list) or len(ids) == 0:
        return jsonify({"success": False, "error": "没有要重试的任务"})
    count = 0
    for task_id in ids:
        task = next((t for t in download_tasks if t.get("id") == task_id), None)
        if task and task.get("status") in ("failed", "stopped"):
            if task.get("savePath") and os.path.exists(task["savePath"]):
                try:
                    os.remove(task["savePath"])
                except Exception:
                    pass
            task["status"] = "pending"
            task["progress"] = 0
            task["receivedBytes"] = 0
            task["totalBytes"] = 0
            task["cancelled"] = False
            task.pop("error", None)
            with queue_lock:
                if not any(t.get("id") == task_id for t in download_queue):
                    download_queue.append(task)
            count += 1
    if count > 0:
        save_download_tasks()
        process_download_queue()
    return jsonify({"success": True, "count": count})


@app.route("/api/tasks", methods=["DELETE"])
def api_delete_tasks():
    data = request.get_json(silent=True) or {}
    ids = data.get("ids")
    if not isinstance(ids, list) or len(ids) == 0:
        return jsonify({"success": False, "error": "没有要删除的任务"})
    for id_ in ids:
        delete_one_task(id_)
    save_download_tasks()
    return jsonify({"success": True, "count": len(ids)})


@app.route("/api/tasks/<task_id>", methods=["DELETE"])
def api_delete_task(task_id):
    idx = next((i for i, t in enumerate(download_tasks) if t.get("id") == task_id), -1)
    if idx == -1:
        return jsonify({"success": False, "error": "任务不存在"})
    delete_one_task(task_id)
    save_download_tasks()
    return jsonify({"success": True})


@app.route("/api/tasks/<task_id>/stop", methods=["POST"])
def api_stop_task(task_id):
    task = next((t for t in download_tasks if t.get("id") == task_id), None)
    if not task:
        return jsonify({"success": False, "error": "任务不存在"})

    task["cancelled"] = True
    task["status"] = "stopped"
    task["error"] = ""
    task["endTime"] = int(time.time() * 1000)

    save_download_tasks()
    broadcast("download-stopped", {"id": task_id, "path": task.get("savePath")})
    return jsonify({"success": True})


@app.route("/api/tasks/<task_id>/retry", methods=["POST"])
def api_retry_task(task_id):
    task = next((t for t in download_tasks if t.get("id") == task_id), None)
    if not task:
        return jsonify({"success": False, "error": "任务不存在"})

    if task.get("savePath") and os.path.exists(task["savePath"]):
        try:
            os.remove(task["savePath"])
        except Exception:
            pass

    task["status"] = "pending"
    task["progress"] = 0
    task["receivedBytes"] = 0
    task["totalBytes"] = 0
    task["cancelled"] = False
    task.pop("error", None)

    with queue_lock:
        if not any(t.get("id") == task_id for t in download_queue):
            download_queue.append(task)
    save_download_tasks()
    process_download_queue()
    return jsonify({"success": True})


# ===== API：SSE 实时事件 =====
@app.route("/api/events")
def api_events():
    q = queue_mod.Queue()
    with sse_lock:
        sse_clients.add(q)

    def gen():
        try:
            yield "retry: 3000\n\n"
            while True:
                try:
                    frame = q.get(timeout=20)
                    yield frame
                except queue_mod.Empty:
                    yield ": keepalive\n\n"
        finally:
            with sse_lock:
                sse_clients.discard(q)

    return Response(
        stream_with_context(gen()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ===== 静态资源与 SPA 回退 =====
DIST_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist-react")


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def spa(path):
    if path.startswith("api/"):
        return jsonify({"success": False, "error": "接口不存在"}), 404
    full = os.path.join(DIST_DIR, path)
    if path and os.path.isfile(full):
        return send_from_directory(DIST_DIR, path)
    return send_from_directory(DIST_DIR, "index.html")


# ===== 启动 =====
def main():
    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
    os.makedirs(DOWNLOAD_ROOT, exist_ok=True)
    store.init(DATA_FILE)
    load_download_tasks()
    get_current_settings()

    try:
        from waitress import serve
    except ImportError:
        print("[Server] 未安装 waitress，回退到 Flask 内置服务器（仅用于开发）")
        app.run(host="0.0.0.0", port=PORT, threaded=True)
        return

    print("[Server] %s 已启动: http://localhost:%d" % (APP_NAME, PORT), flush=True)
    print("[Server] 下载目录: %s" % DOWNLOAD_ROOT, flush=True)
    print("[Server] 数据文件: %s" % DATA_FILE, flush=True)
    serve(app, host="0.0.0.0", port=PORT, threads=16)


if __name__ == "__main__":
    main()
