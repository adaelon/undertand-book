<script setup lang="ts">
import { CloudUpload, File, FileCheck, FileText, RefreshCw, X } from "@lucide/vue";
import { computed, ref, useId } from "vue";
import { fileMatchesAccept, formatFileSize } from "../file-drop";

const props = withDefaults(
  defineProps<{
    modelValue: File | null;
    label: string;
    accept: string;
    acceptLabel: string;
    kind?: "markdown" | "pdf";
    disabled?: boolean;
  }>(),
  {
    kind: "markdown",
    disabled: false,
  },
);

const emit = defineEmits<{
  (event: "update:modelValue", file: File | null): void;
}>();

const inputId = `file-drop-${useId()}`;
const inputRef = ref<HTMLInputElement | null>(null);
const dragging = ref(false);
const validationError = ref<string | null>(null);
const FileKindIcon = computed(() => (props.kind === "pdf" ? File : FileText));

function openPicker() {
  if (!props.disabled) inputRef.value?.click();
}

function selectFile(file: File | null) {
  if (!file) return;
  if (!fileMatchesAccept(file, props.accept)) {
    validationError.value = `${file.name} 不是支持的 ${props.acceptLabel} 文件`;
    return;
  }
  validationError.value = null;
  emit("update:modelValue", file);
}

function onInputChange(event: Event) {
  selectFile((event.target as HTMLInputElement).files?.[0] ?? null);
}

function onDragEnter() {
  if (!props.disabled) dragging.value = true;
}

function onDragLeave(event: DragEvent) {
  const current = event.currentTarget as HTMLElement | null;
  const next = event.relatedTarget as Node | null;
  if (!current || !next || !current.contains(next)) dragging.value = false;
}

function onDrop(event: DragEvent) {
  dragging.value = false;
  if (props.disabled) return;
  selectFile(event.dataTransfer?.files[0] ?? null);
}

function clearFile() {
  validationError.value = null;
  if (inputRef.value) inputRef.value.value = "";
  emit("update:modelValue", null);
}
</script>

<template>
  <div
    class="file-drop-field"
    :class="{ dragging, selected: !!props.modelValue, invalid: !!validationError, disabled: props.disabled }"
    :data-kind="props.kind"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <div class="file-drop-heading">
      <label :for="inputId">{{ props.label }}</label>
      <span>{{ props.acceptLabel }}</span>
    </div>

    <input
      :id="inputId"
      ref="inputRef"
      class="file-drop-native"
      type="file"
      :accept="props.accept"
      :disabled="props.disabled"
      @change="onInputChange"
    />

    <div v-if="props.modelValue" class="file-drop-selection">
      <span class="file-drop-type-icon" aria-hidden="true"><FileCheck :size="22" :stroke-width="1.8" /></span>
      <span class="file-drop-file">
        <strong :title="props.modelValue.name">{{ props.modelValue.name }}</strong>
        <small>{{ formatFileSize(props.modelValue.size) }}</small>
      </span>
      <span class="file-drop-actions">
        <button type="button" :disabled="props.disabled" :title="`替换${props.label}`" :aria-label="`替换${props.label}`" @click="openPicker">
          <RefreshCw :size="17" />
        </button>
        <button type="button" :disabled="props.disabled" :title="`移除${props.label}`" :aria-label="`移除${props.label}`" @click="clearFile">
          <X :size="18" />
        </button>
      </span>
    </div>

    <button v-else type="button" class="file-drop-empty" :disabled="props.disabled" @click="openPicker">
      <span class="file-drop-upload-icon" aria-hidden="true"><CloudUpload :size="25" :stroke-width="1.7" /></span>
      <span class="file-drop-empty-copy">
        <strong>选择文件</strong>
        <small>{{ dragging ? "松开以选用" : "本机文件" }}</small>
      </span>
      <component :is="FileKindIcon" class="file-drop-kind-icon" :size="18" aria-hidden="true" />
    </button>

    <p v-if="validationError" class="file-drop-error" role="alert">{{ validationError }}</p>
  </div>
</template>

<style scoped>
.file-drop-field {
  min-width: 0;
  color: var(--ink);
}
.file-drop-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.38rem;
}
.file-drop-heading label {
  color: var(--slate);
  font-size: 0.78rem;
  font-weight: 650;
}
.file-drop-heading span {
  border: 1px solid var(--hairline-soft);
  border-radius: 999px;
  background: #fff;
  color: var(--muted);
  padding: 0.1rem 0.4rem;
  font-family: var(--mono);
  font-size: 0.66rem;
  font-weight: 650;
}
.file-drop-native {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}
.file-drop-empty,
.file-drop-selection {
  width: 100%;
  min-height: 86px;
  box-sizing: border-box;
  border: 1px dashed var(--hairline);
  border-radius: 8px;
  background: #f9faf9;
}
.file-drop-empty {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.7rem;
  color: var(--ink);
  padding: 0.8rem;
  text-align: left;
  cursor: pointer;
  transition: border-color 140ms ease, background 140ms ease, box-shadow 140ms ease;
}
.file-drop-empty:hover:not(:disabled),
.file-drop-empty:focus-visible,
.file-drop-field.dragging .file-drop-empty {
  border-color: var(--file-accent);
  background: var(--file-accent-soft);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--file-accent) 12%, transparent);
  outline: none;
}
.file-drop-upload-icon,
.file-drop-type-icon {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border-radius: 8px;
  background: var(--file-accent-soft);
  color: var(--file-accent);
}
.file-drop-empty-copy,
.file-drop-file {
  display: grid;
  min-width: 0;
  gap: 0.2rem;
}
.file-drop-empty-copy strong,
.file-drop-file strong {
  overflow: hidden;
  font-size: 0.86rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-drop-empty-copy small,
.file-drop-file small {
  color: var(--muted);
  font-size: 0.72rem;
}
.file-drop-kind-icon {
  color: var(--file-accent);
}
.file-drop-selection {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.7rem;
  border-style: solid;
  border-color: color-mix(in srgb, var(--file-accent) 30%, var(--hairline));
  background: #fff;
  padding: 0.75rem;
}
.file-drop-actions {
  display: flex;
  gap: 0.28rem;
}
.file-drop-actions button {
  display: grid;
  width: 34px;
  height: 34px;
  min-height: 34px;
  place-items: center;
  border: 1px solid var(--hairline-soft);
  border-radius: 7px;
  background: var(--canvas);
  color: var(--steel);
  padding: 0;
}
.file-drop-actions button:hover:not(:disabled),
.file-drop-actions button:focus-visible {
  border-color: var(--file-accent);
  color: var(--file-accent);
  outline: none;
}
.file-drop-error {
  margin: 0.42rem 0 0;
  color: var(--brand-error);
  font-size: 0.75rem;
}
.file-drop-field[data-kind="markdown"] {
  --file-accent: #16735b;
  --file-accent-soft: #eaf6f1;
}
.file-drop-field[data-kind="pdf"] {
  --file-accent: #b7443e;
  --file-accent-soft: #fbefed;
}
.file-drop-field.disabled {
  opacity: 0.58;
}
@media (max-width: 520px) {
  .file-drop-actions {
    flex-direction: column;
  }
}
</style>
