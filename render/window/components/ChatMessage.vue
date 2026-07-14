<script setup>
import { computed, ref, nextTick, watch, onMounted, onBeforeUnmount } from 'vue';
import { Bubble, Thinking, XMarkdown } from 'vue-element-plus-x';
import { ElTooltip, ElButton, ElInput, ElCollapse, ElCollapseItem, ElIcon, ElCheckbox, ElTag, ElMessage } from 'element-plus';
import { DocumentCopy, Refresh, Delete, Document, CaretTop, CaretBottom, Edit, Check, Close, CloseBold, Picture } from '@element-plus/icons-vue';
import 'katex/dist/katex.min.css';
import DOMPurify from 'dompurify';
import ChoiceCard from './ChoiceCard.vue';

import { formatTimestamp, formatMessageText, sanitizeToolArgs, formatToolResult } from '../utils/formatters.js';

let html2canvasPromise = null;
const loadHtml2Canvas = () => {
  if (!html2canvasPromise) {
    html2canvasPromise = import('html2canvas').then((mod) => mod.default || mod);
  }
  return html2canvasPromise;
};

const CODE_BLOCK_COPY_SVG = `<svg width="14" height="14" fill="currentColor" viewBox="0 0 16 16"><path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/><path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/></svg>`;

const props = defineProps({
  message: Object,
  index: Number,
  isLastMessage: Boolean,
  isLoading: Boolean,
  userAvatar: String,
  userNickname: String,
  aiAvatar: String,
  isCollapsed: Boolean,
  isDarkMode: Boolean,
  isAutoApprove: Boolean,
});

const emit = defineEmits(['copy-text', 're-ask', 'delete-message', 'toggle-collapse', 'avatar-click', 'edit-message', 'edit-message-requested', 'edit-finished', 'cancel-tool-call', 'confirm-tool', 'reject-tool', 'update-auto-approve', 'submit-choice']);
const editInputRef = ref(null);
const isEditing = ref(false);
const editedContent = ref('');
const messageWrapperRef = ref(null);
const markdownRootRef = ref(null);
let copyButtonRafId = 0;
let copyButtonTimerId = 0;

const isStreamingThisMessage = computed(() => Boolean(props.isLoading && props.isLastMessage));

// 计算耗时或显示开始时间
const formatTokenCount = (value) => {
  const count = Number(value);
  if (!Number.isFinite(count) || count < 0) return '0';
  if (count >= 1000000) return `${(count / 1000000).toFixed(count >= 10000000 ? 1 : 2)}M`;
  if (count >= 10000) return `${(count / 1000).toFixed(count >= 100000 ? 0 : 1)}K`;
  return String(Math.round(count));
};

const tokenUsageDisplay = computed(() => {
  if (props.message?.role !== 'assistant') return '';
  const usage = props.message?.tokenUsage;
  if (!usage || typeof usage !== 'object') return '';

  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens);
  const reasoningTokens = Number(usage.reasoning_tokens);
  if (!Number.isFinite(promptTokens) && !Number.isFinite(completionTokens)) return '';

  if (Number.isFinite(reasoningTokens) && reasoningTokens > 0) {
    return `总输入 ${formatTokenCount(promptTokens)} · 思考 ${formatTokenCount(reasoningTokens)} · 输出 ${formatTokenCount(completionTokens)}`;
  }

  return `总输入 ${formatTokenCount(promptTokens)} · 输出 ${formatTokenCount(completionTokens)}`;
});


const timeDisplay = computed(() => {
  const msg = props.message;
  // 获取开始时间：优先取 startTime (AI)，其次取 timestamp (User/AI旧数据)
  const startTime = msg.startTime || msg.timestamp;
  if (!startTime) return '';

  const formattedStart = formatTimestamp(startTime);

  // 如果是 AI 消息且有结束时间，追加耗时
  if (msg.role === 'assistant' && msg.endTime && msg.startTime) {
    const duration = (msg.endTime - msg.startTime) / 1000;
    let durationStr = '';
    if (duration < 60) {
        durationStr = `${duration.toFixed(1)} s`;
    } else {
        durationStr = `${(duration / 60).toFixed(1)} min`;
    }
    // 格式：2023-01-01 12:00 (3.5 s)
    return `${formattedStart} (${durationStr})`;
  }

  return formattedStart;
});


const SCREENSHOT_THEME = {
  light: {
    background: '#FFFDF7',
    bubble: '#FFFFFF',
    bubbleBorder: 'rgba(220, 210, 194, 0.92)',
    text: '#2B2620',
    subText: '#7A6B5B',
    codeBg: '#F6F1E8',
    codeBorder: 'rgba(214, 203, 186, 0.92)',
    thinkingBg: '#F4EEE4'
  },
  dark: {
    background: '#17181C',
    bubble: '#23262D',
    bubbleBorder: 'rgba(255, 255, 255, 0.10)',
    text: '#F5F7FA',
    subText: '#AAB2BF',
    codeBg: '#1B1D23',
    codeBorder: 'rgba(255, 255, 255, 0.08)',
    thinkingBg: '#1F232B'
  }
};

const waitForScreenshotImages = async (container) => {
  if (!container) return;
  const images = Array.from(container.querySelectorAll('img'));
  if (images.length === 0) return;

  await Promise.all(images.map((img) => {
    try {
      img.removeAttribute('loading');
      img.setAttribute('loading', 'eager');
      img.decoding = 'sync';
    } catch {
      // ignore image eager-load fallback failure
    }

    if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const done = () => {
        img.onload = null;
        img.onerror = null;
        resolve();
      };
      img.onload = done;
      img.onerror = done;
    });
  }));
};

const applyMessageScreenshotStyles = (clone, theme, role = 'assistant') => {
  if (!clone) return;

  clone.style.position = 'relative';
  clone.style.zIndex = '1';
  clone.style.margin = '0';
  clone.style.maxWidth = '100%';
  clone.style.width = '100%';
  clone.style.alignSelf = role === 'user' ? 'flex-end' : 'flex-start';

  clone.querySelectorAll('*').forEach((element) => {
    element.style.animation = 'none';
    element.style.transition = 'none';
    element.style.backdropFilter = 'none';
    element.style.webkitBackdropFilter = 'none';
    if (element.tagName !== 'IMG') {
      element.style.filter = 'none';
    }
  });

  clone.querySelectorAll('.message-footer').forEach((footer) => footer.remove());
  clone.querySelectorAll('.markdown-wrapper').forEach((markdownWrapper) => {
    markdownWrapper.style.height = 'auto';
    markdownWrapper.style.maxHeight = 'none';
    markdownWrapper.style.overflow = 'visible';
    markdownWrapper.classList.remove('collapsed');
  });

  clone.querySelectorAll('.elx-xmarkdown-container').forEach((container) => {
    container.style.background = 'transparent';
    container.style.backgroundImage = 'none';
    container.style.color = theme.text;
  });

  clone.querySelectorAll('.chat-avatar-top').forEach((avatar) => {
    avatar.style.boxShadow = 'none';
  });

  clone.querySelectorAll('.timestamp-row, .voice-name').forEach((metaText) => {
    metaText.style.color = theme.subText;
  });

  clone.querySelectorAll('.user-name, .ai-name').forEach((nameText) => {
    nameText.style.color = theme.text;
  });

  clone.querySelectorAll('.el-bubble-content').forEach((bubble) => {
    bubble.style.background = theme.bubble;
    bubble.style.backgroundImage = 'none';
    bubble.style.color = theme.text;
    bubble.style.border = `1px solid ${theme.bubbleBorder}`;
    bubble.style.borderRadius = '22px';
    bubble.style.boxShadow = 'none';
    bubble.style.overflow = 'hidden';
  });

  clone.querySelectorAll('.el-thinking .trigger').forEach((trigger) => {
    trigger.style.background = theme.thinkingBg;
    trigger.style.backgroundImage = 'none';
    trigger.style.border = `1px solid ${theme.codeBorder}`;
    trigger.style.borderRadius = '16px';
    trigger.style.boxShadow = 'none';
    trigger.style.color = theme.text;
  });

  clone.querySelectorAll('.el-thinking .content pre, pre').forEach((preElement) => {
    preElement.style.background = theme.codeBg;
    preElement.style.backgroundImage = 'none';
    preElement.style.border = `1px solid ${theme.codeBorder}`;
    preElement.style.borderRadius = '16px';
    preElement.style.boxShadow = 'none';
    preElement.style.color = theme.text;
    preElement.style.whiteSpace = 'pre-wrap';
    preElement.style.overflow = 'visible';
    preElement.style.height = 'auto';
    preElement.style.maxHeight = 'none';
  });

  clone.querySelectorAll('code').forEach((codeElement) => {
    codeElement.style.color = theme.text;
    codeElement.style.textShadow = 'none';
  });
};


