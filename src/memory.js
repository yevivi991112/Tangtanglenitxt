/**
 * memory.js — 记忆条目 CRUD、快照、还原、多分区捕获、楼层排序、以及基于 chatMetadata 的防丢绑定
 *
 * 设计不变量：
 * 1. 每个聊天在 ST 的 chatMetadata.memory_vault 中持久化 { vaultId, lastChatId }：
 *    - 酒馆内重命名（CHAT_RENAMED）无缝沿用原库；
 *    - 创建分支（Branch）自动复制一份独立记忆库，互不串戏。
 * 2. 统一按楼层顺序（linkedMessageId 升序）排列：
 *    - 「最近 N 条」严格按楼层顺序排序，无楼层手动记忆排在最后；
 *    - 「置顶区块」未手动设序号时默认按楼层顺序排，拖动或点 ↑/↓ 时规范化为连续 pinnedOrder。
 * 3. 多分区支持：每条记忆通过 zoneId 归属到自定义分区（缺省归入首个分区，100% 兼容老数据），
 *    单次扫描可同时捕获多个分区的自定义标签块，支持按分区配置「捕获时默认置顶」。
 */

import {
    mvRead, mvWrite,
    chatKey, chatSnapshotKey, dbSnapshotKey,
    updateVaultMeta,
} from './storage.js';

const CHAT_META_FIELD = 'memory_vault';

export const DEFAULT_ZONES = [
    { id: 'default', name: '记忆', tag: 'Lenitxt', defaultPinned: false },
];

// ─── 分区工具 ─────────────────────────────────────────────────────────────

export function normalizeZones(zones) {
    if (!Array.isArray(zones) || !zones.length) {
        return DEFAULT_ZONES.map(z => ({ ...z }));
    }
    const valid = zones
        .filter(z => z && typeof z === 'object' && z.id && String(z.tag || '').trim())
        .map(z => ({
            id: String(z.id),
            name: String(z.name || z.tag).trim() || '未命名分区',
            tag: String(z.tag).trim(),
            defaultPinned: Boolean(z.defaultPinned),
        }));
    return valid.length ? valid : DEFAULT_ZONES.map(z => ({ ...z }));
}

export function getEntryZoneId(entry, zones = DEFAULT_ZONES) {
    const list = normalizeZones(zones);
    if (entry?.zoneId && list.some(z => z.id === entry.zoneId)) {
        return entry.zoneId;
    }
    return list[0].id;
}

export function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function hasAnyZoneTag(mesText, zones = DEFAULT_ZONES) {
    if (!mesText) return false;
    const list = normalizeZones(zones);
    return list.some(z => {
        const re = new RegExp(`<${escapeRegex(z.tag)}>`, 'i');
        return re.test(mesText);
    });
}

// ─── 统一楼层比较器（linkedMessageId 升序，无楼层排最后） ─────────────────

export function compareByFloor(a, b) {
    const hasA = a.linkedMessageId !== null && a.linkedMessageId !== undefined;
    const hasB = b.linkedMessageId !== null && b.linkedMessageId !== undefined;
    if (hasA && hasB) {
        if (a.linkedMessageId !== b.linkedMessageId) return a.linkedMessageId - b.linkedMessageId;
        const ba = a.originalBlockIndex ?? 0;
        const bb = b.originalBlockIndex ?? 0;
        if (ba !== bb) return ba - bb;
    } else if (hasA !== hasB) {
        return hasA ? -1 : 1;
    }
    return (a.timestamp || 0) - (b.timestamp || 0);
}

// ─── ID 生成 ───────────────────────────────────────────────────────────────

