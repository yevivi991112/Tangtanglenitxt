/**
 * memory.js — 记忆条目 CRUD、快照、还原、以及基于 chatMetadata 的防丢绑定与分支复制
 *
 * 设计不变量：
 * 1. 每个聊天在 ST 的 chatMetadata.memory_vault 中持久化 { vaultId, lastChatId }。
 *    - 酒馆内重命名聊天（CHAT_RENAMED）时，沿用同一个 vaultId，仅更新 lastChatId 与 vault_meta。
 *    - 创建分支（Branch）时，ST 会复制原聊天的 chatMetadata；检测到 lastChatId !== currentChatId
 *      且未命中近期改名事件时，自动为新分支创建独立 vaultId 并完整复制原记忆库，保证分支互不串戏。
 * 2. 兼容历史数据：首次打开老聊天时若 chatMetadata 尚无记录，优先沿用旧 key（chat_<chatId> 或群聊旧 key chat_group_<groupId>）。
 * 3. 编辑记忆楼层号时必须保留原有 pinned / pinnedOrder / sourceDeleted 状态。
 */

import {
    mvRead, mvWrite,
    chatKey, chatSnapshotKey, dbSnapshotKey,
    updateVaultMeta,
} from './storage.js';

const CHAT_META_FIELD = 'memory_vault';

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

/**
 * 解析当前聊天对应的有效 vaultId，并自动处理：
 * - 普通打开 & 历史旧数据兼容
 * - 酒馆改名（recentRename 命中时直接沿用原 vaultId）
 * - 分支聊天（chatMetadata 携带旧 chatId 的 vaultId 且非改名 -> 自动复制为独立新 vaultId）
 *
 * @param {object|null} recentRename - { oldFileName, newFileName, ts }
 * @returns {{ vaultId: string|null, chatId: string|null, action: 'none'|'existing'|'renamed'|'branched'|'new', copiedCount?: number }}
 */
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

    // 情况 1：chatMetadata 中已有绑定记录
    if (meta?.vaultId) {
        const metaVaultId = String(meta.vaultId);
        const lastChatId = meta.lastChatId ? String(meta.lastChatId) : null;

        // 1a. 同一个聊天，或刚刚在酒馆内被重命名
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

        // 1b. lastChatId !== currentChatId 且不是改名 -> 判定为分支（Branch）或手工复制的 .jsonl
        // 按设计：自动复制一份独立记忆库，保证分支与原聊天互不串戏
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

    // 情况 2：chatMetadata 中尚无记录（老聊天首次升级，或刚改名的老聊天）
    // 2a. 如果是刚改名的老聊天，旧文件名对应的记忆库还在 chat_<oldFileName> 下
    if (isRecentRename && recentRename.oldFileName) {
        const oldVaultId = String(recentRename.oldFileName);
        const oldMemories = loadMemories(oldVaultId);
        if (oldMemories.length > 0) {
            writeChatVaultMeta(oldVaultId, currentChatId);
            updateVaultMeta(oldVaultId, { chatName: currentChatId, charName });
            return { vaultId: oldVaultId, chatId: currentChatId, action: 'renamed' };
        }
    }

    // 2b. 检查当前 chatId 对应的老数据
    const directMemories = loadMemories(currentChatId);
    if (directMemories.length > 0) {
        writeChatVaultMeta(currentChatId, currentChatId);
        updateVaultMeta(currentChatId, { chatName: currentChatId, charName });
        return { vaultId: currentChatId, chatId: currentChatId, action: 'existing' };
    }

    // 2c. 群聊兼容：检查旧版 group_<groupId> key
    const legacyGroupId = getLegacyGroupVaultId();
    if (legacyGroupId && legacyGroupId !== currentChatId) {
        const legacyMemories = loadMemories(legacyGroupId);
        if (legacyMemories.length > 0) {
            writeChatVaultMeta(legacyGroupId, currentChatId);
            updateVaultMeta(legacyGroupId, { chatName: currentChatId, charName });
            return { vaultId: legacyGroupId, chatId: currentChatId, action: 'existing' };
        }
    }

    // 2d. 全新空白聊天：暂不强制落盘 chatMetadata（等真正写入记忆时再落盘），先使用 currentChatId 作为 vaultId
    return { vaultId: currentChatId, chatId: currentChatId, action: 'new' };
}

