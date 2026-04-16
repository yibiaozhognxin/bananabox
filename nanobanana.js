const API_BASE = '';
const HISTORY_PAGE_SIZE = 24;
const TASK_POLL_INTERVAL = 3000;
const USER_STORAGE_KEY = 'nanobanana.userId';

let uploadedFiles = [];
let tasks = [];
let currentUserId = '';
let currentSession = null;
let taskPollTimer = null;
let adminSettingsState = null;
let apiKeyVisible = false;
let adminApiKeyDraft = '';
let qualitySettingsState = null;
let selectedQualityKey = '1k';
let selectedRatioKey = '1x1';

const previewUrlStore = new WeakMap();
const loadedTaskIds = new Set();
const historyState = {
    page: 1,
    pageSize: HISTORY_PAGE_SIZE,
    hasMore: true,
    loading: false,
    initialLoaded: false
};

let editorState = {
    active: false,
    image: null,
    paths: [],
    currentPath: [],
    isDrawing: false,
    currentColor: '#ef4444',
    currentColorName: '红色区域',
    scale: 1,
    prompts: {}
};

const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');
const previewList = document.getElementById('previewList');
const gallery = document.getElementById('gallery');
const promptInput = document.getElementById('promptInput');
const submitBtn = document.getElementById('submitBtn');
const editorModal = document.getElementById('editorModal');
const canvas = document.getElementById('editorCanvas');
const ctx = canvas.getContext('2d');
const boxListEl = document.getElementById('boxList');
const ratioSelect = document.getElementById('ratioSelect');
const legacyRatioSelect = document.getElementById('legacyRatioSelect');
const qualityLabelEl = document.getElementById('qualityLabel');
const ratioLabelEl = document.getElementById('ratioLabel');
const qualityChip = document.getElementById('qualityChip');
const qualityPopover = document.getElementById('qualityPopover');
const qualityGrid = document.getElementById('qualityGrid');
const ratioChip = document.getElementById('ratioChip');
const ratioPopover = document.getElementById('ratioPopover');
const ratioGrid = document.getElementById('ratioGrid');
const modalPromptEl = document.getElementById('modalPrompt');
const modalQualityEl = document.getElementById('modalQuality');
const modalRatioEl = document.getElementById('modalRatio');
const modalCreatedAtEl = document.getElementById('modalCreatedAt');
const modalCopyPromptBtn = document.getElementById('modalCopyPromptBtn');
const imageModal = document.getElementById('imageModal');
const modalImg = document.getElementById('modalImg');
const historyStatus = document.getElementById('historyStatus');
const loadMoreBtn = document.getElementById('loadMoreBtn');
const userModal = document.getElementById('userModal');
const userIdInput = document.getElementById('userIdInput');
const userModalError = document.getElementById('userModalError');
const confirmUserBtn = document.getElementById('confirmUserBtn');
const switchUserBtn = document.getElementById('switchUserBtn');
const currentUserText = document.getElementById('currentUserText');
const adminBadge = document.getElementById('adminBadge');
const adminSettingsBtn = document.getElementById('adminSettingsBtn');
const adminModal = document.getElementById('adminModal');
const closeAdminModalBtn = document.getElementById('closeAdminModalBtn');
const allowRegistrationToggle = document.getElementById('allowRegistrationToggle');
const apiBaseUrlInput = document.getElementById('apiBaseUrlInput');
const apiKeyInput = document.getElementById('apiKeyInput');
const toggleApiKeyBtn = document.getElementById('toggleApiKeyBtn');
const saveAdminSettingsBtn = document.getElementById('saveAdminSettingsBtn');
const adminUserList = document.getElementById('adminUserList');
const adminSummary = document.getElementById('adminSummary');
const adminQualityList = document.getElementById('adminQualityList');

const imageLazyObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            const img = entry.target;
            const source = img.dataset.src;
            if (source && img.src !== source) img.src = source;
            imageLazyObserver.unobserve(img);
        });
    }, { root: null, rootMargin: '300px 0px', threshold: 0.01 })
    : null;

fileInput.setAttribute('accept', 'image/*');

qualitySettingsState = getDefaultQualitySettings();

if (promptInput) {
    promptInput.addEventListener('input', () => {
        autoResize(promptInput);
        syncComposerCompactState();
    });
    promptInput.addEventListener('keydown', (event) => {
        if (event.isComposing) return;
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submitTask();
        }
    });
    promptInput.addEventListener('focus', () => {
        setComposerCompact(false);
        autoResize(promptInput);
    });
    promptInput.addEventListener('blur', () => {
        syncComposerCompactState();
    });
}

if (gallery) {
    gallery.addEventListener('scroll', syncComposerCompactState, { passive: true });
}

window.addEventListener('scroll', syncComposerCompactState, { passive: true });

loadMoreBtn.addEventListener('click', () => {
    if (!currentUserId) return;
    loadHistory({ append: true });
});

switchUserBtn.addEventListener('click', () => {
    openUserModal(true);
});

if (adminSettingsBtn) {
    adminSettingsBtn.addEventListener('click', () => {
        if (!isAdmin()) return;
        openAdminModal();
    });
}

if (closeAdminModalBtn) closeAdminModalBtn.addEventListener('click', closeAdminModal);

if (toggleApiKeyBtn) {
    toggleApiKeyBtn.addEventListener('click', () => {
        apiKeyVisible = !apiKeyVisible;
        apiKeyInput.type = apiKeyVisible ? 'text' : 'password';
        if (apiKeyVisible) adminApiKeyDraft = apiKeyInput.value;
        toggleApiKeyBtn.textContent = apiKeyVisible ? '隐藏' : '显示';
    });
}

if (apiKeyInput) {
    apiKeyInput.addEventListener('input', () => {
        adminApiKeyDraft = apiKeyInput.value;
    });
}

if (saveAdminSettingsBtn) saveAdminSettingsBtn.addEventListener('click', saveAdminSettings);
if (adminUserList) adminUserList.addEventListener('click', handleAdminUserAction);

confirmUserBtn.addEventListener('click', () => {
    commitUserId();
});

userIdInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        commitUserId();
    }
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files) {
        const newFiles = Array.from(e.target.files);
        appendUploadedFiles(newFiles);
        fileInput.value = '';
    }
});

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const newFiles = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
        appendUploadedFiles(newFiles);
    }
});

function openUserModal(isSwitch = false) {
    userModal.classList.add('active');
    userModalError.hidden = true;
    userModalError.textContent = '';
    userIdInput.value = isSwitch ? '' : (currentUserId || localStorage.getItem(USER_STORAGE_KEY) || '');
    setTimeout(() => userIdInput.focus(), 20);
}

