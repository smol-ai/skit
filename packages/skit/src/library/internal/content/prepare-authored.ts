import { Effect, FileSystem, Schema } from "effect";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { type SkitDescriptor } from "../../../artifact/schemas.js";
import { readSkitDescriptor, validateSkitDirectory } from "../../../artifact/skit.js";
import { walkTree } from "../../../artifact/tree.js";
import type { TreeFile } from "../../../artifact/tree-entry.js";
import { errorMessage } from "../../../shared/failure.js";
import { Hash } from "../../../shared/hash.js";
import { originalTreeHash, originalTreeHashFromEntries } from "../../collection-version.js";
import { installedSkillHash } from "../../installed-skill-hash.js";
import { InvalidLibraryState } from "../../failures.js";
import { evaluateSkillFrontmatter } from "../../../harnesses/frontmatter.js";
import {
  authoredInputsFile,
  AuthoredInputs,
  AuthoredSelection,
  readAuthoredInputs,
} from "./authored-inputs.js";
import type { HarnessName } from "../../../harnesses/contracts.js";

const within = (path: string, root: string) =>
  root === "." || path === root || path.startsWith(`${root}/`);
const inputs = (files: readonly TreeFile[], skill: SkitDescriptor["skills"][number]) =>
  files.filter(
    (file) =>
      within(file.path, skill.path) ||
      skill.shared?.some((mapping) => within(file.path, mapping.from)),
  );
const inputHash = (files: readonly TreeFile[], skill: SkitDescriptor["skills"][number]) =>
  originalTreeHashFromEntries([
    {
      kind: "file",
      path: "declaration.json",
      mode: 0o644,
      bytes: new TextEncoder().encode(JSON.stringify(skill)),
    },
    ...inputs(files, skill),
  ]);

/** Every staging directory belongs to the enclosing Library operation's scope. */
const stage = Effect.fn("Library.stageAuthoredInputs")(function* (
  files: readonly TreeFile[],
  descriptor: SkitDescriptor,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-authored-inputs-" });
  for (const file of files) {
    if (file.path === "skit.json" || file.path === "README.md") continue;
    const path = join(root, file.path);
    yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });
    yield* fs.writeFile(path, file.bytes, { flag: "wx", mode: file.mode });
  }
  yield* fs.writeFileString(join(root, "README.md"), `---\n${stringify(descriptor)}---\n`);
  return root;
});

/** Choose complete per-skill input closures. Original declarations and observation ids live
 * alongside the derived retained tree, so malformed later descriptors can use known declarations.
 * This is provenance for that immutable Collection Version, not another mutable selection store. */
