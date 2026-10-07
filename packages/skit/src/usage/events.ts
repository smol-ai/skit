import { Schema, Option } from "effect";
import type { UsageHarness, UsageKind } from "./contracts.js";
import { literalCommands, shellReadPaths } from "./literals.js";
const RecordObject = Schema.Record(Schema.String, Schema.Unknown);
const decodeRecord = Schema.decodeUnknownOption(RecordObject);
export interface TranscriptRecord extends Schema.Schema.Type<typeof RecordObject> {}
export const object = (value: unknown): TranscriptRecord =>
  Option.getOrElse(decodeRecord(value), () => ({}));
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const parts = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
function texts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  return parts(content).flatMap((p) => {
    const b = object(p);
    return ["text", "input_text"].includes(String(b.type)) && typeof b.text === "string"
      ? [b.text]
      : [];
  });
}
export interface UsageEvent {
  kind: UsageKind;
  name: string;
  path?: string;
  id?: string;
  cwd?: string;
}
export interface ExtractedUsage {
  events: UsageEvent[];
  unsupported: number;
  summaries: number;
  mentions: number;
  slashCommands: number;
}
export function extractUsage(harness: UsageHarness, r: TranscriptRecord): ExtractedUsage {
  const out: ExtractedUsage = {
    events: [],
    unsupported: 0,
    summaries: 0,
    mentions: 0,
    slashCommands: 0,
  };
  const p = object(r.payload),
    m = object(r.message);
  if (
    r.type === "compacted" ||
    r.isCompactSummary === true ||
    (r.type === "system" && r.subtype === "compact_boundary")
  ) {
    out.summaries++;
    return out;
  }
  const read = (file: string, id?: string, cwd?: string) => {
    if (/(?:^|\/)SKILL\.md$/.test(file))
      out.events.push({ kind: "reads", name: file.split("/").at(-2) ?? file, path: file, id, cwd });
  };
  const tool = (name: unknown, input: TranscriptRecord, id?: string) => {
    if (harness === "claude-code" && name === "Skill" && text(input.skill))
      out.events.push({ kind: "calls", name: String(input.skill), id });
    if (name === "Read" && text(input.file_path)) read(String(input.file_path), id);
    if (["exec_command", "shell_command", "Bash", "shell"].includes(String(name))) {
      const value = input.cmd ?? input.command;
      let command = text(value);
      if (Array.isArray(value)) {
        const [shell, flag, script] = value;
        if (
          value.length === 3 &&
          typeof shell === "string" &&
          /(?:^|\/)(?:bash|sh|zsh|dash|ksh)$/.test(shell) &&
          (flag === "-c" || flag === "-lc") &&
          typeof script === "string"
        )
          command = script;
        else out.unsupported++;
      } else if (command === undefined) out.unsupported++;
      if (command)
        for (const file of new Set(shellReadPaths(command)))
          read(file, id, text(input.cwd) ?? text(input.workdir));
    }
  };
  if (harness === "claude-code") {
    if (r.type === "assistant")
      for (const item of parts(m.content)) {
        const b = object(item);
        if (b.type === "tool_use") tool(b.name, object(b.input), text(b.id));
      }
    if (r.type === "user")
      for (const s of texts(m.content)) {
        if (r.isMeta === true && s.startsWith("Base directory for this skill:")) {
          const dir = s.split(/\r?\n/, 1)[0].slice("Base directory for this skill:".length).trim();
          if (dir)
            out.events.push({
              kind: "loads",
              name: dir.split("/").filter(Boolean).at(-1) ?? dir,
              path: dir.replace(/\/$/, "") + "/SKILL.md",
              id: text(r.uuid),
            });
        }
        if (/^<command-message>[\s\S]*?<command-name>\//.test(s)) out.slashCommands++;
      }
  } else if (r.type === "response_item") {
    if (p.type === "message" && p.role === "user")
      for (const s of texts(p.content)) {
        const injected =
          /^<skill>\s*<name>([^<]+)<\/name>\s*<path>([^<]+)<\/path>[\s\S]*<\/skill>\s*$/.exec(s);
        if (injected)
          out.events.push({ kind: "loads", name: injected[1], path: injected[2], id: text(p.id) });
      }
    if (p.type === "function_call") {
      try {
        const args: unknown = JSON.parse(text(p.arguments) ?? "");
        tool(text(p.name)?.replace(/^functions\./, ""), object(args), text(p.call_id));
      } catch {
        out.unsupported++;
      }
    }
    if (p.type === "custom_tool_call" && ["exec", "functions.exec"].includes(String(p.name))) {
      const source = text(p.input) ?? "";
      if (source.includes("SKILL.md")) {
        const result = literalCommands(source);
        if (result.unsupported || !result.commands.length) out.unsupported++;
        for (const command of result.commands)
          tool("exec_command", object(command), text(p.call_id));
      }
    }
  }
  const content =
    harness === "claude-code" ? texts(m.content) : p.type === "message" ? texts(p.content) : [];
  if (
    !out.events.length &&
    content.some((s) => /SKILL\.md|<skill>|Base directory for this skill:/.test(s))
  )
    out.mentions++;
  return out;
}
