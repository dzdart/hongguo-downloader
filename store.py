"""
store.py - 精简持久化模块（Python 版）

用单个 JSON 文件保存「设置」与「下载任务」，减少依赖，方便 Web/Docker 部署。
对应原 Node 实现：src/store.js
"""
import json
import os

data_file = None
cache = None


def _load_cache():
    global cache
    if not data_file:
        raise Exception("store 未初始化")
    if cache is not None:
        return cache
    try:
        if os.path.exists(data_file):
            with open(data_file, "r", encoding="utf-8") as f:
                cache = json.load(f)
    except Exception as e:
        print("[Store] 读取数据文件失败，使用空数据:", e)
    if not isinstance(cache, dict):
        cache = {}
    if not isinstance(cache.get("tasks"), list):
        cache["tasks"] = []
    if not isinstance(cache.get("settings"), dict):
        cache["settings"] = {}
    return cache


def _flush():
    if not data_file:
        return
    try:
        os.makedirs(os.path.dirname(data_file), exist_ok=True)
        with open(data_file, "w", encoding="utf-8") as f:
            json.dump(cache or {}, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print("[Store] 写入数据文件失败:", e)


def init(file_path):
    global data_file
    data_file = file_path
    _load_cache()


def get_settings():
    return _load_cache().get("settings")


def save_settings(settings):
    _load_cache()["settings"] = settings or {}
    _flush()


def get_tasks():
    return _load_cache().get("tasks")


def save_tasks(tasks):
    _load_cache()["tasks"] = tasks or []
    _flush()
