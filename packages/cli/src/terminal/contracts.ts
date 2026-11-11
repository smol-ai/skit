import { homedir } from "node:os";

export interface TerminalFrame {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number;
}

export interface TerminalEnvironment {
  readonly color: boolean;
  readonly detail: "summary" | "full";
  readonly format: "human" | "json";
  /** Abbreviated in prose and path spans; executable code keeps its exact text. */
  readonly home: string;
  /** Columns to wrap prose to; absent when output is not going to a terminal. */
  readonly width?: number;
}

export const defaultTerminalEnvironment: TerminalEnvironment = {
  color: false,
  detail: "summary",
  format: "human",
  home: homedir(),
};

export type RenderContext = Pick<TerminalEnvironment, "color" | "detail" | "width"> &
  Partial<Pick<TerminalEnvironment, "home">>;