function getDefaultQualitySettings() {
    return {
        '1k': { enabled: false, modelId: '' },
        '2k': { enabled: false, modelId: '' },
        '4k': { enabled: false, modelId: '' }
    };
}

function normalizeQualitySettings(qualities) {
    const fallback = getDefaultQualitySettings();
    const source = qualities && typeof qualities === 'object' ? qualities : {};
    return {
        '1k': {
            enabled: source['1k'] ? source['1k'].enabled !== false : fallback['1k'].enabled,
            modelId: String(source['1k'] && source['1k'].modelId ? source['1k'].modelId : fallback['1k'].modelId).trim() || fallback['1k'].modelId
        },
        '2k': {
            enabled: source['2k'] ? source['2k'].enabled !== false : fallback['2k'].enabled,
            modelId: String(source['2k'] && source['2k'].modelId ? source['2k'].modelId : fallback['2k'].modelId).trim() || fallback['2k'].modelId
        },
        '4k': {
            enabled: source['4k'] ? source['4k'].enabled !== false : fallback['4k'].enabled,
            modelId: String(source['4k'] && source['4k'].modelId ? source['4k'].modelId : fallback['4k'].modelId).trim() || fallback['4k'].modelId
        }
    };
}

function getAvailableQualityKeys() {
    return ['1k', '2k', '4k'].filter((key) => qualitySettingsState[key] && qualitySettingsState[key].enabled);
}

function ensureSelectedQuality() {
    const available = getAvailableQualityKeys();
    if (available.length === 0) {
        selectedQualityKey = '1k';
        return;
    }
    if (!available.includes(selectedQualityKey)) {
        selectedQualityKey = available[0];
    }
}

function getSelectedQualityConfig() {
    const key = selectedQualityKey in qualitySettingsState ? selectedQualityKey : '1k';
    return qualitySettingsState[key] || getDefaultQualitySettings()['1k'];
}

function closeUserModal() {
    userModal.classList.remove('active');
}

async function commitUserId() {
    const candidate = String(userIdInput.value || '').trim();
    if (!/^\d{6,20}$/.test(candidate)) {
        userModalError.hidden = false;
        userModalError.textContent = '请输入 6 到 20 位数字ID。';
        return;
    }

    try {
        currentSession = await bootstrapSession(candidate);
    } catch (error) {
        userModalError.hidden = false;
        userModalError.textContent = error.message || '进入失败';
        return;
    }

    currentUserId = candidate;
    localStorage.setItem(USER_STORAGE_KEY, currentUserId);
    syncCurrentUserUi();
    closeUserModal();
    closeAdminModal();
    resetWorkspaceForUser();
    loadHistory();
    startTaskPolling();
}

function resetWorkspaceForUser() {
    revokeAllPreviewUrls(uploadedFiles);
    uploadedFiles = [];
    tasks = [];
    loadedTaskIds.clear();
    previewList.innerHTML = '';
    gallery.innerHTML = '';
    promptInput.value = '';
    autoResize(promptInput);
    historyState.page = 1;
    historyState.hasMore = true;
    historyState.loading = false;
    historyState.initialLoaded = false;
    updateHistoryStatus('正在加载历史记录...');
    syncLoadMoreButton();
}

function setComposerCompact(isCompact) {
    document.body.classList.toggle('composer-compact', Boolean(isCompact));
}

function syncComposerCompactState() {
    const promptFocused = document.activeElement === promptInput;
    const galleryStage = document.querySelector('.gallery-stage');
    const scrolledDown = Boolean(galleryStage && galleryStage.scrollTop > 24);
    setComposerCompact(!promptFocused && scrolledDown);
}

function renderQualityOptions() {
    const qualities = qualitySettingsState || getDefaultQualitySettings();
    const options = [
        { key: '1k', label: '1K', desc: '标准速度' },
        { key: '2k', label: '2K', desc: '平衡细节' },
        { key: '4k', label: '4K', desc: '更高细节' }
    ];

    qualityGrid.innerHTML = '';
    options.forEach((option) => {
        const config = qualities[option.key] || getDefaultQualitySettings()[option.key];
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `quality-option${option.key === selectedQualityKey ? ' active' : ''}`;
        button.dataset.value = option.key;
        button.dataset.label = option.label;
        button.dataset.enabled = config.enabled ? 'true' : 'false';
        button.disabled = !config.enabled;
        button.innerHTML = `
            <span class="quality-badge">${option.label}</span>
            <span class="quality-desc">${config.enabled ? option.desc : '未开启'}</span>
        `;
        qualityGrid.appendChild(button);
    });
}

function syncQualitySelection() {
    ensureSelectedQuality();
    const qualities = qualitySettingsState || getDefaultQualitySettings();
    qualityGrid.querySelectorAll('.quality-option').forEach((option) => {
        option.classList.toggle('active', option.dataset.value === selectedQualityKey);
    });
    qualityLabelEl.textContent = selectedQualityKey.toUpperCase();
}

function syncCurrentUserUi() {
    currentUserText.textContent = currentUserId || '-';
    adminBadge.hidden = !isAdmin();
    if (adminSettingsBtn) adminSettingsBtn.hidden = !isAdmin();
}

function isAdmin() {
    return Boolean(currentSession && currentSession.isAdmin);
}

