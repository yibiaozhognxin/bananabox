const http = require('http');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const SYSTEM_PATH = path.join(DATA_DIR, 'system.json');
const USERS_META_PATH = path.join(DATA_DIR, 'users.json');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
const LEGACY_IMAGE_DIR = path.join(ROOT_DIR, 'image');
const LEGACY_HISTORY_PATH = path.join(LEGACY_IMAGE_DIR, 'history.json');
const LEGACY_ADMIN_USER_ID = '';
const DEFAULT_ADMIN_USER_ID = '';
const DEFAULT_API_BASE_URL = '';
const DEFAULT_API_KEY = '';
const DEFAULT_QUALITY_SETTINGS = {
    '1k': { enabled: false, modelId: '' },
    '2k': { enabled: false, modelId: '' },
    '4k': { enabled: false, modelId: '' }
};
const TASK_SUBMIT_INTERVAL = 1000;
const MAX_ACTIVE_TASKS_PER_USER = 5;

const runtimeTasks = new Map();
const pendingQueue = [];
let queueTimer = null;
let lastSubmitAt = 0;

ensureStorage();
ensureSystemConfig();
migrateLegacyData();
syncUsersFromHistory();
hydrateRuntimeTasksFromHistory();
startQueue();

const server = http.createServer(async (req, res) => {
    try {
        const requestUrl = new URL(req.url, `http://${req.headers.host}`);

        if (req.method === 'GET' && requestUrl.pathname === '/') {
            return serveFile(path.join(ROOT_DIR, 'nanobanana.html'), res);
        }

        if (req.method === 'POST' && requestUrl.pathname === '/api/session') {
            const body = await readJsonBody(req);
            return handleSession(body, res);
        }

        if (req.method === 'GET' && requestUrl.pathname === '/api/history') {
            const userId = parseUserId(requestUrl.searchParams.get('userId'));
            if (!userId) return json(res, 400, { error: 'Missing or invalid userId' });
            const access = ensureUserAccess(userId);
            if (!access.ok) return json(res, access.statusCode, { error: access.message, code: access.code });
            const page = Math.max(1, Number.parseInt(requestUrl.searchParams.get('page') || '1', 10) || 1);
            const pageSize = Math.min(50, Math.max(1, Number.parseInt(requestUrl.searchParams.get('pageSize') || '24', 10) || 24));
            const targetUserId = parseUserId(requestUrl.searchParams.get('targetUserId'));
            return json(res, 200, getHistoryPage(userId, page, pageSize, targetUserId));
        }

        if (req.method === 'GET' && requestUrl.pathname === '/api/tasks') {
            const userId = parseUserId(requestUrl.searchParams.get('userId'));
            if (!userId) return json(res, 400, { error: 'Missing or invalid userId' });
            const access = ensureUserAccess(userId);
            if (!access.ok) return json(res, access.statusCode, { error: access.message, code: access.code });
            const targetUserId = parseUserId(requestUrl.searchParams.get('targetUserId'));
            return json(res, 200, { records: getRuntimeTasksForUser(userId, targetUserId) });
        }

        if (req.method === 'POST' && requestUrl.pathname === '/api/generate') {
            const body = await readJsonBody(req);
            return handleGenerate(body, res);
        }

        if (req.method === 'POST' && requestUrl.pathname === '/api/retry') {
            const body = await readJsonBody(req);
            return handleRetry(body, res);
        }

        if (req.method === 'DELETE' && requestUrl.pathname.startsWith('/api/history/')) {
            const recordId = decodeURIComponent(requestUrl.pathname.slice('/api/history/'.length));
            const userId = parseUserId(requestUrl.searchParams.get('userId'));
            if (!userId) return json(res, 400, { error: 'Missing or invalid userId' });
            return handleDeleteHistory(recordId, userId, res);
        }

        if (req.method === 'GET' && requestUrl.pathname === '/api/admin/settings') {
            const userId = parseUserId(requestUrl.searchParams.get('userId'));
            if (!assertAdmin(userId, res)) return;
            return json(res, 200, { settings: sanitizeSystemConfig(readSystemConfig()) });
        }

        if (req.method === 'PATCH' && requestUrl.pathname === '/api/admin/settings') {
            const body = await readJsonBody(req);
            if (!assertAdmin(parseUserId(body.userId), res)) return;
            return handleUpdateAdminSettings(body, res);
        }

        if (req.method === 'GET' && requestUrl.pathname === '/api/admin/users') {
            const userId = parseUserId(requestUrl.searchParams.get('userId'));
            if (!assertAdmin(userId, res)) return;
            return json(res, 200, getAdminUsersPayload());
        }

        if (req.method === 'PATCH' && requestUrl.pathname.startsWith('/api/admin/users/') && requestUrl.pathname.endsWith('/status')) {
            const targetUserId = decodeURIComponent(requestUrl.pathname.slice('/api/admin/users/'.length, -'/status'.length));
            const body = await readJsonBody(req);
            if (!assertAdmin(parseUserId(body.userId), res)) return;
            return handleAdminUserStatus(targetUserId, body, res);
        }

        if (req.method === 'DELETE' && requestUrl.pathname.startsWith('/api/admin/users/')) {
            const targetUserId = decodeURIComponent(requestUrl.pathname.slice('/api/admin/users/'.length));
            const userId = parseUserId(requestUrl.searchParams.get('userId'));
            if (!assertAdmin(userId, res)) return;
            return handleAdminDeleteUser(targetUserId, res);
        }

        if (req.method === 'GET' && requestUrl.pathname.startsWith('/image/')) {
            return handleServeImage(requestUrl.pathname, requestUrl.searchParams, res);
        }

        if (req.method === 'GET') {
            return serveStatic(requestUrl.pathname, res);
        }

        json(res, 404, { error: 'Not found' });
    } catch (error) {
        console.error(error);
        json(res, 500, { error: error.message || 'Internal server error' });
    }
});

