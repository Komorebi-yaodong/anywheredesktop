<script setup>
import { ref, watch, onMounted, nextTick, provide, onBeforeUnmount, computed } from 'vue'
import Chats from './components/Chats.vue'
import Tasks from './components/Tasks.vue'
import Prompts from './components/Prompts.vue'
import Mcp from './components/Mcp.vue'
import Setting from './components/Setting.vue'
import Providers from './components/Providers.vue'
import Skills from './components/Skills.vue'

import { useI18n } from 'vue-i18n'
import { Collection, Bell, Document } from '@element-plus/icons-vue'
import { marked } from 'marked';
import { ElBadge } from 'element-plus'; // 确保引入 ElBadge

const { t, locale } = useI18n()
const tab = ref(0);
const header_text = ref(t('app.header.chats'));

const config = ref(null);


const fallbackDefaultConfig = {
  defaultTaskModel: '',
  tasks: {},
  providers: {
    '0': {
      name: 'default',
      url: 'https://api.openai.com/v1',
      api_key: '',
      apiType: 'chat_completions',
      modelList: [],
      enable: true
    }
  },
  providerOrder: ['0'],
  providerFolders: {},
  prompts: {
    AI: {
      type: 'over',
      prompt: '你是一个AI助手',
      showMode: 'window',
      model: '0|gpt-4o',
      enable: true,
      icon: '',
      stream: true,
      temperature: 0.7,
      isTemperature: false,
      isDirectSend_file: false,
      isDirectSend_normal: true,
      isDirectSend_image: true,
      ifTextNecessary: false,
      voice: null,
      reasoning_effort: 'default',
      defaultMcpServers: [],
      defaultSkills: [],
      window_width: 580,
      window_height: 740,
      position_x: 0,
      position_y: 0,
      autoCloseOnBlur: true,
      isAlwaysOnTop: true,
      autoSaveChat: false
    }
  },
  settingsCardOrder: ['general', 'desktop', 'voice', 'data', 'webdav'],
  settingsCardCollapsed: {
    general: false,
    desktop: false,
    voice: false,
    data: false,
    webdav: false
  },
  fastWindowPosition: null,
  mcpServers: {},
  skillPath: '',
  language: 'zh',
  tags: {},
  skipLineBreak: false,
  CtrlEnterToSend: false,
  isDarkMode: false,
  themeMode: 'system',
  fix_position: false,
  isAlwaysOnTop_global: true,
  autoCloseOnBlur_global: true,
  autoSaveChat_global: false,
  zoom: 1,
  webdav: {
    url: '',
    username: '',
    password: '',
    path: '/anywhere',
    data_path: '/anywhere_data',
    localChatPath: ''
  },
    desktop: {
    closeToTray: true,
    shortcuts: {
      mainToggle: 'Ctrl+Space',
      quickSummon: 'Alt+A',
      appendFollowUp: 'Alt+S',
      promptBindings: []
    },
    profile: {
      nickname: 'User',
      avatar: ''
    },
    guide: {
      quickStartOpened: false
    }
  },

voiceList: []
};

function normalizeConfigPayload(result) {
  const base = JSON.parse(JSON.stringify(fallbackDefaultConfig));
  const fromResult = result && typeof result === 'object' && result.config && typeof result.config === 'object'
    ? result.config
    : null;
  return fromResult ? Object.assign(base, fromResult) : base;
}




const initialDarkMode = window.__ANYWHERE_INITIAL_DARK__ === true;

function resolveDocumentDarkMode(nextConfig = null) {
  const themeMode = typeof nextConfig?.themeMode === 'string' ? nextConfig.themeMode : '';
  if (themeMode === 'dark') return true;
  if (themeMode === 'light') return false;
  if (typeof nextConfig?.isDarkMode === 'boolean') return nextConfig.isDarkMode;
  return initialDarkMode;
}