async function bootstrapSession(userId) {
    const res = await fetch(`${API_BASE}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '进入失败');
    if (data.session && data.session.system) {
        applySystemConfig(data.session.system);
    }
    return data.session || null;
}

function applySystemConfig(system) {
    if (!system) return;
    qualitySettingsState = normalizeQualitySettings(system.qualities || system.qualitySettings || qualitySettingsState);
    renderQualityOptions();
    ensureSelectedQuality();
    syncQualitySelection();
}

function appendUploadedFiles(newFiles) {
    if (!Array.isArray(newFiles) || newFiles.length === 0) return;
    uploadedFiles = [...uploadedFiles, ...newFiles];
    renderPreview();
}

function getPreviewUrl(file) {
    if (!previewUrlStore.has(file)) previewUrlStore.set(file, URL.createObjectURL(file));
    return previewUrlStore.get(file);
}

function revokePreviewUrl(file) {
    const previewUrl = previewUrlStore.get(file);
    if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        previewUrlStore.delete(file);
    }
}

function revokeAllPreviewUrls(files) {
    files.forEach((file) => revokePreviewUrl(file));
}

function updatePreviewIndexes() {
    previewList.querySelectorAll('.preview-item').forEach((item, index) => {
        item.dataset.index = String(index);
        const badge = item.querySelector('.index-badge');
        if (badge) badge.textContent = String(index + 1);
        const editBtn = item.querySelector('.tool-btn.edit');
        const deleteBtn = item.querySelector('.tool-btn.del');
        const previewButton = item.querySelector('.preview-open-btn');
        if (editBtn) editBtn.setAttribute('onclick', `openEditor(${index})`);
        if (deleteBtn) deleteBtn.setAttribute('onclick', `removeFile(${index})`);
        if (previewButton) previewButton.setAttribute('onclick', `openModalByPreviewIndex(${index})`);
    });
}

function buildPreviewItem(file, index) {
    const div = document.createElement('div');
    div.className = 'preview-item';
    div.dataset.index = String(index);
    div.innerHTML = `
        <div class="preview-thumb">
            <button class="preview-open-btn" type="button" onclick="openModalByPreviewIndex(${index})">
                <span class="index-badge">${index + 1}</span>
                <img src="${getPreviewUrl(file)}" alt="Ref">
            </button>
        </div>
        <div class="preview-info">
            <div class="preview-name">${escapeHtml(file.name)}</div>
            <div class="preview-actions">
                <button class="tool-btn edit" onclick="openEditor(${index})">✏️ 编辑</button>
                <button class="tool-btn del" onclick="removeFile(${index})">🗑️ 删除</button>
            </div>
        </div>
    `;
    return div;
}

function renderPreview() {
    previewList.innerHTML = '';
    const fragment = document.createDocumentFragment();
    uploadedFiles.forEach((file, index) => {
        fragment.appendChild(buildPreviewItem(file, index));
    });
    previewList.appendChild(fragment);
}

function removeFile(index) {
    const [removedFile] = uploadedFiles.splice(index, 1);
    if (removedFile) revokePreviewUrl(removedFile);
    const previewItem = previewList.querySelector(`.preview-item[data-index="${index}"]`);
    if (previewItem) {
        previewItem.remove();
        updatePreviewIndexes();
        return;
    }
    renderPreview();
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
    });
}

function getActiveTaskCount() {
    return tasks.filter((task) => task.status === 'queued' || task.status === 'processing').length;
}

async function submitTask(options = {}) {
    if (!currentUserId) {
        openUserModal(false);
        return;
    }

    const prompt = String(options.promptOverride || promptInput.value || '').trim();
    const qualityKey = options.qualityOverride || selectedQualityKey;
    const ratio = options.ratioOverride || ratioSelect.value;
    const filesToUse = Array.isArray(options.filesOverride) ? [...options.filesOverride] : [...uploadedFiles];
    if (!prompt) {
        alert('请输入图片描述');
        return;
    }
    if (getActiveTaskCount() >= 5) {
        alert('当前最多同时进行 5 个任务，请等待已有任务完成后再试');
        return;
    }

    submitBtn.disabled = true;
    const taskId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const currentFiles = [...filesToUse];
    const task = {
        id: taskId,
        userId: currentUserId,
        prompt,
        model: qualityKey,
        ratio,
        status: 'queued',
        queuedAt: new Date().toISOString(),
        createdAt: null,
        imageUrl: '',
        thumbnailUrl: '',
        queuePosition: 0
    };

    tasks.unshift(task);
    createTaskCard(task, true);
    syncTaskOrder();

    if (!options.keepComposerState) {
        promptInput.value = '';
        autoResize(promptInput);
        uploadedFiles = [];
        renderPreview();
        if (!options.filesOverride) revokeAllPreviewUrls(currentFiles);
    }

    try {
        const images = currentFiles.length > 0 ? await Promise.all(currentFiles.map((f) => fileToBase64(f))) : [];
        const res = await fetch(`${API_BASE}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: currentUserId,
                clientTaskId: task.id,
                model: task.model,
                prompt: task.prompt,
                ratio: task.ratio,
                images
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            handleApiError(data, data.error || `HTTP ${res.status}`);
            throw new Error(data.error || `HTTP ${res.status}`);
        }
        mergeTaskRecord(data.task || task);
        await refreshTaskStatuses();
    } catch (error) {
        markTaskFailed(task.id, error.message || '提交失败');
        if (!String(error.message || '').includes('HTTP')) alert(error.message || '提交失败');
    } finally {
        submitBtn.disabled = false;
    }
}

function createTaskCard(task, prepend = false) {
    if (loadedTaskIds.has(String(task.id))) {
        updateTaskCard(task);
        return;
    }
    loadedTaskIds.add(String(task.id));

    const card = document.createElement('div');
    card.className = 'card';
    card.id = `card-${task.id}`;
    const ratioLabel = formatRatioLabel(task.ratio);
    const modelName = getQualityLabel(task.model);
    const userPill = isAdmin() ? `<span class="card-user-pill">用户ID ${escapeHtml(task.userId || '-')}</span>` : '';

    card.innerHTML = `
        <div class="card-img-box" id="img-box-${task.id}">
            <div class="status-overlay" id="status-${task.id}">
                <div class="spinner"></div>
                <div class="timer" id="timer-${task.id}">${getStatusLabel(task)}</div>
                <div class="status-text" id="status-text-${task.id}">${getStatusDescription(task)}</div>
            </div>
            <div class="card-overlay-actions">
                <button class="btn-icon ghost" onclick="copyPrompt('${task.id}'); event.stopPropagation();" id="btn-copy-${task.id}">复制提示词</button>
                <button class="btn-icon ghost danger" onclick="deleteSavedImage('${task.id}'); event.stopPropagation();" id="delete-${task.id}" style="display:none">删除</button>
            </div>
            <img id="img-${task.id}" src="" alt="Result" loading="lazy" decoding="async" draggable="true" ondragstart="event.dataTransfer.setData('text/plain', this.dataset.fullSrc || this.currentSrc || this.src)" onclick="openModalById('${task.id}')">
            ${userPill}
        </div>
        <div class="card-info">
            <div class="card-meta">
                <span class="card-meta-pill">${modelName} | ${ratioLabel}</span>
                <div class="action-buttons">
                    <button class="btn-mini" onclick="editSavedImage('${task.id}')" id="edit-${task.id}" style="display:none">编辑</button>
                    <button class="btn-mini primary" id="dl-${task.id}" style="display:none" onclick="downloadImg('${task.id}')">下载</button>
                </div>
            </div>
        </div>
    `;

    if (prepend) gallery.prepend(card);
    else gallery.appendChild(card);
    updateTaskCard(task);
}