const forceScreenshotExportStyles = (clone, theme) => {
  if (!clone) return;

  const selectors = [
    '.el-bubble-content-wrapper',
    '.el-bubble-content-wrapper .el-bubble-content',
    '.el-bubble-content-wrapper .el-bubble-footer',
    '.el-thinking .trigger',
    '.el-thinking-popper',
    '.el-thinking-popper .el-popper__arrow::before',
    '.markdown-wrapper',
    '.elx-xmarkdown-container',
    'pre',
    '.table-scroll-wrapper',
    'blockquote',
    '.markdown-mermaid .mermaid-content',
    '.markdown-mermaid .mermaid-source-code'
  ];

  clone.querySelectorAll('*').forEach((element) => {
    element.style.backgroundImage = 'none';
    element.style.boxShadow = 'none';
    element.style.filter = 'none';
    element.style.backdropFilter = 'none';
    element.style.webkitBackdropFilter = 'none';
    element.style.mixBlendMode = 'normal';
    element.style.maskImage = 'none';
    element.style.webkitMaskImage = 'none';
  });

  clone.querySelectorAll('.message-wrapper').forEach((wrapper) => {
    wrapper.style.background = 'transparent';
    wrapper.style.border = 'none';
    wrapper.style.boxShadow = 'none';
  });

  clone.querySelectorAll('.el-bubble-content-wrapper').forEach((wrapper) => {
    wrapper.style.background = 'transparent';
    wrapper.style.backgroundImage = 'none';
    wrapper.style.border = 'none';
    wrapper.style.boxShadow = 'none';
    wrapper.style.padding = '0';
  });

  clone.querySelectorAll('.el-bubble-content-wrapper .el-bubble-content').forEach((bubble) => {
    bubble.style.background = theme.bubble;
    bubble.style.backgroundImage = 'none';
    bubble.style.border = `1px solid ${theme.bubbleBorder}`;
    bubble.style.boxShadow = 'none';
    bubble.style.outline = 'none';
    bubble.style.color = theme.text;
  });

  clone.querySelectorAll('.el-bubble-content-wrapper .el-bubble-footer').forEach((footer) => {
    footer.style.background = 'transparent';
    footer.style.backgroundImage = 'none';
    footer.style.border = 'none';
    footer.style.boxShadow = 'none';
  });

  clone.querySelectorAll('.el-thinking .trigger, .el-thinking-popper').forEach((node) => {
    node.style.background = theme.thinkingBg;
    node.style.backgroundImage = 'none';
    node.style.border = `1px solid ${theme.codeBorder}`;
    node.style.boxShadow = 'none';
    node.style.color = theme.text;
  });

  clone.querySelectorAll('pre, .table-scroll-wrapper, blockquote, .markdown-mermaid .mermaid-content, .markdown-mermaid .mermaid-source-code').forEach((node) => {
    node.style.background = theme.codeBg;
    node.style.backgroundImage = 'none';
    node.style.border = `1px solid ${theme.codeBorder}`;
    node.style.boxShadow = 'none';
    node.style.color = theme.text;
  });

  clone.querySelectorAll('.markdown-wrapper, .elx-xmarkdown-container, code, .inline-code-tag').forEach((node) => {
    node.style.color = theme.text;
    node.style.textShadow = 'none';
  });
};

const cleanupMessageScreenshot = (wrapper, canvas) => {
  try {
    wrapper?.querySelectorAll?.('img').forEach((img) => {
      img.onload = null;
      img.onerror = null;
      img.removeAttribute('src');
      img.src = '';
    });
  } catch {
    // ignore screenshot image cleanup failure
  }

  try {
    wrapper?.querySelectorAll?.('*').forEach((node) => {
      node.ontransitionend = null;
      node.onanimationend = null;
    });
  } catch {
    // ignore temporary node cleanup failure
  }

  try {
    if (wrapper) {
      wrapper.innerHTML = '';
    }
  } catch {
    // ignore wrapper html cleanup failure
  }

  try {
    if (wrapper?.parentNode) {
      wrapper.parentNode.removeChild(wrapper);
    }
  } catch {
    wrapper?.remove?.();
  }

  try {
    if (canvas) {
      const context = canvas.getContext?.('2d');
      context?.clearRect?.(0, 0, canvas.width, canvas.height);
      canvas.width = 0;
      canvas.height = 0;
    }
  } catch {
    // ignore canvas cleanup failure
  }
};

const canvasToPngBytes = async (canvas) => {
  if (!canvas) {
    throw new Error('canvas_required');
  }

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) {
        resolve(result);
      } else {
        reject(new Error('canvas_to_blob_failed'));
      }
    }, 'image/png');
  });

  const arrayBuffer = await blob.arrayBuffer();
  return new Uint8Array(arrayBuffer);
};

const onCopyImage = async () => {
  if (!messageWrapperRef.value) return;

  const loadingMsg = ElMessage.info({ message: '正在生成图片...', duration: 0 });

  setTimeout(async () => {
    let wrapper = null;
    let canvas = null;
    let imageBytes = null;

    try {
      const isDark = document.documentElement.classList.contains('dark');
      const theme = isDark ? SCREENSHOT_THEME.dark : SCREENSHOT_THEME.light;
      const role = props.message.role === 'user' ? 'user' : 'assistant';
      const sourceWidth = Math.ceil(messageWrapperRef.value.clientWidth || 0);
      const targetWidth = Math.min(Math.max(sourceWidth + 24, 560), 960);

      wrapper = document.createElement('div');
      wrapper.style.cssText = `
        position: fixed;
        left: -20000px;
        top: 0;
        z-index: -9999;
        width: ${targetWidth}px;
        padding: 20px;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border-radius: 24px;
        background: ${theme.background};
      `;

      const clone = messageWrapperRef.value.cloneNode(true);
      applyMessageScreenshotStyles(clone, theme, role);
      forceScreenshotExportStyles(clone, theme);
      wrapper.appendChild(clone);
      document.body.appendChild(wrapper);

      await waitForScreenshotImages(wrapper);
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 80)));

      const html2canvas = await loadHtml2Canvas();

      canvas = await html2canvas(wrapper, {
        useCORS: true,
        allowTaint: true,
        backgroundColor: theme.background,
        scale: 2,
        logging: false,
        ignoreElements: () => false
      });

      imageBytes = await canvasToPngBytes(canvas);
      await window.api.copyImage({ buffer: imageBytes });
      loadingMsg.close();
      ElMessage.success('消息图片已复制');
    } catch (error) {
      console.error('截图失败:', error);
      loadingMsg.close();
      ElMessage.error('生成图片失败');
    } finally {
      cleanupMessageScreenshot(wrapper, canvas);
      wrapper = null;
      canvas = null;
      imageBytes = null;
    }
  }, 50);
};


// 如果是最后一条消息 && 正在加载 && 没有正在进行的思考内容
const showBubbleLoading = computed(() => {
  if (!props.isLastMessage || !props.isLoading) return false;
  
  // 如果有 reasoning_content 且状态是 thinking，说明正在思考，不显示正文 loading
  if (props.message.reasoning_content && props.message.status === 'thinking') {
    return false;
  }
  
  // 正文为空时才显示 loading
  const contentEmpty = !props.message.content || (Array.isArray(props.message.content) && props.message.content.length === 0);
  return contentEmpty && (!props.message.tool_calls || props.message.tool_calls.length === 0);
});

// 格式化工具参数为易读的 JSON 字符串
const formatToolArgs = (argsString) => {
  try {
    const sanitized = sanitizeToolArgs(argsString);
    const obj = JSON.parse(sanitized);
    // 2 表示缩进空格数
    return JSON.stringify(obj, null, 2);
  } catch (e) {
    return argsString;
  }
};

const preprocessKatexPlainText = (text) => {
  let processedText = text;

  // 1. 替换非标准连字符
  processedText = processedText.replace(/\u2013/g, '-').replace(/\u2014/g, '-');

  // 2. 将 \[ ... \] 转换为 $$ ... $$ (块级公式)
  processedText = processedText.replace(/\\\[([\s\S]*?)\\\]/g, '$$$$$1$$$$');

  // 3. 将 \( ... \) 转换为 $ ... $ (行内公式)
  processedText = processedText.replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, '$$$1$');

  // 4. 将 {align} 和 {equation} 替换为 {aligned}
  // KaTeX 在 $$...$$ 内部通常不支持 align 环境（它是顶级环境）。
  // 使用 aligned 环境可以完美解决渲染问题，同时配合下方的 \tag 模拟显示。
  processedText = processedText.replace(/\\begin\{align\*?\}/g, '\\begin{aligned}');
  processedText = processedText.replace(/\\end\{align\*?\}/g, '\\end{aligned}');
  processedText = processedText.replace(/\\begin\{equation\*?\}/g, '\\begin{aligned}');
  processedText = processedText.replace(/\\end\{equation\*?\}/g, '\\end{aligned}');

  // 5. 模拟 LaTeX \tag{} 显示
  // 由于 aligned 环境不支持原生 \tag，或者 Markdown 渲染器会吞掉反斜杠，
  // 将其替换为右侧间距 + 文本的形式： \qquad \text{(...)}
  processedText = processedText.replace(/(?<!\\)\\tag\s*\{([^{}]+)\}/g, '\\qquad \\text{($1)}');

  processedText = processedText.replace(/(?<!\\)(\$)([^$]+?)(?<!\\)(\$)/g, (match, p1, p2, p3) => {
    if (/[，。、！？：“”【】（）\u4e00-\u9fa5]/.test(p2) || p2.includes('\n\n') || p2.length > 200) {
      return `$${p2}$`;
    }
    return match;
  });

  return processedText;
};

