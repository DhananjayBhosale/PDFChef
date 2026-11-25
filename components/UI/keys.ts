import type { KeyboardEvent } from 'react';

/** Enter that confirms the field, not the Enter that ends a Japanese, Chinese or Korean (IME) composition. */
export const isConfirmEnter = (event: KeyboardEvent) =>
  event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229;
