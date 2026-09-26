<template>
  <div>
    <button @click="inc">{{ label }}</button>
    <span class="count">{{ count }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

const props = defineProps<{ step: number; max: number }>();
const count = ref(0);
const label = computed(() => (count.value >= props.max ? 'Full' : 'Add'));

function inc() {
  if (count.value + props.step <= props.max) {
    count.value = count.value + props.step;
  }
}
</script>