const preprocessKatex = (text) => {
  if (!text) return '';

  const protectedMap = new Map();
  let placeholderIndex = 0;
  const addPlaceholder = (segment) => {
    const placeholder = `\uE000KATEX_PROTECTED_${placeholderIndex++}\uE001`;
    protectedMap.set(placeholder, segment);
    return placeholder;
  };

  // KaTeX 兼容预处理只能作用于普通 Markdown 文本。
  // 代码围栏与行内代码中的反斜杠/方括号是代码语义，例如 Bash 正则 ^\[bot\]，不能被转换成 $$bot$$。
  let protectedText = text.replace(/(^|\n)([ \t]*)(`{3,}|~{3,})([^\n]*)\n[\s\S]*?(?:\n[ \t]*\3[ \t]*(?=\n|$)|$)/g, (match) => {
    return addPlaceholder(match);
  });

  protectedText = protectedText.replace(/(`+)([^`\n]*?)\1/g, (match) => {
    return addPlaceholder(match);
  });

  let processedText = preprocessKatexPlainText(protectedText);
  protectedMap.forEach((segment, placeholder) => {
    processedText = processedText.replaceAll(placeholder, segment);
  });

  return processedText;
};

const mermaidConfig = computed(() => ({
  theme: props.isDarkMode ? 'dark' : 'neutral',
}));

const formatMessageContent = (content, role) => {
  if (!content) return "";
  if (!Array.isArray(content)) {
    if (String(content).toLowerCase().startsWith('file name:') && String(content).toLowerCase().endsWith('file end')) {
      return "";
    } else {
      return String(content);
    }
  }

  let markdownString = "";
  let i = 0;
  while (i < content.length) {
    const part = content[i];

    if (part.type === 'text' && part.text && part.text.toLowerCase().startsWith('file name:') && part.text.toLowerCase().endsWith('file end')) {
      i++;
      continue;
    } else if (part.type === 'image_url' && part.image_url?.url) {
      let imageGroupMarkdown = "";
      while (i < content.length && content[i].type === 'image_url' && content[i].image_url?.url) {
        imageGroupMarkdown += `![Image](${content[i].image_url.url}) `;
        i++;
      }
      markdownString += `\n\n${imageGroupMarkdown.trim()}\n\n`;
    } else if (part.type === 'input_audio' && part.input_audio?.data) {
      if (role === 'user') {
        markdownString += `\n\n<audio class="chat-audio-player" controls preload="none">\n<source id="${part.input_audio.format}" src="data:audio/${part.input_audio.format};base64,${part.input_audio.data}">\n</audio>\n`;
      } else {
        markdownString += `\n\n<audio class="chat-audio-player" controls autoplay preload="none">\n<source id="${part.input_audio.format}" src="data:audio/${part.input_audio.format};base64,${part.input_audio.data}">\n</audio>\n`;
      }
      i++;
    } else if (part.type === 'text' && part.text) {
      markdownString += part.text;
      i++;
    } else {
      i++;
    }
  }

  return markdownString;
};

const formatMessageFile = (content) => {
  let files = [];
  if (!Array.isArray(content)) {
    if (String(content).toLowerCase().startsWith('file name:') && String(content).toLowerCase().endsWith('file end')) files.push(String(content).split('\n')[0].replace('file name:', '').trim());
    else return [];
  } else {
    content.forEach(part => {
      if (part.type === 'text' && part.text && part.text.toLowerCase().startsWith('file name:') && part.text.toLowerCase().endsWith('file end')) files.push(part.text.split('\n')[0].replace('file name:', '').trim());
      else if (part.type === "input_file" && part.filename) files.push(part.filename);
      else if (part.type === "file" && part.file.filename) files.push(part.file.filename);
    });
  }
  return files;
};

const isEditable = computed(() => {
  if (props.message.role === 'user') return true;
  const content = props.message.content;
  if (typeof content === 'string') return true;
  if (Array.isArray(content)) {
    return content.some(part => part.type === 'text' && part.text && !(part.text.toLowerCase().startsWith('file name:')));
  }
  return false;
});

const switchToEditMode = () => {
  editedContent.value = formatMessageText(props.message.content);
  isEditing.value = true;
  nextTick(() => {
    editInputRef.value?.focus();
  });
};

const switchToShowMode = () => {
  isEditing.value = false;
};

defineExpose({ switchToEditMode, switchToShowMode });

const finishEdit = (action) => {
  isEditing.value = false;
  emit('edit-finished', {
    id: props.message.id,
    action: action,
    content: editedContent.value
  });
};

const handleEditKeyDown = (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    finishEdit('cancel');
  } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    finishEdit('save');
  }
};

const renderedMarkdownContent = computed(() => {
  const content = props.message.role ? props.message.content : props.message;
  const role = props.message.role ? props.message.role : 'user';
  let formattedContent = formatMessageContent(content, role);
  formattedContent = preprocessKatex(formattedContent);

  const protectedMap = new Map();
  let placeholderIndex = 0;
  const protectedContentPattern = /__PROTECTED_CONTENT_\d+__/g;
  const addPlaceholder = (text) => {
    const placeholder = `__PROTECTED_CONTENT_${placeholderIndex++}__`;
    protectedMap.set(placeholder, text);
    return placeholder;
  };
  const restoreProtectedContent = (text) => {
    let restoredText = text;
    // 内联代码可能先被 `...` 保护，再被 $...$ 误判包裹成更大的数学公式保护块。
    // 因此必须递归恢复，避免内层 __PROTECTED_CONTENT_X__ 泄漏并被 Markdown 渲染为 PROTECTED_CONTENT_X。
    for (let i = 0; i < placeholderIndex; i++) {
      const nextText = restoredText.replace(protectedContentPattern, (placeholder) => {
        return protectedMap.get(placeholder) || placeholder;
      });
      if (nextText === restoredText) break;
      restoredText = nextText;
    }
    return restoredText;
  };

  // 1. 保护代码块和数学公式不被 DOMPurify 处理
  let processedContent = formattedContent.replace(/(^|[^\\])(`+)([\s\S]*?)\2/g, (match, prefix, delimiter, inner) => {
    return prefix + addPlaceholder(delimiter + inner + delimiter);
  });
  processedContent = processedContent.replace(/(\$\$)([\s\S]*?)(\$\$)/g, (match) => addPlaceholder(match));
  processedContent = processedContent.replace(/(\$)(?!\s)([^$\n]+?)(?<!\s)(\$)/g, (match) => addPlaceholder(match));
  processedContent = processedContent.replace(/(^|[^\\])\*\*([^\n]+?)\*\*/g, '$1<strong>$2</strong>');

  // 2. 进行 HTML 清洗
  let sanitizedPart = DOMPurify.sanitize(processedContent, {
    ADD_TAGS: ['video', 'audio', 'source'],
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    ADD_ATTR: ['style']
  });

  // 全局将 &gt; 恢复为 >
  sanitizedPart = sanitizedPart.replace(/&gt;/g, '>');

  // 3. 恢复受保护的内容（代码块等）
  let finalContent = restoreProtectedContent(sanitizedPart);

  // 匹配 <table...> 标签并包裹 div，利用正则确保只匹配实际的标签
  finalContent = finalContent.replace(/<table/g, '<div class="table-scroll-wrapper"><table').replace(/<\/table>/g, '</table></div>');

  return finalContent || '';
});

const injectCopyButtonsForRoot = (root) => {
  if (!root) return;
  const codeBlocks = root.querySelectorAll('pre.hljs, pre.shiki');
  codeBlocks.forEach((pre) => {
    if (pre.closest('.code-block-wrapper')) return;
    if (pre.querySelector('.code-block-copy-button')) return;
    const codeElement = pre.querySelector('code');
    if (!codeElement) return;

    const parent = pre.parentNode;
    if (!parent) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper';
    parent.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    const codeText = codeElement.textContent || '';
    const lineCount = codeText.trimEnd().split('\n').length;
    const createButton = (positionClass) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `code-block-copy-button ${positionClass}`;
      button.innerHTML = CODE_BLOCK_COPY_SVG;
      button.title = 'Copy code';
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        try {
          await navigator.clipboard.writeText(codeText.trimEnd());
          ElMessage.success('Code copied to clipboard!');
        } catch (err) {
          console.error('Failed to copy code:', err);
          ElMessage.error('Failed to copy code.');
        }
      });
      wrapper.appendChild(button);
    };
    createButton('code-block-copy-button-bottom');
    if (lineCount > 3) createButton('code-block-copy-button-top');
  });
};

const scheduleInjectCopyButtons = (immediate = false) => {
  // 流式过程中不注入复制按钮，避免频繁 DOM wrap 造成 reflow
  if (isStreamingThisMessage.value && !immediate) return;

  if (copyButtonTimerId) {
    clearTimeout(copyButtonTimerId);
    copyButtonTimerId = 0;
  }
  if (copyButtonRafId) {
    cancelAnimationFrame(copyButtonRafId);
    copyButtonRafId = 0;
  }

  const run = async () => {
    await nextTick();
    copyButtonRafId = requestAnimationFrame(() => {
      copyButtonRafId = 0;
      injectCopyButtonsForRoot(markdownRootRef.value);
    });
  };

  if (immediate) {
    run();
    return;
  }

  copyButtonTimerId = setTimeout(() => {
    copyButtonTimerId = 0;
    run();
  }, 120);
};

watch(
  () => [renderedMarkdownContent.value, props.isLoading, props.isLastMessage, props.isCollapsed, isEditing.value],
  ([, loading, isLast]) => {
    // 流式结束（loading 从 true 变 false）时立即补一次完整高亮后的复制按钮
    const finishedStreaming = isLast && !loading;
    scheduleInjectCopyButtons(finishedStreaming);
  },
  { flush: 'post' }
);

onMounted(() => {
  scheduleInjectCopyButtons(true);
});

onBeforeUnmount(() => {
  if (copyButtonTimerId) clearTimeout(copyButtonTimerId);
  if (copyButtonRafId) cancelAnimationFrame(copyButtonRafId);
});

const reasoningContent = computed(() => {
  if (typeof props.message.reasoning_content !== 'string') return '';
  return props.message.reasoning_content.trim();
});

const hasReasoningContent = computed(() => reasoningContent.value.length > 0);
const isThinkingExpanded = ref(false);

watch(() => props.message?.id, () => {
  isThinkingExpanded.value = false;
});

