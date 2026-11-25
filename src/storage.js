/**
 * storage.js — 持久化后端，支持 extension_settings（ST 服务端）和 localStorage 两种方案
 *
 * 设计不变量：
 * 1. 记忆库主数据使用 `chat_<vaultId>` 前缀，聊天原文快照使用 `chat_snapshot_<vaultId>`，
 *    记忆库快照使用 `db_snapshot_<vaultId>`，元数据索引使用 `vault_meta`。
 * 2. 任何遍历记忆库的操作必须使用 isMemoryChatKey()，严格排除 `chat_snapshot_` 前缀，
 *    避免将快照对象误当作记忆数组导出/导入。
 */

export const StorageBackend = Object.freeze({ EXT: 'ext', LOCAL: 'local' });

const SETTINGS_KEY = 'memory_vault';

let _backend = StorageBackend.EXT;

export function setBackend(b) { _backend = b; }
export function getBackend()  { return _backend; }

// ─── ST 1.19+ 兼容的设置落盘函数 ──────────────────────────────────────────

function persistExtSettings(ctx) {
    try {
        if (typeof ctx?.saveSettingsDebounced === 'function') {
            ctx.saveSettingsDebounced();
            return;
        }
    } catch {}
    if (typeof window !== 'undefined' && typeof window.saveSettingsDebounced === 'function') {
        window.saveSettingsDebounced();
    } else if (typeof saveSettingsDebounced === 'function') {
        saveSettingsDebounced();
    }
}

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
        if (!ctx?.extensionSettings) return false;
        if (!ctx.extensionSettings[SETTINGS_KEY]) ctx.extensionSettings[SETTINGS_KEY] = {};
        ctx.extensionSettings[SETTINGS_KEY][key] = value;
        persistExtSettings(ctx);
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
            persistExtSettings(ctx);
        }
        return true;
    } catch { return false; }
}

function localDelete(key) {
    try { localStorage.removeItem('mv_' + key); return true; }
    catch { return false; }
}

export function mvDelete(key) {
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

export function chatKey(vaultId)         { return `chat_${vaultId}`; }
export function chatSnapshotKey(vaultId) { return `chat_snapshot_${vaultId}`; }
export function dbSnapshotKey(vaultId)   { return `db_snapshot_${vaultId}`; }
export const SETTINGS_STORE_KEY = 'settings';
export const VAULT_META_KEY     = 'vault_meta';

/**
 * 判断 key 是否为真正的聊天记忆库 key（严格排除 chat_snapshot_）
 */
export function isMemoryChatKey(key) {
    return typeof key === 'string'
        && key.startsWith('chat_')
        && !key.startsWith('chat_snapshot_');
}

export function extractVaultIdFromKey(key) {
    return isMemoryChatKey(key) ? key.slice('chat_'.length) : null;
}

// ─── 记忆库元数据索引（用于前端展示原聊天名、角色名、更新时间） ──────────

export function readAllVaultMeta() {
    const meta = mvRead(VAULT_META_KEY);
    return (meta && typeof meta === 'object' && !Array.isArray(meta)) ? meta : {};
}

export function updateVaultMeta(vaultId, patch) {
    if (!vaultId) return;
    const all = readAllVaultMeta();
    all[vaultId] = {
        ...(all[vaultId] || {}),
        ...patch,
        updatedAt: Date.now(),
    };
    mvWrite(VAULT_META_KEY, all);
}

export function removeVaultMeta(vaultId) {
    if (!vaultId) return;
    const all = readAllVaultMeta();
    if (Object.prototype.hasOwnProperty.call(all, vaultId)) {
        delete all[vaultId];
        mvWrite(VAULT_META_KEY, all);
    }
}

// ─── 枚举所有历史记忆库 ──────────────────────────────────────────────────

function getRawStoreEntries(backend) {
    const entries = {};
    if (backend === StorageBackend.EXT) {
        try {
            const ctx = SillyTavern.getContext();
            const store = ctx?.extensionSettings?.[SETTINGS_KEY] ?? {};
            for (const [k, v] of Object.entries(store)) {
                if (isMemoryChatKey(k) && Array.isArray(v)) {
                    entries[k] = v;
                }
            }
        } catch {}
    } else {
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const raw = localStorage.key(i);
                if (raw && raw.startsWith('mv_')) {
                    const k = raw.slice(3);
                    if (isMemoryChatKey(k)) {
                        try {
                            const parsed = JSON.parse(localStorage.getItem(raw));
                            if (Array.isArray(parsed)) entries[k] = parsed;
                        } catch {}
                    }
                }
            }
        } catch {}
    }
    return entries;
}

/**
 * 在 EXT 与 LOCAL 两个存储后端之间一键迁移所有记忆库与元数据（合并去重，不覆盖已有数据）
 */