server.listen(PORT, () => {
    console.log(`Nano Banana server running at http://0.0.0.0:${PORT}`);
});

function handleSession(body, res) {
    const userId = parseUserId(body.userId);
    if (!userId) return json(res, 400, { error: 'Missing or invalid userId' });

    const access = ensureUserAccess(userId);
    if (!access.ok) return json(res, access.statusCode, { error: access.message, code: access.code });

    return json(res, 200, {
        session: {
            userId,
            isAdmin: isAdmin(userId),
            user: getUserMeta(userId),
            system: sanitizeSystemConfig(readSystemConfig())
        }
    });
}

async function handleGenerate(body, res) {
    const userId = parseUserId(body.userId);
    const clientTaskId = String(body.clientTaskId || '').trim();
    const prompt = String(body.prompt || '').trim();
    const model = String(body.model || '').trim();
    const ratio = String(body.ratio || '').trim();
    const images = Array.isArray(body.images) ? body.images.filter(Boolean) : [];

    if (!userId) return json(res, 400, { error: 'Missing or invalid userId' });
    const access = ensureUserAccess(userId);
    if (!access.ok) return json(res, access.statusCode, { error: access.message, code: access.code });
    if (!clientTaskId) return json(res, 400, { error: 'Missing clientTaskId' });
    if (!prompt) return json(res, 400, { error: 'Missing prompt' });
    if (!model) return json(res, 400, { error: 'Missing model' });

    const activeCount = countUserActiveTasks(userId);
    if (activeCount >= MAX_ACTIVE_TASKS_PER_USER) {
        return json(res, 400, { error: `当前最多同时进行 ${MAX_ACTIVE_TASKS_PER_USER} 个任务，请等待已有任务完成后再试` });
    }

    const existingTask = runtimeTasks.get(clientTaskId);
    if (existingTask && String(existingTask.userId) === String(userId)) {
        return json(res, 200, { task: sanitizeTask(existingTask) });
    }

    const task = {
        id: clientTaskId,
        userId,
        prompt,
        model,
        ratio: ratio || '1x1',
        images,
        status: 'queued',
        queuedAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        createdAt: null,
        imageUrl: '',
        thumbnailUrl: '',
        errorMessage: ''
    };

    runtimeTasks.set(task.id, task);
    pendingQueue.push(task.id);
    startQueue();
    return json(res, 202, { task: sanitizeTask(task) });
}

async function handleRetry(body, res) {
    const userId = parseUserId(body.userId);
    const originalTaskId = String(body.taskId || '').trim();

    if (!userId) return json(res, 400, { error: 'Missing or invalid userId' });
    if (!originalTaskId) return json(res, 400, { error: 'Missing taskId' });

    const access = ensureUserAccess(userId);
    if (!access.ok) return json(res, access.statusCode, { error: access.message, code: access.code });

    const activeCount = countUserActiveTasks(userId);
    if (activeCount >= MAX_ACTIVE_TASKS_PER_USER) {
        return json(res, 400, { error: `当前最多同时进行 ${MAX_ACTIVE_TASKS_PER_USER} 个任务，请等待已有任务完成后再试` });
    }

    const original = runtimeTasks.get(String(originalTaskId));
    if (!original) return json(res, 404, { error: 'Original task not found' });
    if (!isAdmin(userId) && String(original.userId) !== String(userId)) {
        return json(res, 404, { error: 'Original task not found' });
    }

    const clientTaskId = String(body.clientTaskId || '').trim() || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const task = {
        id: clientTaskId,
        userId,
        prompt: original.prompt,
        model: original.model,
        ratio: original.ratio || '1x1',
        images: Array.isArray(original.images) ? [...original.images] : [],
        status: 'queued',
        queuedAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        createdAt: null,
        imageUrl: '',
        thumbnailUrl: '',
        errorMessage: ''
    };

    runtimeTasks.set(task.id, task);
    pendingQueue.push(task.id);
    startQueue();
    return json(res, 202, { task: sanitizeTask(task) });
}

function handleDeleteHistory(recordId, userId, res) {
    if (!recordId) return json(res, 400, { error: 'Missing record id' });
    const access = ensureUserAccess(userId);
    if (!access.ok) return json(res, access.statusCode, { error: access.message, code: access.code });

    const history = readHistory();
    const index = history.findIndex((item) => {
        if (String(item.id) !== String(recordId)) return false;
        if (isAdmin(userId)) return true;
        return String(item.userId) === String(userId);
    });

    if (index === -1) {
        const runtimeTask = runtimeTasks.get(String(recordId));
        if (!runtimeTask) return json(res, 404, { error: 'History record not found' });
        if (!isAdmin(userId) && String(runtimeTask.userId) !== String(userId)) {
            return json(res, 404, { error: 'History record not found' });
        }
        removeTaskFromQueue(recordId);
        runtimeTasks.delete(String(recordId));
        return json(res, 200, { success: true });
    }

    const [record] = history.splice(index, 1);
    writeHistory(history);
    removeTaskFromQueue(record.id);
    runtimeTasks.delete(String(record.id));
    safeUnlink(resolveStoredPath(record.imageUrl || ''));
    safeUnlink(resolveStoredPath(record.thumbnailUrl || ''));
    return json(res, 200, { success: true });
}