const collapseThinking = () => {
  isThinkingExpanded.value = false;
};

const hasContentToShow = computed(() => {
  const hasText = renderedMarkdownContent.value && renderedMarkdownContent.value.trim().length > 0;
  const hasTools = props.message.tool_calls && props.message.tool_calls.length > 0;
  return hasText || hasTools || isEditing.value || showBubbleLoading.value;
});

const shouldShowCollapseButton = computed(() => {
  if (!props.isLastMessage) return true;
  if (props.isLastMessage) return !props.isLoading;
  return false;
});

const onCopy = () => {
  if (props.isLoading && props.isLastMessage) return;
  emit('copy-text', formatMessageText(props.message.content), props.index);
};
const onReAsk = () => emit('re-ask');
const onDelete = () => emit('delete-message', props.index);
const onToggleCollapse = (event) => emit('toggle-collapse', props.index, event);
const onAvatarClick = (role, event) => emit('avatar-click', role, event);

const BLOCKED_MARKDOWN_LINK_PROTOCOLS = new Set(['javascript:', 'data:', 'blob:', 'about:']);

const isBlockedMarkdownLinkProtocol = (url) => {
  try {
    return BLOCKED_MARKDOWN_LINK_PROTOCOLS.has(new URL(url).protocol.toLowerCase());
  } catch {
    return false;
  }
};

