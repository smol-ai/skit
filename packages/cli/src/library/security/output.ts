import { SkillSecurityReview } from "@smolai/skit-core/audit";

export const securityOutputContracts = {
  securityReview: { id: "skit.security.review.v4", schema: SkillSecurityReview },
  securityAccept: { id: "skit.security.accept.v4", schema: SkillSecurityReview },
} as const;
