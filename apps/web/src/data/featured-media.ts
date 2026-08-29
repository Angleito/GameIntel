import { loadMediaShowcase, mediaShowcasePath, type MediaShowcase } from "@gameintel/config";

export type FeaturedMediaSet = MediaShowcase;

// The showcase media for a profile lives in the profile itself
// (profiles/<profile-id>/media-showcase.json), never in the web app.
export async function getFeaturedMedia(profileId?: string): Promise<FeaturedMediaSet> {
  return loadMediaShowcase(mediaShowcasePath(profileId));
}