/**
 * 手动将当前聊天重新绑定到某个已存在的历史记忆库
 */
export function bindCurrentChatToVault(targetVaultId) {
    const currentChatId = getCurrentChatId();
    if (!currentChatId || !targetVaultId) return false;
    const charName = getCurrentCharName();
    writeChatVaultMeta(targetVaultId, currentChatId);
    updateVaultMeta(targetVaultId, { chatName: currentChatId, charName });
    return true;
}

/**
 * 将历史记忆库的内容合并到目标记忆库（按 id 或同楼层同原文去重）
 */
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
    // 只要往当前聊天的记忆库写过数据，就确保 chatMetadata 已绑定，以后改名绝不丢
    const meta = readChatVaultMeta();
    if (currentChatId && (!meta || meta.vaultId !== vaultId || meta.lastChatId !== currentChatId)) {
        writeChatVaultMeta(vaultId, currentChatId);
    }
    updateVaultMeta(vaultId, {
        chatName: currentChatId || vaultId,
        charName,
    });
}

// ─── 快照（支持增量合并，防止后续扫描覆盖先前楼层的原文快照） ─────────────

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
    // changedMsgs: { [mesid]: originalText }
    if (!vaultId || !changedMsgs || !Object.keys(changedMsgs).length) return;
    if (mergeExisting) {
        const prev = getChatSnapshot(vaultId);
        // 保留最早一份原文快照（同一个楼层若已被捕获过一次，不覆盖最初的完整原文）
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
    while ((m = re.exec(mesText || '')) !== null) {
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
        // 找到最后一个 linkedMessageId <= targetId 的位置，插在其后
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

// ─── 精确从消息文本删除某块（从后往前） ──────────────────────────────────

export function removeBlockFromText(mesText, block) {
    const actual = mesText.substring(block.startPos, block.startPos + block.originalText.length);
    if (actual === block.originalText) {
        return mesText.substring(0, block.startPos) + mesText.substring(block.startPos + block.originalText.length);
    }
    return mesText.replace(block.originalText, '');
}

/**
 * 判断某楼层中的某个 <Lenitxt> 块是否已在有效记忆中存在
 * 修复：不再仅靠 originalBlockIndex（删块后补写会重置为 0），改按同楼层且原文完全相同去重
 */
export function isBlockAlreadyStored(existingList, mesid, block) {
    return existingList.some(e =>
        !e.sourceDeleted
        && e.linkedMessageId === mesid
        && e.originalText === block.originalText
    );
}

// ─── 自动扫描并入库（单条消息），返回新增条目与修改后文本 ──────────────────

export function scanAndStoreMessage(vaultId, mesid, mesText, existingList, defaultImportance) {
    const blocks = extractBlocks(mesText);
    if (!blocks.length) return { newEntries: [], modifiedText: mesText };

    const newBlocks = blocks.filter(b => !isBlockAlreadyStored(existingList, mesid, b));
    if (!newBlocks.length) return { newEntries: [], modifiedText: mesText };

    // 计算该楼层当前最大的 originalBlockIndex，补写的新块顺延编号
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
            pinned:             false,
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

export function restoreOneToChat(vaultId, memoryId) {
    const ctx = SillyTavern.getContext();
    const list = loadMemories(vaultId);
    const entry = list.find(e => e.id === memoryId);
    if (!entry || entry.linkedMessageId === null || entry.linkedMessageId === undefined) return false;
    const msg = ctx.chat?.[entry.linkedMessageId];
    if (!msg) return false;
    const restoreText = entry.originalText || `<Lenitxt>${entry.content}</Lenitxt>`;
    msg.mes = msg.mes + '\n' + restoreText;
    entry.sourceDeleted = true;
    saveMemories(vaultId, list);
    return true;
}

// ─── 批量还原所有有来源的记忆到聊天 ──────────────────────────────────────

export function restoreAllToChat(vaultId) {
    const ctx = SillyTavern.getContext();
    const list = loadMemories(vaultId);
    const toRestore = list
        .filter(e => !e.sourceDeleted && e.linkedMessageId !== null && e.linkedMessageId !== undefined && e.originalText)
        .sort((a, b) => a.linkedMessageId - b.linkedMessageId || (a.originalBlockIndex ?? 0) - (b.originalBlockIndex ?? 0));
    if (!toRestore.length) return 0;
    let restoredCount = 0;
    for (const entry of toRestore) {
        const msg = ctx.chat?.[entry.linkedMessageId];
        if (!msg) continue;
        msg.mes = msg.mes + '\n' + entry.originalText;
        entry.sourceDeleted = true;
        restoredCount++;
    }
    if (restoredCount > 0) saveMemories(vaultId, list);
    return restoredCount;
}

// ─── 将超出当前聊天长度的记忆标记为 sourceDeleted（适配 ST 1.19+ MESSAGE_DELETED(chat.length)）

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

export function markSourceDeleted(vaultId, mesid) {
    const list = loadMemories(vaultId);
    let changed = false;
    for (const entry of list) {
        if (entry.linkedMessageId === mesid && !entry.sourceDeleted) {
            entry.sourceDeleted = true;
            changed = true;
        }
    }
    if (changed) saveMemories(vaultId, list);
    return changed;
}

// ─── 按楼层排序插入多条记忆 ───────────────────────────────────────────────

export function insertMemoriesSorted(vaultId, newEntries) {
    const list = loadMemories(vaultId);
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
            insertPos = list.findIndex(e => e.linkedMessageId !== null && e.linkedMessageId !== undefined && e.linkedMessageId > entry.linkedMessageId);
            if (insertPos === -1) insertPos = list.length;
        }
        list.splice(insertPos, 0, entry);
    }
    saveMemories(vaultId, list);
    return newEntries.length;
}

// ─── 清空遗弃区块 ─────────────────────────────────────────────────────────

export function clearAbandoned(vaultId) {
    const list = loadMemories(vaultId);
    saveMemories(vaultId, list.filter(e => !e.sourceDeleted));
}

// ─── 置顶操作 ─────────────────────────────────────────────────────────────

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
        if (oa == null && ob == null) return 0;
        if (oa == null) return -1;
        if (ob == null) return 1;
        return oa - ob;
    });
}

