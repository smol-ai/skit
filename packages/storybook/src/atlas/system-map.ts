import { pathToFileURL } from "node:url";
import { join, relative } from "node:path";
import { Effect, FileSystem, Schema, Struct } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { ProviderComposition, traceProviders } from "./provider-tracing.ts";
import { extract } from "./effect-graph/src/extract.ts";
import {
  MapMember,
  MapProvider,
  MapSource,
  MapStop,
  ServiceDefinition,
  SystemMap,
  type PersistedStore,
} from "./data.ts";

const ExtractedMap = Schema.Struct({
  tracing: Schema.optionalKey(ProviderComposition),
  sourceFingerprint: Schema.String,
  services: Schema.Array(
    Schema.Struct(Struct.omit(ServiceDefinition.fields, ["providers", "stores"])),
  ),
  providers: Schema.Array(
    Schema.Struct({ ...MapProvider.fields, provides: Schema.Array(MapMember) }),
  ),
  commands: Schema.Array(
    Schema.Struct({
      ...MapSource.fields,
      command: Schema.String,
      scopes: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({ ...MapSource.fields, name: Schema.String, id: Schema.String }),
        ),
      ),
      requirements: Schema.Array(
        Schema.Struct({
          ...MapMember.fields,
          providers: Schema.Array(Schema.Struct({ ...MapSource.fields, name: Schema.String })),
          stops: Schema.Array(MapStop),
        }),
      ),
      incompleteErrors: Schema.Boolean,
      notes: Schema.Array(Schema.String),
      stops: Schema.Array(MapStop),
    }),
  ),
  stops: Schema.Array(MapStop),
  elapsedMs: Schema.Finite,
  compiler: SystemMap.fields.compiler,
});

class SystemMapFailure extends Schema.TaggedError<SystemMapFailure>()("SystemMapFailure", {
  cause: Schema.Defect(),
}) {}

/** Decode extraction, resolve declaration identities, and retain every incomplete answer. */
export const readSystemMap = Effect.fn("Atlas.readSystemMap")(function* (
  input: unknown,
  stores: readonly PersistedStore[],
) {
  const raw = yield* Schema.decodeUnknownEffect(ExtractedMap)(input);
  const members = [
    ...raw.providers.flatMap((provider) => [...provider.provides, ...provider.requires]),
    ...raw.commands.flatMap((command) => command.requirements),
  ];
  const external = new Map<string, typeof ServiceDefinition.Type>();
  for (const member of members)
    if (
      !member.incomplete &&
      member.file.includes("node_modules/") &&
      /^[\w$]+$/.test(member.name)
    ) {
      const id = `${member.file}#${member.name}`;
      external.set(id, {
        id,
        name: member.name,
        identifier: member.name,
        kind: "External requirement",
        file: member.file,
        line: member.line,
        operations: [],
        providers: [],
        stores: [],
      });
    }
  const definitions = [...raw.services, ...external.values()];
  const linked = <Member extends typeof MapMember.Type>(member: Member) => {
    const service = definitions.find(
      (service) =>
        service.name === member.name &&
        member.declarations.some((file) => file.toLowerCase() === service.file.toLowerCase()),
    );
    return { ...member, ...(service ? { service: service.id } : {}) };
  };
  const services = definitions.map((service) => ({
    ...service,
    providers: raw.providers
      .filter((provider) =>
        provider.provides.some((member) => linked(member).service === service.id),
      )
      .map((provider) => ({ ...provider, requires: provider.requires.map(linked) })),
    stores: stores
      .filter((store) =>
        store.owners.some(
          (owner) =>
            owner.name === service.name && owner.file.toLowerCase() === service.file.toLowerCase(),
        ),
      )
      .map((store) => store.id),
  }));
  const trace = raw.tracing ? traceProviders(raw.tracing) : undefined;
  const commands = new Map<string, SystemMap["commands"][number]>();
  for (const command of raw.commands) {
    const previous = commands.get(command.command);
    const requirements = new Map<string, SystemMap["commands"][number]["requirements"][number]>();
    const traced = trace?.(command.requirements, command.scopes?.map((scope) => scope.id) ?? []);
    const current =
      traced?.requirements ??
      command.requirements.map((requirement) => ({
        ...requirement,
        id: `${requirement.key}:${command.file}:${command.line}`,
        candidates: [],
        providers: requirement.providers.map((provider) => ({
          ...provider,
          requires: [],
          incomplete: true,
          notes: ["Provider requirements are not recorded"],
          dependencies: [],
        })),
      }));
    for (const requirement of [
      ...(previous?.requirements ?? []),
      ...current.map((requirement) => ({
        ...linked(requirement),
        providers: requirement.providers.map((provider) => ({
          ...provider,
          requires: provider.requires.map(linked),
        })),
        candidates: requirement.candidates.map((provider) => ({
          ...provider,
          requires: provider.requires.map(linked),
        })),
      })),
    ]) {
      const key = requirement.service ?? `${requirement.file}#${requirement.name}`,
        existing = requirements.get(key);
      const providers = [
        ...new Map(
          [...(existing?.providers ?? []), ...requirement.providers].map((provider) => [
            `${provider.file}:${provider.line}:${provider.name}:${JSON.stringify(provider.notes)}`,
            provider,
          ]),
        ).values(),
      ];
      const inconsistent =
        existing &&
        (providers.length > 1 ||
          existing.providers.length > 0 !== requirement.providers.length > 0 ||
          existing.candidates.length > 0 !== requirement.candidates.length > 0);
      requirements.set(key, {
        ...requirement,
        providers: inconsistent ? [] : providers,
        candidates: [
          ...(existing?.candidates ?? []),
          ...requirement.candidates,
          ...(inconsistent ? providers : []),
        ],
        stops: [
          ...(inconsistent
            ? [
                {
                  file: command.file,
                  line: command.line,
                  reason: "Command factory occurrences do not identify one provider consistently",
                },
              ]
            : []),
          ...new Map(
            [...(existing?.stops ?? []), ...requirement.stops].map((stop) => [
              `${stop.file}:${stop.line}:${stop.reason}`,
              stop,
            ]),
          ).values(),
        ],
      });
    }
    const required = [...requirements.values()];
    commands.set(command.command, {
      command: command.command,
      sources: [...(previous?.sources ?? []), { file: command.file, line: command.line }],
      requirements: required,
      traces: [
        ...new Map(
          [...(previous?.traces ?? []), ...(traced?.traces ?? current)].map((item) => [
            item.id,
            {
              ...linked(item),
              providers: item.providers.map((provider) => ({
                ...provider,
                requires: provider.requires.map(linked),
              })),
              candidates: item.candidates.map((provider) => ({
                ...provider,
                requires: provider.requires.map(linked),
              })),
            },
          ]),
        ).values(),
      ],
      application: traced?.application ?? [],
      incompleteErrors: command.incompleteErrors || previous?.incompleteErrors === true,
      notes: [...new Set([...(previous?.notes ?? []), ...command.notes])],
      stops: [...(previous?.stops ?? []), ...command.stops],
      stores: [
        ...new Set(
          required.flatMap(
            (requirement) =>
              services.find((service) => service.id === requirement.service)?.stores ?? [],
          ),
        ),
      ],
    });
  }
  return {
    sourceFingerprint: raw.sourceFingerprint,
    services,
    commands: [...commands.values()],
    stops: raw.stops,
    elapsedMs: raw.elapsedMs,
    compiler: raw.compiler,
  };
});