export function migrateBackendData(fromBackend, toBackend) {
    if (!fromBackend || !toBackend || fromBackend === toBackend) {
        return { vaultCount: 0, entryCount: 0 };
    }
    const srcEntries = getRawStoreEntries(fromBackend);
    const readTarget  = (k) => (toBackend === StorageBackend.EXT ? extRead(k) : localRead(k));
    const writeTarget = (k, v) => (toBackend === StorageBackend.EXT ? extWrite(k, v) : localWrite(k, v));
    const readSrc     = (k) => (fromBackend === StorageBackend.EXT ? extRead(k) : localRead(k));

    let vaultCount = 0;
    let entryCount = 0;

    for (const [k, srcList] of Object.entries(srcEntries)) {
        if (!Array.isArray(srcList) || !srcList.length) continue;
        const dstList = readTarget(k);
        const merged = Array.isArray(dstList) ? [...dstList] : [];
        const ids = new Set(merged.map(e => e.id));
        let addedHere = 0;
        for (const item of srcList) {
            if (!ids.has(item.id)) {
                merged.push(item);
                ids.add(item.id);
                addedHere++;
            }
        }
        if (addedHere > 0) {
            writeTarget(k, merged);
            vaultCount++;
            entryCount += addedHere;
        }
    }

    // 同步合并 vault_meta
    const srcMeta = readSrc(VAULT_META_KEY);
    if (srcMeta && typeof srcMeta === 'object' && !Array.isArray(srcMeta)) {
        const dstMeta = readTarget(VAULT_META_KEY);
        const mergedMeta = {
            ...srcMeta,
            ...(dstMeta && typeof dstMeta === 'object' && !Array.isArray(dstMeta) ? dstMeta : {}),
        };
        writeTarget(VAULT_META_KEY, mergedMeta);
    }

    return { vaultCount, entryCount };
}

/**
 * 列出当前存储后端下的所有历史记忆库
 */
export function listAllVaults(activeVaultId = null) {
    const entries = getRawStoreEntries(_backend);
    const metaMap = readAllVaultMeta();
    const list = [];

    for (const [k, memories] of Object.entries(entries)) {
        const vaultId = extractVaultIdFromKey(k);
        if (!vaultId) continue;
        if (!memories.length && vaultId !== activeVaultId) continue;

        const meta = metaMap[vaultId] || {};
        const validMemories = memories.filter(e => !e.sourceDeleted);
        const latest = memories.length
            ? memories.reduce((a, b) => ((b.timestamp || 0) > (a.timestamp || 0) ? b : a), memories[0])
            : null;

        list.push({
            vaultId,
            key: k,
            chatName: meta.chatName || vaultId,
            charName: meta.charName || '',
            totalCount: memories.length,
            activeCount: validMemories.length,
            updatedAt: meta.updatedAt || latest?.timestamp || 0,
            latestDate: latest?.date || '',
            preview: latest?.content ? String(latest.content).split('\n')[0].slice(0, 80) : '',
            isCurrent: vaultId === activeVaultId,
        });
    }

    list.sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    return list;
}

/**
 * 彻底删除某个记忆库（包含其快照与元数据）
 */
export function deleteVault(vaultId) {
    if (!vaultId) return false;
    mvDelete(chatKey(vaultId));
    mvDelete(chatSnapshotKey(vaultId));
    mvDelete(dbSnapshotKey(vaultId));
    removeVaultMeta(vaultId);
    return true;
}

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

// ─── 全量导出 / 按 vaultId 导出 ───────────────────────────────────────────

export function exportAll() {
    const dump = {};
    try {
        const ctx = SillyTavern.getContext();
        const store = ctx?.extensionSettings?.[SETTINGS_KEY] ?? {};
        for (const [k, v] of Object.entries(store)) {
            if (isMemoryChatKey(k) && Array.isArray(v)) dump[k] = v;
        }
        for (let i = 0; i < localStorage.length; i++) {
            const raw = localStorage.key(i);
            if (raw && raw.startsWith('mv_')) {
                const k = raw.slice(3);
                if (isMemoryChatKey(k) && !dump[k]) {
                    try {
                        const parsed = JSON.parse(localStorage.getItem(raw));
                        if (Array.isArray(parsed)) dump[k] = parsed;
                    } catch {}
                }
            }
        }
    } catch {}
    return dump;
}

export function exportChat(vaultId) {
    const k = chatKey(vaultId);
    const data = mvRead(k);
    return Array.isArray(data) ? { [k]: data } : {};
}

export function importData(dump, mode) {
    if (!dump || typeof dump !== 'object' || Array.isArray(dump)) {
        return { success: false, error: '导入数据格式错误：不是有效的 JSON 对象' };
    }

    const chatKeys = Object.keys(dump).filter(k => isMemoryChatKey(k));
    if (!chatKeys.length) {
        return { success: false, error: '导入数据中未找到任何聊天记忆（需要 chat_ 开头的记忆数组）' };
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
    return { success: true, error: null, importedKeys: chatKeys };
}