function handleUpdateAdminSettings(body, res) {
    const system = readSystemConfig();
    const hasApiKey = Object.prototype.hasOwnProperty.call(body, 'apiKey');
    const next = {
        ...system,
        allowNewRegistration: body.allowNewRegistration !== false,
        apiBaseUrl: normalizeApiBaseUrl(body.apiBaseUrl || system.apiBaseUrl),
        apiKey: hasApiKey ? String(body.apiKey ?? '').trim() : system.apiKey,
        qualities: normalizeQualitySettings(body.qualities || system.qualities)
    };
    writeSystemConfig(next);
    return json(res, 200, { settings: sanitizeSystemConfig(next) });
}

function handleAdminUserStatus(targetUserId, body, res) {
    const userId = parseUserId(targetUserId);
    if (!userId) return json(res, 400, { error: 'Invalid target userId' });
    if (isAdmin(userId)) return json(res, 400, { error: '管理员不能被禁用' });
    const status = body.status === 'disabled' ? 'disabled' : 'active';

    const users = readUsersMeta();
    const index = users.findIndex((item) => String(item.userId) === String(userId));
    if (index === -1) return json(res, 404, { error: '用户不存在' });
    users[index].status = status;
    users[index].lastSeenAt = new Date().toISOString();
    writeUsersMeta(users);
    return json(res, 200, { success: true, user: users[index] });
}

function handleAdminDeleteUser(targetUserId, res) {
    const userId = parseUserId(targetUserId);
    if (!userId) return json(res, 400, { error: 'Invalid target userId' });
    if (isAdmin(userId)) return json(res, 400, { error: '管理员不能被删除' });

    const history = readHistory();
    const relatedRecords = history.filter((item) => String(item.userId) === String(userId));
    const remained = history.filter((item) => String(item.userId) !== String(userId));
    relatedRecords.forEach((record) => {
        safeUnlink(resolveStoredPath(record.imageUrl || ''));
        safeUnlink(resolveStoredPath(record.thumbnailUrl || ''));
        runtimeTasks.delete(String(record.id));
        removeTaskFromQueue(record.id);
    });
    writeHistory(remained);

    Array.from(runtimeTasks.values()).forEach((task) => {
        if (String(task.userId) === String(userId)) {
            runtimeTasks.delete(String(task.id));
            removeTaskFromQueue(task.id);
        }
    });

    removeUserDirectory(userId);
    writeUsersMeta(readUsersMeta().filter((item) => String(item.userId) !== String(userId)));
    return json(res, 200, { success: true });
}

function handleServeImage(requestPath, searchParams, res) {
    const userId = parseUserId(searchParams.get('userId'));
    if (!userId) return json(res, 400, { error: 'Missing or invalid userId' });

    const access = ensureUserAccess(userId);
    if (!access.ok) return json(res, access.statusCode, { error: access.message, code: access.code });

    const decodedPath = decodeURIComponent(requestPath);
    const filePath = resolveStoredPath(decodedPath);

    if (!filePath.startsWith(DATA_DIR)) return json(res, 403, { error: 'Forbidden' });

    if (isAdmin(userId)) return serveFile(filePath, res);

    const normalized = normalizedRequestPath(decodedPath);
    const ownPrefix = `image/users/${userId}/`;
    if (!normalized.startsWith(ownPrefix)) return json(res, 403, { error: 'Forbidden' });
    return serveFile(filePath, res);
}

function ensureStorage() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR, { recursive: true });
}

function ensureSystemConfig() {
    if (!fs.existsSync(SYSTEM_PATH)) {
        writeSystemConfig({
            adminUserId: DEFAULT_ADMIN_USER_ID,
            allowNewRegistration: true,
            apiBaseUrl: DEFAULT_API_BASE_URL,
            apiKey: DEFAULT_API_KEY
        });
    }
    if (!fs.existsSync(USERS_META_PATH)) {
        writeUsersMeta([]);
    }
    syncAdminMeta();
}

function migrateLegacyData() {
    if (!fs.existsSync(LEGACY_HISTORY_PATH)) return;
    const legacyHistory = readLegacyHistory();
    if (legacyHistory.length === 0) return;

    const current = readHistory();
    const existingIds = new Set(current.map((item) => String(item.id)));
    let changed = false;

    legacyHistory.forEach((record) => {
        const normalized = migrateLegacyRecord(record);
        if (!normalized) return;
        if (existingIds.has(String(normalized.id))) return;
        current.push(normalized);
        existingIds.add(String(normalized.id));
        changed = true;
    });

    if (changed) writeHistory(current);
}