/** Native compiler execution is dev-time only. The normal Atlas reader consumes its JSON. */
export const generateSystemMap = (
  root: string,
  output: string,
  stores: readonly PersistedStore[],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const sources: Array<{ path: string; text: string }> = [];
    for (const pkg of ["cli", "skit", "skit-server-effect"]) {
      const directory = join(root, "packages", pkg),
        src = join(directory, "src");
      const names = yield* fs.readDirectory(src, { recursive: true });
      for (const name of [
        "../package.json",
        ...names.filter(
          (name) => name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts"),
        ),
      ]) {
        const file = join(src, name);
        sources.push({ path: relative(root, file), text: yield* fs.readFileString(file) });
      }
    }
    const owners = [
      ...new Map(
        stores
          .flatMap((store) => store.owners)
          .map((owner) => [`${owner.file}#${owner.name}`, { file: owner.file, name: owner.name }]),
      ).values(),
    ];
    const policyModule = yield* Effect.tryPromise({
      try: async (): Promise<unknown> =>
        import(pathToFileURL(join(root, "architecture/boundaries.mjs")).href),
      catch: (cause) => new SystemMapFailure({ cause }),
    });
    const policy = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        owners: Schema.Array(
          Schema.Struct({
            sources: Schema.optionalKey(Schema.Array(Schema.String)),
            objects: Schema.optionalKey(Schema.Array(Schema.String)),
          }),
        ),
      }),
    )(policyModule);
    sources.push({
      path: "architecture/boundaries.mjs",
      text: yield* fs.readFileString(join(root, "architecture/boundaries.mjs")),
    });
    const objects = policy.owners.flatMap((owner) =>
      (owner.sources ?? []).flatMap((prefix) =>
        (owner.objects ?? []).map((name) => ({ prefix, name })),
      ),
    );
    const raw = yield* Effect.try({
      try: () =>
        extract(
          root,
          sources,
          ["packages/cli/src/main.ts", "packages/skit-server-effect/src/index.ts"],
          { file: "packages/cli/src/commands/tree.ts", name: "skitCommand" },
          owners,
          objects,
        ),
      catch: (cause) => new SystemMapFailure({ cause }),
    });
    const path = join(output, "services-extracted.json");
    yield* fs.writeFileString(path, JSON.stringify(raw));
    const saved = yield* fs.readFileString(path);
    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(ExtractedMap))(saved);
    return yield* readSystemMap(decoded, stores);
  }).pipe(Effect.provide(NodeFileSystem.layer));
