/**
 * memory.js — 记忆条目 CRUD、快照、还原
 */

import { mvRead, mvWrite, chatKey, chatSnapshotKey, dbSnapshotKey } from './storage.js';

// ─── ID 生成 ───────────────────────────────────────────────────────────────

function genId() {
    return Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

// ─── 读取当前聊天 ID ───────────────────────────────────────────────────────

export function getCurrentChatId() {
    try {
        const ctx = SillyTavern.getContext();
        if (!ctx) return null;
        if (ctx.groupId) return 'group_' + ctx.groupId;
        if (ctx.characters && typeof ctx.characterId === 'number' && ctx.characterId >= 0) {
            const char = ctx.characters[ctx.characterId];
            if (char?.chat) return String(char.chat);
        }
        if (ctx.chatId) return String(ctx.chatId);
    } catch {}
    return null;
}

// ─── 主库读写 ─────────────────────────────────────────────────────────────

export function loadMemories(chatId) {
    return mvRead(chatKey(chatId)) ?? [];
}

export function saveMemories(chatId, list) {
    mvWrite(chatKey(chatId), list);
}

// ─── 快照 ─────────────────────────────────────────────────────────────────

export function saveDbSnapshot(chatId) {
    const current = loadMemories(chatId);
    mvWrite(dbSnapshotKey(chatId), JSON.parse(JSON.stringify(current)));
}

export function restoreDbSnapshot(chatId) {
    const snap = mvRead(dbSnapshotKey(chatId));
    if (snap === null) return false;
    saveMemories(chatId, snap);
    return true;
}

export function saveChatSnapshot(chatId, changedMsgs) {
    // changedMsgs: { [mesid]: originalText }
    mvWrite(chatSnapshotKey(chatId), changedMsgs);
}

export function getChatSnapshot(chatId) {
    return mvRead(chatSnapshotKey(chatId)) ?? {};
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
        tags:       tagStr ? tagStr.split(',').map(t => t.trim()).filter(Boolean) : [],
        importance: isNaN(importance) ? 0.5 : Math.min(1, Math.max(0, importance)),
        content,
    };
}

// ─── 从消息文本提取 <Lenitxt> 块 ─────────────────────────────────────────

export function extractBlocks(mesText) {
    const blocks = [];
    const re = /<Lenitxt>([\s\S]*?)<\/Lenitxt>/gi;
    let m, idx = 0;
    while ((m = re.exec(mesText)) !== null) {
        blocks.push({
            originalText:   m[0],
            innerText:      m[1].trim(),
            startPos:       m.index,
            blockIndex:     idx++,
        });
    }
    return blocks;
}

// ─── 写入一条新记忆 ───────────────────────────────────────────────────────

export function addMemory(chatId, fields) {
    const list = loadMemories(chatId);
    const entry = {
        id:                 genId(),
        content:            fields.content ?? '',
        tags:               fields.tags ?? [],
        importance:         fields.importance ?? 0.5,
        date:               fields.date ?? new Date().toISOString().slice(0, 10),
        timestamp:          fields.timestamp ?? Date.now(),
        source:             fields.source ?? 'manual',
        pinned:             false,
        pinnedOrder:        null,
        linkedMessageId:    fields.linkedMessageId ?? null,
        originalBlockIndex: fields.originalBlockIndex ?? null,
        originalText:       fields.originalText ?? null,
        sourceDeleted:      false,
    };
    list.push(entry);
    saveMemories(chatId, list);
    return entry;
}

export function addMemoryAtFloor(chatId, fields) {
    const list = loadMemories(chatId);
    const entry = {
        id:                 genId(),
        content:            fields.content ?? '',
        tags:               fields.tags ?? [],
        importance:         fields.importance ?? 0.5,
        date:               fields.date ?? new Date().toISOString().slice(0, 10),
        timestamp:          fields.timestamp ?? Date.now(),
        source:             fields.source ?? 'manual',
        pinned:             false,
        pinnedOrder:        null,
        linkedMessageId:    fields.linkedMessageId ?? null,
        originalBlockIndex: fields.originalBlockIndex ?? null,
        originalText:       fields.originalText ?? null,
        sourceDeleted:      false,
    };
    const targetId = entry.linkedMessageId;
    if (targetId === null || targetId === undefined) {
        list.push(entry);
    } else {
        // 找到最后一个 linkedMessageId <= targetId 的位置，插在其后
        let insertPos = 0;
        for (let i = 0; i < list.length; i++) {
            const lid = list[i].linkedMessageId;
            if (lid !== null && lid !== undefined && lid <= targetId) {
                insertPos = i + 1;
            } else if (lid !== null && lid !== undefined && lid > targetId) {
                // 遇到第一个比 targetId 大的，停止
                break;
            }
        }
        list.splice(insertPos, 0, entry);
    }
    saveMemories(chatId, list);
    return entry;
}