function updateTaskCard(task) {
    const card = document.getElementById(`card-${task.id}`);
    if (!card) return;

    const overlay = document.getElementById(`status-${task.id}`);
    const timerEl = document.getElementById(`timer-${task.id}`);
    const statusTextEl = document.getElementById(`status-text-${task.id}`);
    const img = document.getElementById(`img-${task.id}`);
    const dlBtn = document.getElementById(`dl-${task.id}`);
    const editBtn = document.getElementById(`edit-${task.id}`);
    const deleteBtn = document.getElementById(`delete-${task.id}`);

    if (task.status === 'success') {
        if (overlay) overlay.style.display = 'none';
        if (img) {
            const nextThumb = buildProtectedImageUrl(task.thumbnailUrl || task.imageUrl);
            const nextFull = buildProtectedImageUrl(task.imageUrl || '');
            const thumbChanged = img.dataset.src !== nextThumb;
            const fullChanged = img.dataset.fullSrc !== nextFull;
            img.dataset.fullSrc = nextFull || '';
            if (thumbChanged || fullChanged) {
                img.dataset.src = nextThumb || '';
                img.classList.remove('loaded');
                img.classList.add('is-lazy');
                img.onload = () => {
                    img.classList.add('loaded');
                    img.classList.remove('is-lazy');
                };
                observeImage(img);
            }
        }
        if (dlBtn) dlBtn.style.display = 'block';
        if (editBtn) editBtn.style.display = task.imageUrl ? 'block' : 'none';
        if (deleteBtn) deleteBtn.style.display = 'block';
        card.classList.remove('is-pending');
        return;
    }

    card.classList.add('is-pending');
    if (overlay) overlay.style.display = 'flex';
    if (timerEl) timerEl.textContent = getStatusLabel(task);
    if (statusTextEl) statusTextEl.textContent = getStatusDescription(task);
    if (deleteBtn) deleteBtn.style.display = task.status === 'failed' ? 'block' : 'none';
    if (editBtn) editBtn.style.display = 'none';
    if (dlBtn) dlBtn.style.display = 'none';

    if (task.status === 'failed') {
        card.classList.remove('is-pending');
        if (overlay) {
            overlay.innerHTML = `<div style="font-size:24px;">❌</div><div>生成失败</div><div class="error-msg">${escapeHtml(task.errorMessage || '生成失败')}</div>`;
        }
    }
}

function getStatusLabel(task) {
    if (task.status === 'queued') {
        if (task.queuePosition > 0) return `排队 ${task.queuePosition}`;
        return '排队中';
    }
    if (task.status === 'processing') return '生成中';
    if (task.status === 'failed') return '失败';
    return '完成';
}

function getStatusDescription(task) {
    if (task.status === 'queued') return '任务已进入队列，将按顺序提交';
    if (task.status === 'processing') return '任务已提交到上游，正在生成';
    if (task.status === 'failed') return task.errorMessage || '生成失败';
    return '图片已生成';
}

function getQualityLabel(key) {
    const normalized = String(key || '').toLowerCase();
    if (normalized === '1k') return '1K';
    if (normalized === '2k') return '2K';
    if (normalized === '4k') return '4K';
    const qualities = qualitySettingsState || getDefaultQualitySettings();
    const match = Object.entries(qualities).find(([, value]) => value.modelId === key);
    if (match) return match[0].toUpperCase();
    return '1K';
}

function mergeTaskRecord(record) {
    if (!record || !record.id) return;
    const normalized = {
        ...record,
        id: String(record.id),
        userId: String(record.userId || currentUserId),
        imageUrl: record.imageUrl || '',
        thumbnailUrl: record.thumbnailUrl || '',
        queuePosition: record.queuePosition || 0
    };

    const index = tasks.findIndex((item) => String(item.id) === String(normalized.id));
    if (index === -1) {
        tasks.unshift(normalized);
        createTaskCard(normalized, true);
    } else {
        tasks[index] = { ...tasks[index], ...normalized };
        updateTaskCard(tasks[index]);
    }
    syncTaskOrder();
}

function markTaskFailed(id, msg) {
    const index = tasks.findIndex((task) => String(task.id) === String(id));
    if (index === -1) return;
    tasks[index] = {
        ...tasks[index],
        status: 'failed',
        errorMessage: msg || '生成失败',
        finishedAt: new Date().toISOString()
    };
    updateTaskCard(tasks[index]);
}

async function refreshTaskStatuses() {
    if (!currentUserId) return;
    try {
        const res = await fetch(`${API_BASE}/api/tasks?userId=${encodeURIComponent(currentUserId)}`);
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            handleApiError(data, data.error || '任务状态加载失败');
            return;
        }
        const data = await res.json();
        const records = Array.isArray(data.records) ? data.records : [];
        records.forEach((record) => mergeTaskRecord(record));
        syncActiveTaskHint();
    } catch (error) {
        console.error('Failed to refresh tasks:', error);
    }
}

function startTaskPolling() {
    stopTaskPolling();
    refreshTaskStatuses();
    taskPollTimer = setInterval(refreshTaskStatuses, TASK_POLL_INTERVAL);
}

function stopTaskPolling() {
    if (taskPollTimer) {
        clearInterval(taskPollTimer);
        taskPollTimer = null;
    }
}

function syncActiveTaskHint() {
    const activeCount = getActiveTaskCount();
    submitBtn.title = activeCount >= 5 ? '当前最多同时进行 5 个任务' : '';
}

function getTaskSortTime(task) {
    const source = task.finishedAt || task.createdAt || task.startedAt || task.queuedAt || '';
    const value = new Date(source).getTime();
    return Number.isNaN(value) ? 0 : value;
}

function syncTaskOrder() {
    tasks.sort((a, b) => {
        const timeDiff = getTaskSortTime(b) - getTaskSortTime(a);
        if (timeDiff !== 0) return timeDiff;
        return String(b.id).localeCompare(String(a.id));
    });
    tasks.forEach((task) => {
        const card = document.getElementById(`card-${task.id}`);
        if (card) gallery.appendChild(card);
    });
}

function openModal(src, task = null) {
    if (!src) return;
    modalImg.src = src;
    if (task) {
        modalPromptEl.textContent = task.prompt || '-';
        modalQualityEl.textContent = getQualityLabel(task.model);
        modalRatioEl.textContent = formatRatioLabel(task.ratio);
        modalCreatedAtEl.textContent = formatCreatedAt(task.createdAt || task.finishedAt || task.queuedAt);
    } else {
        modalPromptEl.textContent = '-';
        modalQualityEl.textContent = '-';
        modalRatioEl.textContent = '-';
        modalCreatedAtEl.textContent = '-';
    }
    imageModal.classList.add('active');
}

