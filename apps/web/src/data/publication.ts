import artifact from "./publication.json";
import { PublicOutputArtifactSchema } from "@gameintel/output";

// Parsing here prevents stale or manually edited local artifacts from reaching
// any static route even if a build is invoked outside the root script.
export default PublicOutputArtifactSchema.parse(artifact);
