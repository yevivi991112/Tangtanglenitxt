/**
 * storage.js — 持久化后端，支持 extension_settings（ST 服务端）和 localStorage 两种方案
 */

export const StorageBackend = Object.freeze({ EXT: 'ext', LOCAL: 'local' });

const SETTINGS_KEY = 'memory_vault';

let _backend = StorageBackend.EXT;

export function setBackend(b) { _backend = b; }
export function getBackend()  { return _backend; }

// ─── 底层读写 ──────────────────────────────────────────────────────────────

function extRead(key) {
    try {
        const ctx = SillyTavern.getContext();
        const store = ctx?.extensionSettings?.[SETTINGS_KEY];
        return (store && Object.prototype.hasOwnProperty.call(store, key)) ? store[key] : null;
    } catch { return null; }
}

function extWrite(key, value) {
    try {
        const ctx = SillyTavern.getContext();
        if (!ctx.extensionSettings) return false;
        if (!ctx.extensionSettings[SETTINGS_KEY]) ctx.extensionSettings[SETTINGS_KEY] = {};
        ctx.extensionSettings[SETTINGS_KEY][key] = value;
        // saveSettingsDebounced is a ST global, not on context
        if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
        return true;
    } catch { return false; }
}

function localRead(key) {
    try { const v = localStorage.getItem('mv_' + key); return v !== null ? JSON.parse(v) : null; }
    catch { return null; }
}

function localWrite(key, value) {
    try { localStorage.setItem('mv_' + key, JSON.stringify(value)); return true; }
    catch { return false; }
}

function extDelete(key) {
    try {
        const ctx = SillyTavern.getContext();
        const store = ctx?.extensionSettings?.[SETTINGS_KEY];
        if (store && Object.prototype.hasOwnProperty.call(store, key)) {
            delete store[key];
        }
        return true;
    } catch { return false; }
}

function localDelete(key) {
    try { localStorage.removeItem('mv_' + key); return true; }
    catch { return false; }
}

function mvDelete(key) {
    return _backend === StorageBackend.EXT ? extDelete(key) : localDelete(key);
}

// ─── 公开 API ──────────────────────────────────────────────────────────────

export function mvRead(key) {
    return _backend === StorageBackend.EXT ? extRead(key) : localRead(key);
}

export function mvWrite(key, value) {
    return _backend === StorageBackend.EXT ? extWrite(key, value) : localWrite(key, value);
}

// ─── Key 工具 ──────────────────────────────────────────────────────────────

export function chatKey(chatId)        { return `chat_${chatId}`; }
export function chatSnapshotKey(chatId){ return `chat_snapshot_${chatId}`; }
export function dbSnapshotKey(chatId)  { return `db_snapshot_${chatId}`; }
export const SETTINGS_STORE_KEY = 'settings';

// ─── 测试可写性 ───────────────────────────────────────────────────────────

export async function testBackend(backend) {
    const probe = '__mv_probe__';
    const prev = _backend;
    _backend = backend;
    const ok = mvWrite(probe, 1) && mvRead(probe) === 1;
    mvDelete(probe);
    _backend = prev;
    return ok;
}

// ─── 全量导出 / 按 chatId 导出 ────────────────────────────────────────────

export function exportAll() {
    const dump = {};
    try {
        const ctx = SillyTavern.getContext();
        const store = ctx.extensionSettings?.[SETTINGS_KEY] ?? {};
        for (const [k, v] of Object.entries(store)) {
            if (k.startsWith('chat_')) dump[k] = v;
        }
        // 兜底：localStorage 里的也一起导出
        for (let i = 0; i < localStorage.length; i++) {
            const raw = localStorage.key(i);
            if (raw && raw.startsWith('mv_chat_')) {
                const k = raw.slice(3); // 去掉 'mv_' 前缀
                if (!dump[k]) {
                    try { dump[k] = JSON.parse(localStorage.getItem(raw)); } catch {}
                }
            }
        }
    } catch {}
    return dump;
}

export function exportChat(chatId) {
    const k = chatKey(chatId);
    const data = mvRead(k);
    return data ? { [k]: data } : {};
}

export function importData(dump, mode) {
    if (!dump || typeof dump !== 'object') {
        return { success: false, error: '导入数据格式错误：不是有效的 JSON 对象' };
    }

    const chatKeys = Object.keys(dump).filter(k => k.startsWith('chat_'));
    if (!chatKeys.length) {
        return { success: false, error: '导入数据中未找到任何聊天记忆（需要 chat_ 开头的 key）' };
    }

    for (const k of chatKeys) {
        const v = dump[k];
        if (!Array.isArray(v)) {
            return { success: false, error: `数据损坏：${k} 不是数组格式` };
        }
        for (let i = 0; i < v.length; i++) {
            const entry = v[i];
            if (!entry || typeof entry !== 'object' || !entry.id || typeof entry.content === 'undefined') {
                return { success: false, error: `数据损坏：${k} 中第 ${i + 1} 条记忆缺少必要字段（id/content）` };
            }
        }
    }

    for (const k of chatKeys) {
        const v = dump[k];
        if (mode === 'overwrite') {
            mvWrite(k, v);
        } else {
            const existing = mvRead(k) ?? [];
            const merged = [...existing];
            const ids = new Set(existing.map(e => e.id));
            for (const entry of v) {
                if (!ids.has(entry.id)) { merged.push(entry); ids.add(entry.id); }
            }
            mvWrite(k, merged);
        }
    }
    return { success: true, error: null };
}