function openModalById(id) {
    const task = tasks.find((item) => String(item.id) === String(id));
    if (!task || !task.imageUrl) return;
    openModal(buildProtectedImageUrl(task.imageUrl), task);
}

function openModalByPreviewIndex(index) {
    const file = uploadedFiles[index];
    if (!file) return;
    openModal(getPreviewUrl(file));
}

function formatRatioLabel(value) {
    if (value === 'ORIGINAL') return '原比例';
    if (!value) return '-';
    return value.replace('x', ':');
}

function formatCreatedAt(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
}

function downloadImg(id) {
    const img = document.getElementById(`img-${id}`);
    const src = (img && (img.dataset.fullSrc || img.dataset.src || img.currentSrc || img.src)) || '';
    if (!src) return;
    const a = document.createElement('a');
    a.href = src;
    a.download = `nano-banana-${id}.png`;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

function copyPrompt(id) {
    const task = tasks.find((item) => String(item.id) === String(id));
    const text = task && task.prompt ? task.prompt : '';
    if (!text) return;
    copyText(text).then(() => {
        const btn = document.getElementById(`btn-copy-${id}`);
        if (!btn) return;
        btn.innerText = '已复制';
        setTimeout(() => { btn.innerText = '复制提示词'; }, 2000);
    }).catch(() => {
        alert('复制失败，请手动复制');
    });
}

function copyModalPrompt() {
    const text = modalPromptEl.textContent || '';
    if (!text || text === '-') return;
    copyText(text).then(() => {
        if (!modalCopyPromptBtn) return;
        modalCopyPromptBtn.textContent = '已复制';
        setTimeout(() => { modalCopyPromptBtn.textContent = '复制提示词'; }, 1800);
    }).catch(() => {
        alert('复制失败，请手动复制');
    });
}

function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text);
    }

    return new Promise((resolve, reject) => {
        try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.setAttribute('readonly', '');
            textarea.style.position = 'fixed';
            textarea.style.top = '-9999px';
            textarea.style.left = '-9999px';
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            textarea.setSelectionRange(0, textarea.value.length);
            const successful = document.execCommand('copy');
            document.body.removeChild(textarea);
            if (!successful) {
                reject(new Error('Copy command failed'));
                return;
            }
            resolve();
        } catch (error) {
            reject(error);
        }
    });
}

function openEditor(fileIndex) {
    const file = uploadedFiles[fileIndex];
    if (!file) return;
    openEditorWithSource(getPreviewUrl(file));
}

function editSavedImage(id) {
    const task = tasks.find((item) => String(item.id) === String(id));
    if (!task || !task.imageUrl) return;
    openEditorWithSource(buildProtectedImageUrl(task.imageUrl));
}