function applyDocumentTheme(isDark) {
  if (isDark) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

//将 config provide 给所有子组件
provide('config', config);

// 主题 class 必须基于 themeMode 统一判定，避免 config 刚注入时的旧 isDarkMode 覆盖首屏主题。
watch(
  () => [config.value?.themeMode, config.value?.isDarkMode],
  () => {
    if (!config.value) return;
    applyDocumentTheme(resolveDocumentDarkMode(config.value));

    console.log('[theme-debug][render:App] after-applyDocumentTheme', {
      finalHasDarkClass: document.documentElement.classList.contains('dark'),
      resolvedDocumentDarkMode: resolveDocumentDarkMode(config.value),
      themeMode: config.value?.themeMode,
      isDarkMode: config.value?.isDarkMode
    });
  },
  { deep: true }
);

const handleGlobalEsc = (e) => {
  if (e.key === 'Escape') {
    // 1. 优先检查图片预览组件 (Image Viewer)
    const imageViewerCloseBtn = document.querySelector('.el-image-viewer__close');
    if (imageViewerCloseBtn && window.getComputedStyle(imageViewerCloseBtn).display !== 'none') {
      e.stopPropagation(); // 阻止 uTools 退出
      imageViewerCloseBtn.click(); // 手动触发关闭
      return;
    }

    // 2. 检查可见的弹窗遮罩层 (Dialog Overlays)
    const overlays = Array.from(document.querySelectorAll('.el-overlay')).filter(el => {
      return el.style.display !== 'none' && !el.classList.contains('is-hidden');
    });

    if (overlays.length > 0) {
      // 找到层级最高（最上层）的弹窗
      const topOverlay = overlays.reduce((max, current) => {
        return (parseInt(window.getComputedStyle(current).zIndex) || 0) >
          (parseInt(window.getComputedStyle(max).zIndex) || 0) ? current : max;
      });

      // 阻止 uTools 退出
      e.stopPropagation();

      // A. 尝试点击右上角的关闭(X)按钮
      const headerBtn = topOverlay.querySelector('.el-dialog__headerbtn, .el-message-box__headerbtn');
      if (headerBtn) {
        headerBtn.click();
        return;
      }

      // B. 尝试点击底部的取消/关闭按钮
      const footer = topOverlay.querySelector('.el-dialog__footer, .el-message-box__btns');
      if (footer) {
        // 特殊处理 Setting.vue 中备份管理的布局 (关闭按钮在 .footer-right)
        const rightBtn = footer.querySelector('.footer-right .el-button');
        if (rightBtn) {
          rightBtn.click();
          return;
        }
        // 通用处理：点击底部第一个按钮 (通常是 取消/Cancel)
        const buttons = footer.querySelectorAll('.el-button');
        if (buttons.length > 0) {
          buttons[0].click();
          return;
        }
      }
    }
  }
};

const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
const handleSystemThemeChange = (e) => {
  // 只有当设置为 "system" 时才响应
  if (config.value?.themeMode === 'system') {
    const isDark = e.matches;
    if (config.value.isDarkMode !== isDark) {
      config.value.isDarkMode = isDark;
      // 同步更新到数据库，确保独立窗口打开时也是正确的颜色
      if (window.api && window.api.saveSetting) {
        window.api.saveSetting('isDarkMode', isDark);
      }
    }
  }
};

const showDocDialog = ref(false);
const docLoading = ref(false);
const currentDocContent = ref('');
const activeDocIndex = ref('0');
const docScrollbarRef = ref(null);
const QUICK_START_DOC_FILE = '__quick_start__';

const versionInfo = ref({
  currentVersion: '',
  latestVersion: '',
  hasUpdate: false,
  source: '',
  checkedUrl: '',
  checkFailed: false
});

const docVersionText = computed(() => {
  const current = versionInfo.value?.currentVersion ? `v${versionInfo.value.currentVersion}` : '';
  if (!current) return '';
  if (versionInfo.value?.hasUpdate && versionInfo.value?.latestVersion) {
    return `${current} · ${t('doc.version.latestAvailable', { version: `v${versionInfo.value.latestVersion}` })}`;
  }
  return current;
});

const docVersionTooltip = computed(() => {
  if (versionInfo.value?.hasUpdate && versionInfo.value?.latestVersion) {
    return t('doc.version.updateTooltip', {
      current: `v${versionInfo.value.currentVersion}`,
      latest: `v${versionInfo.value.latestVersion}`
    });
  }
  if (versionInfo.value?.currentVersion) {
    return t('doc.version.currentOnlyTooltip', {
      current: `v${versionInfo.value.currentVersion}`
    });
  }
  return '';
});


const getReleasePageUrl = () => {
  if (versionInfo.value?.source === 'gitee') {
    return 'https://gitee.com/Komorebi-yaodong/anywheredesktop/releases';
  }
  return 'https://github.com/Komorebi-yaodong/anywheredesktop/releases';
};

const openReleasePage = () => {
  const targetUrl = getReleasePageUrl();
  if (window.api && window.api.shellOpenExternal) {
    window.api.shellOpenExternal(targetUrl);
    return;
  }
  window.open(targetUrl, '_blank');
};

const fetchVersionInfo = async () => {
  try {
    const currentResult = await window.api.getAppVersion();
    const currentVersion = typeof currentResult?.version === 'string' ? currentResult.version.trim() : '';
    versionInfo.value = {
      ...versionInfo.value,
      currentVersion,
      checkFailed: false
    };

    const latestResult = await window.api.checkLatestVersion();
    if (latestResult?.ok) {
      versionInfo.value = {
        currentVersion,
        latestVersion: typeof latestResult?.latestVersion === 'string' ? latestResult.latestVersion.trim() : '',
        hasUpdate: Boolean(latestResult?.hasUpdate),
        source: typeof latestResult?.source === 'string' ? latestResult.source : '',
        checkedUrl: typeof latestResult?.checkedUrl === 'string' ? latestResult.checkedUrl : '',
        checkFailed: false
      };
      return;
    }

    versionInfo.value = {
      ...versionInfo.value,
      currentVersion,
      latestVersion: '',
      hasUpdate: false,
      source: '',
      checkedUrl: '',
      checkFailed: true
    };
  } catch (error) {
    console.warn('Failed to fetch version info:', error);
    versionInfo.value = {
      ...versionInfo.value,
      latestVersion: '',
      hasUpdate: false,
      source: '',
      checkedUrl: '',
      checkFailed: true
    };
  }
};


const escapeHtml = (value = '') => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const getQuickStartDocHtml = () => {
  const mainToggle = config.value?.desktop?.shortcuts?.mainToggle || 'Ctrl+Space';
  const quickSummon = config.value?.desktop?.shortcuts?.quickSummon || 'Alt+A';
  const appendFollowUp = config.value?.desktop?.shortcuts?.appendFollowUp || 'Alt+S';

  const renderShortcut = (shortcut) => {
    return escapeHtml(shortcut)
      .split('+')
      .filter(Boolean)
      .map((part) => `<span class="shortcut-key">${part}</span>`)
      .join('<span class="shortcut-plus">+</span>');
  };

  return `
    <section class="quick-start-doc">
      <div class="quick-start-hero">
        <div class="quick-start-hero__title-row">
          <h1>${escapeHtml(t('doc.quickStart.title'))}</h1>
          <div class="quick-start-hero__badge">${escapeHtml(t('doc.quickStart.badge'))}</div>
        </div>
        <p>${escapeHtml(t('doc.quickStart.description'))}</p>
      </div>

      <div class="quick-start-panel">
        <div class="quick-start-panel__header">
          <h2>${escapeHtml(t('doc.quickStart.basicsTitle'))}</h2>
          <p>${escapeHtml(t('doc.quickStart.basicsDescription'))}</p>
        </div>

        <div class="quick-start-shortcuts">
          <article class="quick-start-shortcut-card">
            <div class="quick-start-shortcut-card__keys">${renderShortcut(mainToggle)}</div>
            <div class="quick-start-shortcut-card__body">
              <h3>${escapeHtml(t('doc.quickStart.mainWindow.title'))}</h3>
              <p>${escapeHtml(t('doc.quickStart.mainWindow.description'))}</p>
            </div>
          </article>

          <article class="quick-start-shortcut-card">
            <div class="quick-start-shortcut-card__keys">${renderShortcut(quickSummon)}</div>
            <div class="quick-start-shortcut-card__body">
              <h3>${escapeHtml(t('doc.quickStart.agent.title'))}</h3>
              <p>${escapeHtml(t('doc.quickStart.agent.description'))}</p>
            </div>
          </article>

          <article class="quick-start-shortcut-card">
            <div class="quick-start-shortcut-card__keys">${renderShortcut(appendFollowUp)}</div>
            <div class="quick-start-shortcut-card__body">
              <h3>${escapeHtml(t('doc.quickStart.followUp.title'))}</h3>
              <p>${escapeHtml(t('doc.quickStart.followUp.description'))}</p>
            </div>
          </article>
        </div>
      </div>

      <div class="quick-start-tips">
        <h2>${escapeHtml(t('doc.quickStart.customShortcut.title'))}</h2>
        <p class="quick-start-tip-lead">${escapeHtml(t('doc.quickStart.customShortcut.description'))}</p>
        <div class="quick-start-custom-card">
          <div class="quick-start-custom-card__keys">
            <span class="shortcut-key">Agent</span>
            <span class="shortcut-plus">→</span>
            <span class="shortcut-key">${escapeHtml(t('doc.quickStart.customShortcut.entry'))}</span>
          </div>
          <div class="quick-start-custom-card__body">
            <h3>${escapeHtml(t('doc.quickStart.customShortcut.cardTitle'))}</h3>
            <p>${escapeHtml(t('doc.quickStart.customShortcut.cardDescription'))}</p>
          </div>
        </div>
      </div>
      <p class="quick-start-feedback">${escapeHtml(t('doc.quickStart.customShortcut.feedbackGroup'))}</p>
    </section>
  `;
};

// 文档列表配置，增加 i18nKey 用于动态标题，lastUpdated 动态获取
const docList = ref([
  { i18nKey: 'doc.titles.quickStart', file: QUICK_START_DOC_FILE, lastUpdated: null, isBuiltin: true },
  { i18nKey: 'doc.titles.chat', file: 'chat_doc.md', lastUpdated: null },
  { i18nKey: 'doc.titles.task', file: 'task_doc.md', lastUpdated: null },
  { i18nKey: 'doc.titles.ai', file: 'ai_doc.md', lastUpdated: null },
  { i18nKey: 'doc.titles.mcp', file: 'mcp_doc.md', lastUpdated: null },
  { i18nKey: 'doc.titles.skill', file: 'skill_doc.md', lastUpdated: null },
  { i18nKey: 'doc.titles.provider', file: 'provider_doc.md', lastUpdated: null },
  { i18nKey: 'doc.titles.setting', file: 'setting_doc.md', lastUpdated: null }
]);

// 阅读状态管理
const readStatusKey = 'anywhere_doc_last_read';
const docReadMap = ref({});

// 初始化读取状态
const loadReadStatus = () => {
  try {
    const stored = localStorage.getItem(readStatusKey);
    docReadMap.value = stored ? JSON.parse(stored) : {};
  } catch (e) {
    docReadMap.value = {};
  }
};

// 定义源地址常量
const GITHUB_BASE = 'https://raw.githubusercontent.com/Komorebi-yaodong/anywhere_doc/main/';
const GITEE_BASE = 'https://gitee.com/Komorebi-yaodong/anywhere_/raw/main/';

/**
 * 尝试从 GitHub 获取，失败则回退到 Gitee
 * @param {string} relativePath 相对路径 (e.g. 'docs/chat_doc.md')
 * @returns {Promise<{text: string, source: 'github'|'gitee'}>}
 */
const fetchWithFallback = async (relativePath) => {
  try {
    const githubResult = await window.api.readRemoteText(`${GITHUB_BASE}${relativePath}`);
    if (githubResult?.ok !== false && typeof githubResult?.text === 'string') {
      return { text: githubResult.text, source: 'github' };
    }
  } catch (e) {
    console.warn(`GitHub fetch failed for ${relativePath}, trying Gitee...`, e);
  }

  try {
    const giteeResult = await window.api.readRemoteText(`${GITEE_BASE}${relativePath}`);
    if (giteeResult?.ok !== false && typeof giteeResult?.text === 'string') {
      return { text: giteeResult.text, source: 'gitee' };
    }
  } catch (e) {
    console.warn(`Gitee fetch failed for ${relativePath}`, e);
  }

  throw new Error('Failed to fetch from both GitHub and Gitee');
};

// 预取所有文档的元数据（更新时间）
const fetchAllDocsMetadata = async () => {
  const dateRegex = /\*\*文档更新时间：(\d{4})年(\d{1,2})月(\d{1,2})日\*\*/;

  const promises = docList.value.map(async (doc) => {
    if (doc.isBuiltin) {
      doc.lastUpdated = null;
      return;
    }

    try {
      const { text } = await fetchWithFallback(`docs/${doc.file}`);
      
      const match = text.match(dateRegex);
      if (match) {
        // 转换为兼容格式 YYYY/MM/DD 00:00:00
        const year = match[1];
        const month = match[2];
        const day = match[3];
        doc.lastUpdated = `${year}/${month}/${day} 00:00:00`;
      }
    } catch (e) {
      console.warn(`Failed to fetch metadata for ${doc.file}`, e);
    }
  });

  await Promise.all(promises);
};

const fetchAndParseDoc = async (filename) => {
  // 标记当前文档为已读
  markDocAsRead(filename);

  if (filename === QUICK_START_DOC_FILE) {
    docLoading.value = false;
    currentDocContent.value = getQuickStartDocHtml();
    nextTick(() => {
      if (docScrollbarRef.value) {
        docScrollbarRef.value.setScrollTop(0);
      }
    });
    return;
  }

  docLoading.value = true;
  try {
    // 使用双源获取策略
    const { text: rawText, source } = await fetchWithFallback(`docs/${filename}`);
    let text = rawText;

    // 根据数据源决定图片的 Base URL
    const imgBaseUrl = source === 'gitee' 
      ? `${GITEE_BASE}image/` 
      : `${GITHUB_BASE}image/`;

    // 图片路径修正逻辑
    text = text.replace(/!\[(.*?)\]\((\.\.[\\/])?image[\\/](.*?)\)/g, (match, alt, prefix, imgFilename) => {
      return `![${alt}](${imgBaseUrl}${encodeURIComponent(imgFilename)})`;
    });

    currentDocContent.value = marked.parse(text);

    // 等待 DOM 更新后，将滚动条回到顶部
    nextTick(() => {
      if (docScrollbarRef.value) {
        docScrollbarRef.value.setScrollTop(0);
      }
    });

  } catch (error) {
    console.error('Failed to load doc:', error);
    currentDocContent.value = `<h3>${t('doc.loadFailed')}</h3><p>${t('doc.checkNetwork')}</p><p style="font-size:12px; color:#888;">${t('doc.sourcesUnavailable')}</p>`;
  } finally {
    docLoading.value = false;
  }
};

// 检查是否有更新
const checkDocHasUpdate = (index) => {
  const doc = docList.value[index];
  if (!doc || doc.isBuiltin || !doc.lastUpdated) return false;

  // 从配置中读取状态
  const readMap = config.value?.docReadStatus || {};
  const lastRead = readMap[doc.file];

  // 如果从未读过，或者更新时间晚于阅读时间，显示红点
  if (!lastRead) return true;

  // Date比较
  const updateTime = new Date(doc.lastUpdated).getTime();
  const readTime = new Date(lastRead).getTime();

  return updateTime > readTime;
};

// 检查是否有任意文档更新（用于铃铛图标）
const hasAnyUpdate = computed(() => {
  return docList.value.some((_, index) => checkDocHasUpdate(index));
});

// 标记文档为已读
const markDocAsRead = async (filename) => {
  if (!config.value) return;

  // 1. 初始化对象 (如果不存在)
  if (!config.value.docReadStatus) {
    config.value.docReadStatus = {};
  }

  // 2. 更新内存中的配置 (触发界面响应)
  config.value.docReadStatus[filename] = new Date().toISOString();

  // 3. 持久化保存到 uTools 数据库，这里保存整个 docReadStatus 对象
  try {
    await window.api.saveSetting('docReadStatus', JSON.parse(JSON.stringify(config.value.docReadStatus)));
  } catch (e) {
    console.error("保存阅读状态失败:", e);
  }
};

// 监听文档切换
watch(activeDocIndex, (newIndex) => {
  const doc = docList.value[newIndex];
  if (doc) {
    fetchAndParseDoc(doc.file);
  }
});

// 打开弹窗时加载第一个文档，并更新阅读状态
const openQuickStartGuideIfNeeded = async () => {
  if (!config.value || config.value?.desktop?.guide?.quickStartOpened) return;

  activeDocIndex.value = '0';
  openHelpDialog();

  config.value.desktop = config.value.desktop || {};
  config.value.desktop.guide = config.value.desktop.guide || {};
  config.value.desktop.guide.quickStartOpened = true;

  try {
    await window.api.saveSetting('desktop.guide.quickStartOpened', true);
  } catch (error) {
    console.error('Failed to persist quick start guide state:', error);
  }
};


const openHelpDialog = () => {
  showDocDialog.value = true;

  const index = parseInt(activeDocIndex.value) || 0;
  const targetDoc = docList.value[index];

  if (targetDoc) {
    // 无论是首次打开还是切换，都重新加载（可能内容有变）并标记已读
    fetchAndParseDoc(targetDoc.file);
  }
};

const handleDocLinks = (event) => {
  const target = event.target.closest('a');
  if (!target) return;

  // 阻止默认跳转（防止在当前窗口打开导致页面白屏）
  event.preventDefault();

  const href = target.getAttribute('href');
  if (!href) return;

  // 1. 处理 HTTP/HTTPS 外部链接 -> 调用系统浏览器打开
  if (href.startsWith('http://') || href.startsWith('https://')) {
    if (window.api && window.api.shellOpenExternal) {
      window.api.shellOpenExternal(href);
    } else {
      window.open(href, '_blank'); // 兜底方案
    }
    return;
  }

  // 2. 处理文档间跳转 (例如: ./mcp_doc.md) -> 切换左侧菜单
  if (href.endsWith('.md')) {
    // 提取文件名 (兼容 ./xxx.md 或 xxx.md)
    const filename = href.split(/[/\\]/).pop();
    const targetIndex = docList.value.findIndex(doc => doc.file === filename);

    if (targetIndex !== -1) {
      activeDocIndex.value = String(targetIndex);
    }
  }
};

onMounted(async () => {
  // 异步获取文档更新时间，获取后会自动更新UI红点
  fetchAllDocsMetadata();
  fetchVersionInfo();

  window.addEventListener('local-config-updated', (event) => {
    const newConfig = event.detail;
    if (newConfig && config.value) {
      config.value = Object.assign({}, config.value, newConfig);
    }
  });

  window.addEventListener('keydown', handleGlobalEsc, true);
  mediaQuery.addEventListener('change', handleSystemThemeChange);
  try {
    const result = await window.api.getConfig();
    config.value = normalizeConfigPayload(result);

    console.log('[theme-debug][render:App] config-loaded', {
      initialDarkMode,
      themeMode: config.value?.themeMode,
      isDarkMode: config.value?.isDarkMode,
      resolvedDocumentDarkMode: resolveDocumentDarkMode(config.value),
      search: window.location.search,
      hasDarkClassBeforeApply: document.documentElement.classList.contains('dark')
    });


    if (config.value.themeMode === 'system') {
      const preferredDark = initialDarkMode;
      if (config.value.isDarkMode !== preferredDark) {
        config.value.isDarkMode = preferredDark;
        window.api.saveSetting('isDarkMode', preferredDark);
      }
    }

    await openQuickStartGuideIfNeeded();
  } catch (error) {
    console.error("Error fetching config in App.vue:", error);
    config.value = normalizeConfigPayload(null);
  }
  // Immediately apply dark mode on mount

  console.log('[theme-debug][render:App] after-mount-applyDocumentTheme', {
    finalHasDarkClass: document.documentElement.classList.contains('dark'),
    resolvedDocumentDarkMode: resolveDocumentDarkMode(config.value),
    themeMode: config.value?.themeMode,
    isDarkMode: config.value?.isDarkMode,
    search: window.location.search
  });

  applyDocumentTheme(resolveDocumentDarkMode(config.value));

  await nextTick();
  requestAnimationFrame(() => {
    hideStartupSplash();
  });
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleGlobalEsc, true);
  mediaQuery.removeEventListener('change', handleSystemThemeChange);
});