function genId() {
    return Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

export function genVaultId(prefix = 'v') {
    const safePrefix = String(prefix || 'v').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_').slice(0, 24);
    return `${safePrefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// ─── 读取当前聊天 ID & 角色名（兼容 ST 1.19+） ────────────────────────────

export function getCurrentChatId() {
    try {
        const ctx = SillyTavern.getContext();
        if (!ctx) return null;
        if (typeof ctx.getCurrentChatId === 'function') {
            const id = ctx.getCurrentChatId();
            if (id) return String(id);
        }
        if (ctx.groupId) {
            const group = ctx.groups?.find?.(g => String(g.id) === String(ctx.groupId));
            if (group?.chat_id) return String(group.chat_id);
            return 'group_' + ctx.groupId;
        }
        if (ctx.characters && typeof ctx.characterId === 'number' && ctx.characterId >= 0) {
            const char = ctx.characters[ctx.characterId];
            if (char?.chat) return String(char.chat);
        }
        if (ctx.chatId) return String(ctx.chatId);
    } catch {}
    return null;
}

export function getCurrentCharName() {
    try {
        const ctx = SillyTavern.getContext();
        if (!ctx) return '';
        if (ctx.groupId) {
            const group = ctx.groups?.find?.(g => String(g.id) === String(ctx.groupId));
            return group?.name ? `[群] ${group.name}` : `群聊 ${ctx.groupId}`;
        }
        if (ctx.characters && typeof ctx.characterId === 'number' && ctx.characterId >= 0) {
            return ctx.characters[ctx.characterId]?.name || '';
        }
    } catch {}
    return '';
}

function getLegacyGroupVaultId() {
    try {
        const ctx = SillyTavern.getContext();
        if (ctx?.groupId) return 'group_' + ctx.groupId;
    } catch {}
    return null;
}

// ─── chatMetadata 持久化（跟随 .jsonl 文件头） ────────────────────────────

function readChatVaultMeta() {
    try {
        const ctx = SillyTavern.getContext();
        const m = ctx?.chatMetadata?.[CHAT_META_FIELD];
        return (m && typeof m === 'object' && m.vaultId) ? m : null;
    } catch { return null; }
}

export function writeChatVaultMeta(vaultId, chatId) {
    try {
        const ctx = SillyTavern.getContext();
        if (!ctx?.chatMetadata) return false;
        ctx.chatMetadata[CHAT_META_FIELD] = {
            vaultId: String(vaultId),
            lastChatId: chatId ? String(chatId) : null,
            boundAt: Date.now(),
        };
        if (typeof ctx.saveMetadataDebounced === 'function') {
            ctx.saveMetadataDebounced();
        } else if (typeof ctx.saveMetadata === 'function') {
            Promise.resolve(ctx.saveMetadata()).catch(() => {});
        }
        return true;
    } catch { return false; }
}

export function resolveActiveVault(recentRename = null) {
    const currentChatId = getCurrentChatId();
    if (!currentChatId) return { vaultId: null, chatId: null, action: 'none' };

    const charName = getCurrentCharName();
    const meta = readChatVaultMeta();

    const isRecentRename = Boolean(
        recentRename
        && recentRename.newFileName === currentChatId
        && (Date.now() - (recentRename.ts || 0) < 15000)
    );

    if (meta?.vaultId) {
        const metaVaultId = String(meta.vaultId);
        const lastChatId = meta.lastChatId ? String(meta.lastChatId) : null;

        if (!lastChatId || lastChatId === currentChatId || (isRecentRename && recentRename.oldFileName === lastChatId)) {
            if (lastChatId !== currentChatId) {
                writeChatVaultMeta(metaVaultId, currentChatId);
            }
            updateVaultMeta(metaVaultId, { chatName: currentChatId, charName });
            return {
                vaultId: metaVaultId,
                chatId: currentChatId,
                action: lastChatId && lastChatId !== currentChatId ? 'renamed' : 'existing',
            };
        }

        const srcMemories = loadMemories(metaVaultId);
        const newVaultId = genVaultId('branch');
        const copiedCount = srcMemories.length ? cloneMemoriesToNewVault(metaVaultId, newVaultId) : 0;
        writeChatVaultMeta(newVaultId, currentChatId);
        updateVaultMeta(newVaultId, { chatName: currentChatId, charName });
        return {
            vaultId: newVaultId,
            chatId: currentChatId,
            action: 'branched',
            copiedCount,
        };
    }

    if (isRecentRename && recentRename.oldFileName) {
        const oldVaultId = String(recentRename.oldFileName);
        const oldMemories = loadMemories(oldVaultId);
        if (oldMemories.length > 0) {
            writeChatVaultMeta(oldVaultId, currentChatId);
            updateVaultMeta(oldVaultId, { chatName: currentChatId, charName });
            return { vaultId: oldVaultId, chatId: currentChatId, action: 'renamed' };
        }
    }

    const directMemories = loadMemories(currentChatId);
    if (directMemories.length > 0) {
        writeChatVaultMeta(currentChatId, currentChatId);
        updateVaultMeta(currentChatId, { chatName: currentChatId, charName });
        return { vaultId: currentChatId, chatId: currentChatId, action: 'existing' };
    }

    const legacyGroupId = getLegacyGroupVaultId();
    if (legacyGroupId && legacyGroupId !== currentChatId) {
        const legacyMemories = loadMemories(legacyGroupId);
        if (legacyMemories.length > 0) {
            writeChatVaultMeta(legacyGroupId, currentChatId);
            updateVaultMeta(legacyGroupId, { chatName: currentChatId, charName });
            return { vaultId: legacyGroupId, chatId: currentChatId, action: 'existing' };
        }
    }

    return { vaultId: currentChatId, chatId: currentChatId, action: 'new' };
}

export function bindCurrentChatToVault(targetVaultId) {
    const currentChatId = getCurrentChatId();
    if (!currentChatId || !targetVaultId) return false;
    const charName = getCurrentCharName();
    writeChatVaultMeta(targetVaultId, currentChatId);
    updateVaultMeta(targetVaultId, { chatName: currentChatId, charName });
    return true;
}

export function mergeVaultInto(fromVaultId, toVaultId) {
    if (!fromVaultId || !toVaultId || fromVaultId === toVaultId) return 0;
    const source = loadMemories(fromVaultId);
    if (!source.length) return 0;
    const existing = loadMemories(toVaultId);
    const merged = [...existing];
    let added = 0;

    for (const entry of source) {
        const dup = merged.some(e =>
            e.id === entry.id
            || (e.content === entry.content && e.date === entry.date && e.linkedMessageId === entry.linkedMessageId)
        );
        if (!dup) {
            merged.push({ ...entry, id: genId() });
            added++;
        }
    }
    if (added > 0) {
        saveMemories(toVaultId, merged);
    }
    return added;
}

// ─── 主库读写 ─────────────────────────────────────────────────────────────

export function loadMemories(vaultId) {
    if (!vaultId) return [];
    const data = mvRead(chatKey(vaultId));
    return Array.isArray(data) ? data : [];
}

export function saveMemories(vaultId, list) {
    if (!vaultId) return;
    mvWrite(chatKey(vaultId), list);
    const currentChatId = getCurrentChatId();
    const charName = getCurrentCharName();
    const meta = readChatVaultMeta();
    if (currentChatId && (!meta || meta.vaultId !== vaultId || meta.lastChatId !== currentChatId)) {
        writeChatVaultMeta(vaultId, currentChatId);
    }
    updateVaultMeta(vaultId, {
        chatName: currentChatId || vaultId,
        charName,
    });
}

// ─── 快照 ─────────────────────────────────────────────────────────────────

export function saveDbSnapshot(vaultId) {
    const current = loadMemories(vaultId);
    mvWrite(dbSnapshotKey(vaultId), JSON.parse(JSON.stringify(current)));
}

export function restoreDbSnapshot(vaultId) {
    const snap = mvRead(dbSnapshotKey(vaultId));
    if (snap === null) return false;
    saveMemories(vaultId, snap);
    return true;
}

export function saveChatSnapshot(vaultId, changedMsgs, mergeExisting = true) {
    if (!vaultId || !changedMsgs || !Object.keys(changedMsgs).length) return;
    if (mergeExisting) {
        const prev = getChatSnapshot(vaultId);
        const merged = { ...changedMsgs, ...prev };
        mvWrite(chatSnapshotKey(vaultId), merged);
    } else {
        mvWrite(chatSnapshotKey(vaultId), changedMsgs);
    }
}

export function getChatSnapshot(vaultId) {
    return mvRead(chatSnapshotKey(vaultId)) ?? {};
}

// ─── 解析 AI 填写格式 ─────────────────────────────────────────────────────
// 格式: 2024-05-17|标签1,标签2|0.8|内容文字

export function parseAiFormat(text) {
    const parts = text.split('|');
    if (parts.length < 4) return null;
    const date       = parts[0].trim();
    const tagStr     = parts[1].trim();
    const importance = parseFloat(parts[2].trim());
    const content    = parts.slice(3).join('|').trim();
    if (!content) return null;
    return {
        date:       /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date().toISOString().slice(0, 10),
        tags:       tagStr ? tagStr.split(/[,，\s]+/).map(t => t.trim()).filter(Boolean) : [],
        importance: isNaN(importance) ? 0.5 : Math.min(1, Math.max(0, importance)),
        content,
    };
}

// ─── 从消息文本提取单个或多分区标签块 ─────────────────────────────────────

export function extractBlocks(mesText, tagName = 'Lenitxt') {
    const blocks = [];
    const safeTag = escapeRegex(tagName);
    const re = new RegExp(`<${safeTag}>([\\s\\S]*?)<\\/${safeTag}>`, 'gi');
    let m, idx = 0;
    while ((m = re.exec(mesText || '')) !== null) {
        blocks.push({
            originalText:   m[0],
            innerText:      m[1].trim(),
            startPos:       m.index,
            blockIndex:     idx++,
            tag:            tagName,
        });
    }
    return blocks;
}

/**
 * 一次性提取消息中所有配置分区的标签块，按出现位置 startPos 升序返回
 */
export function extractBlocksForZones(mesText, zones = DEFAULT_ZONES) {
    const list = normalizeZones(zones);
    const all = [];
    for (const zone of list) {
        const safeTag = escapeRegex(zone.tag);
        const re = new RegExp(`<${safeTag}>([\\s\\S]*?)<\\/${safeTag}>`, 'gi');
        let m, idx = 0;
        while ((m = re.exec(mesText || '')) !== null) {
            all.push({
                originalText:  m[0],
                innerText:     m[1].trim(),
                startPos:      m.index,
                blockIndex:    idx++,
                zoneId:        zone.id,
                zoneName:      zone.name,
                tag:           zone.tag,
                defaultPinned: Boolean(zone.defaultPinned),
            });
        }
    }
    all.sort((a, b) => a.startPos - b.startPos);
    return all;
}

// ─── 写入一条新记忆 ───────────────────────────────────────────────────────

export function addMemory(vaultId, fields) {
    const list = loadMemories(vaultId);
    const entry = {
        id:                 genId(),
        content:            fields.content ?? '',
        tags:               fields.tags ?? [],
        importance:         fields.importance ?? 0.5,
        date:               fields.date ?? new Date().toISOString().slice(0, 10),
        timestamp:          fields.timestamp ?? Date.now(),
        source:             fields.source ?? 'manual',
        zoneId:             fields.zoneId ?? 'default',
        pinned:             Boolean(fields.pinned),
        pinnedOrder:        fields.pinnedOrder ?? null,
        linkedMessageId:    fields.linkedMessageId ?? null,
        originalBlockIndex: fields.originalBlockIndex ?? null,
        originalText:       fields.originalText ?? null,
        sourceDeleted:      Boolean(fields.sourceDeleted),
    };
    list.push(entry);
    saveMemories(vaultId, list);
    return entry;
}

export function addMemoryAtFloor(vaultId, fields) {
    const list = loadMemories(vaultId);
    const entry = {
        id:                 fields.id || genId(),
        content:            fields.content ?? '',
        tags:               fields.tags ?? [],
        importance:         fields.importance ?? 0.5,
        date:               fields.date ?? new Date().toISOString().slice(0, 10),
        timestamp:          fields.timestamp ?? Date.now(),
        source:             fields.source ?? 'manual',
        zoneId:             fields.zoneId ?? 'default',
        pinned:             Boolean(fields.pinned),
        pinnedOrder:        fields.pinnedOrder ?? null,
        linkedMessageId:    fields.linkedMessageId ?? null,
        originalBlockIndex: fields.originalBlockIndex ?? null,
        originalText:       fields.originalText ?? null,
        sourceDeleted:      Boolean(fields.sourceDeleted),
    };
    const targetId = entry.linkedMessageId;
    if (targetId === null || targetId === undefined) {
        list.push(entry);
    } else {
        let insertPos = 0;
        for (let i = 0; i < list.length; i++) {
            const lid = list[i].linkedMessageId;
            if (lid !== null && lid !== undefined && lid <= targetId) {
                insertPos = i + 1;
            } else if (lid !== null && lid !== undefined && lid > targetId) {
                break;
            }
        }
        list.splice(insertPos, 0, entry);
    }
    saveMemories(vaultId, list);
    return entry;
}

export function updateMemory(vaultId, id, patch) {
    const list = loadMemories(vaultId);
    const idx = list.findIndex(e => e.id === id);
    if (idx === -1) return false;
    Object.assign(list[idx], patch);
    saveMemories(vaultId, list);
    return true;
}

export function deleteMemory(vaultId, id) {
    const list = loadMemories(vaultId);
    const next = list.filter(e => e.id !== id);
    saveMemories(vaultId, next);
}

export function deleteMemories(vaultId, ids) {
    const set = new Set(ids);
    const list = loadMemories(vaultId);
    saveMemories(vaultId, list.filter(e => !set.has(e.id)));
}

// ─── 合并多条记忆为一条 ───────────────────────────────────────────────────

export function mergeMemories(vaultId, ids, mergedContent) {
    const list = loadMemories(vaultId);
    const sources = list.filter(e => ids.includes(e.id));
    if (sources.length < 2) return null;
    const allTags = [...new Set(sources.flatMap(s => s.tags || []))];
    const maxImportance = Math.max(...sources.map(s => s.importance ?? 0));
    const earliestDate = sources.reduce((min, s) => s.date < min ? s.date : min, sources[0].date);
    const linkedIds = sources.filter(s => s.linkedMessageId !== null && s.linkedMessageId !== undefined).map(s => s.linkedMessageId);
    const latestLinkedId = linkedIds.length ? Math.max(...linkedIds) : null;
    const entry = {
        id:                 genId(),
        content:            mergedContent,
        tags:               allTags,
        importance:         maxImportance,
        date:               earliestDate,
        timestamp:          Date.now(),
        source:             'manual',
        zoneId:             sources[0].zoneId ?? 'default',
        pinned:             false,
        pinnedOrder:        null,
        linkedMessageId:    latestLinkedId,
        originalBlockIndex: null,
        originalText:       null,
        sourceDeleted:      false,
    };
    const idSet = new Set(ids);
    const filtered = list.filter(e => !idSet.has(e.id));
    filtered.push(entry);
    saveMemories(vaultId, filtered);
    return entry;
}

// ─── 判断某楼层中的某个标签块是否已入库 ──────────────────────────────────

export function isBlockAlreadyStored(existingList, mesid, block) {
    return existingList.some(e =>
        !e.sourceDeleted
        && e.linkedMessageId === mesid
        && e.originalText === block.originalText
    );
}

// ─── 自动扫描并入库（单条消息，支持多分区同时捕获） ───────────────────────

export function scanAndStoreMessage(vaultId, mesid, mesText, existingList, defaultImportance, zones = DEFAULT_ZONES) {
    const blocks = extractBlocksForZones(mesText, zones);
    if (!blocks.length) return { newEntries: [], modifiedText: mesText };

    const newBlocks = blocks.filter(b => !isBlockAlreadyStored(existingList, mesid, b));
    if (!newBlocks.length) return { newEntries: [], modifiedText: mesText };

    let nextBlockIdx = existingList
        .filter(e => e.linkedMessageId === mesid && typeof e.originalBlockIndex === 'number')
        .reduce((max, e) => Math.max(max, e.originalBlockIndex), -1) + 1;

    const newEntries = newBlocks.map(block => {
        const parsed = parseAiFormat(block.innerText);
        return {
            id:                 genId(),
            content:            parsed ? parsed.content : block.innerText,
            tags:               parsed ? parsed.tags : [],
            importance:         parsed ? parsed.importance : defaultImportance,
            date:               parsed ? parsed.date : new Date().toISOString().slice(0, 10),
            timestamp:          Date.now(),
            source:             'auto',
            zoneId:             block.zoneId || 'default',
            pinned:             Boolean(block.defaultPinned),
            pinnedOrder:        null,
            linkedMessageId:    mesid,
            originalBlockIndex: nextBlockIdx++,
            originalText:       block.originalText,
            sourceDeleted:      false,
        };
    });

    // 从后往前精确删除新块（避免位置偏移）
    let modifiedText = mesText;
    const sortedDesc = [...newBlocks].sort((a, b) => b.startPos - a.startPos);
    for (const block of sortedDesc) {
        const actual = modifiedText.substring(block.startPos, block.startPos + block.originalText.length);
        if (actual === block.originalText) {
            modifiedText = modifiedText.substring(0, block.startPos)
                         + modifiedText.substring(block.startPos + block.originalText.length);
        } else {
            modifiedText = modifiedText.replace(block.originalText, '');
        }
    }

    return { newEntries, modifiedText };
}

// ─── 还原单条记忆到聊天 ───────────────────────────────────────────────────

export function restoreOneToChat(vaultId, memoryId, zones = DEFAULT_ZONES) {
    const ctx = SillyTavern.getContext();
    const list = loadMemories(vaultId);
    const entry = list.find(e => e.id === memoryId);
    if (!entry || entry.linkedMessageId === null || entry.linkedMessageId === undefined) return false;
    const msg = ctx.chat?.[entry.linkedMessageId];
    if (!msg) return false;
    const zoneList = normalizeZones(zones);
    const zone = zoneList.find(z => z.id === getEntryZoneId(entry, zoneList)) || zoneList[0];
    const restoreText = entry.originalText || `<${zone.tag}>${entry.content}</${zone.tag}>`;
    msg.mes = msg.mes + '\n' + restoreText;
    entry.sourceDeleted = true;
    saveMemories(vaultId, list);
    return true;
}

// ─── 批量还原所有有来源的记忆到聊天（返回还原数量与受影响楼层列表） ──────

export function restoreAllToChat(vaultId) {
    const ctx = SillyTavern.getContext();
    const list = loadMemories(vaultId);
    const toRestore = list
        .filter(e => !e.sourceDeleted && e.linkedMessageId !== null && e.linkedMessageId !== undefined && e.originalText)
        .sort(compareByFloor);
    if (!toRestore.length) return { count: 0, mesids: [] };
    const mesidSet = new Set();
    let count = 0;
    for (const entry of toRestore) {
        const msg = ctx.chat?.[entry.linkedMessageId];
        if (!msg) continue;
        msg.mes = msg.mes + '\n' + entry.originalText;
        entry.sourceDeleted = true;
        mesidSet.add(entry.linkedMessageId);
        count++;
    }
    if (count > 0) saveMemories(vaultId, list);
    return { count, mesids: [...mesidSet] };
}

// ─── 截断删楼标记遗弃 ─────────────────────────────────────────────────────

export function markOutOfRangeDeleted(vaultId, currentChatLength) {
    if (!vaultId || typeof currentChatLength !== 'number' || currentChatLength < 0) return false;
    const list = loadMemories(vaultId);
    let changed = false;
    for (const entry of list) {
        if (
            entry.linkedMessageId !== null
            && entry.linkedMessageId !== undefined
            && entry.linkedMessageId >= currentChatLength
            && !entry.sourceDeleted
        ) {
            entry.sourceDeleted = true;
            changed = true;
        }
    }
    if (changed) saveMemories(vaultId, list);
    return changed;
}

export function clearAbandoned(vaultId) {
    const list = loadMemories(vaultId);
    saveMemories(vaultId, list.filter(e => !e.sourceDeleted));
}

// ─── 置顶操作（默认按楼层排序，拖拽或微调时规范化 pinnedOrder） ───────────

export function pinMemory(vaultId, id, order) {
    updateMemory(vaultId, id, { pinned: true, pinnedOrder: order ?? null });
}

export function unpinMemory(vaultId, id) {
    updateMemory(vaultId, id, { pinned: false, pinnedOrder: null });
}

export function getPinnedSorted(list) {
    return list.filter(e => e.pinned && !e.sourceDeleted).sort((a, b) => {
        const oa = a.pinnedOrder;
        const ob = b.pinnedOrder;
        if (oa != null && ob != null && oa !== ob) return oa - ob;
        if (oa != null && ob == null) return -1;
        if (oa == null && ob != null) return 1;
        // 两者都未手动设定序号时，默认按楼层顺序排列
        return compareByFloor(a, b);
    });
}

/**
 * 未置顶的有效记忆：统一按楼层顺序排列（linkedMessageId 升序，无楼层排末尾）
 */
export function getRecentUnpinned(list) {
    return list.filter(e => !e.pinned && !e.sourceDeleted).sort(compareByFloor);
}

export function getAbandoned(list) {
    return list.filter(e => e.sourceDeleted).sort(compareByFloor);
}

/**
 * 将当前置顶列表的 pinnedOrder 规范化为 0, 1, 2, ...（保证 ↑/↓ 与拖拽始终有效）
 */
function normalizePinnedOrdersInList(list) {
    const ordered = getPinnedSorted(list);
    ordered.forEach((item, idx) => {
        item.pinnedOrder = idx;
    });
    return ordered;
}

/**
 * 按拖拽后的 ID 顺序重新设定置顶序号（支持按子集重排，例如在某个分区内拖拽）
 */
export function reorderPinned(vaultId, draggedId, targetId, insertBefore = true) {
    if (!vaultId || !draggedId || !targetId || draggedId === targetId) return false;
    const list = loadMemories(vaultId);
    const ordered = normalizePinnedOrdersInList(list);
    const fromIdx = ordered.findIndex(e => e.id === draggedId);
    const toIdx   = ordered.findIndex(e => e.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return false;

    const [moved] = ordered.splice(fromIdx, 1);
    const newTargetIdx = ordered.findIndex(e => e.id === targetId);
    const insertIdx = insertBefore ? newTargetIdx : newTargetIdx + 1;
    ordered.splice(insertIdx, 0, moved);

    ordered.forEach((item, idx) => {
        item.pinnedOrder = idx;
    });
    saveMemories(vaultId, list);
    return true;
}

export function movePinnedTop(vaultId, id) {
    const list = loadMemories(vaultId);
    const ordered = normalizePinnedOrdersInList(list);
    const idx = ordered.findIndex(e => e.id === id);
    if (idx <= 0) return;
    const [moved] = ordered.splice(idx, 1);
    ordered.unshift(moved);
    ordered.forEach((item, i) => { item.pinnedOrder = i; });
    saveMemories(vaultId, list);
}

export function movePinnedBottom(vaultId, id) {
    const list = loadMemories(vaultId);
    const ordered = normalizePinnedOrdersInList(list);
    const idx = ordered.findIndex(e => e.id === id);
    if (idx === -1 || idx >= ordered.length - 1) return;
    const [moved] = ordered.splice(idx, 1);
    ordered.push(moved);
    ordered.forEach((item, i) => { item.pinnedOrder = i; });
    saveMemories(vaultId, list);
}

export function movePinnedUp(vaultId, id) {
    const list = loadMemories(vaultId);
    const ordered = normalizePinnedOrdersInList(list);
    const idx = ordered.findIndex(e => e.id === id);
    if (idx <= 0) return;
    [ordered[idx - 1], ordered[idx]] = [ordered[idx], ordered[idx - 1]];
    ordered.forEach((item, i) => { item.pinnedOrder = i; });
    saveMemories(vaultId, list);
}

export function movePinnedDown(vaultId, id) {
    const list = loadMemories(vaultId);
    const ordered = normalizePinnedOrdersInList(list);
    const idx = ordered.findIndex(e => e.id === id);
    if (idx === -1 || idx >= ordered.length - 1) return;
    [ordered[idx], ordered[idx + 1]] = [ordered[idx + 1], ordered[idx]];
    ordered.forEach((item, i) => { item.pinnedOrder = i; });
    saveMemories(vaultId, list);
}

// ─── 复制记忆到新库（用于分支/切换复制场景） ─────────────────────────────

export function cloneMemoriesToNewVault(fromVaultId, toVaultId) {
    const source = loadMemories(fromVaultId);
    if (!source.length) return 0;
    const copied = source.map(entry => ({
        ...entry,
        tags: Array.isArray(entry.tags) ? [...entry.tags] : [],
        id: genId(),
    }));
    mvWrite(chatKey(toVaultId), copied);
    return copied.length;
}

export function copyMemories(fromVaultId, toVaultId) {
    const source = loadMemories(fromVaultId);
    if (!source.length) return 0;
    const existing = loadMemories(toVaultId);
    if (existing.length) return 0;
    const copied = source.map(entry => ({
        ...entry,
        tags: Array.isArray(entry.tags) ? [...entry.tags] : [],
        id: genId(),
    }));
    saveMemories(toVaultId, copied);
    return copied.length;
}