async function deleteSavedImage(id) {
    const task = tasks.find((item) => String(item.id) === String(id));
    if (!task) return;
    const confirmed = window.confirm('确认删除这张历史图片吗？删除后无法恢复。');
    if (!confirmed) return;

    try {
        const res = await fetch(`${API_BASE}/api/history/${encodeURIComponent(id)}?userId=${encodeURIComponent(currentUserId)}`, {
            method: 'DELETE'
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            handleApiError(data, data.error || `HTTP ${res.status}`);
            throw new Error(data.error || `HTTP ${res.status}`);
        }

        tasks = tasks.filter((item) => String(item.id) !== String(id));
        loadedTaskIds.delete(String(id));
        const card = document.getElementById(`card-${id}`);
        if (card) card.remove();
        syncActiveTaskHint();
        if (tasks.length === 0) updateHistoryStatus('还没有历史图片，先生成一张试试。');
        if (isAdmin() && adminModal.classList.contains('active')) loadAdminPanel();
    } catch (error) {
        if (!String(error.message || '').includes('HTTP')) alert(error.message || '删除失败');
    }
}

function undoLastPath() {
    if (editorState.paths.length === 0) return;
    const lastPath = editorState.paths.pop();
    if (lastPath && lastPath.color) {
        const stillUsed = editorState.paths.some((path) => path.color === lastPath.color);
        if (!stillUsed) editorState.prompts[lastPath.color] = '';
    }
    drawCanvas();
    renderBoxList();
}

function openEditorWithSource(src) {
    editorState.image = new Image();
    editorState.image.crossOrigin = 'anonymous';
    editorState.image.decoding = 'async';
    editorState.image.src = src;
    editorState.image.onload = () => {
        editorState.paths = [];
        editorState.currentPath = [];
        editorState.isDrawing = false;
        editorState.prompts = {};
        document.querySelectorAll('.color-btn').forEach((btn) => {
            editorState.prompts[btn.dataset.color] = '';
        });
        editorState.active = true;
        editorModal.classList.add('active');
        resizeCanvas();
        drawCanvas();
        renderBoxList();
    };
}

function closeEditor() {
    editorModal.classList.remove('active');
    editorState.active = false;
}

function resizeCanvas() {
    if (!editorState.image) return;
    const maxWidth = window.innerWidth * 0.7;
    const maxHeight = window.innerHeight * 0.8;
    const imgW = editorState.image.naturalWidth;
    const imgH = editorState.image.naturalHeight;
    const scale = Math.min(maxWidth / imgW, maxHeight / imgH);
    editorState.scale = scale;
    canvas.width = imgW * scale;
    canvas.height = imgH * scale;
    drawCanvas();
}

function drawCanvas() {
    if (!editorState.image) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(editorState.image, 0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    editorState.paths.forEach((path) => {
        ctx.beginPath();
        ctx.strokeStyle = path.color;
        if (path.points.length > 0) {
            ctx.moveTo(path.points[0].x, path.points[0].y);
            for (let i = 1; i < path.points.length; i += 1) ctx.lineTo(path.points[i].x, path.points[i].y);
        }
        ctx.stroke();
    });
    if (editorState.isDrawing && editorState.currentPath.length > 0) {
        ctx.beginPath();
        ctx.strokeStyle = editorState.currentColor;
        ctx.moveTo(editorState.currentPath[0].x, editorState.currentPath[0].y);
        for (let i = 1; i < editorState.currentPath.length; i += 1) ctx.lineTo(editorState.currentPath[i].x, editorState.currentPath[i].y);
        ctx.stroke();
    }
}

function getCanvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    const clientX = typeof event.clientX === 'number' ? event.clientX : (event.touches && event.touches[0] ? event.touches[0].clientX : 0);
    const clientY = typeof event.clientY === 'number' ? event.clientY : (event.touches && event.touches[0] ? event.touches[0].clientY : 0);
    return { x: clientX - rect.left, y: clientY - rect.top };
}

function endCanvasPath() {
    if (!editorState.isDrawing) return;
    editorState.isDrawing = false;
    if (editorState.currentPath.length > 1) {
        editorState.paths.push({ points: [...editorState.currentPath], color: editorState.currentColor, colorName: editorState.currentColorName });
        renderBoxList();
    }
    editorState.currentPath = [];
    drawCanvas();
}

canvas.addEventListener('pointerdown', (e) => {
    if (!editorState.active) return;
    canvas.setPointerCapture?.(e.pointerId);
    editorState.isDrawing = true;
    editorState.currentPath = [getCanvasPoint(e)];
    drawCanvas();
});

canvas.addEventListener('pointermove', (e) => {
    if (!editorState.isDrawing) return;
    editorState.currentPath.push(getCanvasPoint(e));
    drawCanvas();
});

canvas.addEventListener('pointerup', endCanvasPath);
canvas.addEventListener('pointercancel', endCanvasPath);
canvas.addEventListener('pointerleave', () => {
    if (editorState.isDrawing) endCanvasPath();
});

document.getElementById('colorPicker').addEventListener('click', (e) => {
    if (e.target.classList.contains('color-btn')) {
        document.querySelectorAll('.color-btn').forEach((b) => b.classList.remove('active'));
        e.target.classList.add('active');
        editorState.currentColor = e.target.dataset.color;
        editorState.currentColorName = e.target.dataset.name;
    }
});

function renderBoxList() {
    boxListEl.innerHTML = '';
    const usedColors = new Set(editorState.paths.map((p) => p.color));
    if (usedColors.size === 0) {
        boxListEl.innerHTML = '<div style="text-align:center; color:#6b7280; font-size:0.85rem;">涂写以添加修改规则</div>';
        return;
    }
    document.querySelectorAll('.color-btn').forEach((btn) => {
        const color = btn.dataset.color;
        const name = btn.dataset.name;
        if (usedColors.has(color)) {
            const item = document.createElement('div');
            item.className = 'box-item';
            item.style.borderLeftColor = color;
            item.innerHTML = `<div class="box-header"><span style="color:${color}">${name}</span><span class="box-del" onclick="clearColorPath('${color}')">清除</span></div>
                <textarea placeholder="输入针对此颜色的修改指令" oninput="updatePrompt('${color}', this.value); autoResize(this)">${escapeHtml(editorState.prompts[color] || '')}</textarea>`;
            boxListEl.appendChild(item);
            autoResize(item.querySelector('textarea'));
        }
    });
}

function autoResize(el) {
    el.style.height = 'auto';
    const maxHeight = 220;
    const nextHeight = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

function submitEditorTask() {
    if (editorState.paths.length === 0) {
        alert('请至少涂抹一个区域');
        return;
    }

    const tempCanvas = document.createElement('canvas');
    const tCtx = tempCanvas.getContext('2d');
    const imgW = editorState.image.naturalWidth;
    const imgH = editorState.image.naturalHeight;
    tempCanvas.width = imgW;
    tempCanvas.height = imgH;
    tCtx.drawImage(editorState.image, 0, 0);

    const scale = editorState.scale;
    tCtx.lineCap = 'round';
    tCtx.lineJoin = 'round';
    tCtx.lineWidth = Math.max(3, imgW / 300);
    editorState.paths.forEach((path) => {
        tCtx.beginPath();
        tCtx.strokeStyle = path.color;
        if (path.points.length > 0) {
            tCtx.moveTo(path.points[0].x / scale, path.points[0].y / scale);
            for (let i = 1; i < path.points.length; i += 1) tCtx.lineTo(path.points[i].x / scale, path.points[i].y / scale);
        }
        tCtx.stroke();
    });

    let basePrompt = promptInput.value.trim();
    if (!basePrompt) basePrompt = 'Refine the marked areas according to instructions.';
    const editInstructions = [];
    const usedColors = new Set(editorState.paths.map((p) => p.color));
    usedColors.forEach((color) => {
        const prompt = editorState.prompts[color];
        if (prompt && prompt.trim()) {
            const colorNameEn = color === '#ef4444' ? 'red' : color === '#10b981' ? 'green' : color === '#3b82f6' ? 'blue' : color === '#f59e0b' ? 'yellow' : 'purple';
            editInstructions.push(`In the ${colorNameEn} area: ${prompt}`);
        }
    });
    let finalPrompt = basePrompt;
    if (editInstructions.length > 0) finalPrompt += ` ${editInstructions.join('; ')}.`;
    finalPrompt += ' Note: The colored lines are markup, do not render them. Blend perfectly.';

    tempCanvas.toBlob((blob) => {
        if (!blob) return;
        const file = new File([blob], 'edited_image.png', { type: 'image/png' });
        closeEditor();
        submitTask({
            promptOverride: finalPrompt,
            filesOverride: [file],
            ratioOverride: 'ORIGINAL',
            keepComposerState: true
        });
    }, 'image/png');
}

async function loadHistory(options = {}) {
    if (!currentUserId) return;
    const append = Boolean(options.append);
    if (historyState.loading) return;

    try {
        historyState.loading = true;
        updateHistoryStatus(append ? '正在加载更多图片...' : '正在加载历史记录...');
        syncLoadMoreButton();
        const targetPage = append ? historyState.page + 1 : 1;
        const res = await fetch(`${API_BASE}/api/history?page=${targetPage}&pageSize=${historyState.pageSize}&userId=${encodeURIComponent(currentUserId)}${getHistoryFilterParams()}`);
        if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            handleApiError(errorData, errorData.error || '历史记录加载失败');
            return;
        }
        const data = await res.json();
        const records = Array.isArray(data.records) ? data.records : [];
        const pagination = data.pagination || {};

        if (!append) {
            tasks = [];
            loadedTaskIds.clear();
            gallery.innerHTML = '';
        }

        records.forEach((record) => mergeTaskRecord(record));
        historyState.page = pagination.page || targetPage;
        historyState.pageSize = pagination.pageSize || historyState.pageSize;
        historyState.hasMore = Boolean(pagination.hasMore);
        historyState.initialLoaded = true;

        if (tasks.length === 0) {
            updateHistoryStatus('还没有历史图片，先生成一张试试。');
        } else if (historyState.hasMore) {
            updateHistoryStatus('已加载更多记录，点击继续加载更多。');
        } else {
            updateHistoryStatus('历史记录已全部加载。');
        }
        syncActiveTaskHint();
    } catch (error) {
        console.error('Failed to load history:', error);
        updateHistoryStatus('历史记录加载失败，请稍后重试。');
    } finally {
        historyState.loading = false;
        syncLoadMoreButton();
    }
}

function updateHistoryStatus(message) {
    if (!message) {
        historyStatus.hidden = true;
        historyStatus.textContent = '';
        return;
    }
    historyStatus.hidden = false;
    historyStatus.textContent = message;
}

function syncLoadMoreButton() {
    const shouldShow = historyState.initialLoaded && historyState.hasMore && tasks.length > 0;
    loadMoreBtn.hidden = !shouldShow;
    loadMoreBtn.disabled = historyState.loading;
    loadMoreBtn.textContent = historyState.loading ? '加载中...' : '加载更多';
}

function observeImage(img) {
    if (!img || !img.dataset.src) return;
    if (imageLazyObserver) {
        imageLazyObserver.unobserve(img);
        if (img.src === img.dataset.src) {
            img.classList.add('loaded');
            img.classList.remove('is-lazy');
            return;
        }
        imageLazyObserver.observe(img);
        return;
    }
    if (img.src === img.dataset.src) {
        img.classList.add('loaded');
        img.classList.remove('is-lazy');
        return;
    }
    img.src = img.dataset.src;
}

function buildProtectedImageUrl(resourcePath) {
    if (!resourcePath) return '';
    const separator = resourcePath.includes('?') ? '&' : '?';
    return `${resourcePath}${separator}userId=${encodeURIComponent(currentUserId)}`;
}

function syncChipLabels() {
    ensureSelectedQuality();
    qualityLabelEl.textContent = getQualityLabel(selectedQualityKey);
    ratioLabelEl.textContent = formatRatioLabel(ratioSelect.value);
}

function toggleQualityPopover(forceState) {
    const shouldOpen = typeof forceState === 'boolean' ? forceState : qualityPopover.hidden;
    qualityPopover.hidden = !shouldOpen;
    qualityChip.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
}

function setQuality(value) {
    const normalized = String(value || '').toLowerCase();
    if (!qualitySettingsState[normalized] || !qualitySettingsState[normalized].enabled) return;
    selectedQualityKey = normalized;
    syncQualitySelection();
    syncChipLabels();
}

function toggleRatioPopover(forceState) {
    const shouldOpen = typeof forceState === 'boolean' ? forceState : ratioPopover.hidden;
    ratioPopover.hidden = !shouldOpen;
    ratioChip.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
}

function setRatio(value) {
    ratioSelect.value = value;
    legacyRatioSelect.value = value;
    ratioGrid.querySelectorAll('.ratio-option').forEach((option) => {
        option.classList.toggle('active', option.dataset.value === value);
    });
    syncChipLabels();
}

imageModal.addEventListener('click', (event) => {
    if (event.target.id === 'imageModal') imageModal.classList.remove('active');
});

ratioChip.addEventListener('click', () => {
    toggleQualityPopover(false);
    toggleRatioPopover();
});

ratioChip.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleRatioPopover();
    }
});

