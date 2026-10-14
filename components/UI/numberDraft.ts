/**
 * What a typed number box should apply. While typing, only an in-range value is applied, so
 * "2" on the way to "24" in an 8–72 box is left alone instead of snapping to 8. When the box
 * is left, the text is clamped into range; text that is not a number keeps the old value.
 */
export const liveNumberValue = (text: string, min: number, max: number): number | null => {
  if (text.trim() === '') return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
};

export const finalNumberValue = (text: string, min: number, max: number): number | null => {
  if (text.trim() === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : null;
};
