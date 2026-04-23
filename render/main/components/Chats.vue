<script setup>
import { ref, onMounted, computed, watch, onUnmounted, nextTick, onActivated, onDeactivated, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { createClient } from "webdav/web";
import { Refresh, Delete as DeleteIcon, ChatDotRound, Edit, Upload, Download, Switch, QuestionFilled, Brush, FolderOpened } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'

const { t } = useI18n();
const currentConfig = inject('config');

// --- Component State ---
const activeView = ref('local');
const localChatPath = ref('');
const webdavConfig = ref(null);
const isWebdavConfigValid = ref(false);
const isCloudDataLoaded = ref(false);

const CHAT_HISTORY_PAGE_SIZE_STORAGE_KEY = 'chats-page-size';
const CHAT_HISTORY_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
const CHAT_HISTORY_DEFAULT_PAGE_SIZE = 20;

function normalizeChatHistoryPageSize(value) {
    const numericValue = Number(value);
    return CHAT_HISTORY_PAGE_SIZE_OPTIONS.includes(numericValue)
        ? numericValue
        : CHAT_HISTORY_DEFAULT_PAGE_SIZE;
}

function loadChatHistoryPageSize() {
    try {
        return normalizeChatHistoryPageSize(localStorage.getItem(CHAT_HISTORY_PAGE_SIZE_STORAGE_KEY));
    } catch {
        return CHAT_HISTORY_DEFAULT_PAGE_SIZE;
    }
}

function persistChatHistoryPageSize(value) {
    try {
        localStorage.setItem(CHAT_HISTORY_PAGE_SIZE_STORAGE_KEY, String(normalizeChatHistoryPageSize(value)));
    } catch {
        // ignore localStorage persistence failure
    }
}

const localChatFiles = ref([]);
const cloudChatFiles = ref([]);
const isTableLoading = ref(false);
const selectedFiles = ref([]);
const currentPage = ref(1);
const pageSize = ref(loadChatHistoryPageSize());
const singleFileSyncing = ref({});
const isDeletingFiles = ref(false);
const sortMode = ref('createdAt');
const sortDirection = ref('desc');

watch(() => currentConfig.value?.webdav, (newWebdav) => {
    if (newWebdav) {
        const oldLocalPath = localChatPath.value;
        localChatPath.value = newWebdav.localChatPath || '';
        webdavConfig.value = newWebdav;
        isWebdavConfigValid.value = !!(webdavConfig.value.url && webdavConfig.value.data_path);

        isCloudDataLoaded.value = false;

        
        // 如果本地路径发生变化，且当前在"本地对话"视图，则重新获取列表
        if (oldLocalPath !== localChatPath.value) {
            if (activeView.value === 'local') {
                if (localChatPath.value) {
                    fetchLocalFiles(true);
                } else {
                    localChatFiles.value = [];
                }
            }
        }
    }
}, { deep: true });

// --- Sync Progress State ---
const isSyncing = ref(false);
const syncProgress = ref(0);
const syncStatusText = ref('');
const syncAbortController = ref(null);

// --- 自动清理功能状态 ---
const showCleanDialog = ref(false);
const cleanDaysOption = ref(30); 
const cleanCustomDays = ref(60);
const isCleaning = ref(false);

// --- 框选功能状态 ---
const isDragActive = ref(false); // 视觉上的选框是否显示
const selectionBox = ref({ top: 0, left: 0, width: 0, height: 0 });
const chatListRef = ref(null);

let startX = 0;
let startY = 0;
let isMouseDown = false;
let hasMoved = false; 
// 记录拖拽开始前哪些文件是选中的 (Set<Basename>)
let initialSelectionSnap = new Set(); 

// --- Computed Properties ---
const getFileMap = (fileList) => new Map(fileList.map(f => [f.basename, f]));

const uploadableCount = computed(() => {
    if (!isWebdavConfigValid.value) return 0;
    const cloudMap = getFileMap(cloudChatFiles.value);
    return localChatFiles.value.filter(local => shouldUploadFile(local, cloudMap.get(local.basename))).length;
});

const downloadableCount = computed(() => {
    if (!isWebdavConfigValid.value) return 0;
    const localMap = getFileMap(localChatFiles.value);
    return cloudChatFiles.value.filter(cloud => shouldDownloadFile(cloud, localMap.get(cloud.basename))).length;
});

const currentFiles = computed(() => {
    const fileList = activeView.value === 'local' ? localChatFiles.value : cloudChatFiles.value;
    return [...fileList].sort(compareFilesBySortMode);
});
const paginatedFiles = computed(() => {
    const start = (currentPage.value - 1) * pageSize.value;
    const end = start + pageSize.value;
    return currentFiles.value.slice(start, end);
});

// --- Helper Functions ---
const normalizeDateValue = (value) => {
    if (value == null || value === '') return '';

    if (typeof value === 'number' && Number.isFinite(value)) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) || date.getTime() <= 0 ? '' : date.toISOString();
    }

    const raw = String(value).trim();
    if (!raw) return '';

    if (/^\d+$/.test(raw)) {
        const numericValue = Number(raw);
        if (Number.isFinite(numericValue) && numericValue > 0) {
            const normalizedNumber = raw.length <= 10 ? numericValue * 1000 : numericValue;
            const numericDate = new Date(normalizedNumber);
            if (!Number.isNaN(numericDate.getTime()) && numericDate.getTime() > 0) {
                return numericDate.toISOString();
            }
        }
    }

    const date = new Date(raw);
    if (Number.isNaN(date.getTime()) || date.getTime() <= 0) return '';
    return date.toISOString();
};