ratioGrid.addEventListener('click', (event) => {
    const option = event.target.closest('.ratio-option');
    if (!option) return;
    setRatio(option.dataset.value);
    toggleRatioPopover(false);
});

qualityChip.addEventListener('click', () => {
    toggleRatioPopover(false);
    toggleQualityPopover();
});

qualityChip.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleQualityPopover();
    }
});

qualityGrid.addEventListener('click', (event) => {
    const option = event.target.closest('.quality-option');
    if (!option) return;
    setQuality(option.dataset.value);
    toggleQualityPopover(false);
});

document.addEventListener('click', (event) => {
    if (!ratioPopover.hidden && !event.target.closest('.ratio-chip') && !event.target.closest('.ratio-popover')) toggleRatioPopover(false);
    if (!qualityPopover.hidden && !event.target.closest('.quality-chip') && !event.target.closest('.quality-popover')) toggleQualityPopover(false);
});

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function handleApiError(data, fallbackMessage) {
    if (!data || data.code !== 'USER_DISABLED') return;
    stopTaskPolling();
    closeAdminModal();
    localStorage.removeItem(USER_STORAGE_KEY);
    currentUserId = '';
    currentSession = null;
    syncCurrentUserUi();
    alert(data.error || fallbackMessage || '账号已被禁用');
    openUserModal(false);
}

function openAdminModal() {
    if (!isAdmin()) return;
    adminModal.classList.add('active');
    loadAdminPanel();
}

function closeAdminModal() {
    if (adminModal) adminModal.classList.remove('active');
}

async function loadAdminPanel() {
    if (!isAdmin()) return;
    try {
        const [settingsRes, usersRes] = await Promise.all([
            fetch(`${API_BASE}/api/admin/settings?userId=${encodeURIComponent(currentUserId)}`),
            fetch(`${API_BASE}/api/admin/users?userId=${encodeURIComponent(currentUserId)}`)
        ]);
        const settingsData = await settingsRes.json().catch(() => ({}));
        const usersData = await usersRes.json().catch(() => ({}));
        if (!settingsRes.ok) throw new Error(settingsData.error || '设置加载失败');
        if (!usersRes.ok) throw new Error(usersData.error || '用户详情加载失败');
        adminSettingsState = settingsData.settings || null;
        renderAdminSettings(adminSettingsState);
        renderAdminUsers(usersData);
        syncCurrentUserUi();
    } catch (error) {
        alert(error.message || '管理员设置加载失败');
    }
}

function renderAdminSettings(settings) {
    if (!settings) return;
    adminApiKeyDraft = settings.apiKey || '';
    allowRegistrationToggle.checked = settings.allowNewRegistration !== false;
    apiBaseUrlInput.value = settings.apiBaseUrl || '';
    apiKeyInput.value = adminApiKeyDraft;
    apiKeyInput.type = apiKeyVisible ? 'text' : 'password';
    toggleApiKeyBtn.textContent = apiKeyVisible ? '隐藏' : '显示';
    qualitySettingsState = normalizeQualitySettings(settings.qualities || qualitySettingsState);
    renderAdminQualitySettings();
    renderQualityOptions();
    syncQualitySelection();
    syncChipLabels();
}

function renderAdminQualitySettings() {
    if (!adminQualityList) return;
    const items = [
        { key: '1k', title: '1K', placeholder: '' },
        { key: '2k', title: '2K', placeholder: '' },
        { key: '4k', title: '4K', placeholder: '' }
    ];
    adminQualityList.innerHTML = '';

    items.forEach((item) => {
        const config = qualitySettingsState[item.key] || getDefaultQualitySettings()[item.key];
        const row = document.createElement('div');
        row.className = 'admin-quality-item';
        row.innerHTML = `
            <div class="admin-quality-main">
                <div class="admin-quality-title">${item.title}</div>
                <label class="admin-quality-toggle">
                    <input type="checkbox" data-quality-enabled="${item.key}" ${config.enabled ? 'checked' : ''}>
                    <span>开启</span>
                </label>
            </div>
            <input type="text" class="admin-quality-input" data-quality-model="${item.key}" placeholder="${item.placeholder}" value="${escapeHtml(config.modelId || '')}">
        `;
        adminQualityList.appendChild(row);
    });
}