function hideStartupSplash() {
  try {
    if (typeof window.__ANYWHERE_HIDE_STARTUP_SPLASH__ === 'function') {
      window.__ANYWHERE_HIDE_STARTUP_SPLASH__();
      return;
    }
  } catch (error) {
    console.warn('Failed to hide startup splash:', error);
  }

  document.body?.classList.add('app-ready');
  document.getElementById('startup-splash')?.remove();
}

function changeTab(newTab) {
  tab.value = newTab;
  updateHeaderText();
}

function updateHeaderText() {
  const tabMap = {
    0: 'app.header.chats',
    1: 'app.header.tasks',
    2: 'app.header.prompts',
    3: 'app.header.mcp',
    4: 'app.header.skills',
    5: 'app.header.providers',
    6: 'app.header.settings'
  };
  header_text.value = t(tabMap[tab.value]);
}

watch(locale, () => {
  updateHeaderText();
});
</script>

<template>
  <el-container class="common-layout">
    <el-header>
      <el-row :gutter="0" class="header-row" align="middle">
        <!-- 左侧：帮助文档按钮 -->
        <el-col :span="6" class="left-actions-col">
          <el-tooltip :content="t('app.header.help') || '使用指南'" placement="bottom">
            <el-button class="tab-button" text @click="openHelpDialog">
              <el-badge :is-dot="hasAnyUpdate" class="bell-badge">
                <el-icon :size="20">
                  <Bell />
                </el-icon>
              </el-badge>
            </el-button>
          </el-tooltip>
        </el-col>

        <el-col :span="12" class="header-title-col">
          <el-text class="header-title-text">{{ header_text }}</el-text>
        </el-col>
        <el-col :span="6" class="tabs-col">
          <div class="tabs-container">
            <!-- 1. Chats (云端对话) -->
            <el-tooltip :content="t('app.tabs.chats')" placement="bottom">
              <el-button class="tab-button" text @click="changeTab(0)" :class="{ 'active-tab': tab === 0 }">
                <el-icon :size="20">
                  <svg t="1765030297139" class="icon" viewBox="0 0 1024 1024" version="1.1"
                    xmlns="http://www.w3.org/2000/svg" p-id="72601" width="200" height="200">
                    <path
                      d="M512 64c259.2 0 469.333333 200.576 469.333333 448s-210.133333 448-469.333333 448a484.48 484.48 0 0 1-232.725333-58.88l-116.394667 50.645333a42.666667 42.666667 0 0 1-58.517333-49.002666l29.76-125.013334C76.629333 703.402667 42.666667 611.477333 42.666667 512 42.666667 264.576 252.8 64 512 64z m0 64C287.488 128 106.666667 300.586667 106.666667 512c0 79.573333 25.557333 155.434667 72.554666 219.285333l5.525334 7.317334 18.709333 24.192-26.965333 113.237333 105.984-46.08 27.477333 15.018667C370.858667 878.229333 439.978667 896 512 896c224.512 0 405.333333-172.586667 405.333333-384S736.512 128 512 128z m-157.696 341.333333a42.666667 42.666667 0 1 1 0 85.333334 42.666667 42.666667 0 0 1 0-85.333334z m159.018667 0a42.666667 42.666667 0 1 1 0 85.333334 42.666667 42.666667 0 0 1 0-85.333334z m158.997333 0a42.666667 42.666667 0 1 1 0 85.333334 42.666667 42.666667 0 0 1 0-85.333334z"
                      fill="currentColor" p-id="72602"></path>
                  </svg>
                </el-icon>
              </el-button>
            </el-tooltip>

            <!-- 2. Tasks 定时任务 -->
            <el-tooltip :content="t('app.tabs.tasks') || '定时任务'" placement="bottom">
              <el-button class="tab-button" text @click="changeTab(1)" :class="{ 'active-tab': tab === 1 }">
                <el-icon :size="20">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                    stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <polyline points="12 6 12 12 16 14"></polyline>
                  </svg>
                </el-icon>
              </el-button>
            </el-tooltip>

            <!-- 3. Prompts (快捷助手/Agent) -->
            <el-tooltip :content="t('app.tabs.prompts')" placement="bottom">
              <el-button class="tab-button" text @click="changeTab(2)" :class="{ 'active-tab': tab === 2 }">
                <el-icon :size="20">
                  <svg t="1765030347985" class="icon" viewBox="0 0 1024 1024" version="1.1"
                    xmlns="http://www.w3.org/2000/svg" p-id="77085" width="200" height="200">
                    <path
                      d="M617.92 198.784A270.4 270.4 0 0 1 888.32 469.12v225.344a270.464 270.464 0 0 1-270.4 270.464h-315.52A270.4 270.4 0 0 1 32 694.528v-225.28a270.4 270.4 0 0 1 270.4-270.464h315.52z m0 90.112h-315.52a180.288 180.288 0 0 0-180.288 180.288v225.344a180.288 180.288 0 0 0 180.288 180.288h315.52a180.288 180.288 0 0 0 180.288-180.288v-225.28a180.288 180.288 0 0 0-180.288-180.352z"
                      p-id="77086"></path>
                    <path
                      d="M324.928 491.712c30.08 0 45.12 15.04 45.12 45.056v90.176c0 30.08-15.04 45.056-45.12 45.056-30.016 0-45.056-15.04-45.056-45.056V536.768c0-30.08 15.04-45.056 45.056-45.056zM594.944 483.584a38.336 38.336 0 0 1 45.952 61.312l-49.28 36.992 49.28 36.928a38.336 38.336 0 0 1 10.496 49.28l-2.816 4.352a38.272 38.272 0 0 1-53.632 7.68l-66.112-49.6a60.8 60.8 0 0 1 0-97.28l66.112-49.664zM922.944 220.544l-21.312 44.544a17.536 17.536 0 0 1-7.104 7.488 21.312 21.312 0 0 1-21.376 0 17.536 17.536 0 0 1-7.104-7.488l-21.376-44.544a44.608 44.608 0 0 0-21.312-20.608l-37.696-17.984a18.368 18.368 0 0 1-7.296-6.144 15.232 15.232 0 0 1-2.688-8.576c0-3.008 0.896-6.016 2.688-8.576a18.368 18.368 0 0 1 7.296-6.144l37.76-17.92a44.8 44.8 0 0 0 21.248-20.736l21.376-44.48a17.536 17.536 0 0 1 7.04-7.488 21.376 21.376 0 0 1 21.44 0c3.2 1.792 5.632 4.48 7.04 7.488l21.376 44.48a44.672 44.672 0 0 0 21.376 20.672l37.632 17.92a18.368 18.368 0 0 1 7.36 6.208 15.168 15.168 0 0 1 0 17.152 18.368 18.368 0 0 1-7.36 6.144l-37.632 17.92a44.608 44.608 0 0 0-21.376 20.672z"
                      p-id="77087"></path>
                  </svg>
                </el-icon>
              </el-button>
            </el-tooltip>

            <!-- 4. MCP -->
            <el-tooltip :content="t('app.tabs.mcp')" placement="bottom">
              <el-button class="tab-button" text @click="changeTab(3)" :class="{ 'active-tab': tab === 3 }">
                <el-icon :size="19">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9"></path>
                    <path d="m18 15 4-4"></path>
                    <path
                      d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5">
                    </path>
                  </svg>
                </el-icon>
              </el-button>
            </el-tooltip>

            <!-- 5. Skills -->
            <el-tooltip :content="t('app.tabs.skills')" placement="bottom">
              <el-button class="tab-button" text @click="changeTab(4)" :class="{ 'active-tab': tab === 4 }">
                <el-icon :size="20">
                  <Collection />
                </el-icon>
              </el-button>
            </el-tooltip>

            <!-- 6. Providers (云服务商) -->
            <el-tooltip :content="t('app.tabs.providers')" placement="bottom">
              <el-button class="tab-button" text @click="changeTab(5)" :class="{ 'active-tab': tab === 5 }">
                <el-icon :size="20">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"></path>
                  </svg>
                </el-icon>
              </el-button>
            </el-tooltip>

            <!-- 7. Settings (设置) -->
            <el-tooltip :content="t('app.tabs.settings')" placement="bottom">
              <el-button class="tab-button" text @click="changeTab(6)" :class="{ 'active-tab': tab === 6 }">
                <el-icon :size="18">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path
                      d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z">
                    </path>
                    <circle cx="12" cy="12" r="3"></circle>
                  </svg>
                </el-icon>
              </el-button>
            </el-tooltip>
          </div>
        </el-col>
      </el-row>
    </el-header>

    <el-main v-if="config">
      <KeepAlive>
        <Chats v-if="tab === 0" key="chats" />
        <Tasks v-else-if="tab === 1" key="tasks" />
        <Prompts v-else-if="tab === 2" key="prompts" />
        <Mcp v-else-if="tab === 3" key="mcp" />
        <Skills v-else-if="tab === 4" key="skills" />
        <Providers v-else-if="tab === 5" key="providers" />
        <Setting v-else-if="tab === 6" key="settings" />
      </KeepAlive>
    </el-main>

    <!-- 帮助文档弹窗 -->
    <el-dialog v-model="showDocDialog" width="80%" :lock-scroll="false" class="doc-dialog">
      <template #header>
        <div class="doc-dialog__header">
          <span class="doc-dialog__title">{{ t('doc.title') }}</span>
          <el-tooltip v-if="docVersionText" :content="docVersionTooltip" placement="top">
            <button type="button" class="doc-dialog__version" :class="{ 'has-update': versionInfo.hasUpdate }" @click="openReleasePage">{{ docVersionText }}</button>
          </el-tooltip>
        </div>
      </template>
      <div class="doc-container">
        <div class="doc-sidebar">
          <el-menu :default-active="activeDocIndex" :default-openeds="[]" @select="(index) => activeDocIndex = index" class="doc-menu">
            <el-menu-item v-for="(doc, index) in docList" :key="index" :index="String(index)" :class="{ 'is-quick-start-item': doc.isBuiltin }">
              <el-icon>
                <Collection v-if="doc.isBuiltin" />
                <Document v-else />
              </el-icon>
              <span class="menu-item-text">
                {{ t(doc.i18nKey) }}
                <!-- 文档具体红点 -->
                <span v-if="checkDocHasUpdate(index)" class="doc-update-dot"></span>
              </span>
            </el-menu-item>
          </el-menu>
        </div>
        <div class="doc-content" v-loading="docLoading" :element-loading-text="t('doc.loading')">
          <el-scrollbar ref="docScrollbarRef" height="60vh">
            <div class="markdown-body" :class="{ 'is-quick-start': docList[Number(activeDocIndex)]?.isBuiltin }" v-html="currentDocContent" @click="handleDocLinks"></div>
          </el-scrollbar>
        </div>
      </div>
    </el-dialog>
  </el-container>