const formatDate = (dateString) => {
    const normalized = normalizeDateValue(dateString);
    if (!normalized) return 'N/A';
    return new Date(normalized).toLocaleString();
};
const formatBytes = (bytes, decimals = 2) => {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024; const dm = decimals < 0 ? 0 : decimals; const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

const getSafeString = (value) => (typeof value === 'string' ? value : '');


const resolveFileBasename = (file) => {
    if (!file || typeof file !== 'object') return '';

    if (typeof file.basename === 'string' && file.basename.trim()) {
        return file.basename.trim();
    }

    if (typeof file.name === 'string' && file.name.trim()) {
        return file.name.trim();
    }

    if (typeof file.path === 'string' && file.path.trim()) {
        const normalizedPath = file.path.replace(/\\/g, '/');
        const segments = normalizedPath.split('/').filter(Boolean);
        return segments.length > 0 ? segments[segments.length - 1] : '';
    }

    return '';
};

const resolveWebdavDataPath = () => {
    const rawPath = webdavConfig.value?.data_path ?? webdavConfig.value?.path ?? '';
    const normalized = String(rawPath || '').trim();
    if (!normalized) return '';
    return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
};

const normalizeChatFile = (file, source = 'local') => {
    const basename = resolveFileBasename(file);
    const size = Number(file?.size);
    const normalizedTitle = typeof file?.title === 'string' ? file.title.trim() : '';

    const normalized = {
        ...file,
        basename,
        title: normalizedTitle || (basename.endsWith('.json') ? basename.slice(0, -5) : basename),
        size: Number.isFinite(size) ? size : 0,
        createdAt: normalizeDateValue(file?.createdAt ?? file?.birthtime ?? file?.ctime ?? ''),
        updatedAt: normalizeDateValue(file?.updatedAt ?? file?.lastmod ?? file?.lastModified ?? file?.mtime ?? ''),
        lastmod: normalizeDateValue(file?.lastmod ?? file?.lastModified ?? file?.mtime ?? file?.updatedAt ?? ''),
        type: typeof file?.type === 'string' && file.type ? file.type : 'file'
    };

    if (!normalized.createdAt) {
        normalized.createdAt = normalized.updatedAt || normalized.lastmod;
    }

    if (!normalized.updatedAt) {
        normalized.updatedAt = normalized.lastmod || normalized.createdAt;
    }

    if (source === 'local' && !normalized.path && localChatPath.value && basename) {
        normalized.path = `${localChatPath.value}/${basename}`;
    }

    return normalized;
};

const normalizeTitleValue = (file) => {
    const rawTitle = typeof file?.title === 'string' ? file.title.trim() : '';
    if (rawTitle) return rawTitle;
    const basename = resolveFileBasename(file);
    return basename.endsWith('.json') ? basename.slice(0, -5) : basename;
};

const isCloudView = computed(() => activeView.value === 'cloud');
const showCreatedAtColumn = computed(() => !isCloudView.value);
const chatTableColumns = computed(() => (
    showCreatedAtColumn.value
        ? '24px minmax(0, 1.8fr) minmax(168px, 1fr) minmax(168px, 1fr) minmax(120px, 0.7fr) 168px'
        : '24px minmax(0, 2.2fr) minmax(180px, 1fr) minmax(120px, 0.7fr) 168px'
));

const getSortDirectionLabel = () => sortDirection.value === 'asc' ? '↑' : '↓';

const getColumnSortLabel = (mode) => `${t(`chats.sort.${mode}`)} ${getSortDirectionLabel()}`;

const toggleSort = (mode) => {
    if (mode === 'createdAt' && isCloudView.value) {
        return;
    }

    if (sortMode.value === mode) {
        sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc';
    } else {
        sortMode.value = mode;
        sortDirection.value = mode === 'name' ? 'asc' : 'desc';
    }

    currentPage.value = 1;
};

const ensureValidSortModeForView = () => {
    if (isCloudView.value && sortMode.value === 'createdAt') {
        sortMode.value = 'updatedAt';
        sortDirection.value = 'desc';
    }
};


const formatFileTimeSummary = (file) => {
    const created = formatDate(file?.createdAt || file?.lastmod);
    const updated = formatDate(file?.updatedAt || file?.lastmod || file?.createdAt);
    return `${created} | ${updated}`;
};

const safeDateValue = (value) => {
    const normalized = normalizeDateValue(value);
    return normalized ? new Date(normalized).getTime() : 0;
};

const getCompareTimestamp = (file) => file?.updatedAt || file?.lastmod || file?.createdAt || '';

const compareFilesBySortMode = (a, b) => {
    let result = 0;

    if (sortMode.value === 'name') {
        result = normalizeTitleValue(a).localeCompare(normalizeTitleValue(b), undefined, {
            numeric: true,
            sensitivity: 'base'
        });
    } else if (sortMode.value === 'updatedAt') {
        result = safeDateValue(b?.updatedAt || b?.lastmod || b?.createdAt) - safeDateValue(a?.updatedAt || a?.lastmod || a?.createdAt);
    } else if (sortMode.value === 'size') {
        result = Number(b?.size || 0) - Number(a?.size || 0);
    } else {
        result = safeDateValue(b?.createdAt || b?.lastmod) - safeDateValue(a?.createdAt || a?.lastmod);
    }

    return sortDirection.value === 'asc' ? -result : result;
};

const shouldUploadFile = (local, cloudFile) => {
    if (!cloudFile) return true;
    return safeDateValue(getCompareTimestamp(local)) > safeDateValue(getCompareTimestamp(cloudFile));
};

const shouldDownloadFile = (cloud, localFile) => {
    if (!localFile) return true;
    return safeDateValue(getCompareTimestamp(cloud)) > safeDateValue(getCompareTimestamp(localFile));
};



const buildWebdavInput = (extra = {}) => ({
    webdavConfig: {
        url: getSafeString(webdavConfig.value?.url),
        username: getSafeString(webdavConfig.value?.username),
        password: getSafeString(webdavConfig.value?.password),
        path: resolveWebdavDataPath() || getSafeString(webdavConfig.value?.path) || '/anywhere_data'
    },
    ...extra
});

const ensureWebdavResult = (result, fallbackReason = 'webdav_operation_failed') => {
    if (!result || result.ok === false) {
        throw new Error(result?.reason || result?.error || fallbackReason);
    }
    return result;
};


const toUtcString = (value) => {
    const normalized = normalizeDateValue(value);
    if (!normalized) return '';
    return new Date(normalized).toUTCString();
};



const handleWindowFocus = () => {
    refreshData(true);
};

async function saveLocalChatPath(pathValue = '') {
    const normalizedPath = typeof pathValue === 'string' ? pathValue.trim() : '';
    localChatPath.value = normalizedPath;

    if (currentConfig.value?.webdav && typeof currentConfig.value.webdav === 'object') {
        currentConfig.value.webdav.localChatPath = normalizedPath;
    }
    if (webdavConfig.value && typeof webdavConfig.value === 'object') {
        webdavConfig.value = {
            ...webdavConfig.value,
            localChatPath: normalizedPath
        };
    }

    await window.api.saveSetting('webdav.localChatPath', normalizedPath);

    if (!normalizedPath) {
        localChatFiles.value = [];
        selectedFiles.value = [];
        currentPage.value = 1;
        return;
    }

    await fetchLocalFiles();
}

async function selectLocalChatPath() {
    try {
        const path = await window.api.selectDirectory();
        if (!path) return;
        await saveLocalChatPath(path);
        ElMessage.success(t('chats.alerts.localPathConfigured'));
    } catch (error) {
        ElMessage.error(`${t('chats.alerts.localPathSaveFailed')}: ${error.message}`);
    }
}


onMounted(async () => {
    try {
        const result = await window.api.getConfig();
        if (result && result.config && result.config.webdav) {
            localChatPath.value = result.config.webdav.localChatPath;
            webdavConfig.value = result.config.webdav;
            isWebdavConfigValid.value = !!(webdavConfig.value.url && webdavConfig.value.data_path);
            if (localChatPath.value) await fetchLocalFiles();
        }
    } catch (error) { 
        ElMessage.error(t('chats.alerts.configError')); 
    }
});

onActivated(() => {
    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('mouseup', onGlobalMouseUp);
    window.addEventListener('mousemove', onGlobalMouseMove);
    refreshData(true);
});

onDeactivated(() => {
    window.removeEventListener('focus', handleWindowFocus);
    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('mouseup', onGlobalMouseUp);
    window.removeEventListener('mousemove', onGlobalMouseMove);
});

onUnmounted(() => {
    window.removeEventListener('focus', handleWindowFocus);
    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('mouseup', onGlobalMouseUp);
    window.removeEventListener('mousemove', onGlobalMouseMove);
});

// --- 框选核心逻辑 ---

const onMouseDown = (e) => {
    if (e.button !== 0) return; // 仅左键

    // 排除特定交互元素（避免点复选框或按钮时触发选框）
    if (e.target.closest('.list-checkbox') || e.target.closest('.list-actions') || e.target.closest('.el-button')) {
        return;
    }

    const container = chatListRef.value?.closest('.table-container');
    if (!container) return;

    const containerRect = container.getBoundingClientRect();

    isMouseDown = true;
    hasMoved = false;
    startX = e.clientX;
    startY = e.clientY;

    // 快照：记录当前已选中的文件ID
    initialSelectionSnap = new Set(selectedFiles.value.map(f => f.basename));

    selectionBox.value = {
        left: startX - containerRect.left,
        top: startY - containerRect.top,
        width: 0,
        height: 0
    };

    // 不在此处 preventDefault，以便支持点击事件冒泡
};

const onGlobalMouseMove = (e) => {
    if (!isMouseDown) return;

    const currentX = e.clientX;
    const currentY = e.clientY;

    // 移动阈值判定，防止点击时的微小抖动被误判为拖拽
    if (!hasMoved && (Math.abs(currentX - startX) > 5 || Math.abs(currentY - startY) > 5)) {
        hasMoved = true;
        isDragActive.value = true; 
        // 拖拽开始，清除浏览器默认的文本选择
        window.getSelection()?.removeAllRanges();
    }

    if (hasMoved) {
        e.preventDefault(); // 阻止后续默认行为

        const container = chatListRef.value?.closest('.table-container');
        if (!container) return;

        const containerRect = container.getBoundingClientRect();

        // 计算选框几何（基于 table-container 局部坐标）
        const left = Math.min(startX, currentX) - containerRect.left;
        const top = Math.min(startY, currentY) - containerRect.top;
        const width = Math.abs(currentX - startX);
        const height = Math.abs(currentY - startY);

        selectionBox.value = { left, top, width, height };

        // 实时更新选中状态 (XOR 逻辑)
        updateSelectionInvert();
    }
};

const updateSelectionInvert = () => {
    if (!chatListRef.value) return;

    const container = chatListRef.value.closest('.table-container');
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const items = chatListRef.value.querySelectorAll('.chat-list-item');
    const boxRect = {
        left: containerRect.left + selectionBox.value.left,
        top: containerRect.top + selectionBox.value.top,
        right: containerRect.left + selectionBox.value.left + selectionBox.value.width,
        bottom: containerRect.top + selectionBox.value.top + selectionBox.value.height
    };

    const currentInBox = new Set();

    // 1. 找出当前所有在框内的文件
    items.forEach((item, index) => {
        const itemRect = item.getBoundingClientRect();
        
        // AABB 碰撞检测
        const isIntersecting = !(
            boxRect.left > itemRect.right ||
            boxRect.right < itemRect.left ||
            boxRect.top > itemRect.bottom ||
            boxRect.bottom < itemRect.top
        );

        if (isIntersecting) {
            const file = paginatedFiles.value[index];
            if (file) currentInBox.add(file.basename);
        }
    });

    // 2. 应用反转逻辑 (XOR)
    // 最终状态 = 初始状态 XOR 框选状态
    // - 原来已选 && 在框内 -> 变未选
    // - 原来已选 && 不在框内 -> 保持已选
    // - 原来未选 && 在框内 -> 变已选
    // - 原来未选 && 不在框内 -> 保持未选
    
    selectedFiles.value = paginatedFiles.value.filter(file => {
        const wasSelected = initialSelectionSnap.has(file.basename);
        const isInBox = currentInBox.has(file.basename);

        if (isInBox) {
            return !wasSelected; // 反转
        } else {
            return wasSelected;  // 保持
        }
    });
};

const onGlobalMouseUp = (e) => {
    if (isMouseDown) {
        // 如果没有发生拖拽，且没有按住 Ctrl/Shift，且点击的是空白处（不是列表项），则清空选择
        // 这是为了符合“点击空白处取消选择”的直觉
        if (!hasMoved && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
            if (!e.target.closest('.chat-list-item')) {
                selectedFiles.value = [];
            }
        }
    }

    isMouseDown = false;
    
    if (isDragActive.value) {
        isDragActive.value = false;
        // 延时重置 hasMoved，防止触发 click 事件
        setTimeout(() => { hasMoved = false; }, 0);
    } else {
        hasMoved = false;
    }
    
    selectionBox.value = { top: 0, left: 0, width: 0, height: 0 };
};

// 列表项点击处理 (保持原有逻辑)
const handleItemClick = (file) => {
    // 如果刚刚发生了拖拽，则忽略此次点击（避免抬起鼠标时触发 click 导致状态再次反转）
    if (hasMoved) return;

    toggleFileSelection(file, !isFileSelected(file));
};

const handleKeyDown = (e) => {
    const activeEl = document.activeElement;
    const tagName = activeEl.tagName;
    
    if (
        (tagName === 'INPUT' && !['checkbox', 'radio'].includes(activeEl.type)) || 
        tagName === 'TEXTAREA' || 
        activeEl.isContentEditable
    ) {
        return;
    }

    // Ctrl+A 全选
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        toggleSelectAll();
        return;
    }

    if (e.key === 'Delete' || (e.key === 'Backspace' && !e.altKey && !e.ctrlKey && !e.shiftKey)) {
        if (e.repeat) return;
        if (selectedFiles.value.length > 0) {
            e.preventDefault();
            deleteFiles(selectedFiles.value);
        }
    }
};

