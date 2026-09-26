import type { Html, HtmlBuilder } from "foldkit/html";
import type { Message } from "./main.js";

export const sourceUrl = "https://github.com/smol-ai/skit";

const codeBlock = (text: string, h: HtmlBuilder<Message>): Html =>
  h.pre(
    [h.Class("overflow-x-auto rounded-lg border bg-muted/50 p-4 font-mono text-sm leading-7")],
    [h.code([], [text])],
  );

export const landingView = (origin: string, account: Html, h: HtmlBuilder<Message>): Html =>
  h.main(
    [h.Class("mx-auto grid w-full max-w-6xl gap-16 px-5 py-12 sm:px-8 sm:py-20")],
    [
      h.div(
        [h.Class("grid items-start gap-10 lg:grid-cols-[1.2fr_1fr] lg:gap-16")],
        [
          h.section(
            [h.Class("grid gap-6")],
            [
              h.p(
                [h.Class("text-sm font-medium text-muted-foreground")],
                ["Open source · MIT licensed"],
              ),
              h.h1(
                [
                  h.Class(
                    "max-w-xl text-4xl font-semibold tracking-tight sm:text-5xl sm:leading-tight",
                  ),
                ],
                ["A better way to manage your agent skills."],
              ),
              h.p(
                [h.Class("max-w-xl text-lg leading-8 text-muted-foreground")],
                [
                  "Keep a skill library of your own. Choose which skills each agent can use, where they are enabled, and whether they can run automatically.",
                ],
              ),
              codeBlock("npm install -g @smolai/skit\nskit setup", h),
              h.p(
                [h.Class("text-sm leading-6 text-muted-foreground")],
                ["Works with Codex, Claude Code, OpenCode, and Devin."],
              ),
              h.a(
                [
                  h.Href(sourceUrl),
                  h.Class("w-fit text-sm font-medium underline underline-offset-4"),
                ],
                ["Read the README and explore the source →"],
              ),
            ],
          ),
          h.section([h.Id("sign-in"), h.Class("scroll-mt-8")], [account]),
        ],
      ),
      h.section(
        [h.Class("grid gap-6 border-t pt-12")],
        [
          h.h2([h.Class("text-2xl font-semibold tracking-tight")], ["Your library. Your rules."]),
          h.div(
            [h.Class("grid gap-8 sm:grid-cols-2")],
            (
              [
                [
                  "Keep skills without activating them",
                  "Your library lives separately from the directories agents automatically read, such as .agents/skills. Installing a skill does not have to mean letting every agent use it.",
                ],
                [
                  "Enable skills where you need them",
                  "Enable or disable a skill in one or more harnesses, globally or in a specific repository. Disabling removes the harness copy and keeps the skill in your library.",
                ],
                [
                  "Control automatic invocation",
                  "Choose whether a skill follows its declared policy, requires an explicit request, or can be invoked automatically. SKIT writes the settings supported by each harness.",
                ],
                [
                  "Sync across machines",
                  "Connect your library and settings to a Registry, or run your own on Cloudflare. Each Registry has its own accounts, credentials, and stored data.",
                ],
              ] as const
            ).map(([title, description]) =>
              h.div(
                [h.Class("grid content-start gap-2")],
                [
                  h.h3([h.Class("text-base font-semibold")], [title]),
                  h.p([h.Class("text-sm leading-7 text-muted-foreground")], [description]),
                ],
              ),
            ),
          ),
        ],
      ),
      h.section(
        [h.Class("grid gap-6 border-t pt-12 lg:grid-cols-2 lg:gap-16")],
        [
          h.div(
            [h.Class("grid content-start gap-4")],
            [
              h.h2([h.Class("text-2xl font-semibold tracking-tight")], ["Why SKIT?"]),
              h.p(
                [h.Class("text-sm leading-7 text-muted-foreground")],
                [
                  "You try a skill someone recommended. Months later, an agent invokes it in a project where you never wanted it. Maybe its trigger is too broad, it needs an app that is not running, or you no longer remember where it came from.",
                ],
              ),
              h.p(
                [h.Class("text-sm leading-7 text-muted-foreground")],
                [
                  "SKIT separates collecting skills from giving agents access to them, so you can keep useful skills and decide when and where they belong.",
                ],
              ),
            ],
          ),
          h.div(
            [h.Class("grid content-start gap-4")],
            [
              h.h2(
                [h.Class("text-2xl font-semibold tracking-tight")],
                ["Start with the skills you already have"],
              ),
              h.p(
                [h.Class("text-sm leading-7 text-muted-foreground")],
                [
                  "Interactive setup finds skills in standard harness locations. Add --work-dir to discover skills and skills.sh lockfiles in your repositories, then choose the exact versions to keep.",
                ],
              ),
              codeBlock("skit setup --work-dir ~/Work\nskit list\nskit enable\nskit disable", h),
            ],
          ),
        ],
      ),
      h.section(
        [h.Class("grid gap-4 rounded-xl border bg-muted/30 p-6 sm:p-8")],
        [
          h.h2([h.Class("text-2xl font-semibold tracking-tight")], ["Take your library with you"]),
          h.p(
            [h.Class("max-w-2xl text-sm leading-7 text-muted-foreground")],
            [
              "After creating an account on this Registry, sign in from the CLI. Run skit sync to preview the plan, then skit sync --apply to sync your library. Prefer your own infrastructure? The Registry server is open source and runs on Cloudflare Workers, D1, and R2.",
            ],
          ),
          codeBlock(`skit auth login ${origin}\nskit sync\nskit sync --apply`, h),
          h.a(
            [
              h.Href(`${sourceUrl}/blob/main/docs/self-hosting.md`),
              h.Class("w-fit text-sm font-medium underline underline-offset-4"),
            ],
            ["Self-hosting guide →"],
          ),
        ],
      ),
    ],
  );