const handleMarkdownLinkClick = async (event) => {
  const link = event.target?.closest?.('a[href]');
  if (!link || !link.closest?.('.markdown-wrapper')) return;

  const href = (link.getAttribute('href') || '').trim();
  if (!href || href.startsWith('#')) return;

  const resolvedHref = link.href || href;
  if (isBlockedMarkdownLinkProtocol(resolvedHref)) {
    event.preventDefault();
    event.stopPropagation();
    ElMessage.warning('已阻止不安全的链接协议');
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  try {
    const result = await window.api?.shellOpenExternal?.(resolvedHref);
    if (result && result.ok === false) {
      ElMessage.error(result.message || result.reason || '链接打开失败');
    }
  } catch (error) {
    console.error('[ChatMessage] Failed to open markdown link:', error);
    ElMessage.error('链接打开失败');
  }
};

const truncateFilename = (filename, maxLength = 30) => {
  if (typeof filename !== 'string' || filename.length <= maxLength) return filename;
  const ellipsis = '...';
  const lastDotIndex = filename.lastIndexOf('.');
  if (lastDotIndex === -1 || lastDotIndex < 10) return filename.substring(0, maxLength - ellipsis.length) + ellipsis;
  const nameWithoutExt = filename.substring(0, lastDotIndex);
  const extension = filename.substring(lastDotIndex);
  const charsToKeep = maxLength - extension.length - ellipsis.length;
  if (charsToKeep < 1) return ellipsis + extension;
  return nameWithoutExt.substring(0, charsToKeep) + ellipsis + extension;
};
</script>

<template>
  <div class="chat-message" v-if="message.role !== 'system'">

    <!-- 用户消息 -->
    <div v-if="message.role === 'user'" class="message-wrapper user-wrapper" ref="messageWrapperRef">
      <div class="message-meta-header user-meta-header">
        <div class="meta-info-column user-meta-info-column">
          <div class="meta-name-row user-meta-name-row">
            <span class="user-name">{{ userNickname || 'User' }}</span>
          </div>
          <span class="timestamp-row" v-if="message.timestamp">{{ formatTimestamp(message.timestamp) }}</span>
        </div>
        <img :src="userAvatar" alt="User Avatar" @click="onAvatarClick('user', $event)"
          class="chat-avatar-top user-avatar">
      </div>

      <Bubble class="user-bubble" placement="end" shape="corner" maxWidth="100%">
        <template #content>
          <div v-if="!isEditing" ref="markdownRootRef" class="markdown-wrapper" :class="{ 'collapsed': isCollapsed }" @click.capture="handleMarkdownLinkClick">
            <XMarkdown :markdown="renderedMarkdownContent" :is-dark="isDarkMode" :enable-latex="true"
              :mermaid-config="mermaidConfig" :default-theme-mode="isDarkMode ? 'dark' : 'light'"
              :themes="{ light: 'github-light', dark: 'github-dark-default' }" :allow-html="true" />
          </div>
          <div v-else class="editing-wrapper">
            <el-input ref="editInputRef" v-model="editedContent" type="textarea" :autosize="{ minRows: 1, maxRows: 15 }"
              resize="none" @keydown="handleEditKeyDown" />
            <div class="editing-actions">
              <span class="edit-shortcut-hint">Ctrl+Enter 确认 / Esc 取消</span>
              <el-button :icon="Check" @click="finishEdit('save')" size="small" circle type="primary" />
              <el-button :icon="Close" @click="finishEdit('cancel')" size="small" circle />
            </div>
          </div>
        </template>
        <template #footer>
          <div class="message-footer">
            <div class="footer-wrapper">
              <div class="footer-actions">
                <el-button :icon="DocumentCopy" @click="onCopy" size="small" circle />
                <el-tooltip content="复制为图片" placement="top" :show-after="500">
                  <el-button :icon="Picture" @click="onCopyImage" size="small" circle />
                </el-tooltip>
                <el-button v-if="isEditable" :icon="Edit" @click="emit('edit-message-requested', index)" size="small"
                  circle />
                <el-button v-if="shouldShowCollapseButton" :icon="isCollapsed ? CaretBottom : CaretTop"
                  @click="onToggleCollapse($event)" size="small" circle />
                <el-button v-if="isLastMessage" :icon="Refresh" @click="onReAsk" size="small" circle />
                <el-button :icon="Delete" size="small" @click="onDelete" circle />
              </div>
              <div class="message-files-vertical-list" v-if="formatMessageFile(message.content).length > 0">
                <el-tooltip v-for="(file_name, idx) in formatMessageFile(message.content)" :key="idx"
                  :content="file_name" placement="top" :disabled="file_name.length < 30"
                  :popper-style="{ maxWidth: '30vw', wordBreak: 'break-all' }">
                  <el-button class="file-button" type="info" plain size="small" :icon="Document">{{
                    truncateFilename(file_name, 20) }}</el-button>
                </el-tooltip>
              </div>
            </div>
          </div>
        </template>
      </Bubble>
    </div>

    <!-- AI 消息 -->
    <div v-if="message.role === 'assistant'" class="message-wrapper ai-wrapper" ref="messageWrapperRef">
      <div class="message-meta-header ai-meta-header">
        <img :src="aiAvatar" alt="AI Avatar" @click="onAvatarClick('assistant', $event)"
          class="chat-avatar-top ai-avatar">
        <div class="meta-info-column">
          <div class="meta-name-row">
            <span class="ai-name">{{ message.aiName }}</span>
            <span v-if="message.voiceName" class="voice-name">({{ message.voiceName }})</span>
          </div>
          <span class="timestamp-row">{{ timeDisplay }}</span>
        </div>
      </div>

      <Bubble class="ai-bubble" placement="start" shape="corner" maxWidth="100%"
        :class="{ 'no-content': !hasContentToShow }"
        :loading="showBubbleLoading">
        <template #header>
          <Thinking v-if="hasReasoningContent" v-model="isThinkingExpanded" maxWidth="90%"
            :content="reasoningContent" :status="message.status" class="message-thinking">
            <template #content="{ content }">
              <div class="thinking-panel">
                <div class="thinking-panel-content">{{ content }}</div>
                <div class="thinking-panel-actions">
                  <el-button class="thinking-collapse-btn" size="small" @click.stop="collapseThinking">
                    <el-icon><CaretTop /></el-icon>
                    <span>收起思考内容</span>
                  </el-button>
                </div>
              </div>
            </template>
          </Thinking>
        </template>
        <template #content v-if="hasContentToShow">
          <div v-if="!isEditing" ref="markdownRootRef" class="markdown-wrapper" :class="{ 'collapsed': isCollapsed }" @click.capture="handleMarkdownLinkClick">
            <XMarkdown :markdown="renderedMarkdownContent" :is-dark="isDarkMode" :enable-latex="true"
              :mermaid-config="mermaidConfig" :default-theme-mode="isDarkMode ? 'dark' : 'light'"
              :themes="{ light: 'one-light', dark: 'vesper' }" :allow-html="true" />
          </div>
          <div v-else class="editing-wrapper">
            <el-input ref="editInputRef" v-model="editedContent" type="textarea" :autosize="{ minRows: 1, maxRows: 15 }"
              resize="none" @keydown="handleEditKeyDown" />
            <div class="editing-actions">
              <span class="edit-shortcut-hint">Ctrl+Enter 确认 / Esc 取消</span>
              <el-button :icon="Check" @click="finishEdit('save')" size="small" circle type="primary" />
              <el-button :icon="Close" @click="finishEdit('cancel')" size="small" circle />
            </div>
          </div>
          <div v-if="message.tool_calls && message.tool_calls.length > 0" class="tool-calls-container">
            <div v-for="toolCall in message.tool_calls" :key="toolCall.id" class="single-tool-wrapper">
              <el-collapse class="tool-collapse"
                :model-value="(!isAutoApprove && (toolCall.approvalStatus === 'waiting' || toolCall.approvalStatus === 'executing')) ? [toolCall.id] : []">
                <el-collapse-item :name="toolCall.id">
                  <template #title>
                    <div class="tool-call-title">
                      <el-icon class="tool-icon">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                          stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="m15 12-8.373 8.373a1 1 0 0 1-3-3L12 9"></path>
                          <path d="m18 15 4-4"></path>
                          <path
                            d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5">
                          </path>
                        </svg>
                      </el-icon>
                      <div class="tool-name-wrapper">
                        <el-tooltip :content="toolCall.name" placement="top" :show-after="500">
                          <span class="tool-name">{{ toolCall.name }}</span>
                        </el-tooltip>
                      </div>
                      <div class="tool-header-right">
                        <el-tag v-if="toolCall.approvalStatus === 'waiting'" type="warning" size="small" effect="light"
                          round>等待批准</el-tag>
                        <el-tag v-else-if="toolCall.approvalStatus === 'choosing'" type="warning" size="small"
                          effect="light" round>待选择</el-tag>
                        <el-tag v-else-if="toolCall.approvalStatus === 'executing'" type="primary" size="small"
                          effect="light" round>执行中</el-tag>
                        <el-tag v-else-if="toolCall.approvalStatus === 'rejected'" type="danger" size="small"
                          effect="plain" round>已拒绝</el-tag>
                        <el-tag v-else-if="toolCall.approvalStatus === 'finished'" type="success" size="small"
                          effect="plain" round>完成</el-tag>
                        <el-tooltip content="停止执行" placement="top" v-if="toolCall.approvalStatus === 'executing'">
                          <div class="stop-btn-wrapper" @click.stop="$emit('cancel-tool-call', toolCall.id)">
                            <el-icon>
                              <CloseBold />
                            </el-icon>
                          </div>
                        </el-tooltip>
                      </div>
                    </div>
                  </template>
                  <div class="tool-call-details">
                    <div class="tool-detail-section">
                      <strong>参数:</strong>
                      <pre><code>{{ formatToolArgs(toolCall.args) }}</code></pre>
                    </div>
                    <div class="tool-detail-section"
                      v-if="toolCall.result && toolCall.result !== '等待批准...' && toolCall.result !== '执行中...'">
                      <strong>结果:</strong>
                      <div class="tool-result-wrapper">
                        <pre><code>{{ formatToolResult(toolCall.result) }}</code></pre>
                      </div>
                    </div>
                  </div>
                </el-collapse-item>
              </el-collapse>
              <div v-if="toolCall.approvalStatus === 'choosing' && toolCall.choiceData" class="tool-choice-wrapper">
                <ChoiceCard :questions="toolCall.choiceData.questions || []"
                  @submit="(payload) => $emit('submit-choice', toolCall.id, payload)" />
              </div>
              <div v-if="toolCall.approvalStatus === 'waiting'" class="tool-approval-actions">
                <div class="actions-left">
                  <el-button type="primary" size="small" :icon="Check"
                    @click="$emit('confirm-tool', toolCall.id, true)">确认</el-button>
                  <el-button size="small" :icon="Close" @click="$emit('reject-tool', toolCall.id, false)">取消</el-button>
                </div>
                <div class="actions-right">
                  <el-checkbox :model-value="isAutoApprove" @change="(val) => $emit('update-auto-approve', val)"
                    label="自动批准后续调用" size="small" />
                </div>
              </div>
            </div>
          </div>
        </template>
        <template #footer>
          <div class="message-footer">
            <div class="footer-actions">
              <el-button :icon="DocumentCopy" @click="onCopy" size="small" circle />
              <el-tooltip content="复制为图片" placement="top" :show-after="500">
                  <el-button :icon="Picture" @click="onCopyImage" size="small" circle />
                </el-tooltip>
              <el-button v-if="isEditable" :icon="Edit" @click="emit('edit-message-requested', index)" size="small"
                circle />
              <el-button v-if="shouldShowCollapseButton" :icon="isCollapsed ? CaretBottom : CaretTop"
                @click="onToggleCollapse($event)" size="small" circle />
              <el-button v-if="isLastMessage" :icon="Refresh" @click="onReAsk" size="small" circle />
              <el-button :icon="Delete" size="small" @click="onDelete" circle />
            </div>
            <span v-if="tokenUsageDisplay" class="token-usage-row">{{ tokenUsageDisplay }}</span>
          </div>
        </template>
      </Bubble>
    </div>
  </div>
</template>

<style scoped lang="less">
/* 使用与原文件相同的样式 */
.chat-message {
  margin: 18px 0 0 0;
  display: flex;
  flex-direction: column;
  overflow-x: hidden;
  padding: 0;
  --bubble-radius: 22px;
}

.message-wrapper {
  display: flex;
  flex-direction: column;
}

.user-wrapper {
  align-self: flex-end;
  align-items: flex-end;
  max-width: 90%;
  margin-right: 4%;
  margin-left: 5%;
}

.ai-wrapper {
  align-self: flex-start;
  align-items: flex-start;
  margin-left: 5%;
  margin-right: 5%;
  max-width: 100%;
}

.message-meta-header {
  display: flex;
  align-items: center;
  gap: 0;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.user-meta-header {
  flex-direction: row;
  margin-bottom: 9px;
}

.user-meta-header {
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
}

.user-meta-info-column {
  align-items: flex-end;
  text-align: right;
}

.user-meta-name-row {
  justify-content: flex-end;
}

.user-name {
  font-weight: 700;
  font-size: 13px;
  color: var(--el-text-color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}


.ai-meta-header {
  flex-direction: row;
  align-items: center;
  margin-bottom: 8px;
}

.meta-info-column {
  display: flex;
  flex-direction: column;
  justify-content: center;
  line-height: 1.2;
  gap: 0;
}

.meta-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.timestamp-row {
  font-size: 11px;
  color: color-mix(in srgb, var(--el-text-color-primary) 72%, transparent);
  margin-top: 2px;
}

.chat-avatar-top {
  width: 34px;
  height: 34px;
  cursor: pointer;
  object-fit: cover;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
  box-shadow: 0 8px 20px rgba(89, 69, 38, 0.12);

  &:hover {
    transform: scale(1.06);
  }
}

.user-avatar {
  border-radius: 50%;
}

.ai-avatar {
  border-radius: 10px;
  margin-right: 10px;
}

.ai-name {
  font-weight: 700;
  font-size: 13px;
  color: var(--el-text-color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chat-message .user-bubble {
  :deep(.el-bubble-content-wrapper .el-bubble-content) {
    border-radius: var(--bubble-radius);
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.58) 0%, rgba(248, 246, 241, 0.42) 100%);
    border: 1px solid rgba(255, 255, 255, 0.4);
    box-shadow: 0 8px 20px rgba(104, 81, 45, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.26);
    backdrop-filter: blur(8px) saturate(118%);
    -webkit-backdrop-filter: blur(8px) saturate(118%);
    padding: 12px 16px 11px 16px;
    margin-bottom: 0;
  }

  :deep(.el-bubble-content-wrapper .el-bubble-footer) {
    margin-top: 4px;
  }
}

.chat-message .ai-bubble {
  :deep(.el-bubble-content-wrapper .el-bubble-content) {
    border-radius: calc(var(--bubble-radius) + 2px);
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.34) 0%, rgba(255, 255, 255, 0.18) 100%);
    border: 1px solid rgba(255, 255, 255, 0.3);
    box-shadow: 0 8px 20px rgba(104, 81, 45, 0.05), inset 0 1px 0 rgba(255, 255, 255, 0.22);
    backdrop-filter: blur(8px) saturate(118%);
    -webkit-backdrop-filter: blur(8px) saturate(118%);
    padding: 14px 16px 12px 16px;
  }

  :deep(.el-bubble-content-wrapper .el-bubble-footer) {
    margin-top: 4px;
  }
}


.chat-message.screenshot-export,
.chat-message.screenshot-export * {
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  filter: none !important;
  text-shadow: none !important;
}

.chat-message.screenshot-export {
  .timestamp-row,
  .voice-name {
    color: var(--screenshot-export-sub-text, #7A6B5B) !important;
  }

  .user-name,
  .ai-name,
  .markdown-wrapper :deep(.elx-xmarkdown-container) {
    color: var(--screenshot-export-text, #2B2620) !important;
  }

  .chat-avatar-top {
    box-shadow: none !important;
  }

  .user-bubble,
  .ai-bubble {
    :deep(.el-bubble-content-wrapper .el-bubble-content) {
      background: var(--screenshot-export-bubble-bg, #FFFFFF) !important;
      background-image: none !important;
      border: 1px solid var(--screenshot-export-bubble-border, rgba(220, 210, 194, 0.92)) !important;
      box-shadow: none !important;
      color: var(--screenshot-export-text, #2B2620) !important;
    }

    :deep(.el-bubble-content-wrapper .el-bubble-footer) {
      background: transparent !important;
      box-shadow: none !important;
    }
  }

  .ai-bubble :deep(.el-thinking .trigger),
  .ai-bubble :deep(.el-thinking-popper),
  .ai-bubble :deep(.el-thinking-popper .el-popper__arrow::before) {
    background: var(--screenshot-export-thinking-bg, #F4EEE4) !important;
    background-image: none !important;
    border-color: var(--screenshot-export-code-border, rgba(214, 203, 186, 0.92)) !important;
    box-shadow: none !important;
    color: var(--screenshot-export-text, #2B2620) !important;
  }

  .markdown-wrapper {
    :deep(pre),
    :deep(.table-scroll-wrapper),
    :deep(blockquote),
    :deep(.markdown-mermaid .mermaid-content),
    :deep(.markdown-mermaid .mermaid-source-code) {
      background: var(--screenshot-export-code-bg, #F6F1E8) !important;
      background-image: none !important;
      border-color: var(--screenshot-export-code-border, rgba(214, 203, 186, 0.92)) !important;
      box-shadow: none !important;
      color: var(--screenshot-export-text, #2B2620) !important;
    }

    :deep(code),
    :deep(.inline-code-tag) {
      color: var(--screenshot-export-text, #2B2620) !important;
      text-shadow: none !important;
    }
  }
}

.chat-message .ai-bubble.no-content {
  :deep(.el-bubble-content) {
    display: none !important;
  }
}

html.dark .chat-message {
  .timestamp-row {
    color: rgba(221, 225, 235, 0.68);
  }

  .chat-avatar-top {
    box-shadow: 0 12px 24px rgba(0, 0, 0, 0.28);
  }
}

html.dark .chat-message .user-bubble {
  :deep(.el-bubble-content-wrapper .el-bubble-content) {
    background: linear-gradient(180deg, rgba(52, 56, 64, 0.6) 0%, rgba(31, 34, 40, 0.48) 100%);
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: 0 22px 44px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  }
}

html.dark .chat-message .ai-bubble {
  :deep(.el-bubble-content-wrapper .el-bubble-content) {
    background: linear-gradient(180deg, rgba(29, 31, 36, 0.5) 0%, rgba(17, 18, 22, 0.36) 100%);
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: 0 24px 50px rgba(0, 0, 0, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  }
}

.markdown-wrapper {
  width: 100%;
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);

  :deep(.elx-xmarkdown-container) {
    background: transparent !important;
    padding: 0;
    color: var(--text-primary);
    font-size: 14px;
    line-height: 1.5;
    tab-size: 4;
    font-family: ui-sans-serif, -apple-system, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
    word-break: break-word;
  }

  :deep(pre) {
    max-width: 100%;
    overflow-x: auto;
    white-space: pre;
    border-radius: var(--bubble-radius) !important;
  }

  :deep(.katex) {
    font-size: 1.2em !important;
  }

  :deep(.katex-display > .katex > .katex-html) {
    padding-bottom: 8px !important;
    scrollbar-width: thin;
    scrollbar-color: var(--el-text-color-disabled) transparent;

    &::-webkit-scrollbar {
      height: 6px;
    }

    &::-webkit-scrollbar-track {
      background: transparent;
    }

    &::-webkit-scrollbar-thumb {
      background-color: var(--el-text-color-disabled);
      border-radius: 3px;
    }

    &::-webkit-scrollbar-thumb:hover {
      background-color: var(--el-text-color-secondary);
    }
  }

  :deep(img) {
    max-width: min(50vw, 400px);
    max-height: min(50vh, 300px);
    width: auto;
    height: auto;
    display: inline-block;
    vertical-align: middle;
    margin: 4px;
    border-radius: 8px;
    object-fit: cover;
  }

  :deep(.chat-audio-player) {
    width: 100%;
    min-width: 60vw;
    height: 48px;
    accent-color: var(--text-primary);

    &::-webkit-media-controls-enclosure {
      background: none;
      border-radius: 24px;
    }

    &::-webkit-media-controls-panel {
      background-color: var(--bg-tertiary, #F0F0F0);
      border-radius: 24px;
      padding: 0 10px 0 10px;
      justify-content: center;
    }

    &::-webkit-media-controls-play-button {
      color: var(--text-primary);
      border-radius: 50%;

      &:hover {
        background-color: rgba(0, 0, 0, 0.05);
      }
    }

    &::-webkit-media-controls-current-time-display,
    &::-webkit-media-controls-time-remaining-display {
      color: var(--text-secondary);
      font-size: 13px;
      text-shadow: none;
    }

    &::-webkit-media-controls-timeline {
      border-radius: 3px;
      height: 6px;
      margin: 0 10px;
    }

    &::-webkit-media-controls-mute-button,
    &::-webkit-media-controls-overflow-button {
      color: var(--text-secondary);
      border-radius: 50%;

      &:hover {
        background-color: rgba(0, 0, 0, 0.05);
      }
    }
  }

  :deep(.table-scroll-wrapper) {
    width: 100%;
    overflow-x: auto;
    margin-bottom: 1em;
    border-radius: 6px;

    /* 移动滚动条样式到容器上 */
    &::-webkit-scrollbar {
      height: 6px;
    }

    &::-webkit-scrollbar-track {
      background: transparent;
    }

    &::-webkit-scrollbar-thumb {
      background-color: var(--el-text-color-disabled);
      border-radius: 3px;
    }

    &::-webkit-scrollbar-thumb:hover {
      background-color: var(--el-text-color-secondary);
    }
  }

  html.dark & :deep(.chat-audio-player) {
    accent-color: var(--text-primary);

    &::-webkit-media-controls-panel {
      background-color: var(--bg-tertiary, #2c2e33);
    }

    &::-webkit-media-controls-play-button,
    &::-webkit-media-controls-mute-button,
    &::-webkit-media-controls-overflow-button,
    &::-webkit-media-controls-current-time-display,
    &::-webkit-media-controls-time-remaining-display {
      filter: invert(1);
    }

    &::-webkit-media-controls-play-button:hover,
    &::-webkit-media-controls-mute-button:hover,
    &::-webkit-media-controls-overflow-button:hover {
      background-color: rgba(255, 255, 255, 0.1);
    }

    &::-webkit-media-controls-timeline {
      background-color: transparent;
    }
  }

  :deep(p:last-of-type) {
    margin-bottom: 0;
  }

  :deep(p) {
    margin-bottom: 1em;
  }

  :deep(ul),
  :deep(ol) {
    margin-bottom: 1em;
  }

  :deep(strong),
  :deep(b) {
    font-weight: 600 !important;
  }

  :deep(h1),
  :deep(h2),
  :deep(h3),
  :deep(h4),
  :deep(h5),
  :deep(h6) {
    font-weight: 600;
    line-height: 1.25;
    margin-top: 0.5em;
    margin-bottom: 0.8em;
    padding-bottom: 0.3em;
    border-bottom: 1px solid #d0d7de;
  }

  :deep(h1) {
    font-size: 1.8em;
  }

  :deep(h2) {
    font-size: 1.5em;
  }

  :deep(h3) {
    font-size: 1.3em;
  }

  :deep(h4) {
    font-size: 1.15em;
  }

  :deep(h5) {
    font-size: 1em;
  }

  :deep(h6) {
    font-size: 0.9em;
    color: #656d76;
  }

  :deep(blockquote) {
    margin: 1em 0;
    padding: 0.5em 1em;
    border-left: 4px solid #b3b3b3;
    background-color: rgba(0, 0, 0, 0.035) !important;
    color: var(--el-text-color-secondary);
    border-radius: 0 8px 8px 0;

    html.dark & {
      border-left-color: #656565;
      background-color: rgba(255, 255, 255, 0.05) !important;
    }
  }

  :deep(blockquote p) {
    margin-bottom: 0.5em;
  }

  :deep(blockquote p:last-child) {
    margin-bottom: 0;
  }

  :deep(pre code),
  :deep(.inline-code-tag) {
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace;
    font-size: 1em;
  }

  :deep(.inline-code-tag) {
    padding: 0.2em 0.4em;
    margin: 0;
    border-radius: 4px;
    background-color: rgba(175, 184, 193, 0.2);
  }

  html:not(.dark) & :deep(pre.shiki) {
    background-color: #f6f8fa !important;
  }

  :deep(.code-block-wrapper) {
    position: relative;
    margin: 0.75em 0;
  }

  :deep(.code-block-wrapper > pre) {
    margin: 0;
  }

  :deep(.code-block-copy-button) {
    position: absolute;
    z-index: 2;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.88);
    color: var(--el-text-color-secondary);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s ease, background-color 0.15s ease, color 0.15s ease;
  }

  :deep(.code-block-wrapper:hover .code-block-copy-button),
  :deep(.code-block-copy-button:focus-visible) {
    opacity: 1;
  }

  :deep(.code-block-copy-button-top) {
    top: 8px;
    right: 8px;
  }

  :deep(.code-block-copy-button-bottom) {
    right: 8px;
    bottom: 8px;
  }

  :deep(.code-block-copy-button:hover) {
    color: var(--el-color-primary);
    background: rgba(255, 255, 255, 0.98);
  }

  html.dark & :deep(.code-block-copy-button) {
    border-color: rgba(255, 255, 255, 0.12);
    background: rgba(30, 32, 36, 0.9);
    color: var(--el-text-color-secondary);
  }

  html.dark & :deep(.code-block-copy-button:hover) {
    background: rgba(40, 44, 52, 0.98);
    color: var(--el-color-primary);
  }

  html.dark & {

    :deep(h1),
    :deep(h2),
    :deep(h3),
    :deep(h4),
    :deep(h5) {
      border-bottom-color: #373A40;
    }

    :deep(h6) {
      color: #8b949e;
    }

    :deep(hr) {
      background-color: #373A40 !important;
      margin-top: 8px;
      margin-bottom: 8px;
    }

    :deep(table) {
      display: table;
      width: 100%;
      max-width: 100%;
      border-spacing: 0;
      border-collapse: collapse;
      margin-bottom: 0;

      /* 优化表格滚动条样式 */
      &::-webkit-scrollbar {
        height: 6px;
      }

      &::-webkit-scrollbar-track {
        background: transparent;
      }

      &::-webkit-scrollbar-thumb {
        background-color: var(--el-text-color-disabled);
        border-radius: 3px;
      }

      &::-webkit-scrollbar-thumb:hover {
        background-color: var(--el-text-color-secondary);
      }
    }

    :deep(th) {
      background-color: #2c2e33;
      min-width: 60px;
    }

    :deep(tr) {
      background-color: #212327;
      border-top: 1px solid #373A40;
    }

    :deep(tr:nth-child(2n)) {
      background-color: #25272b;
    }

    :deep(td) {
      border-color: #373A40;
      min-width: 60px;
    }

    :deep(.pre-md) {
      border: 0px solid #373A40;
    }

    :deep(.inline-code-tag) {
      background-color: rgba(110, 118, 129, 0.4);
      color: #c9d1d9;
    }
  }

  :deep(.markdown-mermaid) {
    background-color: transparent;
    max-width: 100%;
    overflow-x: auto;
    padding: 5px;
    border-radius: 8px;
    box-sizing: border-box;

    .mermaid-content {
      background-color: rgba(245, 245, 245, 0.5);
      border-bottom-left-radius: 8px;
      border-bottom-right-radius: 8px;
    }

    html.dark & {
      color: var(--el-text-color-primary) !important;
    }

    .toolbar-container {
      border-radius: 18px;
    }

    .mermaid-toolbar {
      border-top-left-radius: 8px;
      border-top-right-radius: 8px;

      html.dark & {
        background-color: rgba(39, 39, 39, 1);

        .el-tabs__nav {
          background-color: #2c2e33;
        }

        .el-tabs__item.is-active {
          color: #202123 !important;
        }

        .el-tabs__item:hover {
          color: #202123 !important;
        }
      }
    }

    .mermaid-source-code {
      border: hidden;
      border-top-left-radius: 0px;
      border-top-right-radius: 0px;
      background-color: rgba(248, 249, 250, 0.5);
      padding-bottom: 0px;

      &::-webkit-scrollbar {
        width: 6px;
        height: 6px;
      }

      &::-webkit-scrollbar-track {
        background: transparent;
      }

      &::-webkit-scrollbar-thumb {
        background-color: var(--el-border-color-darker, #4C4D4F);
        border-radius: 4px;
      }

      &::-webkit-scrollbar-thumb:hover {
        background-color: var(--el-text-color-secondary);
      }

      &::-webkit-scrollbar-corner {
        background: transparent;
      }

      html.dark & {
        background-color: rgba(23, 23, 23, 0.5);
        color: var(--el-text-color-primary);
      }
    }
  }

  &.collapsed :deep(.elx-xmarkdown-container) {
    max-height: 3.4em;
    position: relative;
    overflow: hidden;
    -webkit-mask-image: linear-gradient(to bottom, black 60%, transparent 100%);
    mask-image: linear-gradient(to bottom, black 60%, transparent 100%);
  }
}

.editing-wrapper {
  width: 100%;
  min-width: 70vw;

  .el-textarea {
    margin-bottom: 8px;

    :deep(.el-textarea__inner) {
      background-color: #ECECEC;
      box-shadow: none !important;
      border: 1px solid var(--el-border-color-light);
      color: var(--el-text-color-primary);
    }

    :deep(.el-textarea__inner::-webkit-scrollbar) {
      width: 8px;
      height: 8px;
    }

    :deep(.el-textarea__inner::-webkit-scrollbar-track) {
      background: transparent;
      border-radius: 4px;
    }

    :deep(.el-textarea__inner::-webkit-scrollbar-thumb) {
      background: var(--el-text-color-disabled, #c0c4cc);
      border-radius: 4px;
      border: 2px solid transparent;
      background-clip: content-box;
    }

    :deep(.el-textarea__inner::-webkit-scrollbar-thumb:hover) {
      background: var(--el-text-color-secondary, #909399);
      background-clip: content-box;
    }

    html.dark & :deep(.el-textarea__inner::-webkit-scrollbar-thumb) {
      background: #6b6b6b;
    }

    html.dark & :deep(.el-textarea__inner::-webkit-scrollbar-thumb:hover) {
      background: #999;
    }
  }

  .editing-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;

    .el-button--primary {
      --el-button-bg-color: var(--bg-accent);
      --el-button-border-color: var(--bg-accent);
      --el-button-text-color: var(--text-on-accent);
    }

    .el-button--primary:hover {
      --el-button-hover-bg-color: var(--bg-accent-light);
      --el-button-hover-border-color: var(--bg-accent-light);
    }
  }

  .edit-shortcut-hint {
    font-size: 12px;
    color: var(--el-text-color-placeholder);
    margin-right: auto;
    align-self: center;
  }
}

html.dark .editing-wrapper {
  .el-textarea :deep(.el-textarea__inner) {
    background-color: #424242;
    border-color: var(--border-primary);
    color: var(--text-primary);
  }

  .editing-actions .el-button--primary {
    --el-button-hover-bg-color: #e0e0e0;
    --el-button-hover-border-color: #e0e0e0;
  }
}

.message-files-vertical-list {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  padding-right: 5px;
  max-height: 150px;
  overflow-y: auto;

  &::-webkit-scrollbar {
    width: 8px !important;
    height: 8px !important;
  }

  &::-webkit-scrollbar-track {
    background: transparent;
    border-radius: 4px;
  }

  &::-webkit-scrollbar-thumb {
    background: var(--el-text-color-disabled, #c0c4cc);
    border-radius: 4px;
    border: 2px solid transparent;
    background-clip: content-box;
  }

  &::-webkit-scrollbar-thumb:hover {
    background: var(--el-text-color-secondary, #909399);
    background-clip: content-box;
  }

  .file-button {
    width: auto;
    justify-content: flex-start;
    border: none;
    background-color: var(--el-fill-color-light);
    color: var(--el-color-info);
  }

  .file-button:hover {
    border: none;
    background-color: var(--el-fill-color-lighter);
    color: var(--el-color-info);
  }
}

html.dark .message-files-vertical-list {
  &::-webkit-scrollbar {
    width: 8px !important;
    height: 8px !important;
  }

  &::-webkit-scrollbar-thumb {
    background: #6b6b6b;
    border-radius: 4px;
    border: 2px solid transparent;
    background-clip: content-box;
  }

  &::-webkit-scrollbar-thumb:hover {
    background: #999;
  }

  .file-button {
    background-color: var(--el-fill-color-dark);
    color: var(--el-text-color-regular);
  }

  .file-button:hover {
    background-color: var(--el-fill-color-darker);
    color: var(--el-text-color-regular);
  }
}

.ai-name {
  font-weight: 600;
  color: var(--el-text-color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

html.dark .ai-name {
  color: var(--el-text-color-regular);
}


html.dark .user-name {
  color: var(--el-text-color-regular);
}


.voice-name {
  opacity: 0.8;
  white-space: nowrap;
  flex-shrink: 0;
  margin-right: 8px;
}

.message-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  width: 100%;
  margin-top: 8px;
}

.ai-bubble .message-footer {
  justify-content: flex-start;
  gap: 10px;
  flex-wrap: wrap;
}

.token-usage-row {
  font-size: 11px;
  line-height: 1;
  color: color-mix(in srgb, var(--el-text-color-primary) 72%, transparent);
  white-space: nowrap;
  user-select: none;
  padding-top: 1px;
}

html.dark .token-usage-row {
  color: rgba(221, 225, 235, 0.68);
}


.footer-actions {
  display: flex;
  align-items: center;
  gap: 0px;
}

.footer-wrapper {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}

.user-bubble .footer-actions {
  margin-left: auto;
}

.ai-bubble .footer-actions {
  margin-right: auto;
}

.timestamp {
  margin-top: 12px;
  font-size: 0.75rem;
  opacity: 0.8;
  white-space: nowrap;
  flex-shrink: 0;
}

.message-thinking {
  display: block;
}

.ai-bubble :deep(.el-thinking .trigger) {
  border-radius: 18px !important;
  padding: 11px 14px !important;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.64), rgba(255, 255, 255, 0.38)) !important;
  border: 1px solid rgba(255, 255, 255, 0.28) !important;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.10) !important;
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  color: var(--el-text-color-primary, #1F2937) !important;
  transition: background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
}

.ai-bubble :deep(.el-thinking .trigger:hover) {
  transform: translateY(-1px);
  box-shadow: 0 14px 34px rgba(15, 23, 42, 0.14) !important;
  border-color: rgba(255, 255, 255, 0.38) !important;
}

.ai-bubble :deep(.el-thinking .trigger .label),
.ai-bubble :deep(.el-thinking .trigger .text) {
  font-weight: 600;
  letter-spacing: 0.01em;
}

.ai-bubble :deep(.el-thinking .el-icon) {
  color: var(--el-text-color-secondary, #667085);
}

:deep(.el-thinking-popper) {
  max-width: min(85vw, 880px) !important;
  border-radius: 20px !important;
  padding: 0 !important;
  overflow: hidden !important;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.76), rgba(250, 250, 252, 0.70)) !important;
  border: 1px solid rgba(255, 255, 255, 0.34) !important;
  box-shadow: 0 18px 48px rgba(15, 23, 42, 0.18) !important;
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
}

:deep(.el-thinking-popper .el-popper__arrow::before) {
  background: rgba(255, 255, 255, 0.74) !important;
  border-color: rgba(255, 255, 255, 0.34) !important;
}

.thinking-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 16px 12px;
}

.thinking-panel-content {
  margin: 0;
  color: var(--el-text-color-regular, #344054);
  font-size: 13px;
  line-height: 1.72;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: min(52vh, 460px);
  overflow: auto;
  padding-right: 4px;
}

.thinking-panel-content::-webkit-scrollbar {
  width: 8px;
}

.thinking-panel-content::-webkit-scrollbar-track {
  background: transparent;
}

.thinking-panel-content::-webkit-scrollbar-thumb {
  background: rgba(148, 163, 184, 0.46);
  border-radius: 999px;
}

.thinking-panel-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 10px;
  border-top: 1px solid rgba(148, 163, 184, 0.16);
}

.thinking-collapse-btn {
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(255, 255, 255, 0.52);
  color: var(--el-text-color-secondary, #475467);
  box-shadow: 0 4px 12px rgba(15, 23, 42, 0.08);
}

.thinking-collapse-btn:hover {
  color: var(--el-text-color-primary, #1F2937);
  border-color: rgba(99, 102, 241, 0.20);
  background: rgba(255, 255, 255, 0.72);
}

.thinking-collapse-btn :deep(.el-icon) {
  margin-right: 4px;
}

.ai-bubble :deep(.el-thinking .content pre) {
  border-radius: 14px !important;
  max-width: 100%;
  margin-bottom: 10px;
  white-space: pre-wrap;
  word-break: break-word;
  box-sizing: border-box;
  background: rgba(255, 255, 255, 0.36);
  border: 1px solid rgba(148, 163, 184, 0.18);
}

html.dark .ai-bubble :deep(.el-thinking .trigger) {
  background: linear-gradient(135deg, rgba(37, 43, 56, 0.82), rgba(24, 29, 39, 0.72)) !important;
  color: var(--el-text-color-primary, #F5F7FA) !important;
  border-color: rgba(148, 163, 184, 0.18) !important;
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.28) !important;
}

html.dark .ai-bubble :deep(.el-thinking .trigger:hover) {
  border-color: rgba(96, 165, 250, 0.24) !important;
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.32) !important;
}

html.dark .ai-bubble :deep(.el-thinking .el-icon) {
  color: var(--el-text-color-secondary, #A0A5B1);
}

html.dark :deep(.el-thinking-popper) {
  background: linear-gradient(180deg, rgba(24, 29, 39, 0.92), rgba(17, 24, 39, 0.86)) !important;
  border-color: rgba(71, 85, 105, 0.34) !important;
  box-shadow: 0 22px 56px rgba(0, 0, 0, 0.34) !important;
}

html.dark :deep(.el-thinking-popper .el-popper__arrow::before) {
  background: rgba(24, 29, 39, 0.92) !important;
  border-color: rgba(71, 85, 105, 0.34) !important;
}

html.dark .thinking-panel-content {
  color: var(--el-text-color-regular, #D0D5DD);
}

html.dark .thinking-panel-content::-webkit-scrollbar-thumb {
  background: rgba(100, 116, 139, 0.6);
}

html.dark .thinking-panel-actions {
  border-top-color: rgba(71, 85, 105, 0.32);
}

html.dark .thinking-collapse-btn {
  background: rgba(51, 65, 85, 0.52);
  border-color: rgba(100, 116, 139, 0.28);
  color: var(--el-text-color-secondary, #CBD5E1);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.18);
}

html.dark .thinking-collapse-btn:hover {
  background: rgba(71, 85, 105, 0.64);
  color: var(--el-text-color-primary, #F8FAFC);
  border-color: rgba(96, 165, 250, 0.28);
}

html.dark .ai-bubble :deep(.el-thinking .content pre) {
  background: rgba(30, 41, 59, 0.62);
  color: var(--el-text-color-regular, #E5E7EB);
  border: 1px solid rgba(71, 85, 105, 0.36);
}

.tool-calls-container {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.single-tool-wrapper {
  width: 100%;
  max-width: 85vw;
  min-width: 250px;
  display: flex;
  flex-direction: column;
}

.tool-collapse {
  width: 100%;
  border: none;
  background: transparent;
  --el-collapse-header-height: 38px;

  :deep(.el-collapse-item) {
    border: none;
  }

  :deep(.el-collapse-item__header) {
    background-color: var(--el-fill-color-light);
    border: 1px solid var(--el-border-color-lighter);
    border-radius: var(--bubble-radius);
    padding: 0 12px;
    font-size: 13px;
    line-height: 1;
    box-shadow: none;
    background-clip: padding-box;
    transition: border-color 0.2s ease, background-color 0.2s ease;
  }

  :deep(.el-collapse-item__arrow) {
    margin-left: 10px;
  }

  :deep(.el-collapse-item__wrap) {
    display: none;
    background-color: transparent;
    border: none;
    border-radius: 0;
    box-shadow: none;
    overflow: hidden;
  }

  :deep(.el-collapse-item__content) {
    padding: 12px;
  }

  :deep(.el-collapse-item:not(.is-active) > .el-collapse-item__header),
  :deep(.el-collapse-item__header:not(.is-active)) {
    background-color: transparent !important;
    border-bottom-left-radius: var(--bubble-radius) !important;
    border-bottom-right-radius: var(--bubble-radius) !important;
    border-bottom-color: var(--el-border-color-lighter) !important;
  }

  :deep(.el-collapse-item.is-active > .el-collapse-item__header),
  :deep(.el-collapse-item__header.is-active) {
    background-color: transparent !important;
    border-bottom-left-radius: 0 !important;
    border-bottom-right-radius: 0 !important;
    border-bottom-color: transparent !important;
  }

  :deep(.el-collapse-item.is-active > .el-collapse-item__wrap) {
    display: block;
    background-color: color-mix(in srgb, var(--el-fill-color-lighter) 78%, transparent);
    border: 1px solid var(--el-border-color-lighter);
    border-top: none;
    border-bottom-left-radius: var(--bubble-radius);
    border-bottom-right-radius: var(--bubble-radius);
  }
}

.tool-call-title {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 8px;
}

.tool-name-wrapper {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  overflow: hidden;
}


.tool-name {
  font-weight: 500;
  color: var(--el-text-color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: block;
  width: 100%;
}

.tool-icon {
  color: var(--el-text-color-secondary);
  flex-shrink: 0;
}

.tool-header-right {
  margin-left: auto;
  margin-right: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.stop-btn-wrapper {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  cursor: pointer;
  transition: all 0.2s ease;
  background-color: var(--el-text-color-primary);
  color: var(--el-bg-color);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);

  &:hover {
    opacity: 0.85;
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
  }

  &:active {
    transform: scale(0.95);
  }
}

html.dark .stop-btn-wrapper {
  background-color: #E5EAF3;
  color: #141414;

  &:hover {
    background-color: #ffffff;
  }
}

.tool-approval-actions {
  margin-top: -2px;
  margin-left: 1px;
  margin-right: 1px;
  padding: 8px 12px;
  background-color: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-lighter);
  border-top: 1px dashed var(--el-border-color-lighter);
  border-bottom-left-radius: 8px;
  border-bottom-right-radius: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  animation: slide-in 0.2s ease-out;
}

@keyframes slide-in {
  from {
    opacity: 0;
    transform: translateY(-5px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.actions-left {
  display: flex;
  gap: 10px;
}

.actions-right {
  margin-left: auto;

  :deep(.el-checkbox__label) {
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }
}

.tool-call-details {
  .tool-detail-section {
    margin-bottom: 10px;

    &:last-child {
      margin-bottom: 0;
    }

    strong {
      display: block;
      margin-bottom: 5px;
      font-size: 13px;
      color: var(--el-text-color-secondary);
    }

    pre {
      margin: 0;
      padding: 8px;
      border-radius: 6px;
      background-color: var(--el-fill-color-light);
      max-height: 150px;
      overflow: auto;
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-all;

      code {
        font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace;
        color: var(--el-text-color-primary);
      }
    }
  }
}

.tool-call-details .tool-detail-section pre {
    border-radius: var(--bubble-radius);
}

.tool-call-details .tool-detail-section pre::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.tool-call-details .tool-detail-section pre::-webkit-scrollbar-track {
  background: transparent;
  border-radius: 4px;
}

.tool-call-details .tool-detail-section pre::-webkit-scrollbar-thumb {
  background: var(--el-text-color-disabled, #c0c4cc);
  border-radius: 4px;
  border: 2px solid var(--el-fill-color-light);
  background-clip: content-box;
}

.tool-call-details .tool-detail-section pre::-webkit-scrollbar-thumb:hover {
  background: var(--el-text-color-secondary, #909399);
  background-clip: content-box;
}

.tool-result-wrapper {
  display: flex;
  align-items: flex-start;
}

.tool-result-wrapper pre {
  flex-grow: 1;
}

html.dark .tool-collapse {
  :deep(.el-collapse-item__header) {
    background-color: var(--el-fill-color-darker);
    border-color: var(--el-border-color-dark);
  }

  :deep(.el-collapse-item__wrap) {
    border-color: var(--el-border-color-dark);
  }
}

html.dark .stop-btn-wrapper:hover {
  background-color: rgba(245, 108, 108, 0.2);
  color: #F56C6C;
}

html.dark .tool-approval-actions {
  background-color: var(--el-fill-color-dark);
  border-color: var(--el-border-color-dark);
  border-top-color: var(--el-border-color-dark);
}

html.dark .tool-call-details {
  .tool-detail-section pre {
    background-color: var(--el-fill-color-darker);
  }
}

html.dark .tool-call-details .tool-detail-section pre::-webkit-scrollbar-thumb {
  background: #6b6b6b;
  border-color: var(--el-fill-color-darker);
}

html.dark .tool-call-details .tool-detail-section pre::-webkit-scrollbar-thumb:hover {
  background: #999;
}

:deep(.markdown-wrapper) {

  .inline-code-tag {
    &:not(pre > code) {
      cursor: pointer !important;
      pointer-events: auto !important;
      position: relative;
      z-index: 1;

      transition: all 0.2s ease;
      border-radius: 4px;
      padding: 2px 5px;
      margin: 0 2px;
      border: 1px solid transparent;

      &:hover {
        background-color: rgba(0, 0, 0, 0.08);
        border-color: rgba(0, 0, 0, 0.12);
      }

      &:active {
        background-color: var(--el-color-primary-light-10) !important;
        transform: scale(0.98);
      }
    }
  }
}
</style>