<script setup lang="ts">
import { shallowRef, watch } from "vue";
import type { ReaderSegment } from "../reader-segment";

const props = defineProps<{
  as: string;
  segment: ReaderSegment;
  sourceFingerprint: string;
  rendererVersion: string;
  renderRevision: string;
  renderSeg: (segment: ReaderSegment) => string;
}>();

const html = shallowRef("");

// The watch source contains only the segment/render identities. The callback is
// deliberately not a watchEffect: reactive overlay stores read by renderSeg do
// not become broad dependencies of every mounted segment.
watch(
  () => [
    props.segment.lid,
    props.segment.text,
    props.segment.kind,
    props.sourceFingerprint,
    props.rendererVersion,
    props.renderRevision,
  ] as const,
  () => {
    html.value = props.renderSeg(props.segment);
  },
  { immediate: true, flush: "sync" },
);
</script>

<template>
  <component :is="props.as" v-html="html"></component>
</template>