</template>

<style scoped>
.common-layout,
.el-container {
  position: relative;
  width: 100%;
  height: 100%;
  padding: 18px;
  margin: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background:
    radial-gradient(circle at 12% 14%, rgba(255, 255, 255, 0.98) 0, rgba(255, 255, 255, 0) 32%),
    radial-gradient(circle at 88% 84%, rgba(24, 24, 27, 0.08) 0, rgba(24, 24, 27, 0) 30%),
    linear-gradient(180deg, rgba(250, 250, 250, 0.92) 0%, rgba(244, 244, 245, 0.98) 100%);
}

.common-layout::before,
.common-layout::after {
  content: '';
  position: absolute;
  border-radius: 999px;
  pointer-events: none;
  filter: blur(12px);
  opacity: 0.7;
}

.common-layout::before {
  width: 220px;
  height: 220px;
  top: -90px;
  left: -70px;
  background: radial-gradient(circle, rgba(255, 255, 255, 0.85) 0%, rgba(228, 228, 231, 0.08) 68%, rgba(228, 228, 231, 0) 100%);
}

.common-layout::after {
  width: 280px;
  height: 280px;
  right: -110px;
  bottom: -130px;
  background: radial-gradient(circle, rgba(39, 39, 42, 0.08) 0%, rgba(39, 39, 42, 0.03) 42%, rgba(39, 39, 42, 0) 100%);
}

