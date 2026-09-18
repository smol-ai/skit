import { Command } from "effect/unstable/cli";
import { checkCliCommand } from "../handlers/library/check.js";
import { serverBootstrapCliCommand } from "../bootstrap/server-bootstrap.js";
import { authLogoutCliCommand } from "../handlers/auth/logout.js";
import { authLoginCliCommand } from "../handlers/auth/login.js";
import { authStatusCliCommand } from "../handlers/auth/status.js";
import { listCliCommand } from "../handlers/library/list.js";
import { addCliCommand } from "../handlers/library/add.js";
import { pullCliCommand } from "../handlers/library/pull.js";
import { pinCliCommand } from "../handlers/library/pin.js";
import { removeCliCommand } from "../handlers/library/remove.js";
import { updateCliCommand } from "../handlers/library/update.js";
import { librarySyncCliCommand } from "../handlers/library/sync.js";
import { disableCliCommand, enableCliCommand } from "../handlers/library/set-enabled.js";
import { securityAcceptCliCommand } from "../handlers/security/accept.js";
import { securityReviewCliCommand } from "../handlers/security/review.js";
import { setupCliCommand } from "../handlers/library/setup.js";
import { doctorCliCommand, inventoryCliCommand } from "../handlers/library/inventory.js";
import {
  repositoryForgetCliCommand,
  repositoryIgnoreCliCommand,
  repositoryListCliCommand,
  repositoryWatchCliCommand,
} from "../handlers/repository.js";
import { libraryHistoryCliCommand } from "../handlers/library/history.js";
import { versionCliCommand } from "../handlers/version.js";
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
  Command.withSubcommands([libraryHistoryCliCommand]),
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
    inventoryCliCommand,
    libraryCommand,
    listCliCommand,
    pinCliCommand,
    pullCliCommand,
    registryCommand,
    repositoryCommand,
    removeCliCommand,
    securityCommand,
    serverCommand,
    setupCliCommand,
    librarySyncCliCommand,
    updateCliCommand,
    versionCliCommand,
  ]),
);
