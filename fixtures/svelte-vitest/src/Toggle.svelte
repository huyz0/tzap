<script lang="ts">
  let { label, initial = false }: { label: string; initial?: boolean } = $props();
  let on = $state(initial);
  const text = $derived(on ? `${label}: on` : `${label}: off`);

  function flip() {
    on = !on;
  }
</script>

<button onclick={flip}>{text}</button>
