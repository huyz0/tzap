import { mount } from '@vue/test-utils';
import { expect, it } from 'vitest';
import Counter from '../src/Counter.vue';

it('counts in steps', async () => {
  const w = mount(Counter, { props: { step: 2, max: 10 } });
  await w.find('button').trigger('click');
  expect(w.find('.count').text()).toBe('2');
});

it('stops at the maximum', async () => {
  const w = mount(Counter, { props: { step: 5, max: 5 } });
  await w.find('button').trigger('click');
  await w.find('button').trigger('click');
  expect(w.find('.count').text()).toBe('5');
  expect(w.find('button').text()).toBe('Full');
});