html.dark .common-layout,
html.dark .el-container {
  background:
    radial-gradient(circle at 12% 14%, rgba(255, 255, 255, 0.04) 0, rgba(255, 255, 255, 0) 30%),
    radial-gradient(circle at 88% 84%, rgba(255, 255, 255, 0.05) 0, rgba(255, 255, 255, 0) 24%),
    linear-gradient(180deg, rgba(9, 9, 11, 0.98) 0%, rgba(24, 24, 27, 0.98) 100%);
}

html.dark .common-layout::before {
  background: radial-gradient(circle, rgba(255, 255, 255, 0.08) 0%, rgba(255, 255, 255, 0) 72%);
}

html.dark .common-layout::after {
  background: radial-gradient(circle, rgba(255, 255, 255, 0.06) 0%, rgba(255, 255, 255, 0) 70%);
}

.el-header {
  position: relative;
  height: 68px;
  padding: 0 18px;
  margin-bottom: 14px;
  display: flex;
  align-items: center;
  border: 1px solid rgba(255, 255, 255, 0.78);
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.82);
  box-shadow: 0 10px 24px -20px rgba(24, 24, 27, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.82);
  backdrop-filter: blur(14px) saturate(135%);
  -webkit-backdrop-filter: blur(14px) saturate(135%);
  flex-shrink: 0;
  z-index: 10;
}

