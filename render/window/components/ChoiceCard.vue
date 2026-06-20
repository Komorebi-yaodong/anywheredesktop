<script setup>
import { reactive, computed } from 'vue';
import { ElButton, ElInput, ElTag, ElIcon } from 'element-plus';
import { Check, ChatLineRound, EditPen } from '@element-plus/icons-vue';

const props = defineProps({
  questions: { type: Array, default: () => [] }
});

const emit = defineEmits(['submit']);

// 每个问题的草稿状态：mode 为 options / custom / discuss，三者互斥
const drafts = reactive(
  props.questions.map(() => ({ mode: '', selected: [], customText: '' }))
);

const optionLetter = (index) => String.fromCharCode(65 + index);

const isOptionSelected = (qi, label) =>
  drafts[qi]?.mode === 'options' && drafts[qi].selected.includes(label);

const selectOption = (qi, label) => {
  const q = props.questions[qi] || {};
  const d = drafts[qi];
  if (!d) return;
  if (q.multiSelect) {
    if (d.mode !== 'options') {
      d.mode = 'options';
      d.selected = [];
    }
    const idx = d.selected.indexOf(label);
    if (idx >= 0) d.selected.splice(idx, 1);
    else d.selected.push(label);
    if (d.selected.length === 0) d.mode = '';
    d.customText = '';
  } else {
    d.mode = 'options';
    d.selected = [label];
    d.customText = '';
  }
};

const chooseCustom = (qi) => {
  const d = drafts[qi];
  if (!d) return;
  d.mode = 'custom';
  d.selected = [];
};

const chooseDiscuss = (qi) => {
  const d = drafts[qi];
  if (!d) return;
  d.mode = 'discuss';
  d.selected = [];
  d.customText = '';
};

const isAnswered = (qi) => {
  const d = drafts[qi];
  if (!d) return false;
  if (d.mode === 'discuss') return true;
  if (d.mode === 'custom') return d.customText.trim().length > 0;
  if (d.mode === 'options') return d.selected.length > 0;
  return false;
};

const allAnswered = computed(() => props.questions.every((_, i) => isAnswered(i)));

const onSubmit = () => {
  if (!allAnswered.value) return;
  const responses = props.questions.map((q, i) => {
    const d = drafts[i];
    if (d.mode === 'discuss') return { questionIndex: i, type: 'discuss', question: q.question };
    if (d.mode === 'custom') return { questionIndex: i, type: 'custom', customText: d.customText.trim(), question: q.question };
    return { questionIndex: i, type: 'options', selected: d.selected.slice(), question: q.question };
  });
  emit('submit', { responses });
};
</script>

<template>
  <div class="choice-card">
    <div v-for="(q, qi) in questions" :key="qi" class="choice-question">
      <div class="choice-q-head">
        <el-tag v-if="q.header" size="small" effect="plain" round class="choice-header-tag">{{ q.header }}</el-tag>
        <span class="choice-q-text">{{ q.question }}</span>
      </div>

      <div class="choice-options">
        <div
          v-for="(opt, oi) in (q.options || [])"
          :key="oi"
          class="choice-option"
          :class="{ 'is-selected': isOptionSelected(qi, opt.label) }"
          @click="selectOption(qi, opt.label)"
        >
          <span class="choice-letter">{{ optionLetter(oi) }}</span>
          <div class="choice-option-body">
            <div class="choice-option-label">{{ opt.label }}</div>
            <div v-if="opt.description" class="choice-option-desc">{{ opt.description }}</div>
          </div>
          <el-icon v-if="isOptionSelected(qi, opt.label)" class="choice-check"><Check /></el-icon>
        </div>

        <!-- 倒数第二项：其他想法（输入框） -->
        <div
          class="choice-option choice-special"
          :class="{ 'is-selected': drafts[qi].mode === 'custom' }"
          @click="chooseCustom(qi)"
        >
          <span class="choice-letter"><el-icon :size="13"><EditPen /></el-icon></span>
          <div class="choice-option-body">
            <div class="choice-option-label">其他想法（自己输入）</div>
            <el-input
              v-if="drafts[qi].mode === 'custom'"
              v-model="drafts[qi].customText"
              type="textarea"
              :autosize="{ minRows: 1, maxRows: 4 }"
              resize="none"
              placeholder="输入你的想法…"
              class="choice-custom-input"
              @click.stop
            />
          </div>
        </div>

        <!-- 最后一项：聊聊这个 -->
        <div
          class="choice-option choice-special"
          :class="{ 'is-selected': drafts[qi].mode === 'discuss' }"
          @click="chooseDiscuss(qi)"
        >
          <span class="choice-letter"><el-icon :size="13"><ChatLineRound /></el-icon></span>
          <div class="choice-option-body">
            <div class="choice-option-label">聊聊这个（继续讨论）</div>
          </div>
        </div>
      </div>
    </div>

    <div class="choice-actions">
      <el-button type="primary" size="small" :icon="Check" :disabled="!allAnswered" @click="onSubmit">
        提交选择
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.choice-card {
  margin-top: 8px;
  padding: 12px;
  border-radius: 12px;
  background-color: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-lighter);
  animation: choice-slide-in 0.25s ease;
}

@keyframes choice-slide-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

.choice-question + .choice-question {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px dashed var(--el-border-color);
}

.choice-q-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.choice-header-tag {
  flex-shrink: 0;
}

.choice-q-text {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  line-height: 1.5;
}

.choice-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.choice-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background-color: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  cursor: pointer;
  transition: all 0.18s ease;
}

.choice-option:hover {
  border-color: var(--el-color-primary);
  background-color: var(--el-fill-color);
}

.choice-option.is-selected {
  border-color: var(--el-color-primary);
  background-color: var(--el-color-primary-light-9);
}

.choice-letter {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 700;
  color: var(--el-text-color-regular);
  background-color: var(--el-fill-color);
}

.choice-option.is-selected .choice-letter {
  color: #fff;
  background-color: var(--el-color-primary);
}

.choice-option-body {
  flex: 1;
  min-width: 0;
}

.choice-option-label {
  font-size: 13px;
  color: var(--el-text-color-primary);
  line-height: 1.5;
}

.choice-option-desc {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.5;
  margin-top: 2px;
}

.choice-custom-input {
  margin-top: 6px;
}

.choice-check {
  flex-shrink: 0;
  color: var(--el-color-primary);
  margin-top: 2px;
}

.choice-special .choice-letter {
  color: var(--el-color-primary);
}

.choice-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
</style>
