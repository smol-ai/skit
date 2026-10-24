/** Quote an exact path or identifier for POSIX shell examples shown by the CLI. */
export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