html.dark .el-header {
  border-color: rgba(82, 82, 91, 0.4);
  background: rgba(24, 24, 27, 0.84);
  box-shadow: 0 12px 26px -18px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.04);
}

.header-row {
  width: 100%;
}

.left-actions-col {
  display: flex;
  align-items: center;
  padding-left: 0;
}

.header-title-col {
  display: flex;
  justify-content: center;
  align-items: center;
}

.header-title-text {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.03em;
  line-height: 1;
  transition: color 0.3s ease;
}

.tabs-col {
  display: flex;
  justify-content: flex-end;
}

.tabs-container {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  border-radius: 999px;
  background: rgba(244, 244, 245, 0.78);
  border: 1px solid rgba(228, 228, 231, 0.8);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.65);
}

html.dark .tabs-container {
  background: rgba(39, 39, 42, 0.78);
  border-color: rgba(82, 82, 91, 0.5);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
}

.tab-button {
  padding: 0;
  border: none;
  background-color: transparent;
  color: var(--text-secondary);
  border-radius: 999px;
  transition: background-color 0.16s ease, color 0.16s ease, box-shadow 0.16s ease;
  height: 40px;
  width: 40px;
}

.tab-button:hover {
  background-color: rgba(244, 244, 245, 0.96);
  color: var(--text-primary);
  box-shadow: inset 0 0 0 1px rgba(228, 228, 231, 0.92);
}

