import { discoveryLimitations, rootOverrideDetail } from "./discovery-coverage.js";
import { harnessDiscoveryFailure } from "../../platform/discovery-failures.js";
import { harnessProbeFailure } from "../../platform/probe-failures.js";
import { duplicateScanIssue } from "../duplicate-scan.js";
import { renderDoctorListingBudget } from "./budget.js";
import type { DoctorReport } from "@smolai/skit-core/library/inventory";
import type { SkillAlias } from "@smolai/skit-core/library/routing";
import { dirname } from "node:path";
import { harnessLabel } from "@smolai/skit-core/harnesses";
import {
  conditionHeadline,
  conditionNextStep,
  installedSkillConflictText,
  ownershipMarkerInvalidReason,
} from "../presentation/language.js";
import type { RenderContext } from "../../terminal/contracts.js";
import { Block, type Inline, type ListItem } from "../../terminal/blocks.js";

export function renderDoctor(data: typeof DoctorReport.Type, context: RenderContext): Block[] {
  // Each finding is an outcome followed by the facts that explain it.
  const finding = (
    tone: "warn" | "error",
    text: ReadonlyArray<Inline>,
    items: ReadonlyArray<ListItem>,
  ) => [Block.Status({ tone, text }), ...(items.length ? [Block.List({ items })] : [])];

  const hasCollisions =
    data.codex.findings.some((finding) => finding.kind !== "layered-name") ||
    data.harnesses.some((check) =>
      check.findings.some((finding) => finding._tag === "NameCollision"),
    );
  const findings: Block[] = [
    ...data.issues.flatMap((issue) => {
      const next = conditionNextStep(issue.code, issue.conflicts);
      return finding(
        "error",
        [
          conditionHeadline(issue.code, "Local library issue"),
          ...(issue.target ? [{ dim: ` (.${issue.target})` }] : []),
        ],
        [
          ...(issue.path
            ? [{ text: [{ dim: issue.path }] }]
            : issue.skillId
              ? [{ text: [{ dim: issue.skillId }] }]
              : []),
          ...(issue.conflicts ?? []).map((conflict) => ({
            text: [installedSkillConflictText(conflict)],
          })),
          ...(issue.markerReason
            ? [{ text: [ownershipMarkerInvalidReason(issue.markerReason)] }]
            : []),
          ...(next ? [{ text: [`Next: ${next}`] }] : []),
        ],
      );
    }),
    ...data.codex.findings.flatMap((codexFinding) =>
      finding(
        "warn",
        [
          { emph: codexFinding.name },
          { dim: ` (Codex, ${codexFinding.instances.length} entries)` },
        ],
        [
          {
            text: [
              `${codexFinding.kind === "layered-name" ? "Same skill name at different scopes (layered)" : codexFinding.kind === "duplicate-name" ? "Same skill name" : "Different skill names share this display name"}, ${codexFinding.documents === "identical" ? "identical SKILL.md" : codexFinding.documents === "different" ? "different SKILL.md" : "content comparison unavailable"}`,
            ],
          },
          ...codexFinding.instances.flatMap((instance) => {
            const locations: readonly SkillAlias[] = instance.aliases?.length
              ? instance.aliases
              : [{ path: instance.path, via: "unknown-root" }];
            return locations.map((alias): ListItem => ({
              text:
                alias.via === "symlink"
                  ? [
                      { dim: alias.path },
                      " → ",
                      { dim: dirname(instance.canonicalPath) },
                      {
                        dim: ` (symlink${alias.linkPath && alias.linkPath !== alias.path ? ` at ${alias.linkPath}` : ""})`,
                      },
                    ]
                  : [{ dim: alias.path }, { dim: ` (${alias.via})` }],
              detail: [
                {
                  dim: `${instance.scope}${instance.pluginId ? `, plugin ${instance.pluginId}` : ""}, ${instance.skitManaged ? "Installed by SKIT" : "not tracked by SKIT"}`,
                },
              ],
            }));
          }),
          ...(codexFinding.kind !== "layered-name" &&
          codexFinding.instances.some((instance) =>
            instance.aliases?.some((alias) => alias.via === "symlink"),
          )
            ? [
                {
                  text: [
                    "Remove the redundant symlink alias or disable the Skill in SKIT; leave the source directory in place.",
                  ],
                },
              ]
            : []),
        ],
      ),
    ),
    ...(data.codex.aliasErrors ?? []).flatMap((error) =>
      finding(
        "warn",
        ["Codex could not inspect ", { dim: error.path }],
        [{ text: [duplicateScanIssue(error.reason)] }],
      ),
    ),
    ...data.codex.errors.flatMap((error) =>
      finding(
        "warn",
        ["Codex could not inspect ", { dim: error.path }],
        [{ text: [error.message] }],
      ),
    ),
    ...data.harnesses.flatMap((check) => {
      const collisions = check.findings.filter((finding) => finding._tag === "NameCollision");
      return [
        ...check.skills.flatMap((skill) =>
          [...skill.errors, ...skill.warnings].flatMap((message) =>
            finding(
              "warn",
              [{ emph: skill.name }, { dim: ` (${harnessLabel(check.harness)})` }],
              [{ text: [message] }, ...(skill.path ? [{ text: [{ dim: skill.path }] }] : [])],
            ),
          ),
        ),
        ...collisions.flatMap(({ name, paths, selectedPath }) =>
          finding(
            "warn",
            [{ emph: name }, { dim: ` (OpenCode, ${paths.length} locations)` }],
            [
              { text: ["Same skill name, OpenCode selects one copy"] },
              ...[...paths].sort().map((value): ListItem => {
                const location = check.locations?.find(
                  (item) =>
                    item.canonicalPath === dirname(value) ||
                    item.aliases.some((alias) => alias.path === dirname(value)),
                );
                const aliases = location?.aliases.filter((alias) => alias.via === "symlink") ?? [];
                return {
                  text: [{ dim: value }, ...(value === selectedPath ? [" (selected)"] : [])],
                  ...(aliases.length
                    ? {
                        detail: [
                          {
                            dim: aliases
                              .map(
                                (alias) =>
                                  `${alias.path} → ${location?.canonicalPath ?? dirname(value)} (symlink)`,
                              )
                              .join("\n"),
                          },
                        ],
                      }
                    : {}),
                };
              }),
            ],
          ),
        ),
        ...(check.aliasErrors ?? []).flatMap((error) =>
          finding(
            "warn",
            [
              `${harnessLabel(check.harness)} could not inspect skill aliases at `,
              { dim: error.path },
            ],
            [{ text: [duplicateScanIssue(error.reason)] }],
          ),
        ),
        ...check.findings
          .filter((finding) => finding._tag === "Warning")
          .flatMap((warning) =>
            finding("warn", [warning.message, { dim: ` (${harnessLabel(check.harness)})` }], []),
          ),
      ];
    }),
  ];

  // A Harness reads as fine, needing attention, or absent; full detail lists what it found.
  const discovery = ({
    state,
    warning,
    harness,
    found,
    version,
    status,
    listed,
    limitations,
  }: {
    readonly state: string;
    readonly warning: boolean;
    readonly harness: string;
    readonly found: string;
    readonly version: string | undefined;
    readonly status: string | undefined;
    readonly listed: ReadonlyArray<ListItem>;
    readonly limitations?: readonly string[];
  }): Block[] => [
    Block.Status({
      tone: state === "checked" ? (warning ? "warn" : "ok") : state === "missing" ? "info" : "warn",
      text: [
        { emph: harness },
        ": ",
        state === "checked"
          ? found
          : state === "missing"
            ? "not installed"
            : state === "failed"
              ? "failed"
              : "not checked",
        ...(version ? [{ dim: ` (${version})` }] : []),
      ],
    }),
    ...(state !== "checked" && state !== "missing"
      ? [Block.List({ items: [{ text: [{ dim: status ?? state }] }] })]
      : []),
    ...(state === "checked" && context.detail === "full" && listed.length
      ? [Block.List({ items: listed })]
      : []),
    ...(state === "checked" && context.detail === "full" && limitations?.length
      ? [Block.List({ items: limitations.map((text) => ({ text: [{ dim: text }] })) })]
      : []),
  ];
  const codex = data.codex;

  return [
    Block.Heading({ text: "SKIT doctor" }),
    Block.Note({ text: [{ dim: data.codex.cwd }] }),
    data.ok
      ? Block.Status({ tone: "ok", text: [{ emph: "Local library is healthy" }] })
      : Block.Status({
          tone: "error",
          text: [
            {
              emph: `${data.issues.length} library issue${data.issues.length === 1 ? "" : "s"}`,
            },
          ],
        }),
    ...(findings.length ? [Block.Group({ title: "Needs attention", children: findings })] : []),
    ...(data.listing_budgets.length
      ? [
          Block.Group({
            title: "Skill budgets",
            children: data.listing_budgets.map((budget) =>
              renderDoctorListingBudget(budget, context.detail),
            ),
          }),
        ]
      : []),
    Block.Group({
      title: "Harness discovery",
      children: [
        ...discovery({
          state: codex.status,
          warning: Boolean(
            codex.findings.some((finding) => finding.kind !== "layered-name") ||
            codex.errors.length ||
            codex.aliasErrors?.length,
          ),
          harness: "Codex",
          found: `${codex.instances.length} enabled skill${codex.instances.length === 1 ? "" : "s"}`,
          version: codex.version,
          limitations: codex.protocol ? discoveryLimitations(codex.protocol) : [],
          status: codex.discoveryFailure
            ? harnessDiscoveryFailure(codex.discoveryFailure).message
            : codex.probeFailure
              ? harnessProbeFailure(codex.probeFailure)
              : codex.rootOverrides
                ? rootOverrideDetail("codex", codex.rootOverrides)
                : undefined,
          listed: codex.instances.map((instance) => ({
            text: [instance.name, " ", { dim: instance.path }],
          })),
        }),
        ...data.harnesses.flatMap((check) =>
          discovery({
            state: check.status,
            warning: Boolean(
              check.warnings.length ||
              (check.aliasErrors?.length ?? 0) ||
              check.skills.some((skill) => skill.warnings.length || skill.errors.length),
            ),
            harness: harnessLabel(check.harness),
            found: `${check.skills.length} ${check.coverage === "callable-commands" ? `callable command${check.skills.length === 1 ? "" : "s"}` : `skill${check.skills.length === 1 ? "" : "s"}`}`,
            version: check.version,
            limitations: check.protocol ? discoveryLimitations(check.protocol) : [],
            status: check.discoveryFailure
              ? harnessDiscoveryFailure(check.discoveryFailure).message
              : check.probeFailure
                ? harnessProbeFailure(check.probeFailure)
                : check.rootOverrides
                  ? rootOverrideDetail(check.harness, check.rootOverrides)
                  : undefined,
            listed: check.skills.map((skill) => ({
              text: [
                skill.name,
                ...(skill.id && skill.id !== skill.name ? [{ dim: ` (ID: ${skill.id})` }] : []),
                ...(skill.path ? [" ", { dim: skill.path }] : []),
              ],
            })),
          }),
        ),
      ],
    }),
    Block.Group({
      title: "Next steps",
      children: [
        ...(hasCollisions
          ? [
              Block.Note({
                text: [
                  "Inspect the listed copies and their ownership before disabling or removing one.",
                ],
              }),
            ]
          : []),
        Block.List({
          items: [
            ...(hasCollisions
              ? [
                  {
                    text: [{ code: "skit inventory" }],
                    detail: [{ dim: "inspect discovered copies and ownership" }],
                  },
                ]
              : data.issues.length
                ? [
                    {
                      text: [{ code: "skit inventory" }],
                      detail: [{ dim: "inspect affected paths and ownership" }],
                    },
                  ]
                : []),
            {
              text: [{ code: "skit doctor --json" }],
              detail: [{ dim: "full lists, paths and native diagnostics" }],
            },
          ],
        }),
      ],
    }),
  ];
}