function renderAdminUsers(payload) {
    const summary = payload.summary || {};
    const records = Array.isArray(payload.records) ? payload.records : [];
    adminSummary.textContent = `用户 ${summary.totalUsers || 0} · 正常 ${summary.activeUsers || 0} · 禁用 ${summary.disabledUsers || 0} · 图片 ${summary.totalImages || 0}`;
    adminUserList.innerHTML = '';

    records.forEach((user) => {
        const item = document.createElement('div');
        item.className = 'admin-user-item';
        const isSelfAdmin = isAdmin() && String(user.userId) === String(currentUserId);
        const statusLabel = user.status === 'disabled' ? '已禁用' : '正常';
        const roleTag = user.role === 'admin' ? '<span class="admin-user-tag">管理员</span>' : '';
        const toggleLabel = user.status === 'disabled' ? '启用' : '禁用';

        item.innerHTML = `
            <div class="admin-user-main">
                <div class="admin-user-title">
                    <span class="admin-user-id">${escapeHtml(user.userId)}</span>
                    ${roleTag}
                </div>
                <div class="admin-user-sub">状态：${statusLabel} · 最近活跃：${formatCreatedAt(user.lastSeenAt)}</div>
            </div>
            <div class="admin-user-count">已生成 ${user.generatedCount || 0} 张</div>
            <div class="admin-user-actions">
                <button class="admin-user-btn warn" type="button" data-action="toggle" data-user-id="${escapeHtml(user.userId)}" ${isSelfAdmin ? 'disabled' : ''}>${toggleLabel}</button>
                <button class="admin-user-btn danger" type="button" data-action="delete" data-user-id="${escapeHtml(user.userId)}" ${isSelfAdmin ? 'disabled' : ''}>删除</button>
            </div>
        `;
        adminUserList.appendChild(item);
    });
}

async function saveAdminSettings() {
    if (!isAdmin()) return;
    try {
        const apiKeyValue = String(apiKeyInput.value || '').trim();
        const qualities = readAdminQualitySettings();
        const res = await fetch(`${API_BASE}/api/admin/settings`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: currentUserId,
                allowNewRegistration: allowRegistrationToggle.checked,
                apiBaseUrl: apiBaseUrlInput.value.trim(),
                apiKey: apiKeyValue,
                qualities
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '设置保存失败');
        apiKeyVisible = false;
        adminSettingsState = data.settings || null;
        renderAdminSettings(adminSettingsState);
        alert('设置已保存');
    } catch (error) {
        alert(error.message || '设置保存失败');
    }
}

function readAdminQualitySettings() {
    const defaults = getDefaultQualitySettings();
    return {
        '1k': readAdminQualityRow('1k', defaults['1k']),
        '2k': readAdminQualityRow('2k', defaults['2k']),
        '4k': readAdminQualityRow('4k', defaults['4k'])
    };
}

function readAdminQualityRow(key, fallback) {
    const enabledInput = adminQualityList ? adminQualityList.querySelector(`[data-quality-enabled="${key}"]`) : null;
    const modelInput = adminQualityList ? adminQualityList.querySelector(`[data-quality-model="${key}"]`) : null;
    return {
        enabled: enabledInput ? enabledInput.checked : fallback.enabled,
        modelId: String(modelInput ? modelInput.value : fallback.modelId || '').trim() || fallback.modelId
    };
}

async function handleAdminUserAction(event) {
    const button = event.target.closest('[data-action]');
    if (!button || !isAdmin()) return;
    const targetUserId = button.dataset.userId;
    const action = button.dataset.action;
    if (!targetUserId) return;

    try {
        if (action === 'toggle') {
            const nextStatus = button.textContent.trim() === '启用' ? 'active' : 'disabled';
            const res = await fetch(`${API_BASE}/api/admin/users/${encodeURIComponent(targetUserId)}/status`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: currentUserId, status: nextStatus })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || '用户状态更新失败');
        }

        if (action === 'delete') {
            const confirmed = window.confirm(`确认删除用户 ${targetUserId} 及其全部历史和图片吗？该操作不可恢复。`);
            if (!confirmed) return;
            const res = await fetch(`${API_BASE}/api/admin/users/${encodeURIComponent(targetUserId)}?userId=${encodeURIComponent(currentUserId)}`, {
                method: 'DELETE'
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || '删除用户失败');
        }

        await loadAdminPanel();
        await loadHistory();
    } catch (error) {
        alert(error.message || '操作失败');
    }
}

window.clearColorPath = (color) => {
    editorState.paths = editorState.paths.filter((p) => p.color !== color);
    editorState.prompts[color] = '';
    drawCanvas();
    renderBoxList();
};

window.updatePrompt = (color, val) => {
    editorState.prompts[color] = val;
};

window.submitTask = submitTask;
window.openModal = openModal;
window.openModalById = openModalById;
window.openModalByPreviewIndex = openModalByPreviewIndex;
window.removeFile = removeFile;
window.openEditor = openEditor;
window.closeEditor = closeEditor;
window.submitEditorTask = submitEditorTask;
window.undoLastPath = undoLastPath;
window.downloadImg = downloadImg;
window.copyPrompt = copyPrompt;
window.editSavedImage = editSavedImage;
window.deleteSavedImage = deleteSavedImage;
window.autoResize = autoResize;

window.addEventListener('resize', () => {
    if (editorState.active) resizeCanvas();
});

window.addEventListener('keydown', (event) => {
    if (!editorState.active) return;
    const isUndo = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z';
    if (!isUndo) return;
    event.preventDefault();
    undoLastPath();
});

window.addEventListener('beforeunload', () => {
    revokeAllPreviewUrls(uploadedFiles);
    stopTaskPolling();
});

renderQualityOptions();
ensureSelectedQuality();
    syncQualitySelection();
    setRatio(ratioSelect.value || '16x9');
    syncChipLabels();
    syncCurrentUserUi();
    autoResize(promptInput);
    syncComposerCompactState();

if (modalCopyPromptBtn) modalCopyPromptBtn.addEventListener('click', copyModalPrompt);

localStorage.removeItem(USER_STORAGE_KEY);
openUserModal(false);