export function updateMemory(chatId, id, patch) {
    const list = loadMemories(chatId);
    const idx = list.findIndex(e => e.id === id);
    if (idx === -1) return false;
    Object.assign(list[idx], patch);
    saveMemories(chatId, list);
    return true;
}

export function deleteMemory(chatId, id) {
    const list = loadMemories(chatId);
    const next = list.filter(e => e.id !== id);
    saveMemories(chatId, next);
}

export function deleteMemories(chatId, ids) {
    const set = new Set(ids);
    const list = loadMemories(chatId);
    saveMemories(chatId, list.filter(e => !set.has(e.id)));
}

// ─── 合并多条记忆为一条 ───────────────────────────────────────────────────

export function mergeMemories(chatId, ids, mergedContent) {
    const list = loadMemories(chatId);
    const sources = list.filter(e => ids.includes(e.id));
    if (sources.length < 2) return null;
    const allTags = [...new Set(sources.flatMap(s => s.tags))];
    const maxImportance = Math.max(...sources.map(s => s.importance));
    const earliestDate = sources.reduce((min, s) => s.date < min ? s.date : min, sources[0].date);
    const linkedIds = sources.filter(s => s.linkedMessageId !== null).map(s => s.linkedMessageId);
    const latestLinkedId = linkedIds.length ? Math.max(...linkedIds) : null;
    const entry = {
        id:                 genId(),
        content:            mergedContent,
        tags:               allTags,
        importance:         maxImportance,
        date:               earliestDate,
        timestamp:          Date.now(),
        source:             'manual',
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
    saveMemories(chatId, filtered);
    return entry;
}

// ─── 精确从消息文本删除某块（从后往前） ──────────────────────────────────

export function removeBlockFromText(mesText, block) {
    const actual = mesText.substring(block.startPos, block.startPos + block.originalText.length);
    if (actual === block.originalText) {
        return mesText.substring(0, block.startPos) + mesText.substring(block.startPos + block.originalText.length);
    }
    // 位置偏移回退
    return mesText.replace(block.originalText, '');
}

// ─── 自动扫描并入库（单条消息），返回新增条目数 ──────────────────────────

export function scanAndStoreMessage(chatId, mesid, mesText, existingList, defaultImportance) {
    const blocks = extractBlocks(mesText);
    if (!blocks.length) return { newEntries: [], modifiedText: mesText };

    // 分离新块（去重）和已存在块
    const newBlocks = blocks.filter(b =>
        !existingList.some(e => e.linkedMessageId === mesid && e.originalBlockIndex === b.blockIndex)
    );
    if (!newBlocks.length) return { newEntries: [], modifiedText: mesText };

    // 构建新记忆条目
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
            pinned:             false,
            pinnedOrder:        null,
            linkedMessageId:    mesid,
            originalBlockIndex: block.blockIndex,
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

export function restoreOneToChat(chatId, memoryId) {
    const ctx = SillyTavern.getContext();
    const list = loadMemories(chatId);
    const entry = list.find(e => e.id === memoryId);
    if (!entry || entry.linkedMessageId === null) return false;
    const msg = ctx.chat?.[entry.linkedMessageId];
    if (!msg) return false;
    const restoreText = entry.originalText || `<Lenitxt>${entry.content}</Lenitxt>`;
    msg.mes = msg.mes + '\n' + restoreText;
    entry.sourceDeleted = true;
    saveMemories(chatId, list);
    return true;
}

// ─── 批量还原所有有来源的记忆到聊天 ──────────────────────────────────────

export function restoreAllToChat(chatId) {
    const ctx = SillyTavern.getContext();
    const list = loadMemories(chatId);
    const toRestore = list
        .filter(e => e.linkedMessageId !== null && e.originalText)
        .sort((a, b) => a.linkedMessageId - b.linkedMessageId || a.originalBlockIndex - b.originalBlockIndex);
    if (!toRestore.length) return 0;
    for (const entry of toRestore) {
        const msg = ctx.chat?.[entry.linkedMessageId];
        if (!msg) continue;
        msg.mes = msg.mes + '\n' + entry.originalText;
        // 标记为遗弃，保留 linkedMessageId / originalText 供遗弃区查看
        entry.sourceDeleted = true;
    }
    saveMemories(chatId, list);
    return toRestore.length;
}

// ─── 将关联某条消息的记忆标记为 sourceDeleted ────────────────────────────

export function markSourceDeleted(chatId, mesid) {
    const list = loadMemories(chatId);
    let changed = false;
    for (const entry of list) {
        if (entry.linkedMessageId === mesid && !entry.sourceDeleted) {
            entry.sourceDeleted = true;
            changed = true;
        }
    }
    if (changed) saveMemories(chatId, list);
    return changed;
}

// ─── 按楼层排序插入多条记忆 ───────────────────────────────────────────────

export function insertMemoriesSorted(chatId, newEntries) {
    const list = loadMemories(chatId);
    for (const entry of [...newEntries].sort((a, b) => (a.linkedMessageId ?? Infinity) - (b.linkedMessageId ?? Infinity))) {
        let insertPos = list.length;
        for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].linkedMessageId !== null && list[i].linkedMessageId !== undefined &&
                list[i].linkedMessageId <= entry.linkedMessageId) {
                insertPos = i + 1;
                break;
            }
        }
        if (insertPos === list.length && list.length > 0) {
            // 所有现有条目都没有 linkedMessageId 或都比 entry 大，插末尾
            insertPos = list.findIndex(e => e.linkedMessageId !== null && e.linkedMessageId !== undefined && e.linkedMessageId > entry.linkedMessageId);
            if (insertPos === -1) insertPos = list.length;
        }
        list.splice(insertPos, 0, entry);
    }
    saveMemories(chatId, list);
    return newEntries.length;
}

