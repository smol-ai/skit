export interface TerminalFrame {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number;
}

export interface TerminalEnvironment {
  readonly color: boolean;
  readonly detail: "summary" | "full";
  readonly format: "human" | "json";
}

export const defaultTerminalEnvironment: TerminalEnvironment = {
  color: false,
  detail: "summary",
  format: "human",
};
