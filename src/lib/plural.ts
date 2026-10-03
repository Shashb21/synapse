/** "1 activity", "3 activities": a count with the right noun form. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
