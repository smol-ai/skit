// Skill metadata, repository paths and server responses reach human output. Their C0 and C1
// controls must not drive the terminal (escape sequences can rewrite the screen or set the
// clipboard), so they are removed before presenters add SKIT's own styling. Newlines and tabs stay.
// oxlint-disable-next-line no-control-regex -- These are exactly the controls being removed.
const TERMINAL_CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export const terminalText = (text: string): string => text.replace(TERMINAL_CONTROLS, "");

/** Every string in plain contract data, keys included, made safe for human output. */
export const terminalData = <T>(value: T): T => {
  if (typeof value === "string") return terminalText(value) as T;
  if (Array.isArray(value)) return value.map(terminalData) as T;
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [terminalText(key), terminalData(entry)]),
    ) as T;
  return value;
};