export const prepareAuthored = Effect.fn("Library.prepareAuthored")(function* (
  source: string,
  files: readonly TreeFile[],
  observation: {
    readonly revisionId: string;
    readonly savedAt: string;
    readonly importedAt: string;
  },
  previousCollection: { readonly root: string; readonly importedAt: string } | undefined,
  harnesses: readonly HarnessName[],
) {
  const fs = yield* FileSystem.FileSystem;
  const previousRoot = previousCollection?.root;
  const previousDescriptor =
    previousRoot === undefined ? undefined : yield* readSkitDescriptor(previousRoot);
  const previousHash =
    previousRoot === undefined ? undefined : yield* originalTreeHash(previousRoot);
  const previousFiles =
    previousRoot === undefined
      ? []
      : (yield* walkTree(previousRoot, "normalized")).filter(
          (entry): entry is TreeFile => entry.kind === "file",
        );
  const metadata = previousRoot === undefined ? undefined : yield* readAuthoredInputs(previousRoot);
  const declaration = yield* readSkitDescriptor(source).pipe(Effect.result);
  const descriptor =
    declaration._tag === "Success"
      ? declaration.success
      : (metadata?.descriptor ?? previousDescriptor);
  const messages: string[] =
    declaration._tag === "Failure" ? [`Descriptor held: ${errorMessage(declaration.failure)}`] : [];
  if (descriptor === undefined) return { root: undefined, messages };
  if (files.some((file) => file.path === authoredInputsFile))
    return {
      root: undefined,
      messages: [`${authoredInputsFile} is reserved for retained input provenance`],
    };
  const selected: Array<{
    files: readonly TreeFile[];
    member: SkitDescriptor["skills"][number];
    provenance: typeof AuthoredSelection.Type;
    artifactHash: Hash;
  }> = [];
  // A missing declaration remains selected until Author supplies an approved removal decision.
  const members = [...descriptor.skills];
  const currentPaths = new Set(files.map((file) => file.path));
  for (const stored of previousDescriptor?.skills ?? []) {
    const previous =
      metadata?.selections.find((item) => item.declaration.path === stored.path)?.declaration ??
      stored;
    if (!members.some((member) => member.path === previous.path)) {
      members.push(previous);
      messages.push(`Keeping ${previous.name}: membership removal awaits confirmation`);
    }
  }
  for (const member of members) {
    const previous = previousDescriptor?.skills.find(
      (item) => item.path === member.path && item.name === member.name,
    );
    const provenance = metadata?.selections.find((item) => item.declaration.path === member.path);
    const present = descriptor.skills.some((item) => item.path === member.path);
    const previousPaths =
      previous === undefined
        ? []
        : [
            ...previousFiles
              .filter((file) => within(file.path, previous.path))
              .map((file) => file.path),
            ...(previous.shared ?? []).flatMap((mapping, index) =>
              previousFiles
                .filter((file) => within(file.path, mapping.from))
                .map(
                  (file) =>
                    `${provenance?.declaration.shared?.[index]?.from ?? mapping.from}${file.path.slice(mapping.from.length)}`,
                ),
            ),
          ];
    // Until the shared inventory owner supplies explicit removal authority, missing supporting
    // files are held too. Repeated saves, elapsed time and restart never approve disappearance.
    const missing = previousPaths.filter((path) => !currentPaths.has(path));
    const candidate =
      present && missing.length === 0
        ? yield* Effect.gen(function* () {
            const root = yield* stage(inputs(files, member), { ...descriptor, skills: [member] });
            const checked = yield* validateSkitDirectory(root, "retained", {
              assessmentContext: "import",
            });
            const errors = checked.diagnostics.filter((item) => item.severity === "error");
            if (errors.length > 0)
              return { valid: false as const, messages: errors.map((item) => item.message) };
            const primary = yield* fs.readFileString(join(root, member.path, "SKILL.md"));
            const metadataIssues = harnesses.flatMap((harness) =>
              evaluateSkillFrontmatter(primary, harness, { directoryName: member.name })
                .issues.filter((issue) => issue.severity === "error")
                .map(
                  (issue) =>
                    `${harness}: ${issue.code}${issue.field === null ? "" : ` (${issue.field})`}`,
                ),
            );
            if (metadataIssues.length > 0)
              return { valid: false as const, messages: metadataIssues };
            return {
              valid: true as const,
              artifactHash: yield* installedSkillHash({
                collectionVersionPath: root,
                sourcePath: member.path,
                shared: member.shared,
              }),
            };
          }).pipe(
            Effect.catch((error) =>
              Effect.succeed({ valid: false as const, messages: [errorMessage(error)] }),
            ),
          )
        : {
            valid: false as const,
            messages:
              missing.length > 0
                ? missing.map((path) => `Input removal awaits confirmation: ${path}`)
                : ["Membership removal awaits confirmation"],
          };
    const hash = inputHash(files, member);
    if (
      candidate.valid &&
      hash !==
        (provenance?.input_hash ??
          (previous === undefined ? undefined : inputHash(previousFiles, previous)))
    ) {
      selected.push({
        files,
        member,
        artifactHash: candidate.artifactHash,
        provenance: {
          declaration: member,
          input_hash: hash,
          imported_at: observation.importedAt,
          source: { revision_id: observation.revisionId, saved_at: observation.savedAt },
        },
      });
    } else if (previous !== undefined && previousRoot !== undefined) {
      selected.push({
        files: previousFiles,
        member: previous,
        artifactHash: yield* installedSkillHash({
          collectionVersionPath: previousRoot,
          sourcePath: previous.path,
          shared: previous.shared,
        }),
        provenance: {
          ...(provenance ?? {
            declaration: previous,
            input_hash: inputHash(previousFiles, previous),
            source: { collection_hash: previousHash! },
          }),
          ...(provenance?.imported_at === undefined && previousCollection !== undefined
            ? { imported_at: previousCollection.importedAt }
            : {}),
        },
      });
    }
    if (!candidate.valid) messages.push(`${member.name}: ${candidate.messages.join("; ")}`);
  }
  if (selected.length === 0) return { root: undefined, messages };
  let sharedRoot = "skit-inputs";
  while (
    files.some((file) => within(file.path, sharedRoot)) ||
    selected.some((selection) => within(selection.member.path, sharedRoot))
  )
    sharedRoot += "-";
  const output: TreeFile[] = [];
  const derived: SkitDescriptor["skills"][number][] = [];
  for (const selection of selected) {
    const { member } = selection;
    output.push(
      ...selection.files.filter(
        (file) => within(file.path, member.path) && file.path !== authoredInputsFile,
      ),
    );
    const shared = member.shared?.map((mapping, index) => {
      const destination = `${sharedRoot}/${member.name}/${index}/input`;
      for (const file of selection.files.filter((file) => within(file.path, mapping.from)))
        output.push({ ...file, path: `${destination}${file.path.slice(mapping.from.length)}` });
      return { from: destination, to: mapping.to };
    });
    derived.push({ ...member, ...(shared === undefined ? {} : { shared }) });
  }
  const root = yield* stage(output, { ...descriptor, skills: derived });
  for (const selection of selected) {
    const member = derived.find((item) => item.path === selection.member.path)!;
    if (
      (yield* installedSkillHash({
        collectionVersionPath: root,
        sourcePath: member.path,
        shared: member.shared,
      })) !== selection.artifactHash
    )
      return yield* new InvalidLibraryState({
        path: root,
        detail: `Selected inputs for ${member.name} do not reproduce their validated artifact`,
      });
  }
  yield* fs.writeFileString(
    join(root, authoredInputsFile),
    yield* Schema.encodeEffect(AuthoredInputs)({
      descriptor,
      selections: selected.map((item) => item.provenance),
    }),
  );
  return { root, messages };
});
