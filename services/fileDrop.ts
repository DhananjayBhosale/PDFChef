/** Match the same MIME/extension list used by a file picker. */
export function acceptsDroppedFile(file: Pick<File, 'name' | 'type'>, accept: string): boolean {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return accept.split(',').some((value) => {
    const rule = value.trim().toLowerCase();
    if (!rule) return false;
    if (rule.startsWith('.')) return name.endsWith(rule);
    if (rule.endsWith('/*')) return type.startsWith(rule.slice(0, -1));
    return type === rule;
  });
}
