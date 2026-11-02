import { Option } from "effect";

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Bytes as UTF-8 text, or none when they are not valid UTF-8. Malformed bytes never become
 * U+FFFD, and a byte order mark stays part of the text.
 */
export const decodeUtf8 = Option.liftThrowable((bytes: Uint8Array) => utf8.decode(bytes));
