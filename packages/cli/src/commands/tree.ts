import { usageCliCommand } from "./library-usage.js";
import { Command } from "effect/cli";
import { Layer } from "effect";
import { skitLayer } from "@smolai/skit-core/platform";
import { configurationLayer, libraryLayer, sourceLayer } from "../application.js";
import { registryHttpLayer } from "../registry/registry-http.js";
import { terminalPrompterLayer } from "../terminal/prompter.js";
import { terminalLibraryProgressLayer } from "../library/update/present-progress.js";
import { checkCliCommand } from "./library-check.js";
import { serverBootstrapCliCommand } from "../registry/commands/bootstrap.js";
import { authLogoutCliCommand } from "../registry/commands/auth-logout.js";
import { authLoginCliCommand } from "../registry/commands/auth-login.js";
import { authStatusCliCommand } from "../registry/commands/status.js";
import { listCliCommand } from "./library-list.js";
import { addCliCommand } from "./library-add.js";
import { removeCliCommand } from "./library-remove.js";
import { updateCliCommand } from "./library-update.js";
import { librarySyncCliCommand } from "./library-sync.js";
import { disableCliCommand } from "./library-disable.js";
import { enableCliCommand } from "./library-enable.js";

import { securityAcceptCliCommand } from "./library-security-accept.js";
import { securityReviewCliCommand } from "./library-security-review.js";
import { librarySetupUndoCliCommand } from "./library-setup-undo.js";
import { setupCliCommand } from "./library-setup.js";
import { doctorCliCommand } from "./library-doctor.js";
import { inventoryCliCommand } from "./library-inventory.js";
import { repositoryForgetCliCommand } from "./library-repository-forget.js";
import { repositoryIgnoreCliCommand } from "./library-repository-ignore.js";
import { repositoryWatchCliCommand } from "./library-repository-watch.js";
import { repositoryListCliCommand } from "./library-repository-list.js";
import { libraryRecoveryCliCommand } from "./library-recovery.js";
import { libraryHistoryCliCommand } from "./library-history.js";
import { versionCliCommand } from "./version.js";
import { feedbackSendCliCommand } from "../feedback.js";
import { registryAddCliCommand } from "../registry/commands/registry-add.js";
import { registryDefaultCliCommand } from "../registry/commands/registry-default.js";
import { registryListCliCommand } from "../registry/commands/registry-list.js";
import { registryRemoveCliCommand } from "../registry/commands/registry-remove.js";
import { homeFlag, localFlags, JsonOutputFlag } from "./parameters.js";

const authCommand = Command.make("auth").pipe(
  Command.withSharedFlags({ home: homeFlag }),
  Command.withDescription("Manage Registry authentication."),
  Command.withSubcommands([authLoginCliCommand, authLogoutCliCommand, authStatusCliCommand]),
  Command.provide((input) => Layer.merge(configurationLayer(input), registryHttpLayer())),
);

const feedbackCommand = Command.make("feedback").pipe(
  Command.withSharedFlags({ home: homeFlag }),
  Command.withDescription("Tell SKIT's maintainers what got in your way."),
  Command.withSubcommands([feedbackSendCliCommand]),
  Command.provide((input) => Layer.merge(configurationLayer(input), registryHttpLayer())),
);

const securityCommand = Command.provide(
  Command.make("security").pipe(
    Command.withSharedFlags(localFlags),
    Command.withDescription("Review and accept retained artifact security findings."),
    Command.withSubcommands([securityAcceptCliCommand, securityReviewCliCommand]),
  ),
  libraryLayer,
);

const serverCommand = Command.make("server").pipe(
  Command.withDescription("Operate a deployed skit-server."),
  Command.withSubcommands([serverBootstrapCliCommand]),
  Command.provide(registryHttpLayer()),
);

const registryCommand = Command.provide(
  Command.make("registry").pipe(
    Command.withSharedFlags({ home: homeFlag }),
    Command.withDescription("Manage named Registry locations."),
    Command.withSubcommands([
      registryAddCliCommand,
      registryDefaultCliCommand,
      registryListCliCommand,
      registryRemoveCliCommand,
    ]),
  ),
  configurationLayer,
);

const libraryCommand = Command.provide(
  Command.make("library").pipe(
    Command.withSharedFlags({ home: homeFlag }),
    Command.withDescription("Manage local Library storage."),
    Command.withSubcommands([
      libraryHistoryCliCommand,
      libraryRecoveryCliCommand,
      librarySetupUndoCliCommand,
    ]),
  ),
  libraryLayer,
);

const repositoryCommand = Command.provide(
  Command.make("repository").pipe(
    Command.withSharedFlags({ home: homeFlag }),
    Command.withDescription("Manage this machine's repository inventory decisions."),
    Command.withSubcommands([
      repositoryListCliCommand,
      repositoryWatchCliCommand,
      repositoryIgnoreCliCommand,
      repositoryForgetCliCommand,
    ]),
  ),
  configurationLayer,
);

/** The executable CLI grammar. Its leaves own parsing, metadata, and execution. */
export const skitCommand = Command.make("skit").pipe(
  Command.withDescription("Manage portable, auditable collections of agent skills."),
  Command.withGlobalFlags([JsonOutputFlag]),
  Command.withSubcommands([
    authCommand,
    Command.provide(addCliCommand, sourceLayer),
    Command.provide(checkCliCommand, sourceLayer),
    Command.provide(doctorCliCommand, libraryLayer),
    Command.provide(disableCliCommand, libraryLayer),
    Command.provide(enableCliCommand, libraryLayer),
    feedbackCommand,
    Command.provide(inventoryCliCommand, libraryLayer),
    libraryCommand,
    Command.provide(listCliCommand, libraryLayer),
    registryCommand,
    repositoryCommand,
    Command.provide(removeCliCommand, libraryLayer),
    securityCommand,
    serverCommand,
    Command.provide(setupCliCommand, sourceLayer),
    Command.provide(librarySyncCliCommand, sourceLayer),
    Command.provide(updateCliCommand, sourceLayer),
    versionCliCommand,
    Command.provide(usageCliCommand, libraryLayer),
  ]),
  Command.provide(Layer.mergeAll(skitLayer, terminalPrompterLayer, terminalLibraryProgressLayer)),
);