export function getRecentUnpinned(list) {
    return list.filter(e => !e.pinned && !e.sourceDeleted)
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

export function getAbandoned(list) {
    return list.filter(e => e.sourceDeleted);
}

// ─── pinnedOrder 调整工具 ─────────────────────────────────────────────────

export function movePinnedTop(vaultId, id) {
    const list = loadMemories(vaultId);
    const pinned = getPinnedSorted(list);
    const minOrder = pinned.length ? Math.min(...pinned.map(e => e.pinnedOrder ?? 0)) : 0;
    updateMemory(vaultId, id, { pinnedOrder: minOrder - 1 });
}

export function movePinnedBottom(vaultId, id) {
    const list = loadMemories(vaultId);
    const pinned = getPinnedSorted(list);
    const maxOrder = pinned.length ? Math.max(...pinned.map(e => e.pinnedOrder ?? 0)) : 0;
    updateMemory(vaultId, id, { pinnedOrder: maxOrder + 1 });
}

export function movePinnedUp(vaultId, id) {
    const list = loadMemories(vaultId);
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
    saveMemories(vaultId, list);
}

export function movePinnedDown(vaultId, id) {
    const list = loadMemories(vaultId);
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
    if (existing.length) return 0; // 目标已有记忆，不覆盖
    const copied = source.map(entry => ({
        ...entry,
        tags: Array.isArray(entry.tags) ? [...entry.tags] : [],
        id: genId(),
    }));
    saveMemories(toVaultId, copied);
    return copied.length;
}