watch(pageSize, (newValue, oldValue) => {
    const normalizedValue = normalizeChatHistoryPageSize(newValue);
    if (normalizedValue !== newValue) {
        pageSize.value = normalizedValue;
        return;
    }
    if (normalizedValue !== oldValue) {
        currentPage.value = 1;
    }
    persistChatHistoryPageSize(normalizedValue);
});

watch(currentFiles, (files) => {
    const totalPages = Math.max(1, Math.ceil((Array.isArray(files) ? files.length : 0) / pageSize.value));
    if (currentPage.value > totalPages) {
        currentPage.value = totalPages;
    }
});

watch(sortMode, () => {
    currentPage.value = 1;
});

watch(activeView, () => {
    ensureValidSortModeForView();
}, { immediate: true });



watch(activeView, async (newView) => {
    if (newView === 'cloud' && !isCloudDataLoaded.value && isWebdavConfigValid.value) {
        const loaded = await fetchCloudFiles();
        isCloudDataLoaded.value = loaded;
    } else if (newView === 'local' && localChatPath.value) {
        await fetchLocalFiles();
    }
    selectedFiles.value = []; 
});

// --- Main Functions ---
async function fetchLocalFiles(silent = false) {
    if (!localChatPath.value) return;
    if (!silent) isTableLoading.value = true;
    try {
        const result = await window.api.listJsonFiles(localChatPath.value);
        const files = Array.isArray(result) ? result : [];
        const normalizedFiles = files.map((item) => normalizeChatFile(item, 'local'));
        localChatFiles.value = normalizedFiles;
    } catch (error) {
        ElMessage.error(`${t('chats.alerts.localListFailed')}: ${error.message}`);
        localChatFiles.value = [];
    } finally {
        isTableLoading.value = false;
    }
}

async function fetchCloudFiles(silent = false) {
    if (!isWebdavConfigValid.value) return false;
    if (!silent) isTableLoading.value = true;
    try {
        const result = ensureWebdavResult(
            await window.api.listWebdavBackups(buildWebdavInput()),
            'webdav_list_failed'
        );

        if (!result.exists) {
            cloudChatFiles.value = [];
            return true;
        }

        const files = Array.isArray(result.files) ? result.files : [];
        const normalizedFiles = files
            .map((item) => normalizeChatFile(item, 'cloud'))
            .filter((item) => item.type === 'file' && item.basename && item.basename.endsWith('.json'));
        cloudChatFiles.value = normalizedFiles;
        return true;
    } catch (error) {
        ElMessage.error(`${t('chats.alerts.fetchFailed')}: ${error.message}`);
        cloudChatFiles.value = [];
        return false;
    } finally {
        isTableLoading.value = false;
    }
}



async function refreshData(silent = false) {
    if (activeView.value === 'local') {
        if (localChatPath.value) {
            await fetchLocalFiles(silent);
        }
    } else if (activeView.value === 'cloud') {
        if (isWebdavConfigValid.value) {
            isCloudDataLoaded.value = await fetchCloudFiles(silent);
        }
    }
}

