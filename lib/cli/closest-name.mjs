// Edit distance and "did you mean" matching for mistyped commands and options.

/** Edit distance where swapping two adjacent characters counts as one edit. */
export function levenshtein(left, right) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let before = null;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(previous[rightIndex] + 1, current[rightIndex - 1] + 1, substitution);
      if (before && leftIndex > 1 && rightIndex > 1 && left[leftIndex - 1] === right[rightIndex - 2] && left[leftIndex - 2] === right[rightIndex - 1]) {
        current[rightIndex] = Math.min(current[rightIndex], before[rightIndex - 2] + 1);
      }
    }
    before = previous;
    previous = current;
  }
  return previous[right.length];
}

/** Names close enough to `input` to be a typo of it, nearest first; empty when nothing is close. */
export function closestNames(input, names, { limit = 3 } = {}) {
  const wanted = String(input ?? "").toLowerCase();
  if (!wanted) return [];
  const threshold = Math.max(2, Math.floor(wanted.length / 3));
  return [...new Set(names)]
    .map((name) => ({ name, distance: levenshtein(wanted, String(name).toLowerCase()) }))
    .filter(({ name, distance }) => distance <= threshold || (wanted.length >= 3 && String(name).toLowerCase().startsWith(wanted)))
    .sort((left, right) => left.distance - right.distance || left.name.localeCompare(right.name, "en"))
    .filter((item, index, sorted) => item.distance === sorted[0].distance)
    .slice(0, limit)
    .map(({ name }) => name);
}
