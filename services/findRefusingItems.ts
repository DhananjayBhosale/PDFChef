/**
 * Find the items a batch operation refuses, by halves.
 *
 * `holds` runs the operation on a group and says whether it succeeded. The whole set is already
 * known to fail, so the search starts from its halves: one bad item among n costs about
 * 2·log2(n) trials instead of n. A group still untried when the trials run out is reported whole.
 * If every part holds alone, the failure comes from a combination, so the whole set is reported.
 */
export const findRefusingItems = async <T>(
  items: readonly T[],
  holds: (group: T[]) => Promise<boolean>,
  maxTrials = 48,
): Promise<T[]> => {
  const refusing: T[] = [];
  let trials = 0;
  const visit = async (group: T[], knownToFail: boolean): Promise<void> => {
    if (group.length === 0) return;
    if (!knownToFail) {
      if (trials >= maxTrials) {
        refusing.push(...group);
        return;
      }
      trials += 1;
      if (await holds(group)) return;
    }
    if (group.length === 1) {
      refusing.push(group[0]);
      return;
    }
    const middle = Math.ceil(group.length / 2);
    await visit(group.slice(0, middle), false);
    await visit(group.slice(middle), false);
  };
  await visit([...items], true);
  return refusing.length > 0 ? refusing : [...items];
};