async function startChat(file) {
    ElMessage.info(t('chats.alerts.loadingChat'));
    try {
        const basename = resolveFileBasename(file);
        if (!basename) {
            throw new Error(t('common.operationFailed'));
        }

        let jsonString;
        if (activeView.value === 'local') {
            const filePath = getSafeString(file?.path) || (localChatPath.value ? `${localChatPath.value}/${basename}` : '');
            if (!filePath) {
                throw new Error(t('chats.alerts.localPathRequired'));
            }
            jsonString = await window.api.readLocalFile(filePath);
        } else {
            const result = ensureWebdavResult(
                await window.api.readWebdavBackup(buildWebdavInput({ filename: basename })),
                'webdav_read_failed'
            );
            jsonString = getSafeString(result.content);
        }
        const parsedSession = JSON.parse(jsonString);
        await window.api.openWindow('window', {
            code: parsedSession?.CODE || 'AI',
            type: 'over',
            payload: jsonString,
            filename: basename
        });
        ElMessage.success(t('chats.alerts.restoreInitiated'));
    } catch (error) { ElMessage.error(`${t('chats.alerts.restoreFailed')}: ${error.message}`); }
}
async function renameFile(file) {
    const basename = resolveFileBasename(file);
    if (!basename) {
        ElMessage.error(t('chats.alerts.renameFailed'));
        return;
    }

    const defaultInputValue = normalizeTitleValue(file) || (basename.endsWith('.json') ? basename.slice(0, -5) : basename);
    try {
        const { value: userInput } = await ElMessageBox.prompt(t('chats.rename.promptMessage'), t('chats.rename.promptTitle'), { inputValue: defaultInputValue });
        let finalFilename = (userInput || "").trim();
        if (!finalFilename.toLowerCase().endsWith('.json')) finalFilename += '.json';
        if (finalFilename === basename || finalFilename === '.json') return;

        if (activeView.value === 'local') {
            const sourcePath = getSafeString(file?.path) || `${localChatPath.value}/${basename}`;
            await window.api.renameLocalFile(sourcePath, `${localChatPath.value}/${finalFilename}`);
            if (isWebdavConfigValid.value && cloudChatFiles.value.some(f => f.basename === basename)) {
                const confirm = await ElMessageBox.confirm(
                    t('chats.rename.syncCloudConfirm'),
                    t('chats.rename.syncTitle'),
                    { type: 'info' }
                ).catch(() => false);
                if (confirm) {
                    ensureWebdavResult(
                        await window.api.moveWebdavFile(buildWebdavInput({ fromFilename: basename, toFilename: finalFilename })),
                        'webdav_move_failed'
                    );
                }
            }
        } else { // cloud
            ensureWebdavResult(
                await window.api.moveWebdavFile(buildWebdavInput({ fromFilename: basename, toFilename: finalFilename })),
                'webdav_move_failed'
            );
            if (localChatFiles.value.some(f => f.basename === basename)) {
                const confirm = await ElMessageBox.confirm(
                    t('chats.rename.syncLocalConfirm'),
                    t('chats.rename.syncTitle'),
                    { type: 'info' }
                ).catch(() => false);
                if (confirm) await window.api.renameLocalFile(`${localChatPath.value}/${basename}`, `${localChatPath.value}/${finalFilename}`);
            }
        }
        ElMessage.success(t('chats.alerts.renameSuccess'));
        await refreshData();
    } catch (error) {
        if (error !== 'cancel' && error !== 'close') ElMessage.error(`${t('chats.alerts.renameFailed')}: ${error.message}`);
    }
}
async function deleteFiles(filesToDelete) {

    const normalizedFiles = filesToDelete
        .map((file) => normalizeChatFile(file, activeView.value === 'local' ? 'local' : 'cloud'))
        .filter((file) => file.basename);

    if (isDeletingFiles.value) return; // 拦截正在进行中的删除操作

    if (normalizedFiles.length === 0) {
        ElMessage.warning(t('common.noFileSelected'));
        return;
    }

    isDeletingFiles.value = true; // 上锁
    try {
        await ElMessageBox.confirm(t('common.confirmDeleteMultiple', { count: normalizedFiles.length }), t('common.warningTitle'), { type: 'warning' });

        let syncDeletions = false;

        if (isWebdavConfigValid.value && localChatPath.value) {
            const localMap = new Map(localChatFiles.value.map(f => [f.basename, f]));
            const cloudMap = new Map(cloudChatFiles.value.map(f => [f.basename, f]));

            const counterpartFiles = normalizedFiles.filter(file => {
                return activeView.value === 'local' ? cloudMap.has(file.basename) : localMap.has(file.basename);
            });

            if (counterpartFiles.length > 0) {
                const location = activeView.value === 'local' ? t('chats.view.cloud') : t('chats.view.local');
                try {
                    await ElMessageBox.confirm(
                        t('chats.alerts.confirmSyncDeleteMessage', { count: counterpartFiles.length, location: location }),
                        t('chats.alerts.confirmSyncDeleteTitle'),
                        { type: 'info' }
                    );
                    syncDeletions = true;
                } catch (e) {
                    syncDeletions = false;
                }
            }
        }

        isTableLoading.value = true;

        for (const file of normalizedFiles) {
            const basename = file.basename;

            if (activeView.value === 'local') {
                const localPath = getSafeString(file?.path) || `${localChatPath.value}/${basename}`;
                await window.api.deleteLocalFile(localPath);
                if (syncDeletions && isWebdavConfigValid.value && cloudChatFiles.value.some(f => f.basename === basename)) {
                    ensureWebdavResult(
                        await window.api.deleteWebdavBackup(buildWebdavInput({ filename: basename })),
                        'webdav_delete_failed'
                    );
                }
            } else { // cloud view
                ensureWebdavResult(
                    await window.api.deleteWebdavBackup(buildWebdavInput({ filename: basename })),
                    'webdav_delete_failed'
                );
                if (syncDeletions && localChatFiles.value.some(f => f.basename === basename)) {
                    await window.api.deleteLocalFile(`${localChatPath.value}/${basename}`);
                }
            }
        }

        ElMessage.success(t('common.deleteSuccessMultiple'));
        await refreshData();
        selectedFiles.value = [];

    } catch (error) {
        if (error !== 'cancel' && error !== 'close') {
            ElMessage.error(`${t('common.deleteFailedMultiple')}: ${error.message}`);
        }
    } finally {
        isTableLoading.value = false;
        isDeletingFiles.value = false; // 释放锁
    }
}
const handleSelectionChange = (val) => selectedFiles.value = val;

const cancelSync = () => {
    if (syncAbortController.value) {
        syncAbortController.value.abort();
    }
};

async function runConcurrentTasks(tasks, signal, concurrencyLimit = 3) {
    const results = { completed: 0, failed: 0, failedFiles: [] };
    const queue = [...tasks];

    const worker = async () => {
        while (queue.length > 0) {
            if (signal.aborted) throw new Error("Cancelled");
            const task = queue.shift();
            try {
                await task.action(signal);
                results.completed++;
            } catch (error) {
                if (error.name === 'AbortError') {
                    throw new Error("Cancelled");
                }
                results.failed++;
                results.failedFiles.push(task.name);
                console.error(`Task failed for ${task.name}:`, error);
            } finally {
                if (!signal.aborted) {
                    syncProgress.value = Math.round(((results.completed + results.failed) / tasks.length) * 100);
                    syncStatusText.value = t('chats.alerts.syncProcessing', { completed: results.completed + results.failed, total: tasks.length });
                }
            }
        }
    };

    const workers = Array(concurrencyLimit).fill(null).map(worker);
    await Promise.all(workers);
    return results;
}

