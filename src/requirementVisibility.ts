import type { Requirement } from "./types.ts";

export function canViewRequirement(requirement: Requirement, viewerId: string, ownerId: string): boolean {
  if (ownerId && viewerId === ownerId) return true;
  if (requirement.visibility === "public") return true;
  return requirement.visibility === "requester" && requirement.requesterId === viewerId;
}
