import { usageCliCommand } from "../handlers/usage.js";
import { Command } from "effect/cli";
import { checkCliCommand } from "../library/commands/check.js";
import { serverBootstrapCliCommand } from "../bootstrap/server-bootstrap.js";
import { authLogoutCliCommand } from "../handlers/auth/logout.js";
import { authLoginCliCommand } from "../handlers/auth/login.js";
import { authStatusCliCommand } from "../handlers/auth/status.js";
import { listCliCommand } from "../library/commands/list.js";
import { addCliCommand } from "../library/commands/add.js";
import { removeCliCommand } from "../library/commands/remove.js";
import { updateCliCommand } from "../library/commands/update.js";
import { librarySyncCliCommand } from "../library/commands/sync.js";
import { disableCliCommand, enableCliCommand } from "../library/enable/command.js";
import { securityAcceptCliCommand } from "../handlers/security/accept.js";
import { securityReviewCliCommand } from "../handlers/security/review.js";
import { setupCliCommand } from "../library/setup/command.js";
import { doctorCliCommand, inventoryCliCommand } from "../library/commands/inventory.js";
import {
  repositoryForgetCliCommand,
  repositoryIgnoreCliCommand,
  repositoryListCliCommand,
  repositoryWatchCliCommand,
} from "../handlers/repository.js";
import { libraryRecoveryCliCommand } from "../library/commands/recovery.js";
import { librarySetupUndoCliCommand } from "../library/setup/undo-command.js";
import { libraryHistoryCliCommand } from "../library/commands/history.js";
import { versionCliCommand } from "../handlers/version.js";
import { feedbackSendCliCommand } from "../handlers/feedback.js";
import {
  registryAddCliCommand,
  registryDefaultCliCommand,
  registryListCliCommand,
  registryRemoveCliCommand,
} from "../handlers/registry.js";
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