function syncUsersFromHistory() {
    const history = readHistory();
    const users = readUsersMeta();
    const map = new Map(users.map((item) => [String(item.userId), item]));
    const adminUserId = getConfiguredAdminUserId();
    const resolvedAdminUserId = adminUserId;

    history.forEach((record) => {
        const userId = String(record.userId || '');
        if (!userId) return;
        if (!map.has(userId)) {
            map.set(userId, buildDefaultUserMeta(userId, userId === resolvedAdminUserId ? 'admin' : 'user', record.createdAt || new Date().toISOString()));
        }
        const meta = map.get(userId);
        const seenAt = record.finishedAt || record.createdAt || record.queuedAt || meta.lastSeenAt;
        if (!meta.lastSeenAt || new Date(seenAt).getTime() > new Date(meta.lastSeenAt).getTime()) {
            meta.lastSeenAt = seenAt;
        }
    });

    writeUsersMeta(Array.from(map.values()).sort((a, b) => String(a.userId).localeCompare(String(b.userId))));
}

function hydrateRuntimeTasksFromHistory() {
    readHistory().forEach((record) => {
        runtimeTasks.set(String(record.id), {
            id: String(record.id),
            userId: String(record.userId || getConfiguredAdminUserId() || LEGACY_ADMIN_USER_ID),
            prompt: record.prompt || '',
            model: record.model || '',
            ratio: record.ratio || '1x1',
            images: [],
            status: record.status || 'success',
            queuedAt: record.queuedAt || record.createdAt || new Date().toISOString(),
            startedAt: record.startedAt || record.createdAt || null,
            finishedAt: record.finishedAt || record.createdAt || null,
            createdAt: record.createdAt || null,
            imageUrl: normalizeRecordPath(record.imageUrl || ''),
            thumbnailUrl: normalizeRecordPath(record.thumbnailUrl || ''),
            errorMessage: record.errorMessage || '',
            requestMeta: record.requestMeta || null
        });
    });
}

function startQueue() {
    if (queueTimer) return;
    queueTimer = setInterval(processQueue, 200);
}

