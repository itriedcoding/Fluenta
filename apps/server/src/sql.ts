/** Tiny SQL predicate helpers, kept dependency-free. */
export const eq = (column: string) => `${column} = ?`;

export const and = (...parts: string[]) => parts.filter(Boolean).join(' AND ');
