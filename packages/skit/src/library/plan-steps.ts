import type { InstalledSkills } from "./installed-skills.js";
import type { InstalledSkill, InstalledSkillSuppressed } from "./library-state.js";
import type { Hash } from "../vocabulary.js";
import type { CopyChange } from "./library-plan.js";

/** One copy the next Library should have installed, with what installing it would write. */
export interface Wanted {
  readonly copy: InstalledSkills.Copy;
  readonly destination: InstalledSkills.Destination;
  readonly name: string;
  readonly path: string;
  /** The record at this place before, matched by physical root. */
  readonly prior: InstalledSkill | undefined;
  readonly folder: InstalledSkills.Observed;
}

/** One change with what apply needs to carry it out. */
export type Step =
  | { readonly _tag: "Install"; readonly change: CopyChange; readonly wanted: Wanted }
  | {
      readonly _tag: "Unreadable";
      readonly change: CopyChange;
      readonly wanted: Wanted;
      readonly reason: string;
    }
  | {
      readonly _tag: "KeepDeleted";
      readonly change: CopyChange;
      readonly wanted: Wanted;
      readonly prior: InstalledSkillSuppressed;
    }
  | {
      readonly _tag: "Update" | "Unchanged";
      readonly change: CopyChange;
      readonly wanted: Wanted;
      /** Built to decide what happens at a folder that is already there. */
      readonly staged: InstalledSkills.Staged;
    }
  | {
      readonly _tag: "Manage";
      readonly change: CopyChange;
      readonly wanted: Wanted;
      readonly staged: InstalledSkills.Staged;
      readonly verification: "replacement" | "adoption" | "marker";
    }
  | {
      readonly _tag: "Conflict";
      readonly change: CopyChange;
      readonly wanted: Wanted;
      readonly staged: InstalledSkills.Staged;
      readonly edited: boolean;
      readonly hash: Hash;
      readonly expectedHash: Hash;
    }
  | {
      readonly _tag: "Uninstall" | "Forget" | "Refuse";
      readonly change: CopyChange;
      readonly copy: InstalledSkill;
    }
  /** A folder that is someone else's in itself: nothing happens to it or its record. */
  | {
      readonly _tag: "Protected";
      readonly change: CopyChange;
      readonly wanted: Wanted;
      readonly reason: InstalledSkills.Protection;
    }
  | {
      readonly _tag: "Protected";
      readonly change: CopyChange;
      readonly copy: InstalledSkill;
      readonly reason: InstalledSkills.Protection;
    }
  /** An edited copy where agents do not read it: kept, and recorded as conflicted. */
  | {
      readonly _tag: "Keep";
      readonly change: CopyChange;
      readonly copy: InstalledSkill;
      readonly hash: Hash;
    };