html.dark .tab-button:hover {
  background-color: rgba(63, 63, 70, 0.88);
  box-shadow: inset 0 0 0 1px rgba(82, 82, 91, 0.65);
}

.active-tab {
  background: var(--bg-accent);
  color: var(--text-on-accent);
  box-shadow: 0 8px 18px -14px rgba(24, 24, 27, 0.45);
}

.active-tab:hover {
  color: var(--text-on-accent) !important;
  background: var(--bg-accent) !important;
  box-shadow: 0 8px 18px -14px rgba(24, 24, 27, 0.45) !important;
  border: none !important;
  outline: none !important;
}

.el-main {
  position: relative;
  padding: 16px;
  flex-grow: 1;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.82);
  border-radius: 30px;
  box-shadow: 0 8px 26px -22px rgba(24, 24, 27, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(10px) saturate(120%);
  -webkit-backdrop-filter: blur(10px) saturate(120%);
}

.el-main::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0));
  pointer-events: none;
}

html.dark .el-main {
  background: rgba(18, 18, 20, 0.9);
  border-color: rgba(63, 63, 70, 0.52);
  box-shadow: 0 10px 28px -20px rgba(0, 0, 0, 0.48), inset 0 1px 0 rgba(255, 255, 255, 0.03);
}

.blank-col {
  min-width: 32px;
}


.doc-dialog__header {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  max-width: calc(100% - 32px);
}

.doc-dialog__title {
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.2;
}

.doc-dialog__version {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  background: rgba(15, 23, 42, 0.06);
  border: 1px solid rgba(15, 23, 42, 0.08);
  white-space: nowrap;
}


.doc-dialog__version {
  appearance: none;
  cursor: pointer;
}

.doc-dialog__version:hover {
  color: var(--text-primary);
  border-color: rgba(15, 23, 42, 0.18);
}

.doc-dialog__version:focus-visible {
  outline: 2px solid rgba(59, 130, 246, 0.45);
  outline-offset: 2px;
}

.quick-start-feedback {
  margin: 18px 4px 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-secondary);
}

.doc-dialog__version.has-update {
  color: #16a34a;
  background: rgba(34, 197, 94, 0.12);
  border-color: rgba(34, 197, 94, 0.28);
}

html.dark .doc-dialog__version {
  color: rgba(228, 228, 231, 0.88);
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(255, 255, 255, 0.08);
}

html.dark .doc-dialog__version.has-update {
  color: #4ade80;
  background: rgba(34, 197, 94, 0.16);
  border-color: rgba(74, 222, 128, 0.28);
}

.doc-container {
  display: flex;
  height: 60vh;
  border: 1px solid var(--border-primary);
  border-radius: 20px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.84);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}

html.dark .doc-container {
  background: rgba(24, 24, 27, 0.86);
}

.bell-badge :deep(.el-badge__content.is-fixed.is-dot) {
  right: 1px;
  top: 1px;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.9);
}

html.dark .bell-badge :deep(.el-badge__content.is-fixed.is-dot) {
  box-shadow: 0 0 0 1px rgba(24, 24, 27, 0.92);
}

.doc-sidebar {
  width: 180px;
  border-right: 1px solid var(--border-primary);
  background: rgba(250, 250, 250, 0.88);
  flex-shrink: 0;
  padding: 10px;
}

html.dark .doc-sidebar {
  background: rgba(9, 9, 11, 0.5);
}

.doc-menu {
  border-right: none;
  background-color: transparent;
}

.doc-menu :deep(.el-menu-item) {
  height: 42px;
  line-height: 42px;
  color: var(--text-secondary);
  font-size: 14px;
  border-radius: 12px;
  margin-bottom: 4px;
}

.doc-menu :deep(.el-menu-item:hover) {
  background-color: rgba(244, 244, 245, 0.95);
}

html.dark .doc-menu :deep(.el-menu-item:hover) {
  background-color: rgba(39, 39, 42, 0.92);
}

.doc-menu :deep(.el-menu-item.is-active) {
  color: var(--text-on-accent);
  background-color: var(--bg-accent);
  font-weight: 600;
}

.menu-item-text {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.doc-update-dot {
  width: 6px;
  height: 6px;
  background-color: var(--el-color-danger);
  border-radius: 50%;
  margin-left: 8px;
  display: inline-block;
}

.doc-content {
  flex: 1;
  background-color: transparent;
  padding: 0;
  overflow: hidden;
}

.markdown-body {
  padding: 18px 34px 28px;
  color: var(--text-primary);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol';
  font-size: 15px;
  line-height: 1.8;
  -webkit-font-smoothing: antialiased;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2) {
  border-bottom: 1px solid var(--border-primary);
  padding-bottom: 0.42em;
  margin-top: 1.5em;
  margin-bottom: 1em;
  color: var(--text-primary);
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.3;
}

.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  margin-top: 1.4em;
  margin-bottom: 0.8em;
  color: var(--text-primary);
  font-weight: 600;
  line-height: 1.4;
}

.markdown-body :deep(p) {
  margin-bottom: 1.15em;
  text-align: justify;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  padding-left: 24px;
  margin-bottom: 1.2em;
}

.markdown-body :deep(li) {
  margin-bottom: 0.4em;
}

.markdown-body :deep(strong),
.markdown-body :deep(b) {
  font-weight: 700;
  color: var(--text-primary);
}

.markdown-body :deep(code) {
  background-color: var(--bg-tertiary);
  padding: 2px 6px;
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 0.85em;
  color: var(--el-color-primary);
  margin: 0 2px;
}

.markdown-body :deep(pre) {
  background-color: var(--bg-tertiary);
  padding: 16px;
  border-radius: 14px;
  overflow-x: auto;
  margin-bottom: 1.2em;
  line-height: 1.5;
  border: 1px solid var(--border-primary);
}

.markdown-body :deep(pre code) {
  background-color: transparent;
  padding: 0;
  color: var(--text-primary);
  margin: 0;
  font-size: 13px;
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
}

.markdown-body :deep(blockquote) {
  margin: 1.2em 0;
  padding: 10px 16px;
  color: var(--text-secondary);
  border-left: 4px solid var(--el-color-primary);
  background-color: var(--bg-tertiary);
  border-radius: 0 10px 10px 0;
}

