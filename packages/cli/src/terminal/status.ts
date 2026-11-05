export const CLEAR_STATUS_LINE = "\r\u001b[2K";
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const STATUS_FRAME_MS = 80;

/** Shared by the console renderer and recorded journey playback. */
export const renderStatusLine = (message: string, frame: number): string =>
  `${frames[frame % frames.length]} ${message}`;