async function intelligentUpload() {
    if (!isWebdavConfigValid.value) return ElMessage.warning(t('chats.alerts.webdavRequired'));
    const filesToUpload = localChatFiles.value.filter(local => shouldUploadFile(local, getFileMap(cloudChatFiles.value).get(local.basename)));
    if (filesToUpload.length === 0) return ElMessage.info(t('chats.alerts.syncNoUpload'));

    try {
        await ElMessageBox.confirm(
            t('chats.tooltips.uploadChanges', { count: filesToUpload.length }) + ' ' + t('chats.alerts.continueConfirm'),
            t('chats.alerts.syncConfirmUploadTitle'),
            { type: 'info' }
        );
        const tasks = filesToUpload.map(file => ({ name: file.basename, action: (signal) => forceSyncFile(file.basename, 'upload', signal) }));
        await executeSync(tasks, t('chats.alerts.syncConfirmUploadTitle'));
    } catch (error) {
        if (error === 'cancel' || error === 'close') return;
        ElMessage.error(`${error.message}`);
    }
}

async function intelligentDownload() {
    if (!localChatPath.value) return ElMessage.warning(t('chats.alerts.localPathRequired'));
    const filesToDownload = cloudChatFiles.value.filter(cloud => shouldDownloadFile(cloud, getFileMap(localChatFiles.value).get(cloud.basename)));
    if (filesToDownload.length === 0) return ElMessage.info(t('chats.alerts.syncNoDownload'));

    try {
        await ElMessageBox.confirm(
            t('chats.tooltips.downloadChanges', { count: filesToDownload.length }) + ' ' + t('chats.alerts.continueConfirm'),
            t('chats.alerts.syncConfirmDownloadTitle'),
            { type: 'info' }
        );
        const tasks = filesToDownload.map(file => ({ name: file.basename, action: (signal) => forceSyncFile(file.basename, 'download', signal) }));
        await executeSync(tasks, t('chats.alerts.syncConfirmDownloadTitle'));
    } catch (error) {
        if (error === 'cancel' || error === 'close') return;
        ElMessage.error(`${error.message}`);
    }
}

async function executeSync(tasks, title) {
    isSyncing.value = true;
    syncProgress.value = 0;
    syncAbortController.value = new AbortController();
    syncStatusText.value = title === t('chats.alerts.syncConfirmUploadTitle') ? t('chats.alerts.syncPreparingUpload') : t('chats.alerts.syncPreparingDownload');

    try {
        const results = await runConcurrentTasks(tasks, syncAbortController.value.signal);
        let message = title === t('chats.alerts.syncConfirmUploadTitle') ? t('chats.alerts.syncSuccessUpload', { count: results.completed }) : t('chats.alerts.syncSuccessDownload', { count: results.completed });
        if (results.failed > 0) message += ` ${t('chats.alerts.syncFailedPartially', { failedCount: results.failed })}`;
        ElMessage.success(message);
        await refreshData();
    } catch (error) {
        if (error.message === 'Cancelled') {
            ElMessage.warning(t('chats.alerts.syncCancelled'));
        } else {
            ElMessage.error(t('chats.alerts.syncFailed', { message: error.message }));
        }
    } finally {
        isSyncing.value = false;
        syncAbortController.value = null;
    }
}

async function forceSyncFile(basename, direction, signal) {
    singleFileSyncing.value[basename] = true;
    try {
        const normalizedBasename = getSafeString(basename);
        const localPath = `${localChatPath.value}/${normalizedBasename}`;

        if (direction === 'upload') {
            const localFile = localChatFiles.value.find(f => f.basename === normalizedBasename);
            if (!localFile) throw new Error(t('chats.alerts.localFileMissing', { filename: normalizedBasename }));

            const content = await window.api.readLocalFile(localPath, signal);
            ensureWebdavResult(
                await window.api.writeWebdavBackup(
                    buildWebdavInput({
                        filename: normalizedBasename,
                        content,
                        overwrite: true,
                        ensureDirectory: true,
                        lastModified: toUtcString(getCompareTimestamp(localFile))
                    })
                ),
                'webdav_write_failed'
            );
        } else { // download
            const cloudFile = cloudChatFiles.value.find(f => f.basename === normalizedBasename);
            if (!cloudFile) throw new Error(t('chats.alerts.cloudFileMissing', { filename: normalizedBasename }));

            const result = ensureWebdavResult(
                await window.api.readWebdavBackup(buildWebdavInput({ filename: normalizedBasename })),
                'webdav_read_failed'
            );
            await window.api.writeLocalFile(localPath, getSafeString(result.content), signal);
            await window.api.setFileMtime(localPath, getCompareTimestamp(cloudFile));
        }
    } catch (error) {
        if (error.name === 'AbortError') throw new Error("Cancelled");
        ElMessage.error(t('chats.alerts.syncFileFailed', { filename: basename, message: error.message }));
        throw error;
    } finally {
        singleFileSyncing.value[basename] = false;
    }
}

const computedFilesToClean = computed(() => {
    const days = cleanDaysOption.value === -1 ? cleanCustomDays.value : cleanDaysOption.value;
    if (!days || days < 1) return [];

    // 计算截止时间戳
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    return currentFiles.value.filter(file => {
        const fileDate = new Date(getCompareTimestamp(file));
        return fileDate < cutoffDate;
    });
});

const totalCleanSize = computed(() => {
    return computedFilesToClean.value.reduce((acc, file) => acc + (file.size || 0), 0);
});

function openCleanDialog() {
    showCleanDialog.value = true;
}

async function executeAutoClean() {
    const filesToDelete = computedFilesToClean.value;
    if (filesToDelete.length === 0) return;

    isCleaning.value = true;
    try {
        const tasks = filesToDelete.map(file => async () => {
            const normalizedFile = normalizeChatFile(file, activeView.value === 'local' ? 'local' : 'cloud');
            const basename = normalizedFile.basename;
            if (!basename) return;

            if (activeView.value === 'local') {
                const localPath = getSafeString(normalizedFile?.path) || `${localChatPath.value}/${basename}`;
                await window.api.deleteLocalFile(localPath);
            } else {
                ensureWebdavResult(
                    await window.api.deleteWebdavBackup(buildWebdavInput({ filename: basename })),
                    'webdav_delete_failed'
                );
            }
        });

        const batchSize = 5;
        for (let i = 0; i < tasks.length; i += batchSize) {
            const batch = tasks.slice(i, i + batchSize);
            await Promise.all(batch.map(t => t()));
        }

        ElMessage.success(t('chats.clean.success', { count: filesToDelete.length }));
        await refreshData();
        showCleanDialog.value = false;
        selectedFiles.value = [];

    } catch (error) {
        ElMessage.error(t('chats.clean.failed', { message: error.message }));
    } finally {
        isCleaning.value = false;
    }
}

const isFileSelected = (file) => {
    return selectedFiles.value.some(f => f.basename === file.basename);
};

const toggleFileSelection = (file, isChecked) => {
    if (isChecked) {
        if (!isFileSelected(file)) {
            selectedFiles.value.push(file);
        }
    } else {
        selectedFiles.value = selectedFiles.value.filter(f => f.basename !== file.basename);
    }
};

const formatFilenameDisplay = (basename) => {
    const safeBasename = getSafeString(basename);
    return safeBasename.endsWith('.json') ? safeBasename.slice(0, -5) : safeBasename;
};

