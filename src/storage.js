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
    mvWrite(probe, undefined); // 清理
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
    // mode: 'merge' | 'overwrite'
    for (const [k, v] of Object.entries(dump)) {
        if (!k.startsWith('chat_')) continue;
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
}