.markdown-body :deep(blockquote p) {
  margin-bottom: 0;
}

.markdown-body :deep(img) {
  max-width: 100%;
  border-radius: 14px;
  margin: 12px 0;
  border: 1px solid var(--border-primary);
  box-shadow: 0 14px 24px -20px rgba(0, 0, 0, 0.25);
  display: block;
}

.markdown-body :deep(a) {
  color: var(--el-color-primary);
  text-decoration: none;
  font-weight: 500;
  border-bottom: 1px solid transparent;
  transition: border-color 0.2s;
  cursor: pointer;
}

.markdown-body :deep(a:hover) {
  border-bottom-color: var(--el-color-primary);
}

.markdown-body.is-quick-start {
  padding: 24px 26px 30px;
}

.markdown-body :deep(.quick-start-doc) {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.markdown-body :deep(.quick-start-hero),
.markdown-body :deep(.quick-start-panel),
.markdown-body :deep(.quick-start-tips) {
  position: relative;
  overflow: hidden;
  border: 1px solid var(--border-primary);
  border-radius: 22px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.92) 0%, rgba(250, 250, 250, 0.82) 100%);
  box-shadow: 0 14px 30px -26px rgba(15, 23, 42, 0.28);
}

html.dark .markdown-body :deep(.quick-start-hero),
html.dark .markdown-body :deep(.quick-start-panel),
html.dark .markdown-body :deep(.quick-start-tips) {
  background: linear-gradient(180deg, rgba(39, 39, 42, 0.9) 0%, rgba(24, 24, 27, 0.86) 100%);
  box-shadow: 0 18px 34px -28px rgba(0, 0, 0, 0.5);
}

.markdown-body :deep(.quick-start-hero) {
  padding: 24px 24px 22px;
}

.markdown-body :deep(.quick-start-hero__title-row) {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.markdown-body :deep(.quick-start-hero__badge) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 999px;
  background: rgba(24, 24, 27, 0.08);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  order: 2;
}

html.dark .markdown-body :deep(.quick-start-hero__badge) {
  background: rgba(255, 255, 255, 0.08);
}

.markdown-body :deep(.quick-start-hero h1) {
  margin: 0;
  font-size: 30px;
  line-height: 1.2;
}

.markdown-body :deep(.quick-start-hero p),
.markdown-body :deep(.quick-start-panel__header p) {
  margin: 0;
  color: var(--text-secondary);
  text-align: left;
}

.markdown-body :deep(.quick-start-panel) {
  padding: 22px;
}

.markdown-body :deep(.quick-start-panel__header) {
  margin-bottom: 18px;
}

.markdown-body :deep(.quick-start-panel__header h2),
.markdown-body :deep(.quick-start-tips h2) {
  margin: 0 0 8px;
  font-size: 20px;
  line-height: 1.3;
  color: var(--text-primary);
}

.markdown-body :deep(.quick-start-shortcuts) {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.markdown-body :deep(.quick-start-shortcut-card) {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  padding: 18px 18px 16px;
  border-radius: 20px;
  border: 1px solid rgba(24, 24, 27, 0.08);
  background: linear-gradient(180deg, rgba(250, 250, 250, 0.96) 0%, rgba(244, 244, 245, 0.9) 100%);
}

html.dark .markdown-body :deep(.quick-start-shortcut-card) {
  border-color: rgba(255, 255, 255, 0.08);
  background: linear-gradient(180deg, rgba(63, 63, 70, 0.58) 0%, rgba(39, 39, 42, 0.62) 100%);
}

.markdown-body :deep(.quick-start-shortcut-card__keys) {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.markdown-body :deep(.shortcut-key) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 46px;
  min-height: 36px;
  padding: 0 12px;
  border-radius: 12px;
  border: 1px solid rgba(24, 24, 27, 0.1);
  background: rgba(255, 255, 255, 0.82);
  box-shadow: inset 0 -2px 0 rgba(24, 24, 27, 0.06);
  font-size: 13px;
  font-weight: 700;
  color: var(--text-primary);
}

html.dark .markdown-body :deep(.shortcut-key) {
  border-color: rgba(255, 255, 255, 0.08);
  background: rgba(24, 24, 27, 0.9);
  box-shadow: inset 0 -2px 0 rgba(255, 255, 255, 0.04);
}

.markdown-body :deep(.shortcut-plus) {
  color: var(--text-secondary);
  font-weight: 700;
}

.markdown-body :deep(.quick-start-shortcut-card__body) {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.markdown-body :deep(.quick-start-shortcut-card__body h3) {
  margin: 0;
  font-size: 18px;
  line-height: 1.35;
}

.markdown-body :deep(.quick-start-shortcut-card__body p) {
  margin: 0;
  color: var(--text-secondary);
  text-align: left;
}

.markdown-body :deep(.quick-start-tips) {
  padding: 22px 22px 20px;
}

.markdown-body :deep(.quick-start-tip-lead) {
  margin: 0 0 16px;
  color: var(--text-secondary);
  text-align: left;
}

.markdown-body :deep(.quick-start-custom-card) {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
  border-radius: 18px;
  border: 1px solid rgba(24, 24, 27, 0.08);
  background: linear-gradient(180deg, rgba(250, 250, 250, 0.96) 0%, rgba(244, 244, 245, 0.9) 100%);
}

html.dark .markdown-body :deep(.quick-start-custom-card) {
  border-color: rgba(255, 255, 255, 0.08);
  background: linear-gradient(180deg, rgba(63, 63, 70, 0.58) 0%, rgba(39, 39, 42, 0.62) 100%);
}

.markdown-body :deep(.quick-start-custom-card__keys) {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.markdown-body :deep(.quick-start-custom-card__body) {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.markdown-body :deep(.quick-start-custom-card__body h3) {
  margin: 0;
  font-size: 17px;
  line-height: 1.35;
}

.markdown-body :deep(.quick-start-custom-card__body p) {
  margin: 0;
  color: var(--text-secondary);
  text-align: left;
}

.markdown-body :deep(.quick-start-tips ul) {
  margin: 0;
  padding-left: 20px;
}

.markdown-body :deep(.quick-start-tips li) {
  color: var(--text-secondary);
  margin-bottom: 10px;
}

:deep(.doc-dialog .el-dialog) {
  overflow: hidden;
}

:deep(.doc-dialog .el-dialog__body) {
  padding: 0 !important;
}

:deep(.doc-dialog .el-dialog__header) {
  padding: 10px 16px 14px !important;
  margin-right: 0;
  border-bottom: 1px solid var(--border-primary);
}
</style>