const isAllSelected = computed(() => {
    if (paginatedFiles.value.length === 0) return false;
    return paginatedFiles.value.every(f => isFileSelected(f));
});

const toggleSelectAll = () => {
    if (isAllSelected.value) {
        const visibleNames = new Set(paginatedFiles.value.map(f => f.basename));
        selectedFiles.value = selectedFiles.value.filter(f => !visibleNames.has(f.basename));
    } else {
        paginatedFiles.value.forEach(f => {
            if (!isFileSelected(f)) selectedFiles.value.push(f);
        });
    }
};

</script>

<template>
    <div class="chats-page-container">
        <div class="chats-content-wrapper">
            <div class="top-toolbar">
                <div class="info-button-container">
                    <el-popover placement="bottom-start" :title="t('chats.info.title')" :width="450" trigger="click">
                        <template #reference>
                            <el-button :icon="QuestionFilled" circle />
                        </template>
                        <div class="info-popover-content">
                            <p v-html="t('chats.info.localDesc', { path: localChatPath || t('chats.info.pathNotSet') })">
                            </p>
                            <p v-html="t('chats.info.cloudDesc')"></p>
                        </div>
                    </el-popover>
                    <el-tooltip :content="t('chats.tooltips.selectFolder')" placement="bottom">
                        <el-button :icon="FolderOpened" circle @click="selectLocalChatPath" />
                    </el-tooltip>
                    <el-tooltip :content="t('chats.clean.button')" placement="bottom">
                        <el-button :icon="Brush" circle @click="openCleanDialog" />
                    </el-tooltip>
                </div>
                <div class="view-selector">
                    <el-radio-group v-model="activeView" @change="currentPage = 1">
                        <el-radio-button value="local">{{ t('chats.view.local') }}</el-radio-button>
                        <el-radio-button value="cloud" :disabled="!isWebdavConfigValid">{{ t('chats.view.cloud')
                            }}</el-radio-button>
                    </el-radio-group>
                </div>
                <div class="sync-buttons-container">
                    <el-tooltip :content="t('chats.tooltips.uploadChanges', { count: uploadableCount })" placement="bottom">
                        <el-badge :value="uploadableCount" :hidden="uploadableCount === 0" type="primary">
                            <el-button :icon="Upload" @click="intelligentUpload" circle
                                :disabled="!isWebdavConfigValid || !localChatPath" />
                        </el-badge>
                    </el-tooltip>
                    <el-tooltip :content="t('chats.tooltips.downloadChanges', { count: downloadableCount })"
                        placement="bottom">
                        <el-badge :value="downloadableCount" :hidden="downloadableCount === 0" type="success">
                            <el-button :icon="Download" @click="intelligentDownload" circle
                                :disabled="!isWebdavConfigValid || !localChatPath" />
                        </el-badge>
                    </el-tooltip>
                </div>
            </div>

            <div class="table-container">
                <!-- 拖拽选框 -->
                <div v-show="isDragActive" class="selection-box" :style="{
                    top: selectionBox.top + 'px',
                    left: selectionBox.left + 'px',
                    width: selectionBox.width + 'px',
                    height: selectionBox.height + 'px'
                }"></div>

                <!-- 空状态：本地未配置 -->
                <div v-if="activeView === 'local' && !localChatPath" class="config-prompt-small">
                    <el-empty :description="t('chats.configRequired.localPathDescription')">
                        <template #image>
                            <el-icon :size="50" color="#909399">
                                <Edit />
                            </el-icon>
                        </template>
                        <template #default>
                            <div class="config-prompt-actions">
                                <el-button type="primary" :icon="FolderOpened" @click="selectLocalChatPath">
                                    {{ t('chats.configRequired.selectFolder') }}
                                </el-button>
                                <div class="config-prompt-tip">{{ t('chats.configRequired.localPathHint') }}</div>
                            </div>
                        </template>
                    </el-empty>
                </div>

                <!-- 空状态：云端未配置 -->
                <div v-else-if="activeView === 'cloud' && !isWebdavConfigValid" class="config-prompt-small">
                    <el-empty :description="t('chats.configRequired.webdavDescription')">
                        <template #image>
                            <el-icon :size="50" color="#909399">
                                <Edit />
                            </el-icon>
                        </template>
                    </el-empty>
                </div>

                <!-- 空状态：无文件 -->
                <div v-else-if="paginatedFiles.length === 0 && !isTableLoading" class="config-prompt-small">
                    <el-empty :description="t('chats.selection.empty')" :image-size="80" />
                </div>

                <!-- 列表视图 -->
                <div v-else class="chat-table-shell" v-loading="isTableLoading" :style="{ '--chat-table-columns': chatTableColumns }">
                    <div class="chat-table-header">
                        <div class="chat-column chat-column-checkbox"></div>
                        <button type="button" class="chat-column chat-column-title sortable" :class="{ active: sortMode === 'name' }"
                            :title="getColumnSortLabel('name')" @click="toggleSort('name')">
                            <span>{{ t('chats.table.filename') }}</span>
                            <span v-if="sortMode === 'name'" class="sort-indicator">{{ getSortDirectionLabel() }}</span>
                        </button>
                        <button v-if="showCreatedAtColumn" type="button" class="chat-column chat-column-created sortable"
                            :class="{ active: sortMode === 'createdAt' }" :title="getColumnSortLabel('createdAt')" @click="toggleSort('createdAt')">
                            <span>{{ t('chats.table.createdTime') }}</span>
                            <span v-if="sortMode === 'createdAt'" class="sort-indicator">{{ getSortDirectionLabel() }}</span>
                        </button>
                        <button type="button" class="chat-column chat-column-updated sortable" :class="{ active: sortMode === 'updatedAt' }"
                            :title="getColumnSortLabel('updatedAt')" @click="toggleSort('updatedAt')">
                            <span>{{ t('chats.table.modifiedTime') }}</span>
                            <span v-if="sortMode === 'updatedAt'" class="sort-indicator">{{ getSortDirectionLabel() }}</span>
                        </button>
                        <button type="button" class="chat-column chat-column-size sortable" :class="{ active: sortMode === 'size' }"
                            :title="getColumnSortLabel('size')" @click="toggleSort('size')">
                            <span>{{ t('chats.table.size') }}</span>
                            <span v-if="sortMode === 'size'" class="sort-indicator">{{ getSortDirectionLabel() }}</span>
                        </button>
                        <div class="chat-column chat-column-actions">{{ t('chats.table.actions') }}</div>
                    </div>
                    <el-scrollbar view-class="chat-list-view">
                    <!-- 绑定 mousedown 启动框选 -->
                    <div class="chat-list" ref="chatListRef" @mousedown="onMouseDown">
                        <div v-for="file in paginatedFiles" :key="file.basename" class="chat-list-item"
                            :class="{ 'is-selected': isFileSelected(file) }"
                            @click="handleItemClick(file)">

                            <!-- 左侧：选择框 -->
                            <div class="list-checkbox">
                                <el-checkbox :model-value="isFileSelected(file)"
                                    @change="(val) => toggleFileSelection(file, val)" @click.stop />
                            </div>

                            <div class="list-title" :title="normalizeTitleValue(file)">
                                {{ normalizeTitleValue(file) }}
                            </div>
                            <div v-if="showCreatedAtColumn" class="meta-created">{{ formatDate(file.createdAt || file.lastmod) }}</div>
                            <div class="meta-updated">{{ formatDate(file.updatedAt || file.lastmod || file.createdAt) }}</div>
                            <div class="meta-size">{{ formatBytes(file.size) }}</div>

                            <div class="list-actions">
                                <!-- 1. 聊天按钮 -->
                                <el-tooltip :content="t('chats.actions.chat')" placement="top" :show-after="500">
                                    <el-button link type="primary" :icon="ChatDotRound"
                                        class="action-icon-btn chat-highlight" @click.stop="startChat(file)" />
                                </el-tooltip>

                                <!-- 2. 同步按钮 -->
                                <el-tooltip
                                    :content="activeView === 'local' ? t('chats.tooltips.forceUpload') : t('chats.tooltips.forceDownload')"
                                    placement="top" :show-after="500">
                                    <el-button link type="primary" :icon="Switch" class="action-icon-btn"
                                        @click.stop="forceSyncFile(file.basename, activeView === 'local' ? 'upload' : 'download')"
                                        :loading="singleFileSyncing[file.basename]" />
                                </el-tooltip>

                                <!-- 3. 重命名按钮 -->
                                <el-tooltip :content="t('chats.actions.rename')" placement="top" :show-after="500">
                                    <el-button link type="warning" :icon="Edit" class="action-icon-btn"
                                        @click.stop="renameFile(file)" />
                                </el-tooltip>

                                <!-- 4. 删除按钮 -->
                                <el-tooltip :content="t('chats.actions.delete')" placement="top" :show-after="500">
                                    <el-button link type="danger" :icon="DeleteIcon" class="action-icon-btn"
                                        @click.stop="deleteFiles([file])" />
                                </el-tooltip>
                            </div>
                        </div>
                    </div>
                </el-scrollbar>
                </div>
            </div>

            <div class="footer-bar">
                <div class="footer-left">
                    <el-checkbox :model-value="isAllSelected" @change="toggleSelectAll" :label="t('chats.selection.selectAll')" size="large"
                        :disabled="paginatedFiles.length === 0" />
                    <span v-if="selectedFiles.length > 0" class="selection-count">{{ t('chats.selection.selectedCount', { count: selectedFiles.length }) }}</span>
                </div>
                <div class="footer-center">
                    <el-pagination v-if="currentFiles.length > 0" v-model:current-page="currentPage"
                        v-model:page-size="pageSize" :page-sizes="[10, 20, 50, 100]" :total="currentFiles.length"
                        layout="total, sizes, prev, pager, next, jumper" background size="small" />
                </div>
                <div class="footer-right">
                    <el-tooltip :content="t('common.refresh')" placement="top">
                        <el-button :icon="Refresh" circle @click="refreshData" />
                    </el-tooltip>
                    <el-tooltip :content="t('common.deleteSelected')" placement="top">
                        <el-button type="danger" :icon="DeleteIcon" circle @click="deleteFiles(selectedFiles)"
                            :disabled="selectedFiles.length === 0" />
                    </el-tooltip>
                </div>
            </div>
        </div>
    </div>
    <el-dialog v-model="isSyncing" :title="t('chats.alerts.syncInProgress')" :close-on-click-modal="false"
        :show-close="false" :close-on-press-escape="false" width="400px" center>
        <div class="sync-progress-container">
            <el-progress :percentage="syncProgress" :stroke-width="10" striped striped-flow />
            <p class="sync-status-text">{{ syncStatusText }}</p>
        </div>
        <template #footer>
            <el-button @click="cancelSync">{{ t('common.cancel') }}</el-button>
        </template>
    </el-dialog>

    <el-dialog v-model="showCleanDialog" :title="t('chats.clean.title')" width="500px" append-to-body>
        <div class="clean-dialog-body">
            <div class="clean-options">
                <span class="label">{{ t('chats.clean.timeRangeLabel') }}:</span>
                <el-select v-model="cleanDaysOption" style="width: 140px; margin-right: 10px;">
                    <el-option :label="t('chats.clean.ranges.3')" :value="3" />
                    <el-option :label="t('chats.clean.ranges.7')" :value="7" />
                    <el-option :label="t('chats.clean.ranges.30')" :value="30" />
                    <el-option :label="t('chats.clean.ranges.custom')" :value="-1" />
                </el-select>
                <el-input-number v-if="cleanDaysOption === -1" v-model="cleanCustomDays" :min="1" :max="3650"
                    style="width: 120px;" controls-position="right" />
            </div>

            <div class="clean-preview">
                <p v-if="computedFilesToClean.length > 0" class="preview-title">
                    {{ t('chats.clean.previewTitle', {
                        count: computedFilesToClean.length,
                        days: cleanDaysOption === -1 ? cleanCustomDays : cleanDaysOption,
                        size: formatBytes(totalCleanSize)
                    }) }}
                </p>
                <p v-else class="preview-title text-gray">{{ t('chats.clean.noFilesFound') }}</p>

                <el-scrollbar max-height="30vh" v-if="computedFilesToClean.length > 0" class="custom-clean-scrollbar">
                    <ul class="file-preview-list">
                        <li v-for="file in computedFilesToClean" :key="file.basename">
                            <span class="fname">{{ normalizeTitleValue(file) }}</span>
                            <span class="fdate">{{ formatDate(getCompareTimestamp(file)) }}</span>
                        </li>
                    </ul>
                </el-scrollbar>
            </div>
        </div>
        <template #footer>
            <el-button @click="showCleanDialog = false">{{ t('common.cancel') }}</el-button>
            <el-button type="danger" @click="executeAutoClean" :loading="isCleaning"
                :disabled="computedFilesToClean.length === 0">
                {{ t('chats.clean.confirmBtn') }}
            </el-button>
        </template>
    </el-dialog>
