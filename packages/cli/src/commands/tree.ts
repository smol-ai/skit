import { usageCliCommand } from "../library/commands/usage.js";
import { Command } from "effect/cli";
import { checkCliCommand } from "../library/check.js";
import { serverBootstrapCliCommand } from "../registry/commands/bootstrap.js";
import { authLogoutCliCommand } from "../registry/commands/logout.js";
import { authLoginCliCommand } from "../registry/commands/login.js";
import { authStatusCliCommand } from "../registry/commands/status.js";
import { listCliCommand } from "../library/commands/list.js";
import { addCliCommand } from "../library/commands/add.js";
import { removeCliCommand } from "../library/remove.js";
import { updateCliCommand } from "../library/commands/update.js";
import { librarySyncCliCommand } from "../library/commands/sync.js";
import { disableCliCommand, enableCliCommand } from "../library/enable.js";
import { securityAcceptCliCommand } from "../library/commands/security-accept.js";
import { securityReviewCliCommand } from "../library/commands/security-review.js";
import { setupCliCommand, librarySetupUndoCliCommand } from "../library/setup.js";
import { doctorCliCommand, inventoryCliCommand } from "../library/commands/inventory.js";
import {
  repositoryForgetCliCommand,
  repositoryIgnoreCliCommand,
  repositoryListCliCommand,
  repositoryWatchCliCommand,
} from "../library/commands/repository.js";
import { libraryRecoveryCliCommand } from "../library/commands/recovery.js";
import { libraryHistoryCliCommand } from "../library/commands/history.js";
import { versionCliCommand } from "./version.js";
import { feedbackSendCliCommand } from "../feedback.js";
import {
  registryAddCliCommand,
  registryDefaultCliCommand,
  registryListCliCommand,
  registryRemoveCliCommand,
} from "../registry/commands/remotes.js";
import { JsonOutputFlag } from "./parameters.js";

const authCommand = Command.make("auth").pipe(
  Command.withDescription("Manage Registry authentication."),
  Command.withSubcommands([authLoginCliCommand, authLogoutCliCommand, authStatusCliCommand]),
);

const feedbackCommand = Command.make("feedback").pipe(
  Command.withDescription("Tell SKIT's maintainers what got in your way."),
  Command.withSubcommands([feedbackSendCliCommand]),
);

const securityCommand = Command.make("security").pipe(
  Command.withDescription("Review and accept retained artifact security findings."),
  Command.withSubcommands([securityAcceptCliCommand, securityReviewCliCommand]),
);

const serverCommand = Command.make("server").pipe(
  Command.withDescription("Operate a deployed skit-server."),
  Command.withSubcommands([serverBootstrapCliCommand]),
);

const registryCommand = Command.make("registry").pipe(
  Command.withDescription("Manage named Registry locations."),
  Command.withSubcommands([
    registryAddCliCommand,
    registryDefaultCliCommand,
    registryListCliCommand,
    registryRemoveCliCommand,
  ]),
);

const libraryCommand = Command.make("library").pipe(
  Command.withDescription("Manage local Library storage."),
  Command.withSubcommands([
    libraryHistoryCliCommand,
    libraryRecoveryCliCommand,
    librarySetupUndoCliCommand,
  ]),
);

const repositoryCommand = Command.make("repository").pipe(
  Command.withDescription("Manage this machine's repository inventory decisions."),
  Command.withSubcommands([
    repositoryListCliCommand,
    repositoryWatchCliCommand,
    repositoryIgnoreCliCommand,
    repositoryForgetCliCommand,
  ]),
);

/** The executable CLI grammar. Its leaves own parsing, metadata, and execution. */
export const skitCommand = Command.make("skit").pipe(
  Command.withDescription("Manage portable, auditable collections of agent skills."),
  Command.withGlobalFlags([JsonOutputFlag]),
  Command.withSubcommands([
    authCommand,
    addCliCommand,
    checkCliCommand,
    doctorCliCommand,
    disableCliCommand,
    enableCliCommand,
    feedbackCommand,
    inventoryCliCommand,
    libraryCommand,
    listCliCommand,
    registryCommand,
    repositoryCommand,
    removeCliCommand,
    securityCommand,
    serverCommand,
    setupCliCommand,
    librarySyncCliCommand,
    updateCliCommand,
    versionCliCommand,
    usageCliCommand,
  ]),
);