async function processQueue() {
    if (pendingQueue.length === 0) {
        if (queueTimer) {
            clearInterval(queueTimer);
            queueTimer = null;
        }
        return;
    }
    if (Date.now() - lastSubmitAt < TASK_SUBMIT_INTERVAL) return;

    const taskId = pendingQueue.shift();
    const task = runtimeTasks.get(String(taskId));
    if (!task || task.status !== 'queued') return;

    lastSubmitAt = Date.now();
    task.status = 'processing';
    task.startedAt = new Date().toISOString();

    try {
        const system = readSystemConfig();
        const requestUrl = `${normalizeApiBaseUrl(system.apiBaseUrl)}/v1/images/generations`;
        const modelId = resolveQualityModelId(task.model, system.qualities);
        const requestBody = {
            model: modelId,
            prompt: task.prompt,
            image: task.images
        };
        if (!task.images || task.images.length === 0) requestBody.n = 1;
        if (task.ratio && task.ratio !== 'ORIGINAL') requestBody.size = task.ratio;
        let finalSize = requestBody.size || '';

        let upstream = await fetch(requestUrl, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${system.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        if (!upstream.ok) {
            const err = await upstream.json().catch(() => ({}));
            const errMsg = String(err.error?.message || err.error || `HTTP ${upstream.status}`);
            const needPixelSize = /divisible by 16|invalid.*size/i.test(errMsg) && requestBody.size && !/^\d{2,}x\d{2,}$/.test(requestBody.size);
            if (needPixelSize) {
                const pixelSize = ratioToPixelSize(requestBody.size, task.model);
                if (pixelSize) {
                    const retryBody = { ...requestBody, size: pixelSize };
                    upstream = await fetch(requestUrl, {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${system.apiKey}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(retryBody)
                    });
                    if (!upstream.ok) {
                        const retryErr = await upstream.json().catch(() => ({}));
                        throw new Error(retryErr.error?.message || retryErr.error || `HTTP ${upstream.status}`);
                    }
                    finalSize = pixelSize;
                } else {
                    throw new Error(errMsg);
                }
            } else {
                throw new Error(errMsg);
            }
        }

        const data = await upstream.json();
        const remoteUrl = data && data.data && data.data[0] && data.data[0].url;
        if (!remoteUrl) throw new Error('No image URL returned by upstream service');

        const saved = await downloadAndSave(remoteUrl, task.userId);
        const record = {
            id: task.id,
            userId: task.userId,
            prompt: task.prompt,
            model: task.model,
            ratio: task.ratio || '1x1',
            imageUrl: saved.publicPath,
            thumbnailUrl: saved.thumbnailPath,
            createdAt: new Date().toISOString(),
            queuedAt: task.queuedAt,
            startedAt: task.startedAt,
            finishedAt: new Date().toISOString(),
            status: 'success',
            errorMessage: '',
            requestMeta: {
                apiUrl: requestUrl,
                modelId: modelId,
                size: finalSize
            }
        };

        upsertHistoryRecord(record);
        runtimeTasks.set(String(task.id), { ...task, ...record, images: [] });
        touchUser(task.userId);
    } catch (error) {
        const failed = {
            ...task,
            status: 'failed',
            finishedAt: new Date().toISOString(),
            errorMessage: error.message || '生成失败，请稍后重试'
        };
        runtimeTasks.set(String(task.id), failed);
        upsertHistoryRecord({
            id: failed.id,
            userId: failed.userId,
            prompt: failed.prompt,
            model: failed.model,
            ratio: failed.ratio,
            imageUrl: '',
            thumbnailUrl: '',
            createdAt: failed.createdAt || failed.queuedAt,
            queuedAt: failed.queuedAt,
            startedAt: failed.startedAt,
            finishedAt: failed.finishedAt,
            status: 'failed',
            errorMessage: failed.errorMessage
        });
    }
}

function countUserActiveTasks(userId) {
    let count = 0;
    runtimeTasks.forEach((task) => {
        if (String(task.userId) !== String(userId)) return;
        if (task.status === 'queued' || task.status === 'processing') count += 1;
    });
    return count;
}

function getRuntimeTasksForUser(userId, targetUserId = '') {
    const normalizedTarget = parseUserId(targetUserId);
    return Array.from(runtimeTasks.values())
        .filter((task) => {
            if (!isAdmin(userId)) return String(task.userId) === String(userId);
            if (!normalizedTarget) return true;
            return String(task.userId) === String(normalizedTarget);
        })
        .sort((a, b) => {
            const timeDiff = getTaskSortTime(b) - getTaskSortTime(a);
            if (timeDiff !== 0) return timeDiff;
            return String(b.id).localeCompare(String(a.id));
        })
        .map((task) => sanitizeTask(task));
}

function getTaskSortTime(task) {
    const source = task.finishedAt || task.createdAt || task.startedAt || task.queuedAt || '';
    const value = new Date(source).getTime();
    return Number.isNaN(value) ? 0 : value;
}

function sanitizeTask(task) {
    return {
        id: String(task.id),
        userId: String(task.userId),
        prompt: task.prompt || '',
        model: task.model || '',
        ratio: task.ratio || '1x1',
        status: task.status || 'queued',
        imageUrl: task.imageUrl || '',
        thumbnailUrl: task.thumbnailUrl || '',
        queuedAt: task.queuedAt || null,
        startedAt: task.startedAt || null,
        finishedAt: task.finishedAt || null,
        createdAt: task.createdAt || null,
        errorMessage: task.errorMessage || '',
        queuePosition: task.status === 'queued' ? getQueuePosition(task.id) : 0,
        requestMeta: task.requestMeta || null
    };
}

function getQueuePosition(taskId) {
    const index = pendingQueue.findIndex((item) => String(item) === String(taskId));
    return index === -1 ? 0 : index + 1;
}

function getHistoryPage(userId, page, pageSize, targetUserId = '') {
    const tasks = getRuntimeTasksForUser(userId, targetUserId);
    const start = (page - 1) * pageSize;
    const records = tasks.slice(start, start + pageSize);
    return {
        records,
        pagination: {
            page,
            pageSize,
            total: tasks.length,
            hasMore: start + pageSize < tasks.length
        }
    };
}

function readHistory() {
    if (!fs.existsSync(HISTORY_PATH)) fs.writeFileSync(HISTORY_PATH, '[]', 'utf8');
    try {
        const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.error(`Failed to read history file ${HISTORY_PATH}: ${error.message}`);
        return [];
    }
}

function writeHistory(records) {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(records, null, 2), 'utf8');
}

function upsertHistoryRecord(record) {
    const history = readHistory();
    const index = history.findIndex((item) => String(item.id) === String(record.id));
    const normalized = {
        id: String(record.id),
        userId: String(record.userId || getConfiguredAdminUserId() || LEGACY_ADMIN_USER_ID),
        prompt: record.prompt || '',
        model: record.model || '',
        ratio: record.ratio || '1x1',
        imageUrl: normalizeRecordPath(record.imageUrl || ''),
        thumbnailUrl: normalizeRecordPath(record.thumbnailUrl || ''),
        createdAt: record.createdAt || new Date().toISOString(),
        queuedAt: record.queuedAt || null,
        startedAt: record.startedAt || null,
        finishedAt: record.finishedAt || null,
        status: record.status || 'success',
        errorMessage: record.errorMessage || '',
        requestMeta: record.requestMeta || null
    };
    if (index === -1) history.push(normalized);
    else history[index] = normalized;
    writeHistory(history);
}

async function downloadAndSave(remoteUrl, userId) {
    const response = await fetch(remoteUrl);
    if (!response.ok) throw new Error(`Failed to download image: HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = response.headers.get('content-type') || 'image/png';
    const ext = contentType.includes('jpeg') ? '.jpg' : contentType.includes('webp') ? '.webp' : '.png';
    const basename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const filename = `${basename}${ext}`;
    const thumbFilename = `${basename}.jpg`;

    const userPaths = ensureUserDirectories(userId);
    const filePath = path.join(userPaths.imageDir, filename);
    const thumbPath = path.join(userPaths.thumbDir, thumbFilename);
    fs.writeFileSync(filePath, buffer);
    const thumbnailCreated = await createThumbnail(filePath, thumbPath);

    return {
        publicPath: `/image/users/${userId}/${filename}`,
        thumbnailPath: thumbnailCreated ? `/image/users/${userId}/thumb/${thumbFilename}` : `/image/users/${userId}/${filename}`
    };
}

async function createThumbnail(input, outputPath) {
    try {
        await sharp(input)
            .rotate()
            .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 78, mozjpeg: true })
            .toFile(outputPath);
        return true;
    } catch (error) {
        console.warn('Thumbnail generation failed:', error.message);
        return false;
    }
}

function ensureUserDirectories(userId) {
    const userDir = path.join(USERS_DIR, String(userId));
    const imageDir = path.join(userDir, 'images');
    const thumbDir = path.join(userDir, 'thumb');
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    if (!fs.existsSync(imageDir)) fs.mkdirSync(imageDir, { recursive: true });
    if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });
    return { userDir, imageDir, thumbDir };
}

function readLegacyHistory() {
    try {
        const raw = fs.readFileSync(LEGACY_HISTORY_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        return [];
    }
}

function migrateLegacyRecord(record) {
    if (!record || !record.imageUrl) return null;
    const imageSource = resolveLegacyPath(record.imageUrl);
    if (!fs.existsSync(imageSource)) return null;

    const userPaths = ensureUserDirectories(LEGACY_ADMIN_USER_ID);
    const imageFilename = path.basename(imageSource);
    const imageTarget = path.join(userPaths.imageDir, imageFilename);
    if (!fs.existsSync(imageTarget)) fs.copyFileSync(imageSource, imageTarget);

    let thumbnailPath = '';
    if (record.thumbnailUrl) {
        const thumbSource = resolveLegacyPath(record.thumbnailUrl);
        if (fs.existsSync(thumbSource)) {
            const thumbFilename = path.basename(thumbSource);
            const thumbTarget = path.join(userPaths.thumbDir, thumbFilename);
            if (!fs.existsSync(thumbTarget)) fs.copyFileSync(thumbSource, thumbTarget);
            thumbnailPath = `/image/users/${LEGACY_ADMIN_USER_ID}/thumb/${thumbFilename}`;
        }
    }

    if (!thumbnailPath) {
        thumbnailPath = `/image/users/${LEGACY_ADMIN_USER_ID}/${imageFilename}`;
    }

    return {
        id: String(record.id),
        userId: LEGACY_ADMIN_USER_ID,
        prompt: record.prompt || '',
        model: record.model || '',
        ratio: record.ratio || '1x1',
        imageUrl: `/image/users/${LEGACY_ADMIN_USER_ID}/${imageFilename}`,
        thumbnailUrl: thumbnailPath,
        createdAt: record.createdAt || new Date().toISOString(),
        queuedAt: record.queuedAt || record.createdAt || new Date().toISOString(),
        startedAt: record.startedAt || record.createdAt || null,
        finishedAt: record.finishedAt || record.createdAt || null,
        status: record.status || 'success',
        errorMessage: record.errorMessage || ''
    };
}

function parseUserId(value) {
    const normalized = String(value || '').trim();
    if (!/^\d{6,20}$/.test(normalized)) return '';
    return normalized;
}

function isAdmin(userId) {
    const normalized = parseUserId(userId);
    if (!normalized) return false;
    const adminUserId = getConfiguredAdminUserId();
    if (adminUserId) return normalized === adminUserId;
    return normalized === LEGACY_ADMIN_USER_ID;
}

function assertAdmin(userId, res) {
    if (!userId || !isAdmin(userId)) {
        json(res, 403, { error: 'Forbidden' });
        return false;
    }
    return true;
}

function ensureUserAccess(userId) {
    const normalized = parseUserId(userId);
    if (!normalized) return { ok: false, statusCode: 400, code: 'INVALID_USER_ID', message: 'Missing or invalid userId' };
    if (isAdmin(normalized)) {
        touchUser(normalized, 'admin');
        return { ok: true };
    }

    const users = readUsersMeta();
    const index = users.findIndex((item) => String(item.userId) === String(normalized));
    const system = readSystemConfig();

    if (index === -1) {
        if (!system.allowNewRegistration) {
            return { ok: false, statusCode: 403, code: 'REGISTRATION_DISABLED', message: '当前不允许新用户注册' };
        }
        const shouldPromoteToAdmin = !parseUserId(system.adminUserId) && !users.some((item) => String(item.role || '') === 'admin');
        users.push(buildDefaultUserMeta(normalized, shouldPromoteToAdmin ? 'admin' : 'user'));
        writeUsersMeta(users);
        if (shouldPromoteToAdmin) {
            writeSystemConfig({
                ...system,
                adminUserId: normalized
            });
        }
        return { ok: true };
    }

    if (users[index].status === 'disabled') {
        return { ok: false, statusCode: 403, code: 'USER_DISABLED', message: '账号已被禁用' };
    }

    users[index].lastSeenAt = new Date().toISOString();
    writeUsersMeta(users);
    return { ok: true };
}

function buildDefaultUserMeta(userId, role = 'user', createdAt = new Date().toISOString()) {
    return {
        userId: String(userId),
        role,
        status: 'active',
        createdAt,
        lastSeenAt: createdAt
    };
}

function touchUser(userId, role = 'user') {
    const users = readUsersMeta();
    const index = users.findIndex((item) => String(item.userId) === String(userId));
    if (index === -1) {
        users.push(buildDefaultUserMeta(userId, role));
    } else {
        users[index].lastSeenAt = new Date().toISOString();
        if (role === 'admin') {
            users[index].role = 'admin';
            users[index].status = 'active';
        }
    }
    writeUsersMeta(users);
}

function syncAdminMeta() {
    const adminUserId = getConfiguredAdminUserId();
    if (!adminUserId) return;
    touchUser(adminUserId, 'admin');
}

function readSystemConfig() {
    try {
        const raw = fs.readFileSync(SYSTEM_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return {
            adminUserId: parseUserId(parsed.adminUserId) || DEFAULT_ADMIN_USER_ID,
            allowNewRegistration: parsed.allowNewRegistration !== false,
            apiBaseUrl: normalizeApiBaseUrl(parsed.apiBaseUrl || DEFAULT_API_BASE_URL),
            apiKey: String(parsed.apiKey || DEFAULT_API_KEY),
            qualities: normalizeQualitySettings(parsed.qualities)
        };
    } catch (error) {
        console.error(`Failed to read system config ${SYSTEM_PATH}: ${error.message}`);
        return {
            adminUserId: DEFAULT_ADMIN_USER_ID,
            allowNewRegistration: true,
            apiBaseUrl: DEFAULT_API_BASE_URL,
            apiKey: DEFAULT_API_KEY,
            qualities: normalizeQualitySettings(DEFAULT_QUALITY_SETTINGS)
        };
    }
}

function getActiveModelIdForQuality(qualityKey) {
    const qualities = normalizeQualitySettings(readSystemConfig().qualities);
    const key = String(qualityKey || '').toLowerCase();
    if (qualities[key] && qualities[key].enabled) return qualities[key].modelId;
    return '';
}

function resolveQualityModelId(qualityKey, qualities) {
    const normalized = normalizeQualitySettings(qualities);
    const key = String(qualityKey || '').toLowerCase();
    if (normalized[key] && normalized[key].enabled) return normalized[key].modelId;
    const matchedEntry = Object.entries(normalized).find(([, value]) => value.modelId === qualityKey);
    if (matchedEntry && matchedEntry[1].enabled) return matchedEntry[1].modelId;
    return normalized['1k'].enabled ? normalized['1k'].modelId : (normalized['4k'].enabled ? normalized['4k'].modelId : normalized['2k'].modelId);
}

function writeSystemConfig(system) {
    const normalized = {
        adminUserId: parseUserId(system.adminUserId) || DEFAULT_ADMIN_USER_ID,
        allowNewRegistration: system.allowNewRegistration !== false,
        apiBaseUrl: normalizeApiBaseUrl(system.apiBaseUrl || DEFAULT_API_BASE_URL),
        apiKey: Object.prototype.hasOwnProperty.call(system, 'apiKey') ? String(system.apiKey ?? '').trim() : DEFAULT_API_KEY,
        qualities: normalizeQualitySettings(system.qualities)
    };
    fs.writeFileSync(SYSTEM_PATH, JSON.stringify(normalized, null, 2), 'utf8');
}

function sanitizeSystemConfig(system) {
    const qualities = normalizeQualitySettings(system.qualities);
    return {
        adminUserId: parseUserId(system.adminUserId) || DEFAULT_ADMIN_USER_ID,
        allowNewRegistration: system.allowNewRegistration !== false,
        apiBaseUrl: normalizeApiBaseUrl(system.apiBaseUrl || DEFAULT_API_BASE_URL),
        apiKey: String(system.apiKey || ''),
        apiKeyMasked: maskApiKey(system.apiKey || ''),
        hasApiKey: Boolean(system.apiKey),
        qualities,
        qualityList: getQualityList(qualities)
    };
}

function readUsersMeta() {
    try {
        const raw = fs.readFileSync(USERS_META_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.error(`Failed to read users meta ${USERS_META_PATH}: ${error.message}`);
        return [];
    }
}

function writeUsersMeta(users) {
    fs.writeFileSync(USERS_META_PATH, JSON.stringify(users, null, 2), 'utf8');
}

function getUserMeta(userId) {
    return readUsersMeta().find((item) => String(item.userId) === String(userId)) || null;
}

function getAdminUsersPayload() {
    const users = readUsersMeta();
    const history = readHistory();
    const statsMap = new Map();
    const adminUserId = getConfiguredAdminUserId();

    history.forEach((record) => {
        const userId = String(record.userId || '');
        if (!userId) return;
        if (!statsMap.has(userId)) statsMap.set(userId, 0);
        if (record.status === 'success' && record.imageUrl) {
            statsMap.set(userId, statsMap.get(userId) + 1);
        }
    });

    const records = users.map((user) => ({
        userId: String(user.userId),
        role: user.role || 'user',
        status: user.status || 'active',
        createdAt: user.createdAt || null,
        lastSeenAt: user.lastSeenAt || null,
        generatedCount: statsMap.get(String(user.userId)) || 0
    })).sort((a, b) => {
        const timeDiff = getSortTime(a.createdAt) - getSortTime(b.createdAt);
        if (timeDiff !== 0) return timeDiff;
        return String(a.userId).localeCompare(String(b.userId));
    });

    return {
        summary: {
            totalUsers: records.length,
            activeUsers: records.filter((item) => item.status === 'active').length,
            disabledUsers: records.filter((item) => item.status === 'disabled').length,
            totalImages: records.reduce((sum, item) => sum + item.generatedCount, 0)
        },
        records
    };
}

function getGlobalHistoryPath() {
    return HISTORY_PATH;
}

function getConfiguredAdminUserId() {
    const system = readSystemConfig();
    return parseUserId(system.adminUserId) || '';
}

function getSortTime(value) {
    const time = new Date(value || '').getTime();
    return Number.isNaN(time) ? 0 : time;
}

function normalizeQualitySettings(input) {
    const source = input && typeof input === 'object' ? input : {};
    return {
        '1k': normalizeQualityItem(source['1k'], DEFAULT_QUALITY_SETTINGS['1k']),
        '2k': normalizeQualityItem(source['2k'], DEFAULT_QUALITY_SETTINGS['2k']),
        '4k': normalizeQualityItem(source['4k'], DEFAULT_QUALITY_SETTINGS['4k'])
    };
}

function normalizeQualityItem(item, fallback) {
    const source = item && typeof item === 'object' ? item : {};
    return {
        enabled: source.enabled !== false && source.enabled !== 'false',
        modelId: String(source.modelId || fallback.modelId || '').trim() || fallback.modelId
    };
}

function getQualityList(qualities) {
    const normalized = normalizeQualitySettings(qualities);
    return [
        { key: '1k', label: '1K', ...normalized['1k'] },
        { key: '2k', label: '2K', ...normalized['2k'] },
        { key: '4k', label: '4K', ...normalized['4k'] }
    ];
}

function ratioToPixelSize(ratio, qualityKey) {
    const parts = String(ratio || '').split('x');
    if (parts.length !== 2) return '';
    const rw = Number.parseInt(parts[0], 10);
    const rh = Number.parseInt(parts[1], 10);
    if (!rw || !rh || rw <= 0 || rh <= 0) return '';
    const BASE_PIXELS = { '1k': 1920, '2k': 2560, '4k': 3840 };
    const base = BASE_PIXELS[String(qualityKey || '').toLowerCase()] || 1920;
    let pixelW, pixelH;
    if (rw >= rh) {
        pixelW = base;
        pixelH = Math.max(16, Math.round(base * rh / rw / 16) * 16);
    } else {
        pixelH = base;
        pixelW = Math.max(16, Math.round(base * rw / rh / 16) * 16);
    }
    return `${pixelW}x${pixelH}`;
}

function removeTaskFromQueue(taskId) {
    const index = pendingQueue.findIndex((item) => String(item) === String(taskId));
    if (index > -1) pendingQueue.splice(index, 1);
}

function safeUnlink(filePath) {
    if (!filePath) return;
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (error) {
        console.warn('Failed to remove file:', filePath, error.message);
    }
}

function removeUserDirectory(userId) {
    const userDir = path.join(USERS_DIR, String(userId));
    try {
        if (fs.existsSync(userDir)) fs.rmSync(userDir, { recursive: true, force: true });
    } catch (error) {
        console.warn('Failed to remove user directory:', userDir, error.message);
    }
}

function normalizedRequestPath(requestPath) {
    return path.normalize(requestPath).replace(/^([.][.][/\\])+/, '').replace(/^[/\\]+/, '').replace(/\\/g, '/');
}

function resolveStoredPath(requestPath) {
    const normalized = normalizedRequestPath(String(requestPath || '').split('?')[0]);
    if (normalized.startsWith('image/users/')) {
        const relative = normalized.slice('image/users/'.length);
        const parts = relative.split('/').filter(Boolean);
        const userId = parts.shift() || '';
        if (!userId) return path.join(USERS_DIR, relative);
        if (parts[0] === 'thumb') return path.join(USERS_DIR, userId, 'thumb', ...parts.slice(1));
        if (parts[0] === 'images') return path.join(USERS_DIR, userId, 'images', ...parts.slice(1));
        return path.join(USERS_DIR, userId, 'images', ...parts);
    }
    if (normalized.startsWith('image/')) {
        return path.join(LEGACY_IMAGE_DIR, normalized.slice('image/'.length));
    }
    return path.join(ROOT_DIR, normalized);
}

function normalizeRecordPath(pathValue) {
    if (!pathValue) return '';
    return pathValue.split('?')[0];
}

function resolveLegacyPath(publicPath) {
    const trimmed = String(publicPath || '').split('?')[0];
    const normalized = path.normalize(trimmed).replace(/^([.][.][/\\])+/, '').replace(/^[/\\]+/, '');
    return path.join(ROOT_DIR, normalized);
}

function normalizeApiBaseUrl(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    return trimmed.replace(/\/+$/, '');
}

function maskApiKey(value) {
    const text = String(value || '');
    if (!text) return '';
    if (text.length <= 8) return '*'.repeat(text.length);
    return `${text.slice(0, 4)}${'*'.repeat(Math.max(4, text.length - 8))}${text.slice(-4)}`;
}

async function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 50 * 1024 * 1024) {
                reject(new Error('Request body too large'));
                req.destroy();
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (error) {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

function serveStatic(requestPath, res) {
    const filePath = resolveSafePath(requestPath);
    if (!filePath.startsWith(ROOT_DIR)) return json(res, 403, { error: 'Forbidden' });
    serveFile(filePath, res);
}

function resolveSafePath(requestPath) {
    const normalized = path.normalize(requestPath).replace(/^([.][.][/\\])+/, '');
    const trimmed = normalized.replace(/^[/\\]+/, '');
    return path.join(ROOT_DIR, trimmed);
}

function serveFile(filePath, res) {
    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            return json(res, 404, { error: 'File not found' });
        }
        res.writeHead(200, {
            'Content-Type': getContentType(filePath),
            'Cache-Control': 'no-store'
        });
        const stream = fs.createReadStream(filePath);
        stream.on('error', () => {
            if (!res.headersSent) json(res, 500, { error: 'Failed to read file' });
            else res.end();
        });
        stream.pipe(res);
    });
}

function getContentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html') return 'text/html; charset=utf-8';
    if (ext === '.css') return 'text/css; charset=utf-8';
    if (ext === '.js') return 'application/javascript; charset=utf-8';
    if (ext === '.json') return 'application/json; charset=utf-8';
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    return 'application/octet-stream';
}

function json(res, statusCode, payload) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
}