</template>

<style scoped>
/* 框选矩形样式 */
.selection-box {
    position: absolute; /* 基于 table-container 局部坐标，避免受外层玻璃态容器影响 */
    background-color: rgba(24, 24, 27, 0.1); /* Panda Black 10% */
    border: 1px solid rgba(24, 24, 27, 0.2); /* Panda Black 20% */
    z-index: 9999;
    pointer-events: none; /* 确保不阻挡鼠标事件 */
}

/* 深色模式下的选框 */
:global(html.dark) .selection-box {
    background-color: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
}

.top-toolbar {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 12px;
    padding: 8px 20px 0;
    flex-shrink: 0;
}

.view-selector {
    min-width: 0;
    text-align: center;
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
}

.chats-page-container {
    height: 100%;
    width: 100%;
    display: flex;
    flex-direction: column;
    padding: 2px;
    box-sizing: border-box;
    overflow: hidden;
}

.config-prompt {
    display: flex;
    justify-content: center;
    align-items: center;
    flex-direction: column;
    height: 100%;
    text-align: center;
    background-color: var(--bg-secondary);
    border-radius: var(--radius-lg);
    box-shadow: 0 0 0 1px var(--border-primary);
}

.config-prompt-title {
    font-size: 18px;
    color: var(--text-primary);
    margin-top: 0;
    margin-bottom: 8px;
    font-weight: 600;
}

:deep(.el-empty__description p) {
    color: var(--text-secondary);
    font-size: 14px;
}

.chats-content-wrapper {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    background-color: var(--bg-secondary);
    border-radius: var(--radius-lg);
    box-shadow: 0 0 0 1px var(--border-primary), var(--shadow-sm);
    overflow: hidden;
}


.chat-table-shell {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
}

.chat-table-header {
    display: grid;
    grid-template-columns: var(--chat-table-columns);
    align-items: center;
    gap: 12px;
    padding: 0 16px 10px 16px;
    margin: 4px 10px 6px 0;
    border-bottom: 1px solid var(--border-primary);
}

.chat-column {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    min-width: 0;
    text-align: left;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-tertiary);
    letter-spacing: 0.02em;
}