// ─── 清空遗弃区块 ─────────────────────────────────────────────────────────

export function clearAbandoned(chatId) {
    const list = loadMemories(chatId);
    saveMemories(chatId, list.filter(e => !e.sourceDeleted));
}

// ─── 置顶操作 ─────────────────────────────────────────────────────────────

export function pinMemory(chatId, id, order) {
    updateMemory(chatId, id, { pinned: true, pinnedOrder: order ?? null });
}

export function unpinMemory(chatId, id) {
    updateMemory(chatId, id, { pinned: false, pinnedOrder: null });
}

export function getPinnedSorted(list) {
    return list.filter(e => e.pinned).sort((a, b) => {
        const oa = a.pinnedOrder;
        const ob = b.pinnedOrder;
        if (oa == null && ob == null) return 0;
        if (oa == null) return -1;
        if (ob == null) return 1;
        return oa - ob;
    });
}

export function getRecentUnpinned(list, n) {
    const unpinned = list.filter(e => !e.pinned && !e.sourceDeleted)
        .sort((a, b) => a.timestamp - b.timestamp);
    return unpinned;
}

export function getAbandoned(list) {
    return list.filter(e => e.sourceDeleted);
}

// ─── pinnedOrder 调整工具 ─────────────────────────────────────────────────

export function movePinnedTop(chatId, id) {
    const list = loadMemories(chatId);
    const pinned = getPinnedSorted(list);
    const minOrder = pinned.length ? Math.min(...pinned.map(e => e.pinnedOrder ?? 0)) : 0;
    updateMemory(chatId, id, { pinnedOrder: minOrder - 1 });
}

export function movePinnedBottom(chatId, id) {
    const list = loadMemories(chatId);
    const pinned = getPinnedSorted(list);
    const maxOrder = pinned.length ? Math.max(...pinned.map(e => e.pinnedOrder ?? 0)) : 0;
    updateMemory(chatId, id, { pinnedOrder: maxOrder + 1 });
}

export function movePinnedUp(chatId, id) {
    const list = loadMemories(chatId);
    const pinned = getPinnedSorted(list);
    const idx = pinned.findIndex(e => e.id === id);
    if (idx <= 0) return;
    const prev = pinned[idx - 1];
    const cur  = pinned[idx];
    const curInList  = list.find(e => e.id === cur.id);
    const prevInList = list.find(e => e.id === prev.id);
    const tmp = curInList.pinnedOrder;
    curInList.pinnedOrder  = prevInList.pinnedOrder;
    prevInList.pinnedOrder = tmp;
    saveMemories(chatId, list);
}

export function movePinnedDown(chatId, id) {
    const list = loadMemories(chatId);
    const pinned = getPinnedSorted(list);
    const idx = pinned.findIndex(e => e.id === id);
    if (idx === -1 || idx >= pinned.length - 1) return;
    const next = pinned[idx + 1];
    const cur  = pinned[idx];
    const curInList  = list.find(e => e.id === cur.id);
    const nextInList = list.find(e => e.id === next.id);
    const tmp = curInList.pinnedOrder;
    curInList.pinnedOrder  = nextInList.pinnedOrder;
    nextInList.pinnedOrder = tmp;
    saveMemories(chatId, list);
}

// ─── 复制记忆到新聊天（用于分支/拷贝场景） ────────────────────────────────

export function copyMemories(fromChatId, toChatId) {
    const source = loadMemories(fromChatId);
    if (!source.length) return 0;
    const existing = loadMemories(toChatId);
    if (existing.length) return 0; // 目标已有记忆，不覆盖
    const copied = source.map(entry => ({
        ...entry,
        id: genId(),
        timestamp: Date.now(),
    }));
    saveMemories(toChatId, copied);
    return copied.length;
}