.chat-column.sortable {
    justify-content: flex-start;
    gap: 6px;
    width: 100%;
    border: none;
    background: transparent;
    padding: 0;
    cursor: pointer;
    transition: color 0.2s ease;
}

.chat-column.sortable:hover,
.chat-column.sortable.active {
    color: var(--el-color-primary);
}

.sort-indicator {
    font-size: 11px;
    line-height: 1;
}

.chat-column-actions {
    justify-content: flex-start;
    padding-right: 0;
}

.table-container {
    flex-grow: 1;
    overflow: hidden;
    padding: 5px 0px 10px 10px;
    position: relative; /* 为选框提供定位上下文 (虽然我们用了 fixed，但保持结构清晰) */
    user-select: none;  /* 防止拖拽时选中文本 */
}

/* === 紧凑列表样式 Start === */
.chat-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-right: 10px;
    min-height: 100%; /* 确保拖拽空白处也能触发 */
    cursor: default;  /* 默认鼠标 */
}

.chat-table-shell :deep(.el-scrollbar) {
    min-height: 0;
    flex: 1;
}

.chat-list-item {
    display: grid;
    grid-template-columns: var(--chat-table-columns);
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    background-color: transparent;
    border-radius: 16px 8px 8px 16px;
    transition: background-color 0.2s;
    cursor: pointer;
    position: relative;
    height: 44px;
    box-sizing: border-box;
    width: 100%;
}

.chat-list-item:hover {
    background-color: var(--bg-tertiary);
    border-radius: 16px 8px 8px 16px;
}

.chat-list-item.is-selected {
    background-color: var(--el-color-primary-light-9);
}

/* 深色模式下的选中状态 */
:global(html.dark) .chat-list-item.is-selected {
    background-color: rgba(64, 158, 255, 0.15);
}

.list-checkbox {
    width: 0;
    margin-right: 0;
    display: flex;
    align-items: center;
    opacity: 0;
    overflow: hidden;
    transition: all 0.2s ease;
    pointer-events: none;
}

.chat-list-item:hover .list-checkbox {
    pointer-events: auto;
}

.chat-list-item.is-selected .list-checkbox {
    width: 24px;
    margin-right: 0px;
    opacity: 1;
    pointer-events: auto;
}

.list-title {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    padding-right: 8px;
    transition: transform 0.2s ease;
}

.meta-created,
.meta-updated,
.meta-size {
    min-width: 0;
    font-size: 12px;
    color: var(--text-tertiary);
    text-align: left;
    white-space: nowrap;
}

.list-actions {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 4px;
    min-width: 0;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.2s;
}

.meta-separator {
    opacity: 0.5;
}

.meta-time {
    white-space: nowrap;
    flex-shrink: 0;
}

.meta-size {
    flex-shrink: 0;
    white-space: nowrap;
}


.chat-list-item:hover .list-actions,
.chat-list-item.is-selected .list-actions {
    opacity: 1;
}

.action-icon-btn {
    font-size: 16px;
    padding: 6px;
    margin-left: 0 !important;
    color: var(--text-secondary);
}

.action-icon-btn:hover {
    color: var(--el-color-primary);
    background-color: rgba(0, 0, 0, 0.05);
}

.action-icon-btn.chat-highlight {
    color: var(--text-secondary);
}

.action-icon-btn.chat-highlight:hover {
    color: var(--el-color-primary);
}

:deep(.chat-list-view) {
    min-height: 100%;
}

.footer-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    flex-wrap: nowrap;
    gap: 10px;
    padding: 10px 15px;
    border-top: 1px solid var(--border-primary);
    background-color: var(--bg-primary);
    flex-shrink: 0;
}

.footer-left {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 70px;
}

.selection-count {
    font-size: 12px;
    color: var(--el-color-primary);
    font-weight: 500;
}

.footer-center {
    flex-grow: 1;
    display: flex;
    justify-content: center;
}

.footer-right {
    display: flex;
    align-items: center;
    gap: 10px;
    justify-content: flex-end;
    min-width: 70px;
}

:deep(.el-pagination) {
    --el-pagination-text-color: var(--text-secondary);
}

:deep(.el-pagination.is-background .el-pager li),
:deep(.el-pagination.is-background .btn-prev),
:deep(.el-pagination.is-background .btn-next) {
    background-color: var(--bg-tertiary);
    color: var(--text-primary);
}

:deep(.el-pagination.is-background .el-pager li:not(.is-disabled).is-active) {
    background-color: var(--bg-accent);
    color: var(--text-on-accent);
}

:deep(.el-pagination.is-background .el-pager li:hover) {
    color: var(--text-accent);
}

:deep(.el-pagination.is-background .btn-prev:hover),
:deep(.el-pagination.is-background .btn-next:hover) {
    color: var(--text-accent);
}

.config-prompt-actions {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    margin-top: 8px;
}

.config-prompt-tip {
    font-size: 12px;
    line-height: 1.6;
    color: var(--text-tertiary);
    text-align: center;
    max-width: 320px;
}


.config-prompt-small {
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100%;
}

.sync-progress-container {
    padding: 20px;
    text-align: center;
}

.sync-status-text {
    margin-top: 15px;
    color: var(--text-secondary);
}

.sync-buttons-container {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    flex-shrink: 0;
}

.sync-buttons-container .el-button {
    width: 32px;
    height: 32px;
}

.sync-buttons-container :deep(.el-badge__content) {
    font-size: 10px;
    padding: 0 5px;
    height: 16px;
    line-height: 16px;
    min-width: 16px;
    border-width: 1px;
    transform: translateY(-50%) translateX(70%);
}

html.dark .sync-buttons-container :deep(.el-badge__content--primary) {
    background-color: var(--el-color-primary);
    color: var(--bg-primary);
}

.info-button-container {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
}

.info-button-container .el-button {
    width: 32px;
    height: 32px;
}

.info-popover-content p {
    margin: 0 0 8px 0;
    line-height: 1.6;
    color: var(--text-secondary);
}

.info-popover-content p:last-child {
    margin-bottom: 0;
}

.info-popover-content strong {
    color: var(--text-primary);
}

.info-popover-content code {
    background-color: var(--bg-tertiary);
    color: var(--el-color-primary);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.9em;
    word-break: break-all;
}

.clean-options {
    display: flex;
    align-items: center;
    margin-top: 10px;
}

.clean-options .label {
    margin-right: 10px;
    font-weight: 500;
    color: var(--text-primary);
}

.clean-preview {
    margin-top: 15px;
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    padding: 10px 10px 5px 10px;
    background-color: var(--bg-tertiary);
}

.preview-title {
    margin: 0 0 8px 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--el-color-danger);
}

.preview-title.text-gray {
    color: var(--text-tertiary);
}

.file-preview-list {
    list-style: none;
    padding: 0;
    margin: 0;
}

.custom-clean-scrollbar {
    width: 100%;
}

.custom-clean-scrollbar :deep(.el-scrollbar__view) {
    display: block;
}

html.dark .custom-clean-scrollbar :deep(.el-scrollbar__thumb) {
    background-color: var(--text-tertiary);
    opacity: 0.5;
}

html.dark .custom-clean-scrollbar :deep(.el-scrollbar__thumb:hover) {
    background-color: var(--text-secondary);
    opacity: 0.8;
}

.file-preview-list li {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    padding: 4px 0;
    border-bottom: 1px dashed var(--border-primary);
    color: var(--text-secondary);
}

.file-preview-list li:last-child {
    border-bottom: none;
}

.file-preview-list .fname {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-right: 10px;
}

.file-preview-list .fdate {
    flex-shrink: 0;
    color: var(--text-tertiary);
    margin-right: 12px;
